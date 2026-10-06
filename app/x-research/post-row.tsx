"use client";

import { useState } from "react";
import { ExternalLink, Quote, Repeat2 } from "lucide-react";

import {
  TweetMetrics,
  TweetStatusBadge,
} from "@/components/channel/tweet-card";
import { creatorAvatarStyle } from "@/components/library/creator-card";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/format";
import type { ResearchPost } from "@/lib/x/research/model";
import type { TweetViewModel } from "@/lib/x/view-model";
import { cn } from "@/lib/utils";

const TEXT_CLAMP_LENGTH = 400;

function isLong(tweet: TweetViewModel): boolean {
  return tweet.text.length > TEXT_CLAMP_LENGTH || tweet.text.includes("\n\n");
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function AuthorLine({ tweet }: { tweet: TweetViewModel }) {
  const avatarSrc = localAvatarSrc(tweet.authorAvatarUrl, tweet.creatorId);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {avatarSrc ? (
        // Streams through the local avatar proxy: same-origin, nothing stored.
        <img
          src={avatarSrc}
          alt=""
          loading="lazy"
          className="size-10 shrink-0 rounded-full border border-border object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-xs font-semibold",
            creatorAvatarStyle(tweet.authorName),
          )}
        >
          {initialsOf(tweet.authorName)}
        </span>
      )}
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0">
        <span className="truncate text-sm font-semibold leading-tight">{tweet.authorName}</span>
        <span className="truncate text-xs text-muted-foreground leading-tight">
          @{tweet.authorHandle}
        </span>
      </span>
    </span>
  );
}

function QuotedBlock({ tweet }: { tweet: TweetViewModel }) {
  if (!tweet.quoted) {
    return null;
  }
  const label = tweet.quoted.name
    ? `${tweet.quoted.name}${tweet.quoted.handle ? ` @${tweet.quoted.handle}` : ""}`
    : tweet.quoted.handle
      ? `@${tweet.quoted.handle}`
      : "Quoted post";
  return (
    <blockquote className="mt-2.5 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
      <p className="truncate text-xs font-medium text-muted-foreground">Quoting {label}</p>
      <p className="mt-1 line-clamp-4 leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {tweet.quoted.text}
      </p>
    </blockquote>
  );
}

function MediaPreview({ tweet }: { tweet: TweetViewModel }) {
  const photos = tweet.media.filter((item) => item.kind === "photo" && item.previewUrl);
  if (tweet.media.length === 0 || photos.length === 0) {
    return null;
  }
  return (
    <div className="mt-2.5 flex flex-wrap gap-2">
      {photos.slice(0, 2).map((item) => (
        // Remote image URL only — binaries are never stored locally.
        <img
          key={item.url}
          src={item.previewUrl ?? item.url}
          alt={item.altText ?? ""}
          loading="lazy"
          className="h-32 w-auto rounded-lg border object-cover"
        />
      ))}
    </div>
  );
}

/**
 * One cached post as an X-style timeline row: avatar, byline, text, and the
 * research metadata (post type, provenance, exact-match highlights) kept to
 * a quiet footer. The checkbox selects the post for a question scope; the
 * card body itself is not a click target — Details and Open on X stay
 * separate, unambiguous actions.
 */
export function PostRow({
  post,
  selected,
  onToggleSelect,
  onOpenDetail,
}: {
  post: ResearchPost;
  selected: boolean;
  onToggleSelect: (checked: boolean) => void;
  onOpenDetail: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { tweet } = post;
  const long = isLong(tweet);
  const eventLabel = formatRelativeTime(post.eventAt);
  const eventAbsolute = formatAbsoluteTimestamp(post.eventAt);
  const publishedLabel = formatRelativeTime(tweet.publishedAt);

  const timeElement = (
    <time
      dateTime={post.eventAt}
      title={eventAbsolute ?? undefined}
      className="shrink-0 text-xs text-muted-foreground"
      suppressHydrationWarning
    >
      {eventLabel ?? "Date unknown"}
    </time>
  );

  return (
    <li
      className={cn(
        "group relative transition-colors motion-reduce:transition-none",
        selected ? "bg-accent/50" : "hover:bg-accent/25",
      )}
    >
      <div className="flex gap-3 px-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <AuthorLine tweet={tweet} />
              <span aria-hidden="true" className="text-xs text-muted-foreground">
                ·
              </span>
              {timeElement}
              {post.postType === "quote" ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Quote aria-hidden="true" className="size-3" />
                  Quote
                </span>
              ) : null}
              {tweet.isRepost ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                  <Repeat2 aria-hidden="true" className="size-3" />
                  Repost
                </span>
              ) : null}
              {tweet.timelineKind === "reply" && !tweet.isRepost ? (
                <span className="truncate text-xs text-muted-foreground">
                  Replying to @{tweet.inReplyToHandle ?? "…"}
                </span>
              ) : null}
            </div>
            <SelectionCheckbox
              aria-label={`Select this post for the question scope`}
              checked={selected}
              onChange={(event) => onToggleSelect(event.target.checked)}
              className={cn(
                "absolute top-4 right-4 transition-opacity",
                selected ? "opacity-100" : "opacity-50 hover:opacity-100",
              )}
            />
          </div>

          <div className="mt-1.5 pr-8">
            {tweet.text.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                The post text could not be read. Open the details to fetch it again.
              </p>
            ) : (
              <p
                className={cn(
                  "text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
                  long && !expanded && "line-clamp-8",
                )}
              >
                {tweet.text}
              </p>
            )}
            {long ? (
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
                className="mt-0.5 inline-block text-xs font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {expanded ? "Show less" : "Read more"}
              </button>
            ) : null}
            <QuotedBlock tweet={tweet} />
            <MediaPreview tweet={tweet} />
          </div>

          {post.match ? (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted-foreground">
                Matched in {post.postType === "quote" ? "own commentary" : "post text"}:
              </span>
              {[
                ...post.match.terms.map((term) => ({ kind: "term" as const, value: term })),
                ...post.match.aliases.map((alias) => ({ kind: "alias" as const, value: alias })),
              ].map((item) => (
                <span
                  key={`${item.kind}-${item.value}`}
                  className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-300"
                >
                  {item.kind === "alias" ? `alias: ${item.value}` : item.value}
                </span>
              ))}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <TweetMetrics tweet={tweet} />
            {post.postType === "repost" && tweet.publishedAt ? (
              <span className="inline-flex items-center gap-1">
                <Repeat2 aria-hidden="true" className="size-3" />
                Original by @{tweet.authorHandle} · {publishedLabel ?? "date unknown"}
              </span>
            ) : null}
            {post.provenance
              .filter(
                (p) =>
                  p.kind === "repost" ||
                  (p.handle ? p.handle !== tweet.authorHandle : p.name !== tweet.authorName),
              )
              .map((p) => (
                <span key={`${p.creatorId}-${p.kind}`} className="truncate">
                  {p.kind === "repost" ? "Shared by" : "In timeline of"} @
                  {p.handle ?? p.name}
                </span>
              ))}
            {tweet.contentStatus !== "complete" ? <TweetStatusBadge tweet={tweet} /> : null}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={onOpenDetail}
                className="rounded-md px-2 py-1 font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Details
              </button>
              <a
                href={tweet.url}
                target="_blank"
                rel="noreferrer"
                title="Open on X (opens in a new tab)"
                aria-label="Open on X (opens in a new tab)"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </span>
          </div>
        </div>
      </div>
    </li>
  );
}
