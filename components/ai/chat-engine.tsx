"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { trackAcceptedReport } from "@/components/background/task-store";
import { Markdown } from "@/components/ai/markdown";
import { indexChatSources, type ChatSource } from "@/components/ai/citation";
import {
  DEFAULT_CHAT_MODE,
  isChatModeId,
  useChatMode,
  type ChatModeId,
} from "@/components/ai/chat-modes";
import type { ReportProfileId, ReportStyleId } from "@/components/ai/report-options";
import type { ToastTone } from "@/components/ui/toast";
import type { SourceRef } from "@/lib/content/model";

/**
 * The shared chat turn engine: every piece of state and logic a chat surface
 * needs to stream one turn at a time from POST /api/ai/chat as SSE, reused
 * by the collapsed "Ask AI" side panel and the full-screen chat workspace.
 *
 * Every turn carries the selected intelligence mode: Quick, Balanced, or
 * Deep — the server maps it to the active provider's model, reasoning effort,
 * and working directive. The selection lives in the switcher above the composer, is
 * remembered across visits in localStorage, and follows a reopened thread's
 * stored mode; switching mid-conversation takes effect on the next message.
 *
 * The engine is deliberately dumb about where its scope comes from — it only
 * receives the video ids to ground answers in. Hosts pass the scope's video
 * metadata (`sources`) to the answer renderer, which resolves the transcript
 * citations into titled source chips. Threads are filtered to a host's scope
 * by the host (the panel filters to its selection; the workspace shows all).
 *
 * Rendering model: the backend emits deltas and completed agent messages.
 * Each message event delimits one assistant block, and blocks are
 * append-only — a partial block survives aborts and errors. Codex 0.150.1
 * opens a turn with an interim "plan" agent message before the real answer;
 * when the answer supersedes it, a `message_superseded` event removes that
 * block so the plan never renders as (part of) the answer. Text is revealed
 * through a small chase buffer so arrivals type out smoothly instead of
 * popping in chunks.
 *
 * Failure states are designed, not defaulted: server `notice` events (e.g.
 * byte-budget truncation) surface as a quiet scope disclosure; a turn that
 * dies mid-answer leaves its partial block in place, explicitly marked "may
 * be incomplete" with an "Ask again" retry; failures surface as a host-rendered
 * inline alert with a "Try again" action that re-sends the last message
 * without clobbering a draft typed meanwhile.
 */

/** Client mirror of the server's ChatStreamEvent (never import lib/ai here). */
export type ChatStreamEvent =
  | { type: "thread"; threadId: number; created: boolean }
  | { type: "user_message"; id: number; content: string; createdAt: string }
  | { type: "status"; phase: "thinking" | "writing" }
  | { type: "notice"; message: string }
  | { type: "delta"; text: string }
  | { type: "message"; text: string }
  | { type: "message_superseded" }
  | { type: "done"; threadId: number; assistantMessageId: number; sessionId: string | null }
  | { type: "error"; code: string; message: string };

export interface MessageDraft {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** True while this assistant block is still receiving text. */
  streaming?: boolean;
  /**
   * True when this block ended short of a completed turn (stopped or died
   * mid-answer); rendered with an explicit "may be incomplete" marker.
   */
  interrupted?: boolean;
}

export interface TurnError {
  code: string;
  message: string;
}

/** The assistant block currently receiving text; text chases `revealed`. */
interface ActiveSegment {
  id: string;
  /** Authoritative text so far (deltas appended, `message` events replace). */
  text: string;
  /** How much of `text` has been revealed to the user. */
  revealed: number;
  /** Whether a `message` event confirmed this block as complete. */
  confirmed: boolean;
}

export type TurnPhase = "idle" | "working" | "writing";

/**
 * Friendly alert heading per failure code; the alert body carries the
 * actionable detail from the server. Raw codes never reach the UI text.
 */
const ERROR_TITLES: Record<string, string> = {
  codex_not_authenticated: "Codex isn't authenticated on this machine.",
  codex_unavailable: "The codex CLI isn't available.",
  codex_quota_exceeded: "Codex hit its usage limit.",
  codex_timeout: "The answer took too long.",
  codex_failed: "The AI turn failed.",
  opencode_not_authenticated: "OpenCode isn't connected on this machine.",
  opencode_unavailable: "The opencode CLI isn't available.",
  opencode_quota_exceeded: "OpenCode hit its usage limit.",
  opencode_timeout: "The answer took too long.",
  opencode_failed: "The AI turn failed.",
  claude_not_authenticated: "Claude Code isn't signed in on this machine.",
  claude_unavailable: "The claude CLI isn't available.",
  claude_quota_exceeded: "Claude hit its usage limit.",
  claude_timeout: "The answer took too long.",
  claude_failed: "The AI turn failed.",
  aborted: "The turn was cancelled.",
  chat_failed: "Something went wrong.",
  network: "scope's server isn't reachable.",
  no_transcripts: "No cached sources in this selection.",
  no_ready_sources: "No ready sources in this selection.",
  scope_too_large: "The selection is too large.",
  thread_not_found: "That conversation doesn't exist.",
  materialize_failed: "The sources couldn't be prepared.",
};

export function errorTitle(code: string): string {
  return ERROR_TITLES[code] ?? "The chat turn failed.";
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (block: string): void => {
    // Heartbeat comments (`: ping`) and event names carry nothing the engine
    // needs; every data payload is a typed event.
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (data.length === 0) {
      return;
    }
    try {
      onEvent(JSON.parse(data) as ChatStreamEvent);
    } catch {
      console.error("[ai/chat-engine] malformed SSE payload:", data);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  }
  const tail = buffer + decoder.decode();
  if (tail.trim().length > 0) {
    dispatch(tail.trimEnd());
  }
}

async function describeHttpFailure(response: Response): Promise<TurnError> {
  const fallback: TurnError = {
    code: `http_${response.status}`,
    message: `The chat request failed (${response.status}).`,
  };
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (!body.error) {
      return fallback;
    }
    return {
      code: body.error.code ?? fallback.code,
      message: body.error.message ?? fallback.message,
    };
  } catch {
    return fallback;
  }
}

export function ThinkingDots() {
  return (
    <span aria-hidden="true" className="flex items-center gap-1">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1.5 animate-pulse rounded-full bg-muted-foreground/70 motion-reduce:animate-none"
          style={{ animationDelay: `${index * 180}ms` }}
        />
      ))}
    </span>
  );
}

export function MessageBubble({
  message,
  sources,
  onRetry,
}: {
  message: MessageDraft;
  sources: ReadonlyMap<string, ChatSource> | undefined;
  onRetry: () => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-secondary px-3.5 py-2 text-sm text-secondary-foreground [overflow-wrap:anywhere]">
          {message.content}
        </p>
      </div>
    );
  }
  const caret = message.streaming ? (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse rounded-full bg-muted-foreground motion-reduce:animate-none"
    />
  ) : null;
  return (
    <div>
      <Markdown text={message.content} sources={sources} trailing={caret} />
      {message.interrupted ? (
        <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>Stopped here — this answer may be incomplete.</span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Ask again
          </button>
        </p>
      ) : null}
    </div>
  );
}

export interface ChatEngineOptions {
  /**
   * Video ids fresh conversations are grounded in; read at send time, so
   * hosts may change it between renders (e.g. when a thread is opened).
   */
  scope: readonly string[];
  /**
   * Mixed source selection (videos + tweets). When non-empty it takes
   * precedence over `scope` for new conversations and reports.
   */
  scopeSources?: readonly SourceRef[];
  /**
   * The host's conversation scroller: the engine follows its bottom while
   * the user stays there and jumps back on demand. Owned by the host (refs
   * are attached to DOM in the host's JSX, never returned from this hook).
   */
  scrollerRef: RefObject<HTMLDivElement | null>;
  /** Toast sink for background failures (opening a thread, report errors). */
  showToast?: (message: string, tone: ToastTone) => void;
  /** Called when a turn creates a new thread (e.g. to sync the URL). */
  onThreadCreated?: (threadId: number) => void;
  /** Called when a turn completes (e.g. to refresh the thread history). */
  onTurnComplete?: () => void;
}

export interface ChatEngine {
  messages: MessageDraft[];
  selectedSources: readonly SourceRef[];
  threadId: number | null;
  draft: string;
  setDraft: (draft: string) => void;
  turnPhase: TurnPhase;
  turnError: TurnError | null;
  /** Scope-level disclosures from the server (e.g. byte-budget truncation). */
  notices: string[];
  /** Selected intelligence mode; sent with every turn. */
  mode: ChatModeId;
  selectMode: (mode: ChatModeId) => void;
  /** The mode the in-flight turn was dispatched with (status text truthfulness). */
  turnMode: ChatModeId;
  generating: boolean;
  canSend: boolean;
  send: (raw: string) => void;
  /** Re-sends the last user message after a failed or stopped turn. */
  retryLast: () => void;
  stop: () => void;
  /** Loads a stored thread and continues it; resolves false when it fails. */
  openThread: (id: number) => Promise<boolean>;
  /** Drops the conversation back to a fresh, unsent one. */
  startNewChat: () => void;
  /** While a thread is being opened (hosts show a pending state). */
  loadingThreadId: number | null;
  /** While a report job is being queued. */
  reportPending: boolean;
  /** Queues an HTML report; resolves true when the job was accepted. */
  generateReport: (profile: ReportProfileId, style: ReportStyleId) => Promise<boolean>;
  atBottom: boolean;
  handleScroll: () => void;
  jumpToLatest: () => void;
  /** Submits the composer form; hosts wire it to <form onSubmit>. */
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Enter-to-send handling for the composer textarea. */
  handleComposerKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** True while the conversation area should show its empty state. */
  showEmptyConversation: boolean;
}

export function useChatTurnEngine(options: ChatEngineOptions): ChatEngine {
  const { scope, scopeSources, scrollerRef } = options;
  const [messages, setMessages] = useState<MessageDraft[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [threadSources, setThreadSources] = useState<SourceRef[]>([]);
  const [draft, setDraft] = useState("");
  const [turnPhase, setTurnPhase] = useState<TurnPhase>("idle");
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const [turnMode, setTurnMode] = useState<ChatModeId>(DEFAULT_CHAT_MODE);
  const [notices, setNotices] = useState<string[]>([]);
  const [loadingThreadId, setLoadingThreadId] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [reportPending, setReportPending] = useState(false);

  const [mode, selectMode] = useChatMode();

  const showToast = options.showToast;
  const onThreadCreated = options.onThreadCreated;
  const onTurnComplete = options.onTurnComplete;

  const abortRef = useRef<AbortController | null>(null);
  const idCounterRef = useRef(0);
  /** Assistant blocks with unrevealed text, in arrival order. */
  const segmentsRef = useRef<ActiveSegment[]>([]);
  const turnCompleteRef = useRef(true);
  const stoppedByUserRef = useRef(false);
  const optimisticIdRef = useRef<string | null>(null);
  const sentMessageRef = useRef("");
  const atBottomRef = useRef(true);
  const revealTimerRef = useRef<number | null>(null);

  // Latest-value mirrors so stable callbacks never read stale state.
  const draftRef = useRef(draft);
  const scopeRef = useRef(scope);
  const scopeSourcesRef = useRef<readonly SourceRef[]>(scopeSources ?? []);
  const showToastRef = useRef(showToast);
  const onThreadCreatedRef = useRef(onThreadCreated);
  const onTurnCompleteRef = useRef(onTurnComplete);
  useEffect(() => {
    draftRef.current = draft;
    scopeRef.current = scope;
    scopeSourcesRef.current = scopeSources ?? [];
    showToastRef.current = showToast;
    onThreadCreatedRef.current = onThreadCreated;
    onTurnCompleteRef.current = onTurnComplete;
  });

  const generating = turnPhase !== "idle";
  const canSend = threadId !== null || scope.length > 0 || (scopeSources?.length ?? 0) > 0;
  const selectedSources =
    threadId !== null && threadSources.length > 0
      ? threadSources
      : scopeSources?.length
        ? scopeSources
        : scope.map((id) => ({ kind: "video" as const, id }));

  const nextId = useCallback((prefix: string): string => {
    idCounterRef.current += 1;
    return `${prefix}-${idCounterRef.current}`;
  }, []);

  const stopReveal = useCallback((): void => {
    if (revealTimerRef.current !== null) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  /** Drives the chase buffer: revealed text catches up with target text. */
  const ensureReveal = useCallback((): void => {
    if (revealTimerRef.current !== null) {
      return;
    }
    revealTimerRef.current = window.setInterval(() => {
      // Reveal the earliest unsettled block; later blocks wait their turn so
      // a multi-message answer types out in order.
      const pending = segmentsRef.current.find((segment) => segment.revealed < segment.text.length);
      if (pending) {
        const remaining = pending.text.length - pending.revealed;
        // Never overshoot: a completed message can replace the streamed text
        // with a slightly shorter authoritative version, and revealed must
        // stay a prefix boundary of whatever text is current.
        pending.revealed = Math.min(
          pending.text.length,
          pending.revealed + Math.max(6, Math.ceil(remaining / 10)),
        );
        const slice = pending.text.slice(0, pending.revealed);
        setMessages((prev) =>
          prev.map((message) =>
            message.id === pending.id ? { ...message, content: slice } : message,
          ),
        );
        return;
      }
      if (turnCompleteRef.current) {
        // The turn is over and everything has been shown: settle the blocks
        // (dropping any that never received text). Content is re-synced to
        // the authoritative text so a message replacement that raced the
        // chase buffer can never leave a partial answer on screen.
        const settled = segmentsRef.current;
        segmentsRef.current = [];
        setMessages((prev) =>
          prev
            .filter(
              (message) =>
                !(
                  settled.some((segment) => segment.id === message.id) &&
                  message.content.length === 0
                ),
            )
            .map((message) => {
              const segment = settled.find((entry) => entry.id === message.id);
              return segment ? { ...message, content: segment.text, streaming: false } : message;
            }),
        );
        stopReveal();
      }
    }, 30);
  }, [stopReveal]);

  /** Opens (or returns) the assistant block that currently receives text. */
  const openSegment = useCallback((): ActiveSegment => {
    const existing = segmentsRef.current.at(-1);
    if (existing && !existing.confirmed) {
      return existing;
    }
    const id = nextId("a");
    const segment: ActiveSegment = { id, text: "", revealed: 0, confirmed: false };
    segmentsRef.current = [...segmentsRef.current, segment];
    setMessages((prev) => [...prev, { id, role: "assistant", content: "", streaming: true }]);
    return segment;
  }, [nextId]);

  const removeOptimisticUser = useCallback((): void => {
    const optimisticId = optimisticIdRef.current;
    if (!optimisticId) {
      return;
    }
    optimisticIdRef.current = null;
    setMessages((prev) => prev.filter((message) => message.id !== optimisticId));
  }, []);

  // Turn failures surface once, inline above the composer — persistent and
  // next to where the user types, unlike the auto-dismissing toast.
  const failTurn = useCallback((code: string, message: string): void => {
    setTurnError({ code, message });
    // Hand the failed message back for editing — but never clobber a draft
    // the user typed while the turn was running.
    if (draftRef.current.length === 0) {
      setDraft(sentMessageRef.current);
    }
  }, []);

  /**
   * Marks the newest assistant block as cut short — the visual contract for
   * a turn that stopped or died mid-answer: the partial text stays, clearly
   * flagged, with an "Ask again" way to retry right where it stopped.
   */
  const markInterrupted = useCallback((): void => {
    setMessages((prev) => {
      const index = prev.findLastIndex((message) => message.role === "assistant");
      const target = index === -1 ? undefined : prev[index];
      if (!target || target.interrupted) {
        return prev;
      }
      // A failure can beat the chase buffer: text the segment holds but has
      // not revealed yet still counts as a partial answer on screen.
      const hasText =
        target.content.length > 0 ||
        segmentsRef.current.some((segment) => segment.id === target.id && segment.text.length > 0);
      if (!hasText) {
        return prev;
      }
      const next = [...prev];
      next[index] = { ...target, interrupted: true };
      return next;
    });
  }, []);

  const handleStreamEvent = useCallback(
    (event: ChatStreamEvent): void => {
      switch (event.type) {
        case "thread": {
          setThreadId(event.threadId);
          if (event.created) {
            onThreadCreatedRef.current?.(event.threadId);
          }
          break;
        }
        case "user_message": {
          // Reconcile the optimistic message with its persisted identity.
          const optimisticId = optimisticIdRef.current;
          if (optimisticId) {
            optimisticIdRef.current = null;
            setMessages((prev) =>
              prev.map((message) =>
                message.id === optimisticId ? { ...message, id: `m-${event.id}` } : message,
              ),
            );
          }
          break;
        }
        case "status": {
          if (event.phase === "writing") {
            setTurnPhase("writing");
          }
          break;
        }
        case "notice": {
          setNotices((prev) => (prev.includes(event.message) ? prev : [...prev, event.message]));
          break;
        }
        case "delta": {
          setTurnPhase("writing");
          const segment = openSegment();
          segment.text += event.text;
          // A retry can arrive while a previous chase timer is winding down;
          // make sure text that just arrived always has a reveal running.
          ensureReveal();
          break;
        }
        case "message": {
          // One completed agent message: the authoritative text of the open
          // block; the next delta/message event starts a new block.
          setTurnPhase("writing");
          const segment = openSegment();
          segment.text = event.text;
          segment.confirmed = true;
          // The replacement can be shorter than the streamed text, so the
          // chase buffer must be running to re-sync and settle the block.
          ensureReveal();
          break;
        }
        case "message_superseded": {
          // The newest block was codex's interim plan message, not the
          // answer: remove it so the answer that follows streams in its
          // place and the model's plan never shows as assistant prose.
          const segment = segmentsRef.current.at(-1);
          if (segment) {
            segmentsRef.current = segmentsRef.current.slice(0, -1);
            setMessages((prev) => prev.filter((message) => message.id !== segment.id));
          }
          break;
        }
        case "done": {
          turnCompleteRef.current = true;
          optimisticIdRef.current = null;
          setTurnPhase("idle");
          onTurnCompleteRef.current?.();
          break;
        }
        case "error": {
          turnCompleteRef.current = true;
          optimisticIdRef.current = null;
          setTurnPhase("idle");
          if (event.code === "aborted" && stoppedByUserRef.current) {
            // The user pressed Stop; the partial text stays, clearly marked.
            markInterrupted();
            return;
          }
          markInterrupted();
          failTurn(event.code, event.message);
          break;
        }
      }
    },
    [ensureReveal, failTurn, markInterrupted, openSegment],
  );

  const runTurn = useCallback(
    async (
      payload:
        | { videoIds: string[]; message: string; mode: ChatModeId }
        | { sources: SourceRef[]; message: string; mode: ChatModeId }
        | { threadId: number; message: string; mode: ChatModeId },
    ): Promise<void> => {
      if (!("threadId" in payload))
        setThreadSources(
          "sources" in payload
            ? payload.sources
            : payload.videoIds.map((id) => ({ kind: "video" as const, id })),
        );
      const controller = new AbortController();
      abortRef.current = controller;
      stoppedByUserRef.current = false;
      turnCompleteRef.current = false;
      setTurnMode(payload.mode);
      setTurnPhase("working");
      ensureReveal();
      try {
        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const failure = await describeHttpFailure(response);
          removeOptimisticUser();
          turnCompleteRef.current = true;
          setTurnPhase("idle");
          if (failure.code === "thread_not_found") {
            setThreadId(null);
          }
          failTurn(failure.code, failure.message);
          return;
        }
        await consumeSse(response.body, handleStreamEvent);
        if (!turnCompleteRef.current) {
          // The stream ended without a terminal event; never leave the
          // composer locked, and mark any partial answer.
          turnCompleteRef.current = true;
          setTurnPhase("idle");
          markInterrupted();
          failTurn("chat_failed", "The chat turn failed unexpectedly.");
        }
      } catch (error) {
        turnCompleteRef.current = true;
        setTurnPhase("idle");
        if (controller.signal.aborted) {
          // Stop pressed (or the host unmounted): keep what arrived, marked
          // as incomplete when any partial answer made it to the screen.
          optimisticIdRef.current = null;
          markInterrupted();
          return;
        }
        removeOptimisticUser();
        console.error("[ai/chat-engine] chat request failed:", error);
        failTurn("network", "scope could not reach the chat service. Is the server running?");
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [ensureReveal, failTurn, handleStreamEvent, markInterrupted, removeOptimisticUser],
  );

  /** Posts one user message as the next turn of this conversation. */
  const dispatchMessage = useCallback(
    (message: string): void => {
      sentMessageRef.current = message;
      optimisticIdRef.current = nextId("u");
      const optimisticId = optimisticIdRef.current;
      setMessages((prev) => [...prev, { id: optimisticId, role: "user", content: message }]);
      const sources = scopeSourcesRef.current;
      void runTurn(
        threadId === null
          ? sources.length > 0
            ? { sources: [...sources], message, mode }
            : { videoIds: [...scopeRef.current], message, mode }
          : { threadId, message, mode },
      );
    },
    [mode, nextId, runTurn, threadId],
  );

  const send = useCallback(
    (raw: string): void => {
      const message = raw.trim();
      if (!canSend || message.length === 0 || turnPhase !== "idle" || abortRef.current) {
        return;
      }
      setTurnError(null);
      setDraft("");
      dispatchMessage(message);
    },
    [canSend, dispatchMessage, turnPhase],
  );

  /**
   * Re-sends the last user message (the "Try again" affordance for a failed
   * or stopped turn). Unlike send it never touches the draft, so text typed
   * while the turn was running survives the retry.
   */
  const retryLast = useCallback((): void => {
    if (!canSend || turnPhase !== "idle" || sentMessageRef.current.length === 0) {
      return;
    }
    setTurnError(null);
    dispatchMessage(sentMessageRef.current);
  }, [canSend, dispatchMessage, turnPhase]);

  const stop = useCallback((): void => {
    stoppedByUserRef.current = true;
    abortRef.current?.abort();
  }, []);

  const openThread = useCallback(
    async (id: number): Promise<boolean> => {
      if (loadingThreadId !== null || abortRef.current) {
        return false;
      }
      setLoadingThreadId(id);
      try {
        const response = await fetch(`/api/ai/chat/threads/${id}`);
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const body = (await response.json()) as {
          thread?: {
            id: number;
            mode?: string;
            videoIds?: string[];
            selectedSources?: SourceRef[];
          };
          messages?: Array<{ id: number; role: string; content: string }>;
        };
        if (!body.thread) {
          throw new Error("thread missing from response");
        }
        const drafts: MessageDraft[] = (body.messages ?? [])
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            id: `m-${message.id}`,
            role: message.role as "user" | "assistant",
            content: message.content,
          }));
        segmentsRef.current = [];
        turnCompleteRef.current = true;
        setThreadId(id);
        setThreadSources(
          body.thread.selectedSources ??
            (body.thread.videoIds ?? []).map((id) => ({ kind: "video" as const, id })),
        );
        setMessages(drafts);
        // The switcher follows the reopened thread's stored mode (threads
        // from before the mode system ran deep).
        if (isChatModeId(body.thread.mode)) {
          selectMode(body.thread.mode);
        } else {
          selectMode(DEFAULT_CHAT_MODE);
        }
        setTurnError(null);
        setNotices([]);
        atBottomRef.current = true;
        setAtBottom(true);
        return true;
      } catch {
        showToastRef.current?.("scope could not open that conversation.", "error");
        return false;
      } finally {
        setLoadingThreadId(null);
      }
    },
    [loadingThreadId, selectMode],
  );

  const startNewChat = useCallback((): void => {
    if (turnPhase !== "idle") {
      return;
    }
    segmentsRef.current = [];
    setThreadId(null);
    setMessages([]);
    setTurnError(null);
    setNotices([]);
  }, [turnPhase]);

  /**
   * Queues an HTML report over the current scope: an open thread passes its
   * threadId so the server uses exactly that thread's scope, a fresh
   * conversation passes the scope's video ids directly. The job runs in the
   * background; the Reports page tracks its status. Resolves true only when
   * the job was accepted, so hosts can close their options dialog then.
   */
  const generateReport = useCallback(
    async (profile: ReportProfileId, style: ReportStyleId): Promise<boolean> => {
      if (!canSend || reportPending) {
        return false;
      }
      setReportPending(true);
      try {
        const sources = scopeSourcesRef.current;
        const payload =
          threadId !== null
            ? { threadId, profile, style }
            : sources.length > 0
              ? { sources: [...sources], profile, style }
              : { videoIds: [...scopeRef.current], profile, style };
        const response = await fetch("/api/ai/reports", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          let message = `The report request failed (${response.status}).`;
          try {
            const body = (await response.json()) as { error?: { message?: string } };
            if (body.error?.message) {
              message = body.error.message;
            }
          } catch {
            // Keep the status-code fallback.
          }
          showToastRef.current?.(message, "error");
          return false;
        }
        await trackAcceptedReport(response);
        showToastRef.current?.("Report queued — track it on the Reports page.", "success");
        return true;
      } catch {
        showToastRef.current?.(
          "scope could not reach the report service. Is the server running?",
          "error",
        );
        return false;
      } finally {
        setReportPending(false);
      }
    },
    [canSend, threadId, reportPending],
  );

  // Follow the stream while the user is at the bottom; scrolling up stops
  // the chase until they return (or press Jump to latest).
  useEffect(() => {
    if (!atBottomRef.current) {
      return;
    }
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [messages, turnPhase, scrollerRef]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      stopReveal();
    };
  }, [stopReveal]);

  const handleScroll = useCallback((): void => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    const bottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  }, [scrollerRef]);

  const jumpToLatest = useCallback((): void => {
    atBottomRef.current = true;
    setAtBottom(true);
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [scrollerRef]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      send(draft);
    },
    [draft, send],
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        send(draft);
      }
    },
    [draft, send],
  );

  const showEmptyConversation =
    messages.length === 0 && turnPhase === "idle" && turnError === null && notices.length === 0;

  return {
    messages,
    selectedSources,
    threadId,
    draft,
    setDraft,
    turnPhase,
    turnError,
    notices,
    mode,
    selectMode,
    turnMode,
    generating,
    canSend,
    send,
    retryLast,
    stop,
    openThread,
    startNewChat,
    loadingThreadId,
    reportPending,
    generateReport,
    atBottom,
    handleScroll,
    jumpToLatest,
    handleSubmit,
    handleComposerKeyDown,
    showEmptyConversation,
  };
}

/**
 * Citations lookup for the answer renderer; identity-stable per sources
 * array. A host that has no display metadata simply passes undefined.
 */
export function useChatSourceIndex(
  sources: readonly ChatSource[] | undefined,
): ReadonlyMap<string, ChatSource> | undefined {
  return useMemo(() => (sources ? indexChatSources(sources) : undefined), [sources]);
}
