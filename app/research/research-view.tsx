"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import {
  ArrowUpRight,
  CalendarClock,
  ExternalLink,
  FileText,
  Filter,
  History,
  Radio,
  Search,
  Users,
  X,
} from "lucide-react";

import { ChatPanel } from "@/components/ai/chat-panel";
import type { ChatSource } from "@/components/ai/citation";
import { ScopeSelectionBar, type ScopeSelectionNote } from "@/components/ai/scope-selection-bar";
import { creatorAvatarStyle } from "@/components/library/creator-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { XLogo } from "@/components/ui/platform-logos";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { sourceKey, type SourceRef } from "@/lib/content/model";
import { formatDate, formatDuration } from "@/lib/format";
import {
  formatScopeCapMessage,
  formatSkippedSources,
  MAX_SCOPE_SOURCES,
  planSourceScope,
  type SourceCandidate,
} from "@/lib/ai/scope-selection";
import { cn } from "@/lib/utils";
import {
  CategoryFilterBar,
  UNCATEGORIZED_FILTER,
} from "@/components/categories/category-filter-bar";
import { CategoryChip } from "@/components/categories/category-chip";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

export interface ResearchCreator {
  id: number;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  categories: CreatorCategory[];
}

export interface ResearchVideo {
  id: string;
  creatorId: number;
  creatorName: string;
  title: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  /** Same stored live status that splits the channel tabs. */
  liveStatus: "not_live" | "is_live" | "was_live" | "upcoming" | "unknown";
}

export interface ResearchTweet {
  id: string;
  creatorId: number;
  creatorName: string;
  authorHandle: string;
  authorName: string;
  /** Whitespace-collapsed snippet prepared on the server. */
  text: string;
  publishedAt: string | null;
  url: string;
  mediaPreviewUrl: string | null;
  contentStatus: "summary" | "complete" | "unavailable";
  readyForAnalysis: boolean;
}

interface ResearchViewProps {
  creators: ResearchCreator[];
  videos: ResearchVideo[];
  /** Cached X posts across the library; absent reads as none. */
  tweets?: ResearchTweet[];
  categories: CategorySummary[];
}

type ResearchItem = ({ kind: "video" } & ResearchVideo) | ({ kind: "tweet" } & ResearchTweet);

/** Videos are always analyzable (captions are read on demand); posts need full text. */
function itemReady(item: ResearchItem): boolean {
  return item.kind === "video" || item.readyForAnalysis;
}

function itemLabel(item: ResearchItem): string {
  return item.kind === "video" ? item.title : item.text;
}

/**
 * The AI Research page (stage 5): a deliberate two-step flow — choose one
 * or more creators, then choose any subset of their cached videos and X
 * posts — ending in the shared chat panel. Search and the "Ready for
 * analysis" filter narrow the list without ever discarding a selection made
 * from a previous view; deselecting a creator does drop that creator's
 * picks, since they are no longer part of the visible universe. Videos are
 * always analyzable — their captions are read in the background when the
 * chat starts — and the chat action stays honestly disabled only when the
 * selection holds nothing but posts without their full text.
 */
export function ResearchView({ creators, videos, tweets = [], categories }: ResearchViewProps) {
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [readyOnly, setReadyOnly] = useState(false);
  const [categoryFilters, setCategoryFilters] = useState<
    ReadonlySet<number | typeof UNCATEGORIZED_FILTER>
  >(() => new Set());
  const [chatOpen, setChatOpen] = useState(false);
  const [note, setNote] = useState<ScopeSelectionNote | null>(null);

  const baseId = useId();

  // Everything the chosen creators contribute, newest first across kinds.
  const universe = useMemo<ResearchItem[]>(() => {
    const items: ResearchItem[] = [
      ...videos
        .filter((video) => selectedCreatorIds.has(video.creatorId))
        .map((video) => ({ kind: "video" as const, ...video })),
      ...tweets
        .filter((tweet) => selectedCreatorIds.has(tweet.creatorId))
        .map((tweet) => ({ kind: "tweet" as const, ...tweet })),
    ];
    return items.sort((a, b) => {
      if (a.publishedAt === null && b.publishedAt === null) {
        return 0;
      }
      if (a.publishedAt === null) {
        return -1;
      }
      if (b.publishedAt === null) {
        return 1;
      }
      return b.publishedAt.localeCompare(a.publishedAt);
    });
  }, [videos, tweets, selectedCreatorIds]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return universe.filter((item) => {
      if (readyOnly && !itemReady(item)) {
        return false;
      }
      if (needle.length === 0) {
        return true;
      }
      return (
        itemLabel(item).toLowerCase().includes(needle) ||
        item.creatorName.toLowerCase().includes(needle)
      );
    });
  }, [universe, query, readyOnly]);

  const candidates = useMemo<SourceCandidate[]>(
    () =>
      universe
        .filter((item) => selectedKeys.has(sourceKey(item)))
        .map((item) => ({
          kind: item.kind,
          id: item.id,
          title:
            item.kind === "video"
              ? item.title
              : item.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
          readyForAnalysis: itemReady(item),
        })),
    [universe, selectedKeys],
  );
  const plan = useMemo(() => planSourceScope(candidates), [candidates]);

  // The page's sources double as the citation index: the chat panel resolves
  // the answers' transcript and post references into titled source chips.
  const sources = useMemo<ChatSource[]>(
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
  );

  const countsByCreator = useMemo(() => {
    const counts = new Map<number, { videos: number; tweets: number }>();
    const bump = (creatorId: number, key: "videos" | "tweets") => {
      const current = counts.get(creatorId) ?? { videos: 0, tweets: 0 };
      current[key] += 1;
      counts.set(creatorId, current);
    };
    for (const video of videos) {
      bump(video.creatorId, "videos");
    }
    for (const tweet of tweets) {
      bump(tweet.creatorId, "tweets");
    }
    return counts;
  }, [videos, tweets]);

  const visibleCreators = useMemo(
    () =>
      creators.filter(
        (creator) =>
          categoryFilters.size === 0 ||
          (categoryFilters.has(UNCATEGORIZED_FILTER) && creator.categories.length === 0) ||
          creator.categories.some((category) => categoryFilters.has(category.id)),
      ),
    [creators, categoryFilters],
  );
  const uncategorizedCount = creators.filter((creator) => creator.categories.length === 0).length;
  const hiddenSelectionCount = [...selectedCreatorIds].filter(
    (id) => !visibleCreators.some((creator) => creator.id === id),
  ).length;

  const selectVisibleCreators = (): void => {
    setSelectedCreatorIds(
      (current) => new Set([...current, ...visibleCreators.map((creator) => creator.id)]),
    );
    setNote(null);
  };

  const toggleCreator = (creatorId: number): void => {
    const removing = selectedCreatorIds.has(creatorId);
    setSelectedCreatorIds((prev) => {
      const next = new Set(prev);
      if (removing) {
        next.delete(creatorId);
      } else {
        next.add(creatorId);
      }
      return next;
    });
    if (removing) {
      // Their sources left the visible universe, so their picks leave too.
      setSelectedKeys((prev) => {
        const next = new Set(prev);
        for (const video of videos) {
          if (video.creatorId === creatorId) {
            next.delete(sourceKey({ kind: "video", id: video.id }));
          }
        }
        for (const tweet of tweets) {
          if (tweet.creatorId === creatorId) {
            next.delete(sourceKey({ kind: "tweet", id: tweet.id }));
          }
        }
        return next;
      });
    }
    setNote(null);
  };

  const toggleItem = (item: ResearchItem): void => {
    const key = sourceKey(item);
    // The analysis cap is enforced at selection time across all kinds: the
    // next tick is refused with a note instead of breaking a later chat.
    if (!selectedKeys.has(key) && selectedKeys.size >= MAX_SCOPE_SOURCES) {
      setNote({ tone: "danger", message: formatScopeCapMessage(selectedKeys.size + 1) });
      return;
    }
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
    setNote(null);
  };

  const openChat = (): void => {
    // The button is disabled while the scope would be empty; this stays as a
    // guard so a stale click can never open an ungrounded conversation.
    if (plan.sources.length === 0) {
      return;
    }
    setNote(
      plan.skippedNotReady.length > 0
        ? { tone: "info", message: formatSkippedSources(plan.skippedNotReady) }
        : null,
    );
    setChatOpen(true);
  };

  // Closing the panel when its scope empties adjusts state during render —
  // not in an effect — per React's guidance for reacting to derived changes
  // (the same pattern the chat panel uses for scope resets).
  const scopeEmpty = plan.sources.length === 0;
  const [renderedScopeEmpty, setRenderedScopeEmpty] = useState(scopeEmpty);
  if (renderedScopeEmpty !== scopeEmpty) {
    setRenderedScopeEmpty(scopeEmpty);
    if (scopeEmpty) {
      setChatOpen(false);
    }
  }

  const stepTwoActive = selectedCreatorIds.size > 0;
  const skippedCount = plan.skippedNotReady.length;
  const chatDisabled = plan.sources.length === 0;
  const disabledHint =
    selectedKeys.size === 0
      ? "Select at least one source to chat about it."
      : "None of the selected posts has its full text cached yet. Fetch them from the creator's page first.";
  const scopeCreatorCount = useMemo(() => {
    const keys = new Set(plan.sources.map((source) => sourceKey(source)));
    return new Set(
      universe.filter((item) => keys.has(sourceKey(item))).map((item) => item.creatorId),
    ).size;
  }, [universe, plan.sources]);
  const description =
    `${plan.sources.length} ${plan.sources.length === 1 ? "source" : "sources"} across ` +
    `${scopeCreatorCount} ${scopeCreatorCount === 1 ? "creator" : "creators"}` +
    (skippedCount > 0 ? ` · ${skippedCount} skipped (no cached content)` : "");

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">AI Research</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Pick creators, choose any of their videos and X posts, and ask AI about them together —
          answers are grounded in what they actually say.
        </p>
      </header>

      <section aria-labelledby="research-step-creators" className="mt-8">
        <StepHeading
          id="research-step-creators"
          step={1}
          title="Choose creators"
          hint="Videos and posts from every creator you pick are pooled below."
        />
        {creators.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
            <span
              aria-hidden="true"
              className="flex size-14 items-center justify-center rounded-full bg-muted"
            >
              <Users className="size-7 text-muted-foreground" />
            </span>
            <h3 className="text-base font-semibold">Your library is empty</h3>
            <p className="max-w-md text-balance text-sm text-muted-foreground">
              Save a creator from the dashboard first — research works over the channels you already
              cache locally.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Go to your library
            </Link>
          </div>
        ) : (
          <>
            <div className="mt-4 rounded-xl border bg-muted/20 p-3">
              <CategoryFilterBar
                categories={categories}
                selected={categoryFilters}
                onChange={setCategoryFilters}
                uncategorizedCount={uncategorizedCount}
                compact
              />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {visibleCreators.length} {visibleCreators.length === 1 ? "creator" : "creators"}{" "}
                  shown
                  {hiddenSelectionCount > 0 ? ` · ${hiddenSelectionCount} selected but hidden` : ""}
                </p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSelectedCreatorIds(new Set());
                      setSelectedKeys(new Set());
                    }}
                    disabled={selectedCreatorIds.size === 0}
                  >
                    Clear selected
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={selectVisibleCreators}
                    disabled={visibleCreators.every((creator) =>
                      selectedCreatorIds.has(creator.id),
                    )}
                  >
                    Select shown
                  </Button>
                </div>
              </div>
            </div>
            <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visibleCreators.map((creator) => {
                const selected = selectedCreatorIds.has(creator.id);
                const counts = countsByCreator.get(creator.id) ?? { videos: 0, tweets: 0 };
                const countLabel = [
                  counts.videos > 0
                    ? `${counts.videos} ${counts.videos === 1 ? "video" : "videos"}`
                    : null,
                  counts.tweets > 0
                    ? `${counts.tweets} ${counts.tweets === 1 ? "post" : "posts"}`
                    : null,
                ]
                  .filter((part): part is string => part !== null)
                  .join(" · ");
                return (
                  <li key={creator.id}>
                    <button
                      type="button"
                      onClick={() => toggleCreator(creator.id)}
                      aria-pressed={selected}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                        selected
                          ? "border-ring bg-accent/40 ring-2 ring-ring/40"
                          : "bg-card shadow-sm hover:border-ring/40",
                      )}
                    >
                      {creator.avatarUrl ? (
                        // Streams through the local avatar proxy: same-origin, nothing stored.
                        <img
                          src={localAvatarSrc(creator.avatarUrl, creator.id) ?? undefined}
                          alt=""
                          className="size-10 shrink-0 rounded-full border border-border object-cover"
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          className={cn(
                            "flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-sm font-semibold",
                            creatorAvatarStyle(creator.displayName),
                          )}
                        >
                          {creator.displayName.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate">{creator.displayName}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {countLabel.length > 0 ? `${countLabel} cached` : "Nothing cached yet"}
                        </span>
                        {creator.categories.length > 0 ? (
                          <span className="mt-1 flex min-w-0 gap-1 overflow-hidden">
                            {creator.categories.slice(0, 2).map((category) => (
                              <CategoryChip
                                key={category.id}
                                category={category}
                                className="max-w-24"
                              />
                            ))}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {visibleCreators.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
                No creators belong to the selected categories.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="research-step-videos" className="mt-10">
        <StepHeading
          id="research-step-videos"
          step={2}
          title="Choose sources"
          hint="Search and filter the pool, then tick anything worth asking about."
        />
        {!stepTwoActive ? (
          <div className="mt-4 rounded-xl border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
            Pick at least one creator above to choose sources.
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative flex-1 sm:max-w-xs">
                <Search
                  aria-hidden="true"
                  className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  aria-label="Search sources"
                  placeholder="Search titles, posts, or creators…"
                  value={query}
                  disabled={universe.length === 0}
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-9 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                ) : null}
              </div>
              {readyOnly || universe.some((item) => !itemReady(item)) ? (
                <button
                  type="button"
                  aria-pressed={readyOnly}
                  onClick={() => setReadyOnly((value) => !value)}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    readyOnly
                      ? "border-ring bg-accent text-accent-foreground"
                      : "bg-card text-muted-foreground shadow-sm hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  <Filter aria-hidden="true" className="size-4" />
                  Ready for analysis
                </button>
              ) : null}
              <p className="text-xs text-muted-foreground sm:ml-auto">
                {visible.length} of {universe.length} {universe.length === 1 ? "source" : "sources"}{" "}
                shown
              </p>
            </div>

            {universe.length === 0 ? (
              <div className="mt-4 rounded-xl border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
                No cached content for the creators you picked. Refresh a feed from a creator&apos;s
                page first.
              </div>
            ) : visible.length === 0 ? (
              <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
                <p className="max-w-md text-balance text-sm text-muted-foreground">
                  No sources match the current search and filters.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setQuery("");
                    setReadyOnly(false);
                  }}
                >
                  Reset filters
                </Button>
              </div>
            ) : (
              <ul className="mt-4 divide-y overflow-hidden rounded-xl border bg-card">
                {visible.map((item) =>
                  item.kind === "video" ? (
                    <ResearchRow
                      key={sourceKey(item)}
                      video={item}
                      checkboxId={`${baseId}-video-${item.id}`}
                      selected={selectedKeys.has(sourceKey(item))}
                      onToggle={() => toggleItem(item)}
                    />
                  ) : (
                    <ResearchTweetRow
                      key={sourceKey(item)}
                      tweet={item}
                      checkboxId={`${baseId}-tweet-${item.id}`}
                      selected={selectedKeys.has(sourceKey(item))}
                      onToggle={() => toggleItem(item)}
                    />
                  ),
                )}
              </ul>
            )}

            <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
              <ScopeSelectionBar
                className="pointer-events-auto"
                count={selectedKeys.size}
                noun="source"
                skippedCount={skippedCount}
                skippedLabel="without cached content"
                onChat={openChat}
                onClear={() => {
                  setSelectedKeys(new Set());
                  setNote(null);
                }}
                chatDisabled={chatDisabled}
                disabledHint={disabledHint}
                note={note}
              />
            </div>
          </>
        )}
      </section>

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        scope={[]}
        scopeSources={plan.sources as SourceRef[]}
        sources={sources}
        description={description}
      />
    </main>
  );
}

function StepHeading({
  id,
  step,
  title,
  hint,
}: {
  id: string;
  step: 1 | 2;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
      >
        {step}
      </span>
      <div className="min-w-0">
        <h2 id={id} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {hint ? <p className="mt-0.5 text-sm text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

/**
 * The row's source kind, using the same badge language as the channel
 * cards: livestream states are spelled out, and every other cached entry
 * is an ordinary video.
 */
function SourceKindBadge({ liveStatus }: { liveStatus: ResearchVideo["liveStatus"] }) {
  switch (liveStatus) {
    case "is_live":
      return (
        <Badge className="shrink-0 gap-1 border-transparent bg-red-700 text-white">
          <Radio aria-hidden="true" className="size-3" />
          Live
        </Badge>
      );
    case "upcoming":
      return (
        <Badge className="shrink-0 gap-1 border-transparent bg-amber-400 text-amber-950">
          <CalendarClock aria-hidden="true" className="size-3" />
          Upcoming
        </Badge>
      );
    case "was_live":
      return (
        <Badge variant="secondary" className="shrink-0 gap-1">
          <History aria-hidden="true" className="size-3" />
          Past live
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="shrink-0 text-muted-foreground">
          Video
        </Badge>
      );
  }
}

function ResearchRow({
  video,
  checkboxId,
  selected,
  onToggle,
}: {
  video: ResearchVideo;
  checkboxId: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={cn(
        "transition-colors motion-reduce:transition-none",
        selected ? "bg-accent/40 ring-1 ring-inset ring-ring/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <SelectionCheckbox
          id={checkboxId}
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${video.title}`}
        />
        <label
          htmlFor={checkboxId}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
        >
          <span className="relative block aspect-video w-24 shrink-0 overflow-hidden rounded-md border bg-muted">
            {video.thumbnailUrl ? (
              // Remote thumbnail URL only — binaries are never stored locally.
              <img
                src={video.thumbnailUrl}
                alt=""
                loading="lazy"
                className="size-full object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex size-full items-center justify-center text-center text-[10px] text-muted-foreground"
              >
                No image
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="line-clamp-2 block text-sm font-medium [overflow-wrap:anywhere]">
              {video.title}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {video.creatorName} · {formatDate(video.publishedAt) ?? "Date unknown"} ·{" "}
              {formatDuration(video.durationSeconds)}
            </span>
          </span>
        </label>
        <SourceKindBadge liveStatus={video.liveStatus} />
        <a
          href={`/channels/${video.creatorId}/videos/${video.id}`}
          aria-label={`Open ${video.title}`}
          title="Open video page"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <ArrowUpRight aria-hidden="true" className="size-4" />
        </a>
      </div>
    </li>
  );
}

/** One cached X post in the research pool. */
function ResearchTweetRow({
  tweet,
  checkboxId,
  selected,
  onToggle,
}: {
  tweet: ResearchTweet;
  checkboxId: string;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={cn(
        "transition-colors motion-reduce:transition-none",
        selected ? "bg-accent/40 ring-1 ring-inset ring-ring/40" : "hover:bg-accent/20",
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <SelectionCheckbox
          id={checkboxId}
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${tweet.text.slice(0, 60)}`}
        />
        <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1">
          <span className="line-clamp-2 block text-sm [overflow-wrap:anywhere]">{tweet.text}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {tweet.authorName} (@{tweet.authorHandle}) ·{" "}
            {formatDate(tweet.publishedAt) ?? "Date unknown"}
          </span>
        </label>
        <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
          <XLogo aria-hidden="true" className="size-3 text-foreground" />
          Post
        </Badge>
        {tweet.readyForAnalysis ? (
          <Badge variant="secondary" className="shrink-0 gap-1">
            <FileText aria-hidden="true" className="size-3" />
            Text cached
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            Fetch full text
          </Badge>
        )}
        <a
          href={tweet.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${tweet.text.slice(0, 40)} on X`}
          title="Open on X"
          className="shrink-0 rounded-md p-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <ExternalLink aria-hidden="true" className="size-4" />
        </a>
      </div>
    </li>
  );
}
