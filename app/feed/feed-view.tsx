"use client";

import { useBackgroundTasks } from "@/components/background/task-store";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  ClipboardCopy,
  ExternalLink,
  FileText,
  History,
  Newspaper,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  X,
} from "lucide-react";

import { getTranscriptAction } from "@/components/background/operations";
import { ChatPanel } from "@/components/ai/chat-panel";
import type { ChatSource } from "@/components/ai/citation";
import {
  TimelineKindBadge,
  TweetDetailDialog,
  TweetStatusBadge,
} from "@/components/channel/tweet-card";
import {
  CategoryFilterBar,
  UNCATEGORIZED_FILTER,
} from "@/components/categories/category-filter-bar";
import { creatorAvatarStyle } from "@/components/library/creator-card";
import { PlatformFilter } from "@/components/library/platform-filter";
import { RefreshAllButton } from "@/components/library/refresh-all-button";
import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { PendingIndicator, Spinner } from "@/components/ui/pending";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { useToast } from "@/components/ui/toast";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { TweetViewModel } from "@/lib/x/view-model";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { CategorySummary } from "@/lib/categories";
import { formatAbsoluteTimestamp, formatDuration, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The Feed page: the newest cached videos and livestreams across every
 * saved creator, one list, newest first. Rows pull their data from the
 * local cache; the two per-row actions — transcript extraction and the
 * "Ask AI" side panel — reuse the same server action and chat panel as the
 * channel and research pages, so behavior never drifts between them.
 *
 * The toolbar narrows the list by kind, platform, and the user's creator
 * categories (plus search) — all client-side over the prebuilt items. One
 * yt-dlp extraction runs at a time across the whole list (the row-level
 * buttons disable while a job is in flight); opening an already-cached
 * transcript is a local read and stays available during one. A changed chat
 * target re-keys the shared panel into a fresh conversation — the same
 * behavior as the stage-5 research selections.
 */

export type FeedItemLiveStatus = "not_live" | "is_live" | "was_live" | "upcoming" | "unknown";

export interface FeedVideoItemModel {
  kind: "video";
  id: string;
  creatorId: number;
  creatorName: string;
  creatorAvatarUrl: string | null;
  creatorPlatform: "youtube" | "rumble";
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  liveStatus: FeedItemLiveStatus;
  /** Whitespace-collapsed snippet prepared on the server. */
  description: string | null;
  hasTranscript: boolean;
  /** The creator's category ids, for the client-side category filter. */
  categoryIds: number[];
}

export interface FeedTweetItemModel {
  kind: "tweet";
  id: string;
  creatorId: number;
  creatorName: string;
  creatorAvatarUrl: string | null;
  creatorPlatform: "x";
  /** Post text, whitespace-collapsed into a display snippet. */
  text: string;
  /** Complete cached text for the detail view. */
  fullText: string;
  url: string;
  publishedAt: string | null;
  timelineKind: "post" | "repost" | "reply";
  authorHandle: string;
  authorName: string;
  isRepost: boolean;
  repostedByHandle: string | null;
  inReplyToHandle: string | null;
  quotedText: string | null;
  replyCount: number | null;
  repostCount: number | null;
  likeCount: number | null;
  mediaPreviewUrl: string | null;
  mediaCount: number;
  contentStatus: "summary" | "complete" | "unavailable";
  /** True when the complete cached text can ground analysis. */
  readyForAnalysis: boolean;
  fetchedAt: string;
  categoryIds: number[];
}

export type FeedItemModel = FeedVideoItemModel | FeedTweetItemModel;

export interface FeedCreatorRef {
  id: number;
  displayName: string;
}

interface FeedTranscript {
  text: string;
  language: string;
  captionSource: "manual" | "automatic";
  fetchedAt: string;
}

interface FeedTranscriptError {
  code: string;
  message: string;
}

interface FeedViewProps {
  items: FeedItemModel[];
  creators: FeedCreatorRef[];
  /** The user's categories, for the filter bar (with per-category creator counts). */
  categories: CategorySummary[];
  /** Creators that belong to no category — backs the bar's Uncategorized chip. */
  uncategorizedCreatorCount: number;
}

/** Which transcript job a row is running; each maps to a server intent. */
type TranscriptJobKind = "extract" | "view" | "refresh";

const JOB_WORDING: Record<TranscriptJobKind, string> = {
  extract: "Extracting the transcript with yt-dlp…",
  view: "Opening your cached transcript…",
  refresh: "Re-extracting the transcript…",
};

const JOB_INTENT: Record<TranscriptJobKind, "get" | "refresh"> = {
  extract: "get",
  view: "get",
  refresh: "refresh",
};

/** Same stored-status rule the repository uses to split the channel tabs. */
function isLivestream(liveStatus: FeedItemLiveStatus): boolean {
  return liveStatus === "is_live" || liveStatus === "was_live" || liveStatus === "upcoming";
}

const INITIAL_VISIBLE = 25;
const VISIBLE_STEP = 25;

const FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "videos", label: "Videos" },
  { value: "livestreams", label: "Livestreams" },
  { value: "tweets", label: "Tweets" },
] as const;

type FeedFilter = (typeof FILTER_OPTIONS)[number]["value"];

export function FeedView({
  items,
  creators,
  categories,
  uncategorizedCreatorCount,
}: FeedViewProps) {
  const router = useRouter();
  const { showToast, toastElement } = useToast();

  const [filter, setFilter] = useState<FeedFilter>("all");
  const [platform, setPlatform] = useState<CreatorPlatform | "all">("all");
  const [categoryFilters, setCategoryFilters] = useState<
    ReadonlySet<number | typeof UNCATEGORIZED_FILTER>
  >(() => new Set());
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [transcripts, setTranscripts] = useState<Record<string, FeedTranscript>>({});
  const [errors, setErrors] = useState<Record<string, FeedTranscriptError | null>>({});
  /** The one in-flight transcript job across the whole list, if any. */
  const [localJob, setJob] = useState<{ videoId: string; kind: TranscriptJobKind } | null>(null);
  const tasks = useBackgroundTasks();
  const activeTranscript = tasks.find(
    (task) => task.key.startsWith("transcript:") && task.status === "running",
  );
  const job = useMemo(
    () =>
      localJob ??
      (activeTranscript
        ? { videoId: activeTranscript.key.slice("transcript:".length), kind: "extract" as const }
        : null),
    [localJob, activeTranscript],
  );
  const [chatTarget, setChatTarget] = useState<FeedItemModel | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [detailTweet, setDetailTweet] = useState<FeedTweetItemModel | null>(null);

  const counts = useMemo(() => {
    let videos = 0;
    let livestreams = 0;
    let tweets = 0;
    let ready = 0;
    for (const item of items) {
      if (item.kind === "tweet") {
        tweets += 1;
        if (item.readyForAnalysis) {
          ready += 1;
        }
        continue;
      }
      if (isLivestream(item.liveStatus)) {
        livestreams += 1;
      } else {
        videos += 1;
      }
      if (item.hasTranscript) {
        ready += 1;
      }
    }
    return { all: items.length, videos, livestreams, tweets, ready };
  }, [items]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((item) => {
      if (platform !== "all" && item.creatorPlatform !== platform) {
        return false;
      }
      if (filter === "tweets" && item.kind !== "tweet") {
        return false;
      }
      if (filter !== "tweets" && filter !== "all" && item.kind === "tweet") {
        return false;
      }
      if (item.kind === "video") {
        if (filter === "videos" && isLivestream(item.liveStatus)) {
          return false;
        }
        if (filter === "livestreams" && !isLivestream(item.liveStatus)) {
          return false;
        }
      }
      // Inclusive category union, same semantics as the research page:
      // any selected category on the creator, or uncategorized when picked.
      if (categoryFilters.size > 0) {
        const inSelected =
          (categoryFilters.has(UNCATEGORIZED_FILTER) && item.categoryIds.length === 0) ||
          item.categoryIds.some((id) => categoryFilters.has(id));
        if (!inSelected) {
          return false;
        }
      }
      if (needle.length === 0) {
        return true;
      }
      if (item.kind === "tweet") {
        return (
          item.text.toLowerCase().includes(needle) ||
          item.authorHandle.toLowerCase().includes(needle) ||
          item.creatorName.toLowerCase().includes(needle)
        );
      }
      return (
        item.title.toLowerCase().includes(needle) || item.creatorName.toLowerCase().includes(needle)
      );
    });
  }, [items, platform, filter, categoryFilters, query]);

  const visible = filtered.slice(0, visibleCount);
  const remaining = filtered.length - visible.length;

  const updateFilter = useCallback((next: FeedFilter) => {
    setFilter(next);
    setVisibleCount(INITIAL_VISIBLE);
  }, []);

  const updatePlatform = useCallback((next: CreatorPlatform | "all") => {
    setPlatform(next);
    setVisibleCount(INITIAL_VISIBLE);
  }, []);

  const updateCategoryFilters = useCallback(
    (next: ReadonlySet<number | typeof UNCATEGORIZED_FILTER>) => {
      setCategoryFilters(next);
      setVisibleCount(INITIAL_VISIBLE);
    },
    [],
  );

  const updateQuery = useCallback((next: string) => {
    setQuery(next);
    setVisibleCount(INITIAL_VISIBLE);
  }, []);

  const resetFilters = useCallback(() => {
    setFilter("all");
    setPlatform("all");
    setCategoryFilters(new Set());
    setQuery("");
    setVisibleCount(INITIAL_VISIBLE);
  }, []);

  /**
   * Runs one transcript job through the shared server action. Extraction
   * and refresh are serialized list-wide; "view" only reads the local
   * cache (the row only offers it when a cached transcript exists).
   */
  const runJob = useCallback(
    async (item: FeedVideoItemModel, kind: TranscriptJobKind): Promise<void> => {
      if (job !== null) {
        return;
      }
      setJob({ videoId: item.id, kind });
      setErrors((prev) => ({ ...prev, [item.id]: null }));
      const result = await getTranscriptAction(item.creatorId, item.id, JOB_INTENT[kind]);
      setJob(null);

      if (!result.ok) {
        setErrors((prev) => ({
          ...prev,
          [item.id]: { code: result.errorCode, message: result.message ?? "Extraction failed." },
        }));
        return;
      }

      setTranscripts((prev) => ({
        ...prev,
        [item.id]: {
          text: result.transcript.text,
          language: result.transcript.language,
          captionSource: result.transcript.captionSource,
          fetchedAt: result.transcript.fetchedAt,
        },
      }));

      if (kind === "extract") {
        showToast("Transcript extracted for this source.", "success");
        setExpandedIds((prev) => new Set(prev).add(item.id));
        // Re-render the server data so the header's cached-transcript count
        // and the row's flag reflect the new extraction (row state survives).
        router.refresh();
      } else if (kind === "refresh") {
        showToast("Transcript refreshed.", "success");
      }
    },
    [job, showToast, router],
  );

  const toggleTranscript = useCallback(
    (item: FeedVideoItemModel): void => {
      const wasExpanded = expandedIds.has(item.id);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (wasExpanded) {
          next.delete(item.id);
        } else {
          next.add(item.id);
        }
        return next;
      });
      // Opening a transcript the page has not seen yet fetches the cached
      // copy; rows without one go through the extraction flow instead.
      if (!wasExpanded && transcripts[item.id] === undefined && item.hasTranscript) {
        void runJob(item, "view");
      }
    },
    [expandedIds, transcripts, runJob],
  );

  const openChat = useCallback((item: FeedItemModel): void => {
    setChatTarget(item);
    setChatOpen(true);
  }, []);

  const tweetViewModel = useMemo(
    () => (detailTweet ? feedTweetToViewModel(detailTweet) : null),
    [detailTweet],
  );

  const chatSources = useMemo<ChatSource[]>(() => {
    if (!chatTarget) {
      return [];
    }
    if (chatTarget.kind === "tweet") {
      return [
        {
          id: chatTarget.id,
          kind: "tweet",
          title: chatTarget.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
          creator: chatTarget.authorName,
          url: chatTarget.url,
          publishedAt: chatTarget.publishedAt,
          thumbnailUrl: chatTarget.mediaPreviewUrl,
        },
      ];
    }
    return [
      {
        id: chatTarget.id,
        title: chatTarget.title,
        creator: chatTarget.creatorName,
        thumbnailUrl: chatTarget.thumbnailUrl,
      },
    ];
  }, [chatTarget]);

  if (creators.length === 0) {
    return (
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The newest videos and livestreams from every creator you save, in one list.
          </p>
        </header>
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Users className="size-7 text-muted-foreground" />
          </span>
          <h2 className="text-base font-semibold">Your library is empty</h2>
          <p className="max-w-md text-balance text-sm text-muted-foreground">
            Save a creator first — the feed collects the newest cached videos, livestreams, and X
            posts from your library.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go to your library
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The newest videos, livestreams, and X posts from your {creators.length} saved{" "}
            {creators.length === 1 ? "creator" : "creators"} — {counts.ready} ready for analysis.
          </p>
        </div>
        <RefreshAllButton creators={creators} onRefreshed={() => router.refresh()} />
      </header>

      {items.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Newspaper className="size-7 text-muted-foreground" />
          </span>
          <h2 className="text-base font-semibold">Nothing cached yet</h2>
          <p className="max-w-md text-balance text-sm text-muted-foreground">
            Refresh your creators to pull in their newest videos, livestreams, and posts —
            everything lands here, newest first.
          </p>
          <RefreshAllButton creators={creators} onRefreshed={() => router.refresh()} />
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center">
            <div
              role="group"
              aria-label="Filter the feed by kind"
              className="flex shrink-0 items-center self-start rounded-md bg-muted/70 p-0.5"
            >
              {FILTER_OPTIONS.map((option) => {
                const selected = filter === option.value;
                const count = counts[option.value];
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateFilter(option.value)}
                    aria-pressed={selected}
                    className={cn(
                      "rounded-[5px] px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                    <span className={cn("ml-1.5", selected ? "text-muted-foreground" : undefined)}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
            <PlatformFilter value={platform} onChange={updatePlatform} />
            <div className="relative lg:ml-auto lg:w-72">
              <Search
                aria-hidden="true"
                className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                aria-label="Search the feed"
                placeholder="Search titles or creators…"
                value={query}
                onChange={(event) => updateQuery(event.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-9 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => updateQuery("")}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              ) : null}
            </div>
          </div>

          {categories.length > 0 ? (
            <CategoryFilterBar
              className="mt-3"
              compact
              categories={categories}
              selected={categoryFilters}
              onChange={updateCategoryFilters}
              uncategorizedCount={uncategorizedCreatorCount}
            />
          ) : null}

          {filtered.length === 0 ? (
            <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
              <p className="max-w-md text-balance text-sm text-muted-foreground">
                No sources match the current filters and search.
              </p>
              <Button variant="outline" size="sm" onClick={resetFilters}>
                Reset filters
              </Button>
            </div>
          ) : (
            <>
              <ul className="mt-4 flex flex-col gap-3">
                {visible.map((item) =>
                  item.kind === "tweet" ? (
                    <TweetFeedRow
                      key={item.id}
                      item={item}
                      onOpenDetail={() => setDetailTweet(item)}
                      onAsk={() => openChat(item)}
                    />
                  ) : (
                    <FeedRow
                      key={item.id}
                      item={item}
                      transcript={transcripts[item.id] ?? null}
                      expanded={expandedIds.has(item.id)}
                      hasTranscript={item.hasTranscript || transcripts[item.id] !== undefined}
                      activeJob={job?.videoId === item.id ? job.kind : null}
                      jobElsewhere={job !== null && job.videoId !== item.id}
                      error={errors[item.id] ?? null}
                      onToggleTranscript={() => toggleTranscript(item)}
                      onExtract={() => void runJob(item, "extract")}
                      onRefresh={() => void runJob(item, "refresh")}
                      onAsk={() => openChat(item)}
                    />
                  ),
                )}
              </ul>

              {remaining > 0 ? (
                <div className="mt-6 flex flex-col items-center gap-1.5">
                  <Button
                    variant="outline"
                    onClick={() => setVisibleCount((count) => count + VISIBLE_STEP)}
                  >
                    <ChevronDown aria-hidden="true" />
                    Show {Math.min(VISIBLE_STEP, remaining)} more
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Showing {visible.length} of {filtered.length}
                  </p>
                </div>
              ) : (
                <p className="mt-6 text-center text-xs text-muted-foreground">
                  That is every source in the feed ({filtered.length}).
                </p>
              )}
            </>
          )}
        </>
      )}

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        scope={chatTarget?.kind === "video" ? [chatTarget.id] : []}
        scopeSources={
          chatTarget?.kind === "tweet" ? [{ kind: "tweet", id: chatTarget.id }] : undefined
        }
        sources={chatSources}
        description={
          chatTarget?.kind === "video"
            ? `Grounded in the cached transcript of “${chatTarget.title}”.`
            : chatTarget?.kind === "tweet"
              ? `Grounded in the cached post by @${chatTarget.authorHandle}.`
              : undefined
        }
      />

      <TweetDetailDialog
        tweet={tweetViewModel}
        open={tweetViewModel !== null}
        onClose={() => setDetailTweet(null)}
      />

      {toastElement}
    </main>
  );
}

interface FeedRowProps {
  item: FeedVideoItemModel;
  transcript: FeedTranscript | null;
  expanded: boolean;
  /** Cached transcript exists (from the server render or this session). */
  hasTranscript: boolean;
  /** The transcript job this row is running, if any. */
  activeJob: TranscriptJobKind | null;
  /** True while another row runs an extraction — one yt-dlp job at a time. */
  jobElsewhere: boolean;
  error: FeedTranscriptError | null;
  onToggleTranscript: () => void;
  onExtract: () => void;
  onRefresh: () => void;
  onAsk: () => void;
}

function FeedRow({
  item,
  transcript,
  expanded,
  hasTranscript,
  activeJob,
  jobElsewhere,
  error,
  onToggleTranscript,
  onExtract,
  onRefresh,
  onAsk,
}: FeedRowProps) {
  const detailHref = `/channels/${item.creatorId}/videos/${item.id}`;
  const externalLabel = item.creatorPlatform === "rumble" ? "Open on Rumble" : "Open on YouTube";
  const busy = activeJob !== null;

  return (
    <li className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-colors motion-reduce:transition-none hover:border-ring/40">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:gap-5">
        <Link
          href={detailHref}
          aria-label={`Open ${item.title}`}
          className="group relative block aspect-video w-full shrink-0 overflow-hidden rounded-lg border bg-muted sm:w-48"
        >
          {item.thumbnailUrl ? (
            // Remote thumbnail URL only — binaries are never stored locally.
            <img
              src={item.thumbnailUrl}
              alt=""
              loading="lazy"
              className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
            />
          ) : (
            <span
              aria-hidden="true"
              className="flex size-full items-center justify-center text-xs text-muted-foreground"
            >
              No preview image
            </span>
          )}
          <LiveBadge liveStatus={item.liveStatus} />
          {item.liveStatus !== "is_live" &&
          item.liveStatus !== "upcoming" &&
          item.durationSeconds !== null ? (
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white">
              {formatDuration(item.durationSeconds)}
            </span>
          ) : null}
        </Link>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <CreatorAvatar
              name={item.creatorName}
              avatarUrl={item.creatorAvatarUrl}
              creatorId={item.creatorId}
            />
            <Link
              href={`/channels/${item.creatorId}`}
              className="shrink-0 font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.creatorName}
            </Link>
            <PlatformGlyph platform={item.creatorPlatform} />
            <span aria-hidden="true">·</span>
            <PublishedLabel item={item} />
          </div>

          <h2 className="text-sm leading-snug font-semibold sm:text-[0.95rem]">
            <Link
              href={detailHref}
              className="underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
            >
              {item.title}
            </Link>
          </h2>

          {item.description ? (
            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
              {item.description}
            </p>
          ) : null}

          <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
            <Button size="sm" onClick={onAsk}>
              <Sparkles aria-hidden="true" />
              Ask AI
            </Button>
            {hasTranscript ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={onToggleTranscript}
                aria-expanded={expanded}
                aria-busy={activeJob === "view"}
                disabled={activeJob === "view"}
              >
                {activeJob === "view" ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <FileText aria-hidden="true" />
                )}
                {expanded ? "Hide transcript" : "Transcript"}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={onExtract}
                disabled={busy || jobElsewhere}
                aria-busy={activeJob === "extract"}
              >
                {activeJob === "extract" ? (
                  <>
                    <Spinner className="size-3.5" />
                    Extracting…
                  </>
                ) : (
                  <>
                    <FileText aria-hidden="true" />
                    Get transcript
                  </>
                )}
              </Button>
            )}
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              title={externalLabel}
              aria-label={`${externalLabel} (opens in a new tab)`}
              className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </div>
        </div>
      </div>

      {expanded ? (
        <div className="border-t bg-muted/20 p-4">
          <span role="status" aria-live="polite" className="sr-only">
            {busy ? JOB_WORDING[activeJob] : ""}
          </span>

          {busy ? (
            <PendingIndicator
              label={JOB_WORDING[activeJob]}
              hint={activeJob === "view" ? undefined : "This can take up to a minute."}
            />
          ) : error ? (
            error.code === "language_choice" ? (
              <AlertNote tone="warning" title="Pick a caption language.">
                {error.message}{" "}
                <Link
                  href={detailHref}
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "ml-1 no-underline",
                  )}
                >
                  Open the video page
                </Link>
              </AlertNote>
            ) : (
              <AlertNote
                tone="danger"
                title={`${error.code.replace(/_/g, " ")}.`}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={hasTranscript ? onRefresh : onExtract}
                  >
                    Try again
                  </Button>
                }
              >
                {error.message}
              </AlertNote>
            )
          ) : transcript ? (
            <TranscriptBody
              item={item}
              transcript={transcript}
              onRefresh={onRefresh}
              refreshDisabled={jobElsewhere}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function TranscriptBody({
  item,
  transcript,
  onRefresh,
  refreshDisabled,
}: {
  item: FeedVideoItemModel;
  transcript: FeedTranscript;
  onRefresh: () => void;
  refreshDisabled: boolean;
}) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const [justCopied, setJustCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  const copied = copyState === "copied" && justCopied;

  const handleCopy = async (): Promise<void> => {
    if (justCopied) {
      return;
    }
    setCopyState(null);
    const outcome = await copyTextToClipboard(transcript.text);
    if (outcome === "failed") {
      setCopyState("failed");
      return;
    }
    setCopyState("copied");
    setJustCopied(true);
    if (resetTimer.current !== null) {
      window.clearTimeout(resetTimer.current);
    }
    resetTimer.current = window.setTimeout(() => setJustCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {transcript.captionSource === "manual" ? "Human-made captions" : "Auto-generated captions"}{" "}
        · Language: {transcript.language} · Cached{" "}
        <time
          dateTime={transcript.fetchedAt}
          title={formatAbsoluteTimestamp(transcript.fetchedAt) ?? undefined}
        >
          {formatRelativeTime(transcript.fetchedAt) ?? "recently"}
        </time>
      </p>
      <div
        role="region"
        aria-label={`Transcript for ${item.title}`}
        tabIndex={0}
        className="max-h-64 overflow-y-auto rounded-md border bg-card p-3 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
      >
        {transcript.text}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void handleCopy()} disabled={copied}>
          {copied ? (
            <>
              <ClipboardCheck aria-hidden="true" />
              Copied
            </>
          ) : (
            <>
              <ClipboardCopy aria-hidden="true" />
              Copy
            </>
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshDisabled}>
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
        <Link
          href={`/channels/${item.creatorId}/videos/${item.id}`}
          className="ml-auto text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open the full video page
        </Link>
      </div>
      {copyState === "failed" ? (
        <p role="alert" className="text-xs text-destructive">
          Copying failed — click inside the transcript, select the text, and copy it manually.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Maps a feed tweet into the shared detail/chat view model. Feed rows carry
 * the complete cached text separately from their display snippet.
 */
function feedTweetToViewModel(item: FeedTweetItemModel): TweetViewModel {
  return {
    id: item.id,
    authorName: item.authorName,
    authorHandle: item.authorHandle,
    authorAvatarUrl: item.creatorAvatarUrl,
    creatorId: item.creatorId,
    text: item.fullText,
    url: item.url,
    publishedAt: item.publishedAt,
    fetchedAt: item.fetchedAt,
    timelineKind: item.timelineKind,
    isRepost: item.isRepost,
    repostedByHandle: item.repostedByHandle,
    inReplyToHandle: item.inReplyToHandle,
    quoted: item.quotedText
      ? { handle: null, name: null, text: item.quotedText, url: item.url }
      : null,
    media:
      item.mediaPreviewUrl !== null
        ? [
            {
              kind: "photo",
              url: item.mediaPreviewUrl,
              previewUrl: item.mediaPreviewUrl,
              altText: null,
            },
          ]
        : [],
    replyCount: item.replyCount,
    repostCount: item.repostCount,
    likeCount: item.likeCount,
    contentStatus: item.contentStatus,
    readyForAnalysis: item.readyForAnalysis,
  };
}

interface TweetFeedRowProps {
  item: FeedTweetItemModel;
  onOpenDetail: () => void;
  onAsk: () => void;
}

/**
 * One X post in the unified feed: a readable text row (never a video tile),
 * with the explicit actions kept apart — Ask AI, Details, and Open on X.
 */
function TweetFeedRow({ item, onOpenDetail, onAsk }: TweetFeedRowProps) {
  return (
    <li className="rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors motion-reduce:transition-none hover:border-ring/40">
      <div className="flex items-start gap-3">
        <CreatorAvatar
          name={item.creatorName}
          avatarUrl={item.creatorAvatarUrl}
          creatorId={item.creatorId}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Link
              href={`/channels/${item.creatorId}`}
              className="shrink-0 font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.creatorName}
            </Link>
            <span className="shrink-0">@{item.authorHandle}</span>
            <PlatformGlyph platform="x" />
            <span aria-hidden="true">·</span>
            <PublishedLabel item={item} />
          </div>

          <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] line-clamp-4">
            {item.text}
          </p>

          {item.quotedText ? (
            <p className="mt-2 line-clamp-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
              Quoting: {item.quotedText}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={onAsk}>
              <Sparkles aria-hidden="true" />
              Ask AI
            </Button>
            <Button variant="secondary" size="sm" onClick={onOpenDetail}>
              <FileText aria-hidden="true" />
              Details
            </Button>
            <TimelineKindBadge tweet={item} />
            <TweetStatusBadge tweet={{ contentStatus: item.contentStatus }} />
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              title="Open on X"
              aria-label="Open on X (opens in a new tab)"
              className="ml-auto inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </div>
        </div>
      </div>
    </li>
  );
}

function LiveBadge({ liveStatus }: { liveStatus: FeedItemLiveStatus }) {
  switch (liveStatus) {
    case "is_live":
      return (
        <span className="absolute top-1.5 left-1.5">
          <Badge className="gap-1 border-transparent bg-red-700 text-white shadow-sm">
            <Radio aria-hidden="true" className="size-3" />
            Live
          </Badge>
        </span>
      );
    case "upcoming":
      return (
        <span className="absolute top-1.5 left-1.5">
          <Badge className="gap-1 border-transparent bg-amber-400 text-amber-950 shadow-sm">
            <CalendarClock aria-hidden="true" className="size-3" />
            Upcoming
          </Badge>
        </span>
      );
    case "was_live":
      return (
        <span className="absolute top-1.5 left-1.5">
          <Badge variant="secondary" className="gap-1 bg-card/90 text-card-foreground shadow-sm">
            <History aria-hidden="true" className="size-3" />
            Past live
          </Badge>
        </span>
      );
    default:
      return null;
  }
}

function CreatorAvatar({
  name,
  avatarUrl,
  creatorId,
}: {
  name: string;
  avatarUrl: string | null;
  creatorId: number;
}) {
  const src = localAvatarSrc(avatarUrl, creatorId);
  if (src) {
    return (
      // Streams through the local avatar proxy: same-origin, nothing stored.
      <img
        src={src}
        alt=""
        loading="lazy"
        className="size-6 shrink-0 rounded-full border border-border object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-semibold",
        creatorAvatarStyle(name),
      )}
    >
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

function PlatformGlyph({ platform }: { platform: CreatorPlatform }) {
  const label = platform === "x" ? "X" : platform === "rumble" ? "Rumble" : "YouTube";
  return (
    <span className="flex shrink-0 items-center" title={label}>
      {platform === "x" ? (
        <XLogo aria-hidden="true" className="size-3.5 text-foreground" />
      ) : platform === "rumble" ? (
        <RumbleLogo aria-hidden="true" className="size-3.5" />
      ) : (
        <YouTubeLogo aria-hidden="true" className="size-3.5" />
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Relative publish label for the byline. Hydration-safe: the label is
 * computed from the clock on both sides, so the text node opts out of the
 * mismatch warning (values may drift by a boundary crossing at worst).
 */
function PublishedLabel({ item }: { item: FeedItemModel }) {
  if (item.publishedAt) {
    return (
      <time
        dateTime={item.publishedAt}
        title={formatAbsoluteTimestamp(item.publishedAt) ?? undefined}
        suppressHydrationWarning
      >
        {formatRelativeTime(item.publishedAt) ?? "Date unknown"}
      </time>
    );
  }
  if (item.kind === "video" && item.liveStatus === "is_live") {
    return <span>Streaming now</span>;
  }
  if (item.kind === "video" && item.liveStatus === "upcoming") {
    return <span>Scheduled</span>;
  }
  return <span>Date unknown</span>;
}
