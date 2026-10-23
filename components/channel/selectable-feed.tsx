"use client";

import { useMemo, useState } from "react";
import { ListChecks, X } from "lucide-react";

import { ChatPanel } from "@/components/ai/chat-panel";
import type { ChatSource } from "@/components/ai/citation";
import { ScopeSelectionBar, type ScopeSelectionNote } from "@/components/ai/scope-selection-bar";
import { FeedTabs } from "@/components/channel/feed-tabs";
import type { VideoCardModel } from "@/components/channel/video-card";
import { PlatformFilter } from "@/components/library/platform-filter";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PLATFORM_LABELS } from "@/lib/creators/labels";
import type { CreatorPlatform } from "@/lib/creators/repository";
import {
  estimateScopeLoad,
  formatVideoHours,
  planChatScope,
  scopeAdditionProblem,
  scopeReading,
  SCOPE_READING_COPY,
} from "@/lib/ai/scope-selection";

interface SelectableFeedProps {
  videos: VideoCardModel[];
  livestreams: VideoCardModel[];
  hasEverRefreshed: boolean;
  creatorName?: string;
  /**
   * The account's platform and avatar, for the answers' citation previews. A
   * card's own `platform` wins, for feeds that mix channels.
   */
  platform?: "youtube" | "rumble";
  creatorAvatarUrl?: string | null;
  /** One plain list instead of the Videos / Livestreams switcher (see FeedTabs). */
  singleList?: boolean;
  /** Filter a single list by the platform hosting each video. */
  showPlatformFilter?: boolean;
  /**
   * Adds a Remove action to the selection bar, behind a confirmation. Resolves
   * once the videos are gone, or rejects with a message to show.
   */
  onRemove?: (videoIds: string[]) => Promise<void>;
}

/**
 * The channel feed with selection (stage 5): a "Select videos" toggle puts
 * checkboxes on every card across both tabs, and the floating action bar —
 * which only appears once something is selected — opens the shared chat
 * panel over the selection. Every video can be analyzed: captions are read
 * in the background when the chat starts.
 */
export function SelectableFeed({
  videos,
  livestreams,
  hasEverRefreshed,
  creatorName,
  platform,
  creatorAvatarUrl,
  singleList,
  showPlatformFilter = false,
  onRemove,
}: SelectableFeedProps) {
  const [selecting, setSelecting] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [chatOpen, setChatOpen] = useState(false);
  const [note, setNote] = useState<ScopeSelectionNote | null>(null);
  const [platformFilter, setPlatformFilter] = useState<CreatorPlatform | "all">("all");
  const filteredVideos =
    platformFilter === "all"
      ? videos
      : videos.filter((video) => (video.platform ?? platform) === platformFilter);

  // The scope follows the feed order (videos, then livestreams), not click
  // order, so the same selection always produces the same conversation key.
  const plan = useMemo(
    () =>
      planChatScope(
        [...videos, ...livestreams]
          .filter((video) => selectedIds.has(video.videoId))
          .map((video) => ({ id: video.videoId, title: video.title })),
      ),
    [videos, livestreams, selectedIds],
  );
  // Feed order doubles as the citation index: the chat panel resolves the
  // answers' transcript references into titled source chips against it.
  const sources = useMemo<ChatSource[]>(
    () =>
      [...videos, ...livestreams].map((video) => ({
        id: video.videoId,
        platform: video.platform ?? platform,
        title: video.title,
        creator: creatorName,
        // A card for an appearance names the channel that hosts it.
        ...(video.hostName ? { channelName: video.hostName } : {}),
        creatorAvatarUrl,
        publishedAt: video.publishedAt,
        durationSeconds: video.durationSeconds,
        thumbnailUrl: video.thumbnailUrl,
      })),
    [videos, livestreams, platform, creatorName, creatorAvatarUrl],
  );
  const hasVideos = filteredVideos.length + livestreams.length > 0;
  const durationById = useMemo(
    () =>
      new Map([...videos, ...livestreams].map((video) => [video.videoId, video.durationSeconds])),
    [videos, livestreams],
  );
  // What the selection holds: a three-hour stream weighs more than a clip.
  const load = useMemo(
    () =>
      estimateScopeLoad(
        [...selectedIds].map((id) => ({ kind: "video", durationSeconds: durationById.get(id) })),
      ),
    [selectedIds, durationById],
  );

  const toggleVideo = (videoId: string): void => {
    // The analysis limits are enforced at selection time: a tick past them
    // is refused with a note instead of silently breaking a later chat.
    const problem = selectedIds.has(videoId)
      ? null
      : scopeAdditionProblem(load, { kind: "video", durationSeconds: durationById.get(videoId) });
    if (problem !== null) {
      setNote({ tone: "danger", message: problem });
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(videoId)) {
        next.delete(videoId);
      } else {
        next.add(videoId);
      }
      return next;
    });
    setNote(null);
  };

  const clearSelection = (): void => {
    setSelectedIds(new Set());
    setNote(null);
  };

  const exitSelection = (): void => {
    setSelecting(false);
    clearSelection();
  };

  const changePlatform = (value: CreatorPlatform | "all"): void => {
    setPlatformFilter(value);
    exitSelection();
    setChatOpen(false);
  };

  const openChat = (): void => {
    if (plan.videoIds.length === 0) {
      return;
    }
    setNote(null);
    setChatOpen(true);
  };

  // Closing the panel when its scope empties adjusts state during render —
  // not in an effect — per React's guidance for reacting to derived changes
  // (the same pattern the chat panel uses for scope resets).
  const scopeEmpty = plan.videoIds.length === 0;
  const [renderedScopeEmpty, setRenderedScopeEmpty] = useState(scopeEmpty);
  if (renderedScopeEmpty !== scopeEmpty) {
    setRenderedScopeEmpty(scopeEmpty);
    if (scopeEmpty) {
      setChatOpen(false);
    }
  }

  // The scope follows the feed order, like the chat plan above.
  const selectedInOrder = (): string[] =>
    [...videos, ...livestreams].filter((v) => selectedIds.has(v.videoId)).map((v) => v.videoId);

  const closeRemoveDialog = (): void => {
    setConfirmingRemove(false);
    setRemoveError(null);
  };

  const confirmRemove = async (): Promise<void> => {
    if (!onRemove || removing) {
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    try {
      await onRemove(selectedInOrder());
      setConfirmingRemove(false);
      clearSelection();
    } catch (error) {
      setRemoveError(
        error instanceof Error && error.message
          ? error.message
          : "The videos could not be removed. Please try again.",
      );
    } finally {
      setRemoving(false);
    }
  };

  const description = creatorName
    ? `${plan.videoIds.length} ${plan.videoIds.length === 1 ? "video" : "videos"} from ${creatorName}`
    : undefined;

  return (
    <div>
      <FeedTabs
        videos={filteredVideos}
        livestreams={livestreams}
        hasEverRefreshed={hasEverRefreshed}
        creatorName={creatorName}
        singleList={singleList}
        headerFilter={
          showPlatformFilter ? (
            <PlatformFilter value={platformFilter} content="videos" onChange={changePlatform} />
          ) : undefined
        }
        emptyState={
          platformFilter !== "all" ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
              <h3 className="text-base font-semibold">
                No videos from {PLATFORM_LABELS[platformFilter]}
              </h3>
              <p className="max-w-md text-balance text-sm text-muted-foreground">
                Try another platform or show all platforms to see the other videos.
              </p>
              <Button variant="outline" size="sm" onClick={() => changePlatform("all")}>
                Show all platforms
              </Button>
            </div>
          ) : undefined
        }
        headerAction={
          hasVideos ? (
            <Button
              variant={selecting ? "secondary" : "outline"}
              size="sm"
              onClick={selecting ? exitSelection : () => setSelecting(true)}
            >
              {selecting ? <X aria-hidden="true" /> : <ListChecks aria-hidden="true" />}
              {selecting ? "Cancel" : "Select videos"}
            </Button>
          ) : null
        }
        selection={selecting ? { selectedIds, onToggle: toggleVideo } : undefined}
      />

      {selecting && selectedIds.size > 0 ? (
        <div className="pointer-events-none sticky bottom-4 z-20 mt-6 flex justify-center">
          <ScopeSelectionBar
            className="pointer-events-auto"
            count={selectedIds.size}
            skippedCount={0}
            detail={`${formatVideoHours(load.videoSeconds)} · ${SCOPE_READING_COPY[scopeReading(load)].label}`}
            onChat={openChat}
            onClear={clearSelection}
            onRemove={onRemove ? () => setConfirmingRemove(true) : undefined}
            note={note}
          />
        </div>
      ) : null}

      {onRemove ? (
        <ConfirmDialog
          open={confirmingRemove}
          onClose={closeRemoveDialog}
          title={`Remove ${selectedIds.size} ${selectedIds.size === 1 ? "video" : "videos"} from Other videos?`}
          description="Their transcripts are deleted if nothing else uses them."
          confirmLabel="Remove"
          busyLabel="Removing…"
          destructive
          busy={removing}
          onConfirm={() => void confirmRemove()}
        >
          {removeError ? <AlertNote tone="danger">{removeError}</AlertNote> : null}
        </ConfirmDialog>
      ) : null}

      <ChatPanel
        open={chatOpen}
        onClose={() => setChatOpen(false)}
        scope={plan.videoIds}
        sources={sources}
        description={description}
      />
    </div>
  );
}
