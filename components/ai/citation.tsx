import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FileText, SquarePlay } from "lucide-react";

import { SearchAvatar } from "@/components/library/creator-search-results";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { PLATFORM_LABELS } from "@/lib/creators/labels";
import { formatDate, formatDuration, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ChatSource } from "@/lib/content/chat-source";
export type { ChatSource } from "@/lib/content/chat-source";

/**
 * Source citations for AI answers (chat): a compact pill naming the source a
 * finding comes from, so transcript and post references read as designed
 * attributions instead of raw file paths. The renderer upgrades the first
 * `transcripts/<videoId>.txt` or `tweets/<tweetId>.txt` mention per answer
 * into one of these; hovering (or focusing) the pill opens a preview card
 * with the thumbnail, platform, full title, creator, and publish date.
 */

/**
 * Builds the source index the Markdown renderer resolves against. Video
 * sources keep their bare id as the key (existing callers and tests build
 * those maps by hand); tweets are namespaced so a numeric post id can never
 * collide with a video id.
 */
export function indexChatSources(sources: readonly ChatSource[]): Map<string, ChatSource> {
  return new Map(
    sources.map((source) => [source.kind === "tweet" ? `tweet:${source.id}` : source.id, source]),
  );
}

/** Hover grace period so sweeping the cursor across text never flashes cards. */
export const CITATION_OPEN_DELAY_MS = 150;

/** The citation pill's look, shared with the X Dashboard's post citations. */
export const CITATION_PILL =
  "inline-flex max-w-[min(12rem,100%)] items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.07] py-px pr-2 align-middle text-[0.85em] leading-5 font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring";
/** Preview card geometry, kept in sync with the w-80 card below. */
const CARD_WIDTH = 320;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;
/** Viewport room below the pill that still allows the card under it. */
const CARD_MIN_BELOW = 340;

type SourcePlatform = "youtube" | "rumble" | "x";

/** Faint brand wash behind a card that has no preview image. */
const PLATFORM_PLATE: Record<SourcePlatform, string> = {
  youtube: "bg-gradient-to-br from-[#FF0000]/20 via-muted to-muted",
  rumble: "bg-gradient-to-br from-[#85C742]/25 via-muted to-muted",
  x: "bg-gradient-to-br from-foreground/10 via-muted to-muted",
};

function platformOf(source: ChatSource): SourcePlatform | null {
  return source.kind === "tweet" ? "x" : (source.platform ?? null);
}

/** "YouTube video", "X post", or plain "Video" when the platform is unknown. */
function sourceTypeLabel(source: ChatSource): string {
  if (source.kind === "tweet") {
    return "X post";
  }
  return source.platform ? `${PLATFORM_LABELS[source.platform]} video` : "Video";
}

/** The hosting channel, when the creator is someone who appears on it instead of owning it. */
function hostedOn(source: ChatSource): string | null {
  return source.creator && source.channelName && source.channelName !== source.creator
    ? source.channelName
    : null;
}

function PlatformMark({
  platform,
  className,
}: {
  platform: SourcePlatform | null;
  className?: string;
}) {
  if (platform === "x") {
    return <XLogo aria-hidden="true" className={cn("text-foreground", className)} />;
  }
  if (platform === "rumble") {
    return <RumbleLogo aria-hidden="true" className={className} />;
  }
  if (platform === "youtube") {
    return <YouTubeLogo aria-hidden="true" className={className} />;
  }
  return <SquarePlay aria-hidden="true" className={cn("text-primary", className)} />;
}

interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
}

/**
 * One inline source citation, ChatGPT citation-style: a small pill with the
 * platform mark and channel (or title, when no creator is known) that
 * expands on hover into a preview card, so the full citation is always one
 * glance away without ever shouting in the text flow.
 */
export function SourceCitation({ source, className }: { source: ChatSource; className?: string }) {
  const [card, setCard] = useState<CardPosition | null>(null);
  const openTimer = useRef<number | null>(null);

  const openCard = (target: HTMLElement): void => {
    const rect = target.getBoundingClientRect();
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - CARD_WIDTH / 2, VIEWPORT_MARGIN),
      Math.max(window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );
    // Fixed positioning relative to the viewport, not the pill's inline box,
    // so message scrollers can't clip the card; flip above when tight.
    setCard(
      window.innerHeight - rect.bottom >= CARD_MIN_BELOW
        ? { left, top: rect.bottom + CARD_GAP }
        : { left, bottom: window.innerHeight - rect.top + CARD_GAP },
    );
  };

  const openAfterDelay = (target: HTMLElement): void => {
    if (openTimer.current !== null) {
      return;
    }
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      openCard(target);
    }, CITATION_OPEN_DELAY_MS);
  };

  const closeCard = (): void => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    setCard(null);
  };

  // A pending timer must not fire after unmount.
  useEffect(() => closeCard, []);

  const isTweet = source.kind === "tweet";
  const platform = platformOf(source);
  const typeLabel = isTweet ? "X post" : `${sourceTypeLabel(source)} transcript`;
  const channelName = hostedOn(source);
  const label = source.creator
    ? `${typeLabel} — ${source.title} by ${source.creator}${channelName ? ` on ${channelName}` : ""}`
    : `${typeLabel} — ${source.title}`;
  const href = isTweet ? `https://x.com/i/status/${encodeURIComponent(source.id)}` : undefined;
  const published = source.publishedAt?.slice(0, 10) ?? "Publication date unknown";
  const Tag = isTweet ? "a" : "span";
  return (
    <Tag
      href={
        isTweet &&
        source.url?.match(
          /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[^?#]+\/status\/\d+(?:[?#].*)?$/,
        )
          ? source.url
          : href
      }
      target={isTweet ? "_blank" : undefined}
      rel={isTweet ? "noopener noreferrer" : undefined}
      tabIndex={0}
      aria-label={isTweet ? `${label} · ${published} · Open on X` : label}
      onMouseEnter={(event) => openAfterDelay(event.currentTarget)}
      onMouseLeave={closeCard}
      onFocus={(event) => openCard(event.currentTarget)}
      onBlur={closeCard}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          closeCard();
        }
      }}
      className={cn(CITATION_PILL, "pl-1.5", className)}
    >
      <PlatformMark
        platform={platform}
        className={cn("shrink-0", platform === "x" ? "size-2.5" : "size-3.5")}
      />
      <span className="min-w-0 truncate text-foreground">{source.creator ?? source.title}</span>
      {isTweet ? <span className="text-muted-foreground"> · {published}</span> : null}
      {card ? <SourcePreviewCard source={source} position={card} /> : null}
    </Tag>
  );
}

/**
 * The hover preview: thumbnail with platform and duration badges, the full
 * title, a creator byline with avatar and publish date, and a footer naming
 * what was cited. Content is non-interactive and pointer-transparent —
 * moving toward the card (or anywhere off the pill) simply closes it.
 */
function SourcePreviewCard({ source, position }: { source: ChatSource; position: CardPosition }) {
  const isTweet = source.kind === "tweet";
  const platform = platformOf(source);
  const platformName = platform ? PLATFORM_LABELS[platform] : null;
  const date = formatDate(source.publishedAt);
  const relative = formatRelativeTime(source.publishedAt);
  const dateLine = [date, relative].filter(Boolean).join(" · ");
  const channelName = hostedOn(source);
  const duration =
    typeof source.durationSeconds === "number" && source.durationSeconds > 0
      ? formatDuration(source.durationSeconds)
      : null;
  return (
    <span
      aria-hidden="true"
      style={{ left: position.left, top: position.top, bottom: position.bottom }}
      className="pointer-events-none fixed z-50 block w-80 font-normal whitespace-normal"
    >
      <span
        className={cn(
          "block overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/30 ring-1 ring-black/5 motion-safe:animate-popover-in",
          position.bottom !== undefined ? "origin-bottom" : "origin-top",
        )}
      >
        <span
          className={cn(
            "relative block aspect-video",
            platform ? PLATFORM_PLATE[platform] : "bg-muted",
          )}
        >
          {source.thumbnailUrl ? (
            <img
              src={source.thumbnailUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center">
              <PlatformMark
                platform={platform}
                className={cn("opacity-60", platform === "x" ? "size-8" : "size-12")}
              />
            </span>
          )}
          {source.thumbnailUrl ? (
            <span className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/40" />
          ) : null}
          {platformName ? (
            <span className="absolute top-2 left-2 inline-flex items-center gap-1.5 rounded-full bg-black/70 py-0.5 pr-2 pl-1.5 text-[11px] leading-4 font-medium text-white ring-1 ring-white/10 backdrop-blur-sm">
              <PlatformMark
                platform={platform}
                className={cn(platform === "x" ? "size-2.5 text-white" : "size-3.5")}
              />
              {platformName}
            </span>
          ) : null}
          {duration ? (
            <span className="absolute right-2 bottom-2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] leading-4 font-semibold text-white tabular-nums">
              {duration}
            </span>
          ) : null}
        </span>
        <span className="block space-y-3 px-3.5 pt-3 pb-3.5">
          <span
            className={cn(
              "block text-sm leading-snug font-semibold text-foreground [overflow-wrap:anywhere]",
              isTweet ? "line-clamp-3" : "line-clamp-2",
            )}
          >
            {source.title}
          </span>
          {source.creator || dateLine ? (
            <span className="flex items-center gap-2.5">
              {source.creator ? (
                <SearchAvatar
                  name={source.creator}
                  src={source.creatorAvatarUrl ?? null}
                  className="size-7 text-[10px]"
                />
              ) : null}
              <span className="block min-w-0 flex-1">
                {source.creator ? (
                  <span className="block truncate text-xs font-medium text-foreground">
                    {source.creator}
                    {channelName ? (
                      <span className="font-normal text-muted-foreground"> on {channelName}</span>
                    ) : null}
                  </span>
                ) : null}
                {dateLine ? (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {dateLine}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </span>
        <span className="flex items-center justify-between gap-3 border-t border-border bg-muted/40 px-3.5 py-2 text-[11px] text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <PlatformMark
              platform={platform}
              className={cn("shrink-0", platform === "x" ? "size-2.5" : "size-3.5")}
            />
            <span className="truncate">{sourceTypeLabel(source)}</span>
          </span>
          {isTweet ? (
            <span className="inline-flex shrink-0 items-center gap-0.5">
              Open on X
              <ArrowUpRight aria-hidden="true" className="size-3" />
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1">
              <FileText aria-hidden="true" className="size-3" />
              Cited from transcript
            </span>
          )}
        </span>
      </span>
    </span>
  );
}
