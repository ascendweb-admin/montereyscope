"use client";

import Link from "next/link";
import { useId } from "react";
import { Radio, CalendarClock, History } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { cn } from "@/lib/utils";

/** Preformatted card model — built on the server so labels never drift. */
export interface VideoCardModel {
  videoId: string;
  title: string;
  detailHref: string;
  thumbnailUrl: string | null;
  publishedLabel: string | null;
  durationLabel: string | null;
  liveStatus: "not_live" | "is_live" | "was_live" | "upcoming" | "unknown";
  /** Whether a cached transcript exists — shown while selecting (stage 5). */
  hasTranscript: boolean;
}

/** When present, the card is a selection target instead of a link. */
export interface VideoCardSelection {
  selected: boolean;
  onToggle: () => void;
}

const CARD_CLASSES =
  "group relative flex h-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

const SELECTED_CLASSES = "border-ring bg-accent/40 ring-2 ring-ring/40";

const LIVE_BADGE_TEXT: Record<VideoCardModel["liveStatus"], string | null> = {
  is_live: "Live",
  upcoming: "Upcoming",
  was_live: "Past live",
  not_live: null,
  unknown: null,
};

function LiveBadge({ liveStatus }: { liveStatus: VideoCardModel["liveStatus"] }) {
  switch (liveStatus) {
    case "is_live":
      return (
        <Badge className="gap-1 border-transparent bg-red-700 text-white shadow-sm">
          <Radio aria-hidden="true" className="size-3" />
          Live
        </Badge>
      );
    case "upcoming":
      return (
        <Badge className="gap-1 border-transparent bg-amber-400 text-amber-950 shadow-sm">
          <CalendarClock aria-hidden="true" className="size-3" />
          Upcoming
        </Badge>
      );
    case "was_live":
      return (
        <Badge variant="secondary" className="gap-1 bg-card/90 text-card-foreground shadow-sm">
          <History aria-hidden="true" className="size-3" />
          Past live
        </Badge>
      );
    default:
      return null;
  }
}

/**
 * One cached feed item. Thumbnails render straight from their remote URL
 * with a plain <img> — scope never downloads or stores image binaries.
 *
 * By default the whole card is a link to the local video detail route. With
 * a `selection` prop (stage 5) the card stops being a link: a checkbox
 * lands on the thumbnail, an invisible label over the whole card toggles
 * the selection, and selected cards get a ring treatment. The "No
 * transcript" chip only appears while selecting, where the information
 * drives the chat-scope decision.
 */
export function VideoCard({
  video,
  selection,
}: {
  video: VideoCardModel;
  selection?: VideoCardSelection;
}) {
  const checkboxId = useId();
  const badgeText = LIVE_BADGE_TEXT[video.liveStatus];
  const badge = badgeText !== null ? <LiveBadge liveStatus={video.liveStatus} /> : null;
  const showDurationChip = badge === null && Boolean(video.durationLabel);

  const body = (
    <>
      <div className="relative aspect-video w-full bg-muted">
        {video.thumbnailUrl ? (
          // Remote thumbnail URL only — binaries are never stored locally.
          <img src={video.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-full items-center justify-center px-2 text-center text-xs text-muted-foreground"
          >
            No preview image
          </span>
        )}
        {badge ? (
          <span className="absolute right-1.5 bottom-1.5 flex items-center gap-1">{badge}</span>
        ) : null}
        {showDurationChip ? (
          <span className="absolute right-1.5 bottom-1.5 rounded-md bg-black/80 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white">
            {video.durationLabel}
          </span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm leading-snug font-medium group-hover:underline [overflow-wrap:anywhere]">
          {video.title}
        </h3>
        <p className="mt-auto text-xs text-muted-foreground">
          {video.publishedLabel ?? "Date unknown"}
          {badgeText !== null ? <span className="sr-only"> — {badgeText}</span> : null}
        </p>
      </div>
    </>
  );

  if (!selection) {
    return (
      <Link href={video.detailHref} className={cn(CARD_CLASSES, "hover:border-ring/40")}>
        {body}
      </Link>
    );
  }

  return (
    <div className={cn(CARD_CLASSES, selection.selected ? SELECTED_CLASSES : undefined)}>
      {body}
      {!video.hasTranscript ? (
        <span className="absolute top-2 right-2 z-20 rounded-md bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
          No transcript
        </span>
      ) : null}
      <SelectionCheckbox
        id={checkboxId}
        className="absolute top-2 left-2 z-20"
        checked={selection.selected}
        onChange={selection.onToggle}
        aria-label={`Select ${video.title}`}
      />
      {/* Invisible overlay: the whole card toggles the checkbox, while the
          input itself keeps native focus, keyboard, and checked semantics. */}
      <label htmlFor={checkboxId} className="absolute inset-0 z-10 cursor-pointer" />
    </div>
  );
}
