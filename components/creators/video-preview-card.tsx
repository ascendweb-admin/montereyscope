import { Badge } from "@/components/ui/badge";
import { RumbleLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { VideoPreview } from "@/lib/videos/import/service";

const PLATFORM_NAMES: Record<VideoPreview["platform"], string> = {
  youtube: "YouTube",
  rumble: "Rumble",
};

/** Whether the English captions were written by a person or generated. */
export function CaptionsChip({ captions }: { captions: VideoPreview["captions"] }) {
  return (
    <Badge variant="outline" className="font-normal">
      {captions === "manual" ? "Human captions" : "Auto captions"}
    </Badge>
  );
}

/** The platform's mark with its name, e.g. "▶ YouTube". */
export function PlatformMark({ platform }: { platform: VideoPreview["platform"] }) {
  const Logo = platform === "rumble" ? RumbleLogo : YouTubeLogo;
  return (
    <span className="inline-flex items-center gap-1">
      <Logo aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only">{PLATFORM_NAMES[platform]}</span>
    </span>
  );
}

/**
 * What a resolved video link looks like before it is added: thumbnail, title,
 * the channel that hosts it, length, platform, and the caption kind that the
 * English-caption check found. Shared by the Add videos dialog's rows and any
 * single-video preview.
 */
export function VideoPreviewSummary({
  preview,
  className,
}: {
  preview: VideoPreview;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-1 items-start gap-3", className)}>
      <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted sm:w-32">
        {preview.thumbnailUrl ? (
          // Remote thumbnail URL only — binaries are never stored locally.
          <img
            src={preview.thumbnailUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="size-full object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-full items-center justify-center px-1 text-center text-[10px] text-muted-foreground"
          >
            No preview
          </span>
        )}
        {preview.durationSeconds !== null ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/80 px-1 font-mono text-[10px] leading-4 font-medium text-white">
            {formatDuration(preview.durationSeconds)}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm leading-snug font-medium [overflow-wrap:anywhere]">
          {preview.title}
        </p>
        <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <PlatformMark platform={preview.platform} />
          <span className="truncate">{preview.hostName}</span>
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <CaptionsChip captions={preview.captions} />
        </div>
      </div>
    </div>
  );
}
