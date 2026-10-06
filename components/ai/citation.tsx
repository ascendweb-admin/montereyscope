import { useEffect, useRef, useState } from "react";
import { SquarePlay } from "lucide-react";

import { XLogo } from "@/components/ui/platform-logos";
import { cn } from "@/lib/utils";

/**
 * Source citations for AI answers (chat): a compact pill naming the source a
 * finding comes from, so transcript and post references read as designed
 * attributions instead of raw file paths. The renderer upgrades the first
 * `transcripts/<videoId>.txt` or `tweets/<tweetId>.txt` mention per answer
 * into one of these; hovering (or focusing) the pill opens a preview card
 * with the thumbnail (when any), full title, and creator/author.
 */
export interface ChatSource {
  /** The video id or tweet id the source file is named after. */
  id: string;
  /** Defaults to "video" for pre-mixed-source callers. */
  kind?: "video" | "tweet";
  url?: string;
  publishedAt?: string | null;
  title: string;
  creator?: string;
  /** Stored remote preview image; absent or null renders a plain plate. */
  thumbnailUrl?: string | null;
}

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
const OPEN_DELAY_MS = 150;
/** Preview card geometry, kept in sync with the w-72 card below. */
const CARD_WIDTH = 288;
const CARD_GAP = 8;
const VIEWPORT_MARGIN = 8;
/** Viewport room below the pill that still allows the card under it. */
const CARD_MIN_BELOW = 240;

interface CardPosition {
  left: number;
  top?: number;
  bottom?: number;
}

/**
 * One inline source citation, ChatGPT citation-style: a small pill with the
 * channel (or title, when no creator is known) that expands on hover into a
 * preview card — thumbnail, full title, creator — so the full citation is
 * always one glance away without ever shouting in the text flow.
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
    }, OPEN_DELAY_MS);
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
  const label = source.creator
    ? `${isTweet ? "X post" : "Video transcript"} — ${source.title} by ${source.creator}`
    : `${isTweet ? "X post" : "Video transcript"} — ${source.title}`;
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
      className={cn(
        "inline-flex max-w-[min(12rem,100%)] items-center gap-1 rounded-full border border-primary/25 bg-primary/[0.07] py-px pr-2 pl-1.5 align-middle text-[0.85em] leading-5 font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {isTweet ? (
        <XLogo aria-hidden="true" className="size-2.5 shrink-0 text-foreground" />
      ) : (
        <SquarePlay aria-hidden="true" className="size-3 shrink-0 text-primary" />
      )}
      <span className="min-w-0 truncate text-foreground">{source.creator ?? source.title}</span>
      {isTweet ? <span className="text-muted-foreground"> · {published}</span> : null}
      {card ? <SourcePreviewCard source={source} position={card} /> : null}
    </Tag>
  );
}

/**
 * The hover preview: thumbnail on top, full title, then the creator line.
 * Content is non-interactive and pointer-transparent — moving toward the
 * card (or anywhere off the pill) simply closes it.
 */
function SourcePreviewCard({ source, position }: { source: ChatSource; position: CardPosition }) {
  const isTweet = source.kind === "tweet";
  return (
    <span
      aria-hidden="true"
      style={{ left: position.left, top: position.top, bottom: position.bottom }}
      className="pointer-events-none fixed z-50 block w-72"
    >
      <span className="block overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
        <span className="block aspect-video bg-muted">
          {source.thumbnailUrl ? (
            <img
              src={source.thumbnailUrl}
              alt=""
              loading="lazy"
              className="size-full object-cover"
            />
          ) : (
            <span className="flex size-full items-center justify-center text-muted-foreground">
              {isTweet ? (
                <XLogo aria-hidden="true" className="size-6 opacity-40" />
              ) : (
                <span className="text-xs">No preview image</span>
              )}
            </span>
          )}
        </span>
        <span className="block space-y-1 p-3">
          <span className="block line-clamp-2 text-sm leading-snug font-semibold whitespace-normal text-foreground [overflow-wrap:anywhere]">
            {source.title}
          </span>
          <span className="block text-xs text-muted-foreground">
            {source.creator ? `${source.creator} · ` : ""}
            {isTweet ? "X post" : "Video transcript"}
          </span>
        </span>
      </span>
    </span>
  );
}
