"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clapperboard,
  Filter,
  ImageOff,
  Layers3,
  Radio,
  Search,
  SearchX,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  CategoryFilterBar,
  UNCATEGORIZED_FILTER,
} from "@/components/categories/category-filter-bar";
import { SearchAvatar } from "@/components/library/creator-search-results";
import { PlatformFilter } from "@/components/library/platform-filter";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/dialog";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { MAX_SCOPE_SOURCES, formatScopeCapMessage } from "@/lib/ai/scope-selection";
import { sourceKey, type SourceRef } from "@/lib/content/model";
import { localAvatarSrc } from "@/lib/creators/avatar";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { formatDuration, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CategorySummary } from "@/lib/categories";

/**
 * The source picker for fresh conversations in the full-screen chat
 * workspace. Where the collapsed panel inherits its scope from the page it
 * opens on (one video, a channel selection, a research selection), the
 * workspace can start anywhere — so it picks its own sources here: any
 * cached videos and X posts across the whole library, capped like every
 * other selection surface at MAX_SCOPE_SOURCES. Videos are always
 * selectable (their captions are read when the chat starts); posts spell out
 * whether their complete text is cached instead of being skipped silently.
 *
 * Layout: a creator rail on the left (who the sources belong to, with
 * per-creator selection counts), a searchable thumbnail grid grouped by
 * creator on the right, and a selection tray along the bottom. Ticks land in
 * a draft that only reaches the conversation on confirm, so Cancel really
 * cancels.
 */

export interface PickerVideo {
  id: string;
  creatorId: number;
  title: string;
  creatorName: string;
  categoryIds: number[];
  thumbnailUrl?: string | null;
  publishedAt?: string | null;
  durationSeconds?: number | null;
  liveStatus?: "not_live" | "is_live" | "was_live" | "upcoming" | "unknown";
}

export interface PickerTweet {
  id: string;
  creatorId: number;
  authorHandle: string;
  authorName: string;
  text: string;
  categoryIds: number[];
  readyForAnalysis: boolean;
  publishedAt?: string | null;
  mediaPreviewUrl?: string | null;
}

/** Creator identity for the rail and group headers (name, avatar, platform). */
export interface PickerCreator {
  id: number;
  /** The saved creator's own name — a post's author can be someone they reposted. */
  displayName?: string;
  avatarUrl: string | null;
  platform: CreatorPlatform;
}

export interface ChatSourcePickerProps {
  open: boolean;
  onClose: () => void;
  videos: readonly PickerVideo[];
  tweets?: readonly PickerTweet[];
  creators?: readonly PickerCreator[];
  categories: readonly CategorySummary[];
  /** Currently committed selection keys (`video:<id>` / `tweet:<id>`) — the draft starts here. */
  selected: ReadonlySet<string>;
  /** Receives the confirmed references in list order (stable conversation key). */
  onConfirm: (sources: SourceRef[]) => void;
}

interface PickerItem {
  key: string;
  kind: "video" | "tweet";
  id: string;
  label: string;
  searchText: string;
  creatorId: number;
  creatorName: string;
  categoryIds: number[];
  ready: boolean;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  liveStatus: PickerVideo["liveStatus"];
  /** Full post text (posts only) — shown in the card body. */
  text: string | null;
  handle: string | null;
  /** The saved creator's platform; posts are always X. */
  platform: CreatorPlatform | null;
}

/** One creator block in the picker: their sources, newest first. */
interface PickerGroup {
  creatorId: number;
  creatorName: string;
  items: PickerItem[];
}

type KindView = "all" | "video" | "tweet" | "selected";

/** Cards per creator in the overview before "Show all" takes over. */
const PREVIEW_LIMIT = 8;

function toItems(
  videos: readonly PickerVideo[],
  tweets: readonly PickerTweet[],
  creatorsById: ReadonlyMap<number, PickerCreator>,
): PickerItem[] {
  return [
    ...videos.map((video) => ({
      key: sourceKey({ kind: "video", id: video.id }),
      kind: "video" as const,
      id: video.id,
      label: video.title,
      searchText: `${video.title} ${video.creatorName}`.toLowerCase(),
      creatorId: video.creatorId,
      creatorName: video.creatorName,
      categoryIds: video.categoryIds,
      ready: true,
      thumbnailUrl: video.thumbnailUrl ?? null,
      publishedAt: video.publishedAt ?? null,
      durationSeconds: video.durationSeconds ?? null,
      liveStatus: video.liveStatus,
      text: null,
      handle: null,
      platform: creatorsById.get(video.creatorId)?.platform ?? null,
    })),
    ...tweets.map((tweet) => ({
      key: sourceKey({ kind: "tweet", id: tweet.id }),
      kind: "tweet" as const,
      id: tweet.id,
      label: tweet.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
      searchText:
        `${tweet.text} ${tweet.authorName} ${tweet.authorHandle} ${creatorsById.get(tweet.creatorId)?.displayName ?? ""}`.toLowerCase(),
      creatorId: tweet.creatorId,
      // Group under the saved creator, not whoever wrote the post: a feed
      // carries reposts and quotes of other accounts.
      creatorName: creatorsById.get(tweet.creatorId)?.displayName ?? tweet.authorName,
      categoryIds: tweet.categoryIds,
      ready: tweet.readyForAnalysis,
      thumbnailUrl: tweet.mediaPreviewUrl ?? null,
      publishedAt: tweet.publishedAt ?? null,
      durationSeconds: null,
      liveStatus: undefined,
      text: tweet.text,
      handle: tweet.authorHandle,
      platform: "x" as const,
    })),
  ];
}

function groupByCreator(items: readonly PickerItem[]): PickerGroup[] {
  const groups = new Map<number, PickerItem[]>();
  for (const item of items) {
    const group = groups.get(item.creatorId);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.creatorId, [item]);
    }
  }
  return [...groups.entries()]
    .map(([creatorId, groupItems]) => ({
      creatorId,
      creatorName: groupItems[0]?.creatorName ?? "Creator",
      items: groupItems,
    }))
    .sort((a, b) => a.creatorName.localeCompare(b.creatorName, undefined, { sensitivity: "base" }));
}

/** "51 videos", "1 post", "3 videos · 2 posts". */
function describeCounts(items: readonly PickerItem[]): string {
  const videos = items.filter((item) => item.kind === "video").length;
  const posts = items.length - videos;
  const parts: string[] = [];
  if (videos > 0) parts.push(`${videos} ${videos === 1 ? "video" : "videos"}`);
  if (posts > 0) parts.push(`${posts} ${posts === 1 ? "post" : "posts"}`);
  return parts.join(" · ");
}

function PlatformMark({ platform, className }: { platform?: CreatorPlatform; className?: string }) {
  if (platform === "youtube") return <YouTubeLogo aria-hidden="true" className={className} />;
  if (platform === "rumble") return <RumbleLogo aria-hidden="true" className={className} />;
  if (platform === "x") return <XLogo aria-hidden="true" className={className} />;
  return null;
}

/** Post timestamps in the compact form X itself uses: "6h", "3d", "Mar 4". */
function compactAge(iso: string | null, nowMs = Date.now()): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const date = new Date(then);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(nowMs).getFullYear() ? {} : { year: "numeric" }),
  }).format(date);
}

const PLATFORM_NAME: Record<CreatorPlatform, string> = {
  youtube: "YouTube",
  rumble: "Rumble",
  x: "X",
};

export function ChatSourcePicker(props: ChatSourcePickerProps) {
  const { open, onClose } = props;
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Choose sources"
      description="Every answer is grounded in what the videos and X posts you pick actually say — across your whole library."
      className="h-[min(56rem,calc(100dvh-2rem))] max-w-6xl flex-col overflow-hidden open:flex"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
    >
      {/* Mounted only while open: the draft starts from the committed
          selection each time, and closed dialogs never pay for the grid. */}
      {open ? <PickerBody {...props} /> : null}
    </AppDialog>
  );
}

function PickerBody({
  onClose,
  videos,
  tweets = [],
  creators = [],
  categories,
  selected,
  onConfirm,
}: ChatSourcePickerProps) {
  const creatorsById = useMemo(
    () => new Map(creators.map((creator) => [creator.id, creator])),
    [creators],
  );
  const items = useMemo(
    () => toItems(videos, tweets, creatorsById),
    [videos, tweets, creatorsById],
  );
  const itemsByKey = useMemo(() => new Map(items.map((item) => [item.key, item])), [items]);

  const [draft, setDraft] = useState<ReadonlySet<string>>(
    () => new Set([...selected].filter((key) => itemsByKey.get(key)?.ready)),
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<KindView>("all");
  const [focusedCreator, setFocusedCreator] = useState<number | null>(null);
  const [capNote, setCapNote] = useState(false);
  const [categoryFilters, setCategoryFilters] = useState<
    ReadonlySet<number | typeof UNCATEGORIZED_FILTER>
  >(() => new Set());
  const [readyOnly, setReadyOnly] = useState(true);
  const [platform, setPlatform] = useState<CreatorPlatform | "all">("all");
  const scrollRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();

  // Everything but the creator focus: the rail lists who still has matches.
  const matching = useMemo(
    () =>
      items.filter((item) => {
        if (readyOnly && !item.ready) return false;
        if (platform !== "all" && item.platform !== platform) return false;
        if (view === "selected" && !draft.has(item.key)) return false;
        if ((view === "video" || view === "tweet") && item.kind !== view) return false;
        const categoryMatch =
          categoryFilters.size === 0 ||
          (categoryFilters.has(UNCATEGORIZED_FILTER) && item.categoryIds.length === 0) ||
          item.categoryIds.some((id) => categoryFilters.has(id));
        if (!categoryMatch) return false;
        return needle.length === 0 || item.searchText.includes(needle);
      }),
    [items, readyOnly, platform, view, draft, categoryFilters, needle],
  );

  const railGroups = useMemo(() => groupByCreator(matching), [matching]);
  // A focus whose creator dropped out of the filters quietly falls back to everyone.
  const activeCreator =
    focusedCreator !== null && railGroups.some((group) => group.creatorId === focusedCreator)
      ? focusedCreator
      : null;
  const groups =
    activeCreator === null
      ? railGroups
      : railGroups.filter((group) => group.creatorId === activeCreator);
  const shownCount = groups.reduce((count, group) => count + group.items.length, 0);
  // The overview previews each creator; focus, search, and review show everything.
  const truncate = activeCreator === null && needle.length === 0 && view !== "selected";

  const kindCounts = useMemo(() => {
    const visible = items.filter(
      (item) => (!readyOnly || item.ready) && (platform === "all" || item.platform === platform),
    );
    return {
      all: visible.length,
      video: visible.filter((item) => item.kind === "video").length,
      tweet: visible.filter((item) => item.kind === "tweet").length,
      // Whether the library holds both kinds at all, so the tabs never
      // vanish out from under an active Videos/Posts view.
      mixed:
        items.some((item) => item.kind === "video") && items.some((item) => item.kind === "tweet"),
    };
  }, [items, readyOnly, platform]);

  const uncategorizedCount = useMemo(
    () =>
      new Set(items.filter((item) => item.categoryIds.length === 0).map((item) => item.creatorId))
        .size,
    [items],
  );

  const remaining = MAX_SCOPE_SOURCES - draft.size;
  const selectedItems = useMemo(() => items.filter((item) => draft.has(item.key)), [items, draft]);

  // The cap note explains one refused tick; it should not linger as a warning.
  useEffect(() => {
    if (!capNote) return;
    const timer = window.setTimeout(() => setCapNote(false), 6000);
    return () => window.clearTimeout(timer);
  }, [capNote]);

  // A new view starts at the top instead of mid-way through the last one.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [activeCreator, view, categoryFilters, platform]);

  const toggleItem = (key: string): void => {
    // The analysis cap is enforced at selection time: the next tick is
    // refused with a note instead of silently breaking a later chat.
    if (!draft.has(key) && draft.size >= MAX_SCOPE_SOURCES) {
      setCapNote(true);
      return;
    }
    setCapNote(false);
    setDraft((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const selectMany = (keys: readonly string[]): void => {
    setCapNote(false);
    setDraft((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (next.size >= MAX_SCOPE_SOURCES) break;
        next.add(key);
      }
      return next;
    });
  };

  const deselectMany = (keys: readonly string[]): void => {
    setCapNote(false);
    setDraft((current) => {
      const next = new Set(current);
      for (const key of keys) next.delete(key);
      return next;
    });
  };

  const clearAll = (): void => {
    setCapNote(false);
    setDraft(new Set());
    if (view === "selected") setView("all");
  };

  const resetFilters = (): void => {
    setQuery("");
    setCategoryFilters(new Set());
    setPlatform("all");
    setView("all");
    setFocusedCreator(null);
  };

  const confirm = (): void => {
    if (draft.size === 0) {
      return;
    }
    // List order, not click order, so the same selection always produces the
    // same conversation key (the same rule the channel selection follows).
    onConfirm(selectedItems.map((item) => ({ kind: item.kind, id: item.id })));
  };

  const filtersActive =
    needle.length > 0 ||
    categoryFilters.size > 0 ||
    platform !== "all" ||
    view !== "all" ||
    activeCreator !== null;

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <CreatorRail
          groups={railGroups}
          total={matching.length}
          active={activeCreator}
          onSelect={setFocusedCreator}
          creatorsById={creatorsById}
          draft={draft}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-col gap-3 border-b px-5 py-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative flex-1">
                <Search
                  aria-hidden="true"
                  className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  type="search"
                  aria-label="Search sources"
                  placeholder="Search titles, posts, or creators…"
                  value={query}
                  autoFocus
                  onChange={(event) => setQuery(event.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background pr-9 pl-9 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                ) : null}
              </div>
              <KindTabs
                view={view}
                onChange={setView}
                counts={kindCounts}
                selectedCount={draft.size}
              />
            </div>
            <div className="flex items-center gap-3">
              <div className="shrink-0">
                <PlatformFilter value={platform} onChange={setPlatform} />
              </div>
              <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />
              <CategoryFilterBar
                categories={categories}
                selected={categoryFilters}
                onChange={setCategoryFilters}
                uncategorizedCount={uncategorizedCount}
                className="min-w-0 flex-1 pb-0"
                compact
              />
              {/* Only posts can lack content; with none of those there is nothing to filter. */}
              {items.some((item) => !item.ready) ? (
                <button
                  type="button"
                  aria-pressed={readyOnly}
                  onClick={() => setReadyOnly((value) => !value)}
                  title="Hide posts whose full text is not cached yet"
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    readyOnly
                      ? "border-foreground/30 bg-accent text-accent-foreground"
                      : "bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Filter aria-hidden="true" className="size-3.5" />
                  Ready for analysis
                </button>
              ) : null}
            </div>
          </div>

          <MobileCreatorStrip
            groups={railGroups}
            active={activeCreator}
            onSelect={setFocusedCreator}
            creatorsById={creatorsById}
          />

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {items.length === 0 ? (
              <EmptyState
                icon={<Clapperboard aria-hidden="true" className="size-6" />}
                title="Nothing cached yet"
                body="Save a creator and fetch their content first — chats work over the sources you already store locally."
              />
            ) : groups.length === 0 ? (
              view === "selected" && !filtersActiveBeyondView(needle, categoryFilters, platform) ? (
                <EmptyState
                  icon={<Layers3 aria-hidden="true" className="size-6" />}
                  title="Nothing selected yet"
                  body="Tick videos or posts and they gather here, so you can review the set before starting the chat."
                  action={
                    <Button variant="outline" size="sm" onClick={() => setView("all")}>
                      Browse all sources
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={<SearchX aria-hidden="true" className="size-6" />}
                  title={
                    needle ? `No sources match “${query.trim()}”` : "No sources match the filters"
                  }
                  body="Try a different search, or widen the platform, categories, and source type."
                  action={
                    filtersActive ? (
                      <Button variant="outline" size="sm" onClick={resetFilters}>
                        Reset filters
                      </Button>
                    ) : null
                  }
                />
              )
            ) : (
              <>
                <p className="sr-only" role="status">
                  {shownCount} {shownCount === 1 ? "source" : "sources"} shown
                </p>
                {groups.map((group) => (
                  <CreatorGroup
                    key={group.creatorId}
                    group={group}
                    creator={creatorsById.get(group.creatorId)}
                    draft={draft}
                    remaining={remaining}
                    truncate={truncate}
                    focused={activeCreator !== null}
                    onToggle={toggleItem}
                    onSelectMany={selectMany}
                    onDeselectMany={deselectMany}
                    onFocus={() => setFocusedCreator(group.creatorId)}
                    onBack={() => setFocusedCreator(null)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      <SelectionTray
        selectedItems={selectedItems}
        capNote={capNote}
        reviewing={view === "selected"}
        onReview={() => setView(view === "selected" ? "all" : "selected")}
        onClear={clearAll}
        onCancel={onClose}
        onConfirm={confirm}
      />
    </>
  );
}

function filtersActiveBeyondView(
  needle: string,
  categoryFilters: ReadonlySet<number | typeof UNCATEGORIZED_FILTER>,
  platform: CreatorPlatform | "all",
): boolean {
  return needle.length > 0 || categoryFilters.size > 0 || platform !== "all";
}

function KindTabs({
  view,
  onChange,
  counts,
  selectedCount,
}: {
  view: KindView;
  onChange: (view: KindView) => void;
  counts: { all: number; video: number; tweet: number; mixed: boolean };
  selectedCount: number;
}) {
  const tabs: { id: KindView; label: string; count: number; srLabel: string }[] = [
    { id: "all", label: "Everything", count: counts.all, srLabel: "sources" },
  ];
  // A library of one kind has nothing to split.
  if (counts.mixed) {
    tabs.push(
      { id: "video", label: "Videos", count: counts.video, srLabel: "videos" },
      { id: "tweet", label: "Posts", count: counts.tweet, srLabel: "posts" },
    );
  }
  tabs.push({ id: "selected", label: "Selected", count: selectedCount, srLabel: "selected" });

  return (
    <div
      role="group"
      aria-label="Source type"
      className="flex max-w-full shrink-0 items-center gap-0.5 self-start overflow-x-auto rounded-lg border bg-muted/40 p-0.5 [scrollbar-width:none] lg:self-auto [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const active = view === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
            <span
              className={cn(
                "min-w-5 rounded-full px-1.5 py-px text-center text-[10px] tabular-nums",
                tab.id === "selected" && tab.count > 0
                  ? "bg-primary text-primary-foreground"
                  : active
                    ? "bg-muted text-foreground"
                    : "bg-muted/60 text-muted-foreground",
              )}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CreatorRail({
  groups,
  total,
  active,
  onSelect,
  creatorsById,
  draft,
}: {
  groups: readonly PickerGroup[];
  total: number;
  active: number | null;
  onSelect: (creatorId: number | null) => void;
  creatorsById: ReadonlyMap<number, PickerCreator>;
  draft: ReadonlySet<string>;
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/20 md:flex">
      <p className="px-5 pt-4 pb-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Creators
      </p>
      <nav
        aria-label="Creators"
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2.5 pb-3"
      >
        <RailButton
          active={active === null}
          onClick={() => onSelect(null)}
          avatar={
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-card">
              <Layers3 aria-hidden="true" className="size-4 text-muted-foreground" />
            </span>
          }
          name="All creators"
          meta={`${total} ${total === 1 ? "source" : "sources"}`}
          selectedCount={draft.size}
        />
        {groups.map((group) => {
          const creator = creatorsById.get(group.creatorId);
          return (
            <RailButton
              key={group.creatorId}
              active={active === group.creatorId}
              onClick={() => onSelect(group.creatorId)}
              avatar={
                <CreatorAvatar
                  name={group.creatorName}
                  creator={creator}
                  creatorId={group.creatorId}
                  className="size-8"
                />
              }
              name={group.creatorName}
              meta={describeCounts(group.items)}
              platform={creator?.platform}
              selectedCount={group.items.filter((item) => draft.has(item.key)).length}
            />
          );
        })}
      </nav>
    </aside>
  );
}

function RailButton({
  active,
  onClick,
  avatar,
  name,
  meta,
  platform,
  selectedCount,
}: {
  active: boolean;
  onClick: () => void;
  avatar: React.ReactNode;
  name: string;
  meta: string;
  platform?: CreatorPlatform;
  selectedCount: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      {avatar}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{name}</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <PlatformMark platform={platform} className="size-3 shrink-0" />
          <span className="truncate">{meta}</span>
        </span>
      </span>
      {selectedCount > 0 ? (
        <span
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground tabular-nums"
          title={`${selectedCount} selected`}
        >
          {selectedCount}
          <span className="sr-only"> selected</span>
        </span>
      ) : null}
    </button>
  );
}

/** Small screens have no room for the rail: the same focus as a chip strip. */
function MobileCreatorStrip({
  groups,
  active,
  onSelect,
  creatorsById,
}: {
  groups: readonly PickerGroup[];
  active: number | null;
  onSelect: (creatorId: number | null) => void;
  creatorsById: ReadonlyMap<number, PickerCreator>;
}) {
  if (groups.length < 2) return null;
  const chip =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="flex gap-2 overflow-x-auto border-b px-5 py-2.5 [scrollbar-width:none] md:hidden">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={cn(chip, active === null ? "bg-accent" : "bg-card text-muted-foreground")}
      >
        Everyone
      </button>
      {groups.map((group) => (
        <button
          key={group.creatorId}
          type="button"
          onClick={() => onSelect(group.creatorId)}
          className={cn(
            chip,
            active === group.creatorId ? "bg-accent" : "bg-card text-muted-foreground",
          )}
        >
          <CreatorAvatar
            name={group.creatorName}
            creator={creatorsById.get(group.creatorId)}
            creatorId={group.creatorId}
            className="size-5 text-[8px]"
          />
          {group.creatorName}
        </button>
      ))}
    </div>
  );
}

function CreatorAvatar({
  name,
  creator,
  creatorId,
  className,
}: {
  name: string;
  creator: PickerCreator | undefined;
  creatorId: number;
  className?: string;
}) {
  const src = localAvatarSrc(creator?.avatarUrl ?? null, creatorId);
  return <SearchAvatar key={src} name={name} src={src} className={cn("text-[11px]", className)} />;
}

function CreatorGroup({
  group,
  creator,
  draft,
  remaining,
  truncate,
  focused,
  onToggle,
  onSelectMany,
  onDeselectMany,
  onFocus,
  onBack,
}: {
  group: PickerGroup;
  creator: PickerCreator | undefined;
  draft: ReadonlySet<string>;
  remaining: number;
  truncate: boolean;
  focused: boolean;
  onToggle: (key: string) => void;
  onSelectMany: (keys: readonly string[]) => void;
  onDeselectMany: (keys: readonly string[]) => void;
  onFocus: () => void;
  onBack: () => void;
}) {
  const visible = truncate ? group.items.slice(0, PREVIEW_LIMIT) : group.items;
  const hidden = group.items.length - visible.length;
  const selectedKeys = group.items.filter((item) => draft.has(item.key)).map((item) => item.key);
  const selectable = group.items.filter((item) => item.ready && !draft.has(item.key));

  let selectAction: { label: string; keys: string[] } | null = null;
  if (selectable.length > 0 && remaining > 0) {
    selectAction =
      selectable.length <= remaining
        ? {
            label: selectedKeys.length > 0 ? "Select the rest" : "Select all",
            keys: selectable.map((item) => item.key),
          }
        : {
            label: `Select newest ${remaining}`,
            keys: selectable.slice(0, remaining).map((item) => item.key),
          };
  }

  return (
    <section aria-label={group.creatorName} className="pb-2">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b bg-card/95 px-5 py-3 backdrop-blur-md supports-[backdrop-filter]:bg-card/80">
        {focused ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to all creators"
            title="Back to all creators"
            className="-ml-2 size-8"
          >
            <ChevronRight aria-hidden="true" className="rotate-180" />
          </Button>
        ) : null}
        <CreatorAvatar
          name={group.creatorName}
          creator={creator}
          creatorId={group.creatorId}
          className="size-9"
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{group.creatorName}</h3>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <PlatformMark platform={creator?.platform} className="size-3 shrink-0" />
            {creator ? <span className="sr-only">{PLATFORM_NAME[creator.platform]} · </span> : null}
            <span className="truncate">
              {describeCounts(group.items)}
              {selectedKeys.length > 0 ? (
                <span className="text-foreground"> · {selectedKeys.length} selected</span>
              ) : null}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {selectedKeys.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDeselectMany(selectedKeys)}
              aria-label={`Deselect ${group.creatorName}'s sources`}
            >
              Deselect
            </Button>
          ) : null}
          {selectAction ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSelectMany(selectAction.keys)}
              aria-label={`${selectAction.label} from ${group.creatorName}`}
            >
              {selectAction.label}
            </Button>
          ) : null}
        </div>
      </header>

      <ul className="grid grid-cols-2 gap-3 px-5 pt-4 sm:grid-cols-3 xl:grid-cols-4">
        {visible.map((item) => (
          <li key={item.key}>
            <SourceCard
              item={item}
              checked={draft.has(item.key)}
              onToggle={() => onToggle(item.key)}
            />
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <div className="px-5 pt-3">
          <button
            type="button"
            onClick={onFocus}
            className="group/more flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            Show all {group.items.length} from {group.creatorName}
            <ArrowRight
              aria-hidden="true"
              className="size-3.5 transition-transform group-hover/more:translate-x-0.5 motion-reduce:transition-none"
            />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SourceCard({
  item,
  checked,
  onToggle,
}: {
  item: PickerItem;
  checked: boolean;
  onToggle: () => void;
}) {
  const checkboxId = useId();
  const published = formatRelativeTime(item.publishedAt);
  const live = item.liveStatus === "is_live" || item.liveStatus === "upcoming";
  const duration =
    item.kind === "video" && !live && item.durationSeconds !== null
      ? formatDuration(item.durationSeconds)
      : null;

  const textOnlyPost = item.kind === "tweet" && !item.thumbnailUrl;
  const meta = (
    <p className="mt-auto flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {item.kind === "tweet" ? <span className="truncate">@{item.handle}</span> : null}
      {item.kind === "tweet" && published ? <span aria-hidden="true">·</span> : null}
      <span className="shrink-0">{published ?? (item.kind === "video" ? "Date unknown" : "")}</span>
    </p>
  );

  return (
    <div
      title={item.ready ? undefined : "This post's full text is not cached yet"}
      className={cn(
        "group relative flex h-full flex-col rounded-xl border bg-card transition-[background-color,border-color,box-shadow] motion-reduce:transition-none",
        textOnlyPost ? "p-3" : "p-1.5",
        checked
          ? "border-primary bg-accent/60 ring-2 ring-primary/80"
          : item.ready
            ? "hover:border-foreground/20 hover:bg-accent/30"
            : "opacity-60",
      )}
    >
      {textOnlyPost ? (
        // A text-only post reads like a post: who and when, then the words.
        <>
          <div className="flex h-5 items-center gap-2 pl-7">
            <XLogo aria-hidden="true" className="size-3 shrink-0" />
            <span className="sr-only">Post</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">@{item.handle}</span>
            {item.publishedAt ? (
              <time
                dateTime={item.publishedAt}
                title={published ?? undefined}
                className="ml-auto shrink-0 text-xs text-muted-foreground"
              >
                {compactAge(item.publishedAt)}
              </time>
            ) : null}
          </div>
          <p
            className={cn(
              "mt-3 line-clamp-6 text-[13px] leading-relaxed whitespace-pre-line [overflow-wrap:anywhere]",
              !item.ready && "text-muted-foreground",
            )}
          >
            {item.text}
          </p>
          {!item.ready ? (
            <span className="mt-auto self-start rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Text not cached yet
            </span>
          ) : null}
        </>
      ) : (
        <>
          {/* Composited up front (transform-gpu) so the rounded clip never
              re-rasterizes when the hover zoom starts or settles. */}
          <div className="relative isolate aspect-video transform-gpu overflow-hidden rounded-lg bg-muted">
            <Thumbnail src={item.thumbnailUrl} kind={item.kind} />
            {/* Top shade keeps the checkbox legible over bright thumbnails. */}
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-transparent transition-opacity motion-reduce:transition-none",
                checked ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
            />
            {item.kind === "tweet" ? (
              <span className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-md bg-black/75 text-white shadow-sm">
                <XLogo aria-hidden="true" className="size-3" />
                <span className="sr-only">Post</span>
              </span>
            ) : null}
            {duration ? (
              <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white tabular-nums">
                {duration}
              </span>
            ) : null}
            {item.liveStatus === "is_live" ? (
              <span className="absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-md bg-red-700 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                <Radio aria-hidden="true" className="size-3" />
                Live
              </span>
            ) : item.liveStatus === "upcoming" ? (
              <span className="absolute right-1.5 bottom-1.5 rounded-md bg-amber-400 px-1.5 py-0.5 text-[11px] font-semibold text-amber-950">
                Upcoming
              </span>
            ) : null}
            {!item.ready ? (
              <span className="absolute inset-x-1.5 bottom-1.5 rounded-md bg-black/80 px-2 py-1 text-center text-[11px] font-medium text-white">
                Text not cached yet
              </span>
            ) : null}
          </div>
          <div className="flex flex-1 flex-col gap-1.5 px-1.5 pt-2 pb-1">
            <p className="line-clamp-2 text-[13px] leading-snug font-medium [overflow-wrap:anywhere]">
              {item.kind === "video" ? item.label : item.text}
            </p>
            {meta}
          </div>
        </>
      )}

      <SelectionCheckbox
        id={checkboxId}
        className={cn(
          "absolute top-3 left-3 z-20 transition-opacity motion-reduce:transition-none",
          // Over a thumbnail the box needs its own contrast, whatever the image.
          !textOnlyPost &&
            "[&>input:not(:checked)]:border-white/85 [&>input:not(:checked)]:bg-black/35",
          checked || !item.ready
            ? "opacity-100"
            : "opacity-80 group-hover:opacity-100 has-[:focus-visible]:opacity-100",
        )}
        checked={checked}
        disabled={!item.ready}
        onChange={onToggle}
        aria-label={`Select ${item.label}`}
      />
      {/* Invisible overlay: the whole card toggles the checkbox, while the
          input itself keeps native focus, keyboard, and checked semantics. */}
      <label
        htmlFor={checkboxId}
        aria-hidden="true"
        className={cn(
          "absolute inset-0 z-10 rounded-xl",
          item.ready ? "cursor-pointer" : "cursor-not-allowed",
        )}
      />
    </div>
  );
}

/** Remote thumbnail with a calm fallback when there is none or it fails. */
function Thumbnail({ src, kind }: { src: string | null; kind: PickerItem["kind"] }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex size-full items-center justify-center bg-gradient-to-br from-muted to-muted/40 text-muted-foreground"
      >
        {kind === "video" ? (
          <Clapperboard className="size-6 opacity-60" />
        ) : (
          <ImageOff className="size-6 opacity-60" />
        )}
      </span>
    );
  }
  return (
    // Remote thumbnail URL only — binaries are never stored locally.
    <img
      ref={(image) => {
        // A failed request can finish before React attaches onError.
        if (image?.complete && image.naturalWidth === 0) setFailed(true);
      }}
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      // will-change keeps the image on its own layer between hovers; without
      // it the browser demotes the layer as the zoom ends, and the re-paint
      // snaps the image by a subpixel ("the glitch at the end").
      className="size-full object-cover transition-transform duration-300 ease-out will-change-transform [backface-visibility:hidden] group-hover:scale-[1.03] motion-reduce:transition-none"
    />
  );
}

function SelectionTray({
  selectedItems,
  capNote,
  reviewing,
  onReview,
  onClear,
  onCancel,
  onConfirm,
}: {
  selectedItems: readonly PickerItem[];
  capNote: boolean;
  reviewing: boolean;
  onReview: () => void;
  onClear: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const count = selectedItems.length;
  const stack = selectedItems.slice(0, 4);
  const percent = Math.min(100, (count / MAX_SCOPE_SOURCES) * 100);
  const full = count >= MAX_SCOPE_SOURCES;

  return (
    <div className="flex flex-col gap-3 border-t bg-muted/20 px-6 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {count > 0 ? (
          <button
            type="button"
            onClick={onReview}
            aria-label={reviewing ? "Back to all sources" : "Review selected sources"}
            title={reviewing ? "Back to all sources" : "Review selection"}
            className="hidden shrink-0 items-center rounded-lg p-1 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring sm:flex"
          >
            {stack.map((item, index) => (
              <span
                key={item.key}
                className={cn(
                  "relative block aspect-video w-14 overflow-hidden rounded-md border bg-muted shadow-sm ring-2 ring-card",
                  index > 0 && "-ml-6",
                )}
                style={{ zIndex: stack.length - index }}
              >
                {item.kind === "tweet" && !item.thumbnailUrl ? (
                  <span className="flex size-full items-center justify-center bg-muted">
                    <XLogo aria-hidden="true" className="size-3.5" />
                  </span>
                ) : (
                  <Thumbnail src={item.thumbnailUrl} kind={item.kind} />
                )}
              </span>
            ))}
            {count > stack.length ? (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground tabular-nums">
                +{count - stack.length}
              </span>
            ) : null}
          </button>
        ) : (
          <span className="hidden aspect-video w-14 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground sm:flex">
            <Layers3 aria-hidden="true" className="size-4" />
          </span>
        )}

        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
            {count === 0
              ? "Nothing selected yet"
              : `${count} ${count === 1 ? "source" : "sources"} selected`}
            {count > 0 ? (
              <>
                <button
                  type="button"
                  onClick={onReview}
                  className="rounded-sm text-xs font-normal text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {reviewing ? "Show all" : "Review"}
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="rounded-sm text-xs font-normal text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Clear
                </button>
              </>
            ) : null}
          </p>
          <div className="mt-1.5 flex items-center gap-2">
            <div
              role="progressbar"
              aria-label="Sources selected"
              aria-valuemin={0}
              aria-valuemax={MAX_SCOPE_SOURCES}
              aria-valuenow={count}
              className="h-1 w-32 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none",
                  full ? "bg-amber-500" : "bg-primary",
                )}
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {count} / {MAX_SCOPE_SOURCES}
              {full ? " · limit reached" : ""}
            </span>
          </div>
          {capNote ? (
            <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              <span>{formatScopeCapMessage(MAX_SCOPE_SOURCES + 1)}</span>
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={count === 0} className="flex-1 sm:min-w-36">
          <Check aria-hidden="true" />
          {count === 0 ? "Use sources" : count === 1 ? "Use 1 source" : `Use ${count} sources`}
        </Button>
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
        {icon}
      </span>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}
