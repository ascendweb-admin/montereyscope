"use client";

import { useMemo, useState } from "react";
import { ListChecks, X } from "lucide-react";

import { ChatPanel } from "@/components/ai/chat-panel";
import type { ChatSource } from "@/components/ai/citation";
import { ScopeSelectionBar, type ScopeSelectionNote } from "@/components/ai/scope-selection-bar";
import { FeedTabs } from "@/components/channel/feed-tabs";
import type { VideoCardModel } from "@/components/channel/video-card";
import { Button } from "@/components/ui/button";
import { formatScopeCapMessage, MAX_SCOPE_VIDEOS, planChatScope } from "@/lib/ai/scope-selection";

interface SelectableFeedProps {
  videos: VideoCardModel[];
  livestreams: VideoCardModel[];
  hasEverRefreshed: boolean;
  creatorName?: string;
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
}: SelectableFeedProps) {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [chatOpen, setChatOpen] = useState(false);
  const [note, setNote] = useState<ScopeSelectionNote | null>(null);

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
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
      })),
    [videos, livestreams],
  );
  const hasVideos = videos.length + livestreams.length > 0;

  const toggleVideo = (videoId: string): void => {
    // The analysis cap is enforced at selection time: the 26th tick is
    // refused with a note instead of silently breaking a later chat.
    if (!selectedIds.has(videoId) && selectedIds.size >= MAX_SCOPE_VIDEOS) {
      setNote({ tone: "danger", message: formatScopeCapMessage(selectedIds.size + 1) });
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

  const description = creatorName
    ? `${plan.videoIds.length} ${plan.videoIds.length === 1 ? "video" : "videos"} from ${creatorName}`
    : undefined;

  return (
    <div>
      <FeedTabs
        videos={videos}
        livestreams={livestreams}
        hasEverRefreshed={hasEverRefreshed}
        creatorName={creatorName}
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
            onChat={openChat}
            onClear={clearSelection}
            note={note}
          />
        </div>
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
