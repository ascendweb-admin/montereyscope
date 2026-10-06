"use client";

import { useBackgroundChat } from "@/components/ai/background-chat";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  FileText,
  History,
  Info,
  Maximize2,
  MessageSquareText,
  Sparkles,
  Square,
  SquarePen,
  X,
} from "lucide-react";

import {
  MessageBubble,
  ThinkingDots,
  errorTitle,
  useChatSourceIndex,
} from "@/components/ai/chat-engine";
import {
  CHAT_MODE_OPTIONS,
  DEFAULT_CHAT_MODE,
  chatModeOption,
  type ChatModeId,
} from "@/components/ai/chat-modes";
import type { ChatSource } from "@/components/ai/citation";
import { ReportOptionsDialog } from "@/components/ai/report-options-dialog";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { PendingIndicator } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";
import { sourceKey, type SourceRef } from "@/lib/content/model";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The collapsed "Ask AI" side panel: a non-modal panel for quick
 * conversations, grounded in whatever scope the host passes (one video, a
 * channel selection, a research selection).
 *
 * All turn behavior — streaming, modes, retries, reports — lives in the
 * shared engine (chat-engine.ts) so this panel and the full-screen chat
 * workspace (/chat) stay one experience in two shapes. Threads are filtered
 * to this scope in the history view; the workspace shows every conversation
 * regardless of scope, which is where older chats from other selections live.
 *
 * The header carries the bridge between the two shapes: "Open full view"
 * navigates to /chat carrying the open thread (or the fresh scope when none
 * exists yet). The shell owns the turn, so navigation leaves its stream running.
 *
 * The panel stays mounted while hidden, so closing it mid-turn keeps the
 * stream running in the background. A changed scope starts a fresh
 * conversation (stage 5 selections re-key the panel this way).
 */

interface ThreadSummary {
  id: number;
  title: string;
  videoIds: string[];
  /** Mixed source selection, when the thread has one. */
  selectedSources?: SourceRef[];
  messageCount: number;
  /** Mode the thread currently runs in; absent reads as the default. */
  mode?: ChatModeId;
  createdAt: string;
  lastMessageAt: string | null;
}

export interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  /** Video ids the conversation is grounded in; threads are filtered to it. */
  scope: readonly string[];
  /**
   * Mixed source selection (videos + tweets). When non-empty it takes
   * precedence over `scope`, and history filters on the same source set.
   */
  scopeSources?: readonly SourceRef[];
  /**
   * The scope's sources with display metadata, so the answers' transcript
   * and post citations render as titled source chips instead of file paths.
   */
  sources?: readonly ChatSource[];
  /** One-line scope description shown under the heading. */
  description?: string;
  /** Opens the report options as soon as the panel becomes visible. */
  initialReportDialogOpen?: boolean;
}

/** Threads belong to this scope when they cover exactly the same video set. */
function sameScope(threadVideoIds: readonly string[], scope: readonly string[]): boolean {
  if (threadVideoIds.length !== scope.length) {
    return false;
  }
  const wanted = new Set(scope);
  return threadVideoIds.every((id) => wanted.has(id));
}

/** Mixed-source scope match: identical ref sets, kinds included. */
function sameSourceScope(
  threadSources: readonly SourceRef[] | undefined,
  scopeSources: readonly SourceRef[],
): boolean {
  if (scopeSources.length === 0) {
    return false;
  }
  if (!threadSources || threadSources.length !== scopeSources.length) {
    return false;
  }
  const wanted = new Set(scopeSources.map(sourceKey));
  return threadSources.every((source) => wanted.has(sourceKey(source)));
}

export function ChatPanel({
  open,
  onClose,
  scope,
  scopeSources,
  sources,
  description,
  initialReportDialogOpen = false,
}: ChatPanelProps) {
  const router = useRouter();
  const [historyView, setHistoryView] = useState(false);
  const [history, setHistory] = useState<ThreadSummary[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);

  const { showToast, toastElement } = useToast();

  // Latest-value mirrors so the stable history loader never reads stale state.
  const scopeRef = useRef(scope);
  const scopeSourcesRef = useRef<readonly SourceRef[]>(scopeSources ?? []);
  const showToastRef = useRef(showToast);
  useEffect(() => {
    scopeRef.current = scope;
    scopeSourcesRef.current = scopeSources ?? [];
    showToastRef.current = showToast;
  }, [scope, scopeSources, showToast]);

  const refreshHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true);
    try {
      const response = await fetch("/api/ai/chat/threads");
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const body = (await response.json()) as { threads?: ThreadSummary[] };
      const threads = Array.isArray(body.threads) ? body.threads : [];
      const sources = scopeSourcesRef.current;
      setHistory(
        threads.filter((thread) =>
          sources.length > 0
            ? sameSourceScope(thread.selectedSources, sources)
            : sameScope(thread.videoIds, scopeRef.current),
        ),
      );
    } catch {
      showToastRef.current("scope could not load the conversation history.", "error");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const engine = useBackgroundChat({
    scope,
    scopeSources,
    scrollerRef: scrollRef,
    showToast,
    onTurnComplete: refreshHistory,
  });

  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const sourceIndex = useChatSourceIndex(sources);
  const { generating } = engine;

  /**
   * The bridge to the full-screen chat workspace: an open thread continues
   * there; a fresh scope starts there preselected. The running turn remains attached to the persistent app shell.
   */
  const openFullScreen = (): void => {
    const params = new URLSearchParams();
    if (engine.threadId !== null) {
      params.set("thread", String(engine.threadId));
    } else if (scopeSources && scopeSources.length > 0) {
      params.set("sources", scopeSources.map((source) => `${source.kind}:${source.id}`).join(","));
    } else if (scope.length > 0) {
      params.set("videos", scope.join(","));
    }
    router.push(params.size > 0 ? `/chat?${params.toString()}` : "/chat");
  };

  const toggleHistory = (): void => {
    setHistoryView((view) => !view);
    if (!historyView) {
      void refreshHistory();
    }
  };

  const openThread = async (id: number): Promise<void> => {
    const opened = await engine.openThread(id);
    if (opened) {
      setHistoryView(false);
    }
  };

  const startNewChat = (): void => {
    engine.startNewChat();
    setHistoryView(false);
  };

  // Focus management mirrors AppDialog: capture the opener, focus the panel,
  // and restore focus after closing (the panel itself stays mounted). The
  // history refresh runs deferred so the effect body stays setState-free.
  useEffect(() => {
    if (!open) {
      return;
    }
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const timer = window.setTimeout(() => void refreshHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [open, refreshHistory]);

  useEffect(() => {
    if (open) {
      return;
    }
    const timer = window.setTimeout(() => {
      const opener = openerRef.current;
      if (opener && opener.isConnected && document.activeElement === document.body) {
        opener.focus();
      }
      openerRef.current = null;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Hosts that offer a direct "Generate report" action open the dialog as
  // soon as this panel becomes visible; the flag fires once per opening.
  const reportDialogSeenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      reportDialogSeenRef.current = false;
      return;
    }
    if (initialReportDialogOpen && !reportDialogSeenRef.current) {
      reportDialogSeenRef.current = true;
      setReportDialogOpen(true);
    }
  }, [open, initialReportDialogOpen]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // A changed scope (stage 5 selections) starts a fresh conversation.
  // Adjusting state during render — not in an effect — per React's guidance
  // for reacting to prop changes.
  const scopeKey = JSON.stringify(scopeSources?.length ? scopeSources : scope);
  const [renderedScopeKey, setRenderedScopeKey] = useState(scopeKey);
  if (renderedScopeKey !== scopeKey) {
    setRenderedScopeKey(scopeKey);
    engine.startNewChat();
    setHistory(null);
    setHistoryView(false);
  }

  const showEmptyConversation = !historyView && engine.showEmptyConversation;

  const conversation = (
    <>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={engine.handleScroll}
          role="log"
          aria-label="Conversation"
          className="size-full overflow-y-auto px-4 py-4"
        >
          {showEmptyConversation ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex size-12 items-center justify-center rounded-full border bg-muted/40">
                <MessageSquareText aria-hidden="true" className="size-6 text-muted-foreground" />
              </div>
              <p className="text-base font-semibold tracking-tight">Ask about your sources</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                The configured AI reads the cached transcripts and posts in scope and answers
                grounded in them — summaries, themes, or specific claims.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {engine.notices.map((notice) => (
                <p
                  key={notice}
                  role="status"
                  className="flex items-start gap-1.5 text-xs text-muted-foreground"
                >
                  <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>{notice}</span>
                </p>
              ))}
              {engine.messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  sources={sourceIndex}
                  onRetry={engine.retryLast}
                />
              ))}
              {engine.turnPhase === "working" ? (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <ThinkingDots />
                  {chatModeOption(engine.turnMode).workingLabel}
                </p>
              ) : null}
            </div>
          )}
        </div>
        {generating && !engine.atBottom ? (
          <button
            type="button"
            onClick={engine.jumpToLatest}
            className="absolute inset-x-0 bottom-3 mx-auto flex w-fit items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs shadow-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
          >
            <ArrowDown aria-hidden="true" className="size-3.5" />
            Jump to latest
          </button>
        ) : null}
      </div>

      <div className="border-t px-4 py-3">
        {engine.turnError ? (
          <div className="mb-3">
            <AlertNote
              tone="danger"
              title={errorTitle(engine.turnError.code)}
              politeness={engine.turnError.code === "no_transcripts" ? "polite" : "assertive"}
              action={
                <Button variant="outline" size="sm" onClick={engine.retryLast}>
                  Try again
                </Button>
              }
            >
              {engine.turnError.message}
            </AlertNote>
          </div>
        ) : null}
        <form onSubmit={engine.handleSubmit} className="flex flex-col gap-2">
          <label htmlFor="chat-composer" className="sr-only">
            Your message
          </label>
          <div className="flex items-center justify-between gap-2">
            <div
              role="group"
              aria-label="Chat mode"
              className="flex shrink-0 items-center rounded-md bg-muted/70 p-0.5"
            >
              {CHAT_MODE_OPTIONS.map((option) => {
                const selected = engine.mode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => engine.selectMode(option.id)}
                    aria-pressed={selected}
                    disabled={!engine.canSend}
                    title={option.tagline}
                    className={cn(
                      "rounded-[5px] px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="min-w-0 truncate text-xs text-muted-foreground">
              {chatModeOption(engine.mode).tagline}
            </p>
          </div>
          <div className="rounded-md border border-input bg-background shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background motion-reduce:transition-none">
            <textarea
              id="chat-composer"
              rows={2}
              value={engine.draft}
              disabled={!engine.canSend}
              placeholder="Ask a question…"
              onChange={(event) => engine.setDraft(event.target.value)}
              onKeyDown={engine.handleComposerKeyDown}
              aria-invalid={engine.turnError ? true : undefined}
              className="max-h-40 w-full resize-none bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Enter to send · Shift+Enter for a new line
            </p>
            {generating ? (
              <Button type="button" variant="secondary" size="sm" onClick={engine.stop}>
                <Square aria-hidden="true" />
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!engine.canSend || engine.draft.trim().length === 0}
              >
                <ArrowUp aria-hidden="true" />
                Send
              </Button>
            )}
          </div>
        </form>
      </div>
    </>
  );

  const historyPanel = (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      {engine.loadingThreadId !== null ? <PendingIndicator label="Opening conversation…" /> : null}
      {historyLoading && (history === null || history.length === 0) ? (
        <PendingIndicator label="Loading conversations…" />
      ) : null}
      {!historyLoading && history !== null && history.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="mx-auto max-w-prose text-sm text-muted-foreground">
            No conversations for this selection yet. Questions you ask are kept as threads here, so
            you can reopen one and continue it later — every conversation also lives in the
            full-screen chat under AI Chat in the sidebar.
          </p>
          <div className="mt-4 flex justify-center">
            <Button onClick={() => setHistoryView(false)}>Back to the conversation</Button>
          </div>
        </div>
      ) : null}
      {history !== null && history.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {history.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                onClick={() => void openThread(thread.id)}
                disabled={engine.loadingThreadId !== null}
                aria-current={thread.id === engine.threadId ? "true" : undefined}
                className="w-full rounded-md px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="block truncate text-sm font-medium">{thread.title}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {thread.messageCount} {thread.messageCount === 1 ? "message" : "messages"} ·{" "}
                  {chatModeOption(thread.mode ?? DEFAULT_CHAT_MODE).label} ·{" "}
                  {formatRelativeTime(thread.lastMessageAt ?? thread.createdAt) ?? "recently"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      inert={open ? undefined : true}
      aria-label="Ask AI"
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-card text-card-foreground shadow-lg outline-none",
        "transition-transform duration-300 ease-out motion-reduce:transition-none",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      <div className="flex items-start gap-2.5 border-b px-4 py-3">
        <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-tight tracking-tight">Ask AI</h2>
          {description ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={startNewChat}
            aria-label="Start a new chat"
            title="New chat"
          >
            <SquarePen aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleHistory}
            aria-pressed={historyView}
            aria-label="Conversation history"
            title="History"
          >
            <History aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setReportDialogOpen(true)}
            disabled={!engine.canSend || generating}
            aria-label="Generate report"
            title="Generate report"
          >
            <FileText aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={openFullScreen}
            aria-label="Open full chat view"
            title="Open the full-screen chat"
          >
            <Maximize2 aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close panel"
            title="Close"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>

      {historyView ? historyPanel : conversation}

      <ReportOptionsDialog
        open={reportDialogOpen}
        onClose={() => setReportDialogOpen(false)}
        onGenerate={(profile, style) =>
          void engine.generateReport(profile, style).then((queued) => {
            if (queued) {
              setReportDialogOpen(false);
            }
          })
        }
        busy={engine.reportPending}
      />

      {toastElement}
    </aside>
  );
}
