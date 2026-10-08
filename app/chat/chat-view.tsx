"use client";

import { useBackgroundChat } from "@/components/ai/background-chat";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowUp,
  BookOpenText,
  FileText,
  Info,
  MessageSquareText,
  PanelLeft,
  PanelLeftClose,
  Search,
  Square,
  SquarePen,
  Trash2,
} from "lucide-react";

import {
  MessageBubble,
  ThinkingDots,
  errorTitle,
  preparingLabel,
  useChatSourceIndex,
} from "@/components/ai/chat-engine";
import { prefetchTranscripts } from "@/components/ai/prefetch-transcripts";
import {
  CHAT_MODE_OPTIONS,
  DEFAULT_CHAT_MODE,
  chatModeOption,
  type ChatModeId,
} from "@/components/ai/chat-modes";
import type { ChatSource } from "@/components/ai/citation";
import { sourceKey, type SourceRef } from "@/lib/content/model";
import { ChatSourcePicker, type PickerCreator } from "@/components/ai/chat-source-picker";
import { ReportOptionsDialog } from "@/components/ai/report-options-dialog";
import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PendingIndicator } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";
import { useChatSidebarCollapsed } from "./sidebar-state";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CategorySummary } from "@/lib/categories";

/**
 * The full-screen chat workspace (the "AI Chat" destination): every saved
 * conversation from every source collection in one place — a history sidebar
 * with search and delete beside a large conversation canvas, plus a source
 * picker so a chat can start from anywhere without a pre-made selection.
 *
 * It shares its turn engine with the collapsed "Ask AI" panel, so the two
 * shapes stay one experience: the same streaming, modes, retries, notices,
 * and report flow. Opening a thread resumes its Codex session with its own
 * scope — old conversations continue exactly where they left off, regardless
 * of what is selected elsewhere.
 *
 * The active thread lives in the URL (?thread=) via the native history API,
 * so a refresh or a shared link reopens the same conversation, and the
 * collapsed panel's "Open full view" lands on the right thread.
 */

export interface ChatWorkspaceVideo {
  id: string;
  creatorId: number;
  title: string;
  creatorName: string;
  thumbnailUrl: string | null;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  liveStatus?: "not_live" | "is_live" | "was_live" | "upcoming" | "unknown";
  categoryIds: number[];
}

export interface ChatWorkspaceTweet {
  url?: string;
  publishedAt?: string | null;
  id: string;
  creatorId: number;
  authorHandle: string;
  authorName: string;
  text: string;
  mediaPreviewUrl: string | null;
  categoryIds: number[];
  readyForAnalysis: boolean;
}

export interface ChatWorkspaceThread {
  researchJobId?: string;
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

export interface ChatWorkspaceProps {
  /** Every cached video across the library (citation index + picker). */
  videos: ChatWorkspaceVideo[];
  /** Every cached X post across the library (citation index + picker). */
  tweets?: ChatWorkspaceTweet[];
  /** Creator avatars and platforms for the source picker. */
  creators?: PickerCreator[];
  categories: CategorySummary[];
  /** Thread summaries rendered by the server so the sidebar starts full. */
  initialThreads: ChatWorkspaceThread[];
  /** ?thread= deep link — opened on mount when it resolves. */
  initialThreadId: number | null;
  /** ?videos= preselected scope (e.g. from the collapsed panel's expand). */
  initialVideoIds: string[];
  /** ?sources= mixed-source deep link (kind:id pairs). */
  initialSources?: SourceRef[];
}

const DAY_MS = 86_400_000;

/** ChatGPT-style recency buckets for the history sidebar. */
function activityBucket(iso: string | null, nowMs: number): string {
  if (!iso) {
    return "Older";
  }
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) {
    return "Older";
  }
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (time >= startOfToday) {
    return "Today";
  }
  if (time >= startOfToday - DAY_MS) {
    return "Yesterday";
  }
  if (time >= startOfToday - 7 * DAY_MS) {
    return "Previous 7 days";
  }
  if (time >= startOfToday - 30 * DAY_MS) {
    return "Previous 30 days";
  }
  return "Older";
}

const BUCKET_ORDER = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

/** Groups threads by recency bucket, keeping the list's activity order. */
function groupThreads(
  threads: readonly ChatWorkspaceThread[],
  nowMs: number,
): Array<{ label: string; threads: ChatWorkspaceThread[] }> {
  const groups = new Map<string, ChatWorkspaceThread[]>();
  for (const thread of threads) {
    const bucket = activityBucket(thread.lastMessageAt ?? thread.createdAt, nowMs);
    const group = groups.get(bucket);
    if (group) {
      group.push(thread);
    } else {
      groups.set(bucket, [thread]);
    }
  }
  return BUCKET_ORDER.filter((bucket) => groups.has(bucket)).map((bucket) => ({
    label: bucket,
    threads: groups.get(bucket) as ChatWorkspaceThread[],
  }));
}

function ThreadList({
  threads,
  activeThreadId,
  generatingThreadId,
  /** Wall-clock milliseconds for the recency buckets; 0 before hydration. */
  nowMs,
  search,
  onSearch,
  onOpen,
  onRequestDelete,
  onNewChat,
  newChatDisabled,
  openDisabled,
  className,
}: {
  threads: readonly ChatWorkspaceThread[];
  activeThreadId: number | null;
  /** The thread a turn is streaming in; its delete stays unavailable. */
  generatingThreadId: number | null;
  nowMs: number;
  search: string;
  onSearch: (value: string) => void;
  onOpen: (id: number) => void;
  onRequestDelete: (thread: ChatWorkspaceThread) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  openDisabled: boolean;
  className?: string;
}) {
  const needle = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      needle ? threads.filter((thread) => thread.title.toLowerCase().includes(needle)) : threads,
    [threads, needle],
  );
  // Until hydration supplies the client clock, everything sits in one
  // "Recent" group (exactly what the server rendered), so the buckets never
  // fight the initial HTML.
  const groups = useMemo(
    () =>
      nowMs === 0
        ? filtered.length > 0
          ? [{ label: "Recent", threads: [...filtered] }]
          : []
        : groupThreads(filtered, nowMs),
    [filtered, nowMs],
  );

  return (
    <div className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <div className="flex flex-col gap-3 px-3 pt-3 pb-2">
        <Button
          variant="outline"
          onClick={onNewChat}
          disabled={newChatDisabled}
          className="w-full justify-start"
        >
          <SquarePen aria-hidden="true" />
          New chat
        </Button>
        <div className="relative min-w-0">
          <Search
            aria-hidden="true"
            className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            aria-label="Search conversations"
            placeholder="Search chats…"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            className="h-8 w-full min-w-0 rounded-md border border-input bg-background pr-3 pl-8 text-xs shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          />
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pb-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        {threads.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            No conversations yet. Pick some sources and ask something — every chat is kept here.
          </p>
        ) : null}
        {threads.length > 0 && filtered.length === 0 ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            No conversations match the search.
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <p className="px-2 pb-1 text-[0.6875rem] font-semibold tracking-wide text-muted-foreground/80 uppercase">
                {group.label}
              </p>
              <ul className="flex flex-col gap-0.5">
                {group.threads.map((thread) => (
                  <li key={thread.id} className="group relative">
                    <button
                      type="button"
                      onClick={() => onOpen(thread.id)}
                      disabled={openDisabled}
                      aria-current={thread.id === activeThreadId ? "true" : undefined}
                      // One compact line, ChatGPT-style; the details ride in
                      // the tooltip instead of a second row.
                      title={`${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"} · ${formatRelativeTime(thread.lastMessageAt ?? thread.createdAt) ?? "recently"}`}
                      className="w-full min-w-0 truncate rounded-md py-2 pr-8 pl-2.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 aria-current:bg-accent hover:bg-accent"
                    >
                      {thread.title}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRequestDelete(thread)}
                      disabled={thread.id === generatingThreadId}
                      aria-label={`Delete ${thread.title}`}
                      title={
                        thread.id === generatingThreadId
                          ? "Wait for the current answer to finish"
                          : "Delete conversation"
                      }
                      className="absolute top-1/2 right-1 -translate-y-1/2 rounded-sm p-1.5 text-muted-foreground opacity-0 outline-none transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-0"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatWorkspace({
  videos,
  tweets = [],
  creators = [],
  categories,
  initialThreads,
  initialThreadId,
  initialVideoIds,
  initialSources,
}: ChatWorkspaceProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [threads, setThreads] = useState<ChatWorkspaceThread[]>(initialThreads);
  const [scopeSources, setScopeSources] = useState<SourceRef[]>(initialSources ?? []);
  const [scope, setScope] = useState<string[]>(() =>
    initialSources && initialSources.length > 0
      ? initialSources.filter((source) => source.kind === "video").map((source) => source.id)
      : initialVideoIds,
  );
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useChatSidebarCollapsed();
  const [threadSearch, setThreadSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ChatWorkspaceThread | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  /**
   * Client wall clock for the sidebar's recency buckets. 0 until hydration
   * (the server renders one stable "Recent" group), so the labels never
   * fight the initial HTML over timezone differences.
   */
  const [nowMs, setNowMs] = useState(0);

  const { showToast, toastElement } = useToast();

  useEffect(() => {
    const timer = window.setTimeout(() => setNowMs(Date.now()), 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Latest-value mirrors so stable callbacks never read stale state.
  const showToastRef = useRef(showToast);
  const threadsRef = useRef(threads);
  const pathnameRef = useRef(pathname);
  const deleteTargetRef = useRef<ChatWorkspaceThread | null>(deleteTarget);
  const activeThreadIdRef = useRef<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const refreshThreads = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/api/ai/chat/threads");
      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }
      const body = (await response.json()) as { threads?: ChatWorkspaceThread[] };
      if (Array.isArray(body.threads)) {
        setThreads(body.threads);
      }
    } catch {
      showToastRef.current("scope could not load the conversation history.", "error");
    }
  }, []);

  /** Keeps ?thread= (or the pending ?videos= scope) in the address bar. */
  const syncUrl = useCallback((query: string): void => {
    window.history.replaceState(
      null,
      "",
      query ? `${pathnameRef.current}?${query}` : pathnameRef.current,
    );
  }, []);

  const engine = useBackgroundChat({
    viewKey: "workspace",
    scope,
    scopeSources: scopeSources.length > 0 ? scopeSources : undefined,
    scrollerRef: scrollRef,
    showToast,
    onThreadCreated: (threadId) => syncUrl(`thread=${threadId}`),
    onTurnComplete: () => void refreshThreads(),
  });

  // Latest-value mirrors so stable callbacks never read stale state.
  useEffect(() => {
    showToastRef.current = showToast;
    threadsRef.current = threads;
    pathnameRef.current = pathname;
    deleteTargetRef.current = deleteTarget;
    activeThreadIdRef.current = engine.threadId;
  });

  const sourceIndex = useChatSourceIndex(
    useMemo<ChatSource[]>(
      () => [
        ...videos.map((video) => ({
          id: video.id,
          title: video.title,
          creator: video.creatorName,
          thumbnailUrl: video.thumbnailUrl,
        })),
        ...tweets.map((tweet) => ({
          id: tweet.id,
          kind: "tweet" as const,
          title: tweet.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
          creator: tweet.authorName,
          url: tweet.url,
          publishedAt: tweet.publishedAt,
          thumbnailUrl: tweet.mediaPreviewUrl,
        })),
      ],
      [videos, tweets],
    ),
  );

  const startNewChat = useCallback((): void => {
    engine.startNewChat();
    setScope([]);
    setScopeSources([]);
    setThreadSearch("");
    syncUrl("");
    setSidebarOpen(false);
    // engine.generating/engine.startNewChat are stable enough for this
    // handler; the sidebar buttons are disabled while a turn runs anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine.generating, engine.startNewChat, syncUrl]);

  const openThread = useCallback(
    async (id: number): Promise<void> => {
      const saved = threadsRef.current.find((entry) => entry.id === id);
      if (saved?.researchJobId) {
        router.push("/x-dashboard");
        return;
      }
      const opened = await engine.openThread(id);
      if (!opened) {
        return;
      }
      const thread = threadsRef.current.find((entry) => entry.id === id);
      const refs = thread?.selectedSources ?? [];
      if (refs.some((source) => source.kind === "tweet")) {
        setScopeSources(refs);
        setScope(refs.filter((source) => source.kind === "video").map((source) => source.id));
      } else {
        setScope(thread ? thread.videoIds : []);
        setScopeSources([]);
      }
      syncUrl(`thread=${id}`);
      setSidebarOpen(false);
    },
    // engine.openThread identity tracks its loading state; recreating this
    // wrapper on that change is harmless (handlers read it fresh).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine.openThread, syncUrl],
  );

  // ?thread= deep link: open it once on mount; a bad reference degrades to a
  // fresh chat (the engine already toasts the failure).
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;
    if (initialThreadId !== null) {
      void openThread(initialThreadId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the mobile history drawer.
  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  const videosById = useMemo(() => new Map(videos.map((video) => [video.id, video])), [videos]);
  const tweetsById = useMemo(() => new Map(tweets.map((tweet) => [tweet.id, tweet])), [tweets]);

  /**
   * The committed selection as typed references. Legacy video-only state
   * (`scope`) normalizes on read, mirroring the server's route boundary.
   */
  const effectiveSources = useMemo<SourceRef[]>(
    () =>
      engine.threadId !== null || engine.generating
        ? [...engine.selectedSources]
        : scopeSources.length > 0
          ? scopeSources
          : scope.map((id) => ({ kind: "video" as const, id })),
    [scopeSources, scope, engine.threadId, engine.generating, engine.selectedSources],
  );

  /** The scope's display facts: labels, creator count, ready-source count. */
  const scopeDetails = useMemo(() => {
    const knownVideos = effectiveSources
      .filter((source) => source.kind === "video")
      .map((source) => videosById.get(source.id))
      .filter((video): video is ChatWorkspaceVideo => video !== undefined);
    const knownTweets = effectiveSources
      .filter((source) => source.kind === "tweet")
      .map((source) => tweetsById.get(source.id))
      .filter((tweet): tweet is ChatWorkspaceTweet => tweet !== undefined);
    const creators = new Set([
      ...knownVideos.map((video) => video.creatorName),
      ...knownTweets.map((tweet) => tweet.authorName),
    ]);
    return {
      known: knownVideos,
      knownItems: [
        ...knownVideos.map((video) => ({ key: `video:${video.id}`, label: video.title })),
        ...knownTweets.map((tweet) => ({
          key: `tweet:${tweet.id}`,
          label: tweet.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
        })),
      ],
      // Every video can ground a chat (its captions are read on the first
      // turn); posts need their complete text.
      sourceCount:
        knownVideos.length + knownTweets.filter((tweet) => tweet.readyForAnalysis).length,
      creatorCount: creators.size,
    };
  }, [effectiveSources, videosById, tweetsById]);

  const activeThread =
    engine.threadId === null
      ? null
      : (threads.find((thread) => thread.id === engine.threadId) ?? null);

  const deleteConversation = useCallback(async (): Promise<void> => {
    const target = deleteTargetRef.current;
    if (!target || deleting) {
      return;
    }
    setDeleting(true);
    try {
      const response = await fetch(`/api/ai/chat/threads/${target.id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        let message = "scope could not delete that conversation.";
        try {
          const body = (await response.json()) as { error?: { message?: string } };
          if (body.error?.message) {
            message = body.error.message;
          }
        } catch {
          // Keep the fallback.
        }
        showToastRef.current(message, "error");
        return;
      }
      engine.forgetThread(target.id);
      setThreads((prev) => prev.filter((thread) => thread.id !== target.id));
      if (activeThreadIdRef.current === target.id) {
        startNewChat();
      }
      showToastRef.current("Conversation deleted.", "success");
      setDeleteTarget(null);
    } catch {
      showToastRef.current(
        "scope could not reach the chat service. Is the server running?",
        "error",
      );
    } finally {
      setDeleting(false);
    }
  }, [deleting, startNewChat, engine]);

  const { generating } = engine;
  const hasAnalyzableSources = videos.length > 0 || tweets.some((tweet) => tweet.readyForAnalysis);
  const pickerSelection = useMemo(
    () => new Set(effectiveSources.map(sourceKey)),
    [effectiveSources],
  );

  /**
   * Commits a selection, keeping the legacy video-id view in sync. A
   * video-only selection stays on the legacy payload; any tweet switches the
   * scope to typed references so both kinds travel together.
   */
  const applySources = useCallback((refs: SourceRef[]): void => {
    const hasTweet = refs.some((source) => source.kind === "tweet");
    const videoIds = refs.filter((source) => source.kind === "video").map((source) => source.id);
    setScopeSources(hasTweet ? refs : []);
    setScope(videoIds);
    // Start reading the picked videos while the user types their question.
    prefetchTranscripts(videoIds);
  }, []);

  const heading = activeThread?.title ?? (engine.threadId !== null ? "Conversation" : "New chat");
  const subheading =
    engine.threadId !== null
      ? `${scopeDetails.sourceCount} ${scopeDetails.sourceCount === 1 ? "source" : "sources"} · ${scopeDetails.creatorCount} ${scopeDetails.creatorCount === 1 ? "creator" : "creators"}`
      : scopeDetails.sourceCount > 0
        ? `${scopeDetails.sourceCount} ${scopeDetails.sourceCount === 1 ? "source" : "sources"} selected · ready to chat`
        : "Pick sources to ground the answers";

  const sidebarList = (
    <ThreadList
      className="flex-1"
      threads={threads}
      activeThreadId={engine.threadId}
      nowMs={nowMs}
      generatingThreadId={generating && engine.threadId !== null ? engine.threadId : null}
      search={threadSearch}
      onSearch={setThreadSearch}
      onOpen={(id) => void openThread(id)}
      onRequestDelete={setDeleteTarget}
      onNewChat={startNewChat}
      newChatDisabled={false}
      openDisabled={engine.loadingThreadId !== null || deleting}
    />
  );

  const conversation = (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={engine.handleScroll}
        role="log"
        aria-label="Conversation"
        className="size-full overflow-y-auto"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-6 sm:px-6">
          {engine.loadingThreadId !== null ? (
            <PendingIndicator label="Opening conversation…" className="mb-4" />
          ) : null}
          {engine.showEmptyConversation && engine.loadingThreadId === null ? (
            scopeDetails.sourceCount > 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
                <div className="flex max-w-md flex-col items-center gap-2.5 rounded-xl border bg-card px-5 py-4 shadow-sm">
                  <p className="text-sm font-semibold">
                    Ready to chat about{" "}
                    {scopeDetails.sourceCount === 1
                      ? "1 source"
                      : `${scopeDetails.sourceCount} sources`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    from {scopeDetails.creatorCount}{" "}
                    {scopeDetails.creatorCount === 1 ? "creator" : "creators"} — ask your first
                    question below.
                  </p>
                  <div className="mt-1 flex max-w-full flex-wrap justify-center gap-1.5">
                    {scopeDetails.knownItems.slice(0, 6).map((item) => (
                      <Badge key={item.key} variant="secondary" className="max-w-56">
                        <span className="min-w-0 truncate">{item.label}</span>
                      </Badge>
                    ))}
                    {scopeDetails.knownItems.length > 6 ? (
                      <Badge variant="outline" className="text-muted-foreground">
                        +{scopeDetails.knownItems.length - 6} more
                      </Badge>
                    ) : null}
                  </div>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => setSourcesOpen(true)}
                  >
                    Change sources
                  </Button>
                </div>
              </div>
            ) : hasAnalyzableSources ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
                <div className="flex size-14 items-center justify-center rounded-full border bg-muted/40">
                  <MessageSquareText aria-hidden="true" className="size-7 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold tracking-tight">
                  What would you like to research?
                </h3>
                <p className="max-w-md text-balance text-sm text-muted-foreground">
                  Every conversation is grounded in the videos and posts you pick — one video or a
                  whole selection, across your whole library. Past chats stay in the history on the
                  left.
                </p>
                <Button onClick={() => setSourcesOpen(true)}>
                  <BookOpenText aria-hidden="true" />
                  Choose sources
                </Button>
              </div>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 py-10 text-center">
                <div className="flex size-14 items-center justify-center rounded-full border bg-muted/40">
                  <MessageSquareText aria-hidden="true" className="size-7 text-muted-foreground" />
                </div>
                <h3 className="text-xl font-semibold tracking-tight">Nothing to chat about yet</h3>
                <p className="max-w-md text-balance text-sm text-muted-foreground">
                  Save a creator and refresh their feed first — then come back and pick their videos
                  or posts as sources.
                </p>
              </div>
            )
          ) : (
            <div className="flex flex-col gap-5">
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
                  {engine.preparing
                    ? preparingLabel(engine.preparing)
                    : chatModeOption(engine.turnMode).workingLabel}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </div>
      {generating && !engine.atBottom ? (
        <button
          type="button"
          onClick={engine.jumpToLatest}
          className="absolute inset-x-0 bottom-4 mx-auto flex w-fit items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 text-xs shadow-md outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none"
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );

  const composer = (
    <div className="border-t px-4 py-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
        {engine.turnError ? (
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
        ) : null}
        <form onSubmit={engine.handleSubmit} className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              {engine.threadId !== null ? (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground"
                  title="A conversation's sources are fixed — start a new chat to pick others"
                >
                  <BookOpenText aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {scopeDetails.sourceCount}{" "}
                    {scopeDetails.sourceCount === 1 ? "source" : "sources"} from this conversation
                  </span>
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSourcesOpen(true)}
                  className={cn("max-w-full", scopeDetails.sourceCount > 0 && "border-ring/40")}
                >
                  <BookOpenText aria-hidden="true" />
                  {scopeDetails.sourceCount > 0
                    ? `${scopeDetails.sourceCount} ${scopeDetails.sourceCount === 1 ? "source" : "sources"}`
                    : "Choose sources"}
                </Button>
              )}
            </div>
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
          </div>
          <label htmlFor="chat-composer" className="sr-only">
            Your message
          </label>
          <div className="rounded-lg border border-input bg-background shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background motion-reduce:transition-none">
            <textarea
              id="chat-composer"
              rows={3}
              value={engine.draft}
              disabled={!engine.canSend}
              placeholder={
                engine.canSend
                  ? "Ask a question…"
                  : "Pick sources first — chats answer from what is said in them"
              }
              onChange={(event) => engine.setDraft(event.target.value)}
              onKeyDown={engine.handleComposerKeyDown}
              aria-invalid={engine.turnError ? true : undefined}
              className="max-h-60 min-h-16 w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground"
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
    </div>
  );

  return (
    // Use the full desktop viewport; mobile sits below the navigation header.
    <div className="relative flex h-[calc(100dvh-6.5rem)] min-h-0 overflow-hidden md:h-dvh">
      {sidebarCollapsed ? null : (
        <div className="hidden w-72 shrink-0 overflow-hidden border-r bg-card md:flex">
          {sidebarList}
        </div>
      )}

      {sidebarOpen ? (
        <>
          <button
            type="button"
            aria-label="Close conversation list"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 z-20 bg-black/40 md:hidden"
          />
          <div className="absolute inset-y-0 left-0 z-30 flex w-72 max-w-[85vw] overflow-hidden border-r bg-card shadow-xl md:hidden">
            {sidebarList}
          </div>
        </>
      ) : null}

      <section className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex items-center gap-1.5 border-b px-4 py-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open conversation list"
            aria-expanded={sidebarOpen}
          >
            <PanelLeft aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            aria-label={sidebarCollapsed ? "Show conversation list" : "Hide conversation list"}
            aria-pressed={sidebarCollapsed}
            title={sidebarCollapsed ? "Show the conversation list" : "Hide the conversation list"}
          >
            {sidebarCollapsed ? (
              <PanelLeft aria-hidden="true" />
            ) : (
              <PanelLeftClose aria-hidden="true" />
            )}
          </Button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold tracking-tight">{heading}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {subheading}
              {engine.threadId !== null
                ? ` · ${chatModeOption(activeThread?.mode ?? DEFAULT_CHAT_MODE).label}`
                : ""}
            </p>
          </div>
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
            onClick={() => setSourcesOpen(true)}
            disabled={engine.threadId !== null || generating}
            aria-label="Change sources"
            title={
              engine.threadId !== null
                ? "A conversation's sources are fixed — start a new chat to pick others"
                : "Change sources"
            }
          >
            <BookOpenText aria-hidden="true" />
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
        </header>

        {conversation}
        {composer}
      </section>

      <ChatSourcePicker
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        videos={videos}
        tweets={tweets}
        creators={creators}
        categories={categories}
        selected={pickerSelection}
        onConfirm={(refs) => {
          applySources(refs);
          setSourcesOpen(false);
          if (engine.threadId === null) {
            const hasTweet = refs.some((source) => source.kind === "tweet");
            syncUrl(
              hasTweet
                ? `sources=${refs.map((source) => `${source.kind}:${source.id}`).join(",")}`
                : `videos=${refs.map((source) => source.id).join(",")}`,
            );
          }
        }}
      />

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

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete this conversation?"
        description={`“${deleteTarget?.title ?? ""}” and all of its messages will be removed from scope.`}
        confirmLabel="Delete conversation"
        destructive
        busy={deleting}
        busyLabel="Deleting…"
        onConfirm={() => void deleteConversation()}
      >
        <p className="text-sm text-muted-foreground">
          Your saved videos and posts are not touched — only this chat disappears from the history.
        </p>
      </ConfirmDialog>

      {toastElement}
    </div>
  );
}
