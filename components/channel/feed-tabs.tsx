"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FileQuestion, ListVideo, Radio } from "lucide-react";

import { Button } from "@/components/ui/button";
import { VideoCard, type VideoCardModel } from "@/components/channel/video-card";
import { cn } from "@/lib/utils";

type FeedTabKey = "videos" | "livestreams";

/** Cards shown before the "Load more" button; older items reveal in-place. */
export const FEED_PAGE_SIZE = 60;

/** Selection state owned by the caller (stage 5); absent when not selecting. */
export interface FeedTabsSelection {
  selectedIds: ReadonlySet<string>;
  onToggle: (videoId: string) => void;
}

interface FeedTabsProps {
  videos: VideoCardModel[];
  livestreams: VideoCardModel[];
  /** False until the first successful refresh (first-load empty state). */
  hasEverRefreshed: boolean;
  /** Used to name the creator in empty-state copy. */
  creatorName?: string;
  /** Rendered on the tab row's far side (e.g. the selection-mode toggle). */
  headerAction?: ReactNode;
  /** When present, every card renders a selection checkbox bound to it. */
  selection?: FeedTabsSelection;
}

const TAB_ORDER: readonly FeedTabKey[] = ["videos", "livestreams"];

/**
 * Videos / Livestreams switcher for the cached feed. Tabs follow the WAI-ARIA
 * tabs pattern (roving tabindex + arrow keys) and render preformatted card
 * models produced on the server. Long feeds paginate in-place: the first
 * FEED_PAGE_SIZE cards render and a "Load more" button reveals the rest, so
 * accumulated history stays browsable without leaving the page. Stage 5 adds
 * optional selection: when a `selection` is passed, cards become toggle
 * targets while tab state stays untouched, so a selection can span both tabs.
 */
export function FeedTabs({
  videos,
  livestreams,
  hasEverRefreshed,
  creatorName,
  headerAction,
  selection,
}: FeedTabsProps) {
  const baseId = useId();
  const [activeTab, setActiveTab] = useState<FeedTabKey>("videos");
  const [visibleCount, setVisibleCount] = useState(FEED_PAGE_SIZE);
  const tabRefs = useRef<Record<FeedTabKey, HTMLButtonElement | null>>({
    videos: null,
    livestreams: null,
  });

  const items: Record<FeedTabKey, VideoCardModel[]> = { videos, livestreams };
  const activeItems = items[activeTab];
  const shownItems = activeItems.slice(0, visibleCount);
  const hiddenCount = activeItems.length - shownItems.length;

  const selectTab = (tab: FeedTabKey): void => {
    setActiveTab(tab);
    // Each tab starts from its first page, like a fresh visit would.
    setVisibleCount(FEED_PAGE_SIZE);
  };

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = TAB_ORDER.indexOf(activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % TAB_ORDER.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = TAB_ORDER.length - 1;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      const nextTab = TAB_ORDER[nextIndex];
      selectTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  };

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="tablist"
          aria-label="Feed sections"
          className="flex w-full gap-1 rounded-lg border bg-muted/50 p-1 sm:w-fit"
        >
          {TAB_ORDER.map((tab) => {
            const selected = tab === activeTab;
            return (
              <button
                key={tab}
                ref={(node) => {
                  tabRefs.current[tab] = node;
                }}
                role="tab"
                id={`${baseId}-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel-${tab}`}
                tabIndex={selected ? 0 : -1}
                onClick={() => selectTab(tab)}
                onKeyDown={handleTabKeyDown}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:flex-none motion-reduce:transition-none",
                  selected
                    ? "bg-card text-card-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab === "videos" ? (
                  <ListVideo aria-hidden="true" className="size-4" />
                ) : (
                  <Radio aria-hidden="true" className="size-4" />
                )}
                {tab === "videos" ? "Videos" : "Livestreams"}
                <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                  {items[tab].length}
                </span>
              </button>
            );
          })}
        </div>
        {headerAction ? <div className="shrink-0">{headerAction}</div> : null}
      </div>

      <div
        role="tabpanel"
        id={`${baseId}-panel-${activeTab}`}
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        tabIndex={0}
        className="mt-5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {activeItems.length > 0 ? (
          <>
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {shownItems.map((video) => (
                <li key={video.videoId}>
                  <VideoCard
                    video={video}
                    selection={
                      selection
                        ? {
                            selected: selection.selectedIds.has(video.videoId),
                            onToggle: () => selection.onToggle(video.videoId),
                          }
                        : undefined
                    }
                  />
                </li>
              ))}
            </ul>
            {hiddenCount > 0 ? (
              <div className="mt-6 flex flex-col items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => setVisibleCount((count) => count + FEED_PAGE_SIZE)}
                >
                  <ChevronDown aria-hidden="true" />
                  Load more
                </Button>
                <p aria-live="polite" className="text-xs text-muted-foreground">
                  Showing {shownItems.length} of {activeItems.length}{" "}
                  {activeTab === "videos" ? "videos" : "livestreams"} — the rest load in place.
                </p>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyTabState
            tab={activeTab}
            hasEverRefreshed={hasEverRefreshed}
            creatorName={creatorName}
          />
        )}
      </div>
    </div>
  );
}

function EmptyTabState({
  tab,
  hasEverRefreshed,
  creatorName,
}: {
  tab: FeedTabKey;
  hasEverRefreshed: boolean;
  creatorName?: string;
}) {
  const isVideos = tab === "videos";
  const subject = isVideos ? "recent videos" : "livestreams";

  if (!hasEverRefreshed) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
        <span
          aria-hidden="true"
          className="flex size-14 items-center justify-center rounded-full bg-muted"
        >
          <ListVideo className="size-7 text-muted-foreground" />
        </span>
        <h3 className="text-base font-semibold">Nothing cached yet</h3>
        <p className="max-w-md text-balance text-sm text-muted-foreground [overflow-wrap:anywhere]">
          Use <strong>Refresh feed</strong> to fetch {creatorName ?? "this creator"}&apos;s latest{" "}
          {subject} with yt-dlp. Only metadata is stored — nothing is downloaded.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
      <span
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-full bg-muted"
      >
        <FileQuestion className="size-7 text-muted-foreground" />
      </span>
      <h3 className="text-base font-semibold">No {subject} found</h3>
      <p className="max-w-md text-balance text-sm text-muted-foreground [overflow-wrap:anywhere]">
        The last successful refresh did not find any {subject} on this channel. Try refreshing again
        later.
      </p>
    </div>
  );
}
