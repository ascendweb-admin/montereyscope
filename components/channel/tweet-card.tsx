"use client";

import { useState } from "react";
import { ExternalLink, Image as ImageIcon, MessageCircle, Repeat2, Heart } from "lucide-react";

import { XLogo } from "@/components/ui/platform-logos";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/dialog";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/format";
import type { TweetViewModel } from "@/lib/x/view-model";
import { cn } from "@/lib/utils";

const TEXT_CLAMP_LENGTH = 280;

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

/** Compact status line: is this post ready to use as analysis material? */
export function TweetStatusBadge({ tweet }: { tweet: Pick<TweetViewModel, "contentStatus"> }) {
  if (tweet.contentStatus === "complete") {
    return (
      <Badge variant="secondary" className="gap-1">
        Saved · Ready for analysis
      </Badge>
    );
  }
  if (tweet.contentStatus === "summary") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        Preview only — fetch full text
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      Content unavailable
    </Badge>
  );
}

export function TimelineKindBadge({
  tweet,
}: {
  tweet: Pick<TweetViewModel, "isRepost" | "repostedByHandle" | "timelineKind" | "inReplyToHandle">;
}) {
  if (tweet.isRepost) {
    return (
      <Badge variant="success" className="gap-1">
        <Repeat2 aria-hidden="true" className="size-3" />
        Repost{tweet.repostedByHandle ? ` by @${tweet.repostedByHandle}` : ""}
      </Badge>
    );
  }
  if (tweet.timelineKind === "reply") {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <MessageCircle aria-hidden="true" className="size-3" />
        Reply{tweet.inReplyToHandle ? ` to @${tweet.inReplyToHandle}` : ""}
      </Badge>
    );
  }
  return null;
}

function Metric({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: number | null;
  label: string;
}) {
  if (value === null) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-1" title={label}>
      {icon}
      {value.toLocaleString()}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function TweetMetrics({ tweet }: { tweet: TweetViewModel }) {
  const items = [
    {
      key: "replies",
      icon: <MessageCircle aria-hidden="true" className="size-3.5" />,
      value: tweet.replyCount,
      label: "replies",
    },
    {
      key: "reposts",
      icon: <Repeat2 aria-hidden="true" className="size-3.5" />,
      value: tweet.repostCount,
      label: "reposts",
    },
    {
      key: "likes",
      icon: <Heart aria-hidden="true" className="size-3.5" />,
      value: tweet.likeCount,
      label: "likes",
    },
  ].filter((item) => item.value !== null);
  if (items.length === 0) {
    return null;
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <Metric key={item.key} icon={item.icon} value={item.value} label={item.label} />
      ))}
    </span>
  );
}

/** Author byline shared by the card and the detail dialog. */
export function TweetAuthor({ tweet, size = "md" }: { tweet: TweetViewModel; size?: "sm" | "md" }) {
  const avatarSrc = localAvatarSrc(tweet.authorAvatarUrl, tweet.creatorId);
  const avatarClass = size === "sm" ? "size-8" : "size-10";
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {avatarSrc ? (
        // Streams through the local avatar proxy: same-origin, nothing stored.
        <img
          src={avatarSrc}
          alt=""
          loading="lazy"
          className={cn(avatarClass, "shrink-0 rounded-full border border-border object-cover")}
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            avatarClass,
            "flex shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold",
          )}
        >
          {initialsOf(tweet.authorName)}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold">{tweet.authorName}</span>
        <span className="block truncate text-xs text-muted-foreground">@{tweet.authorHandle}</span>
      </span>
    </span>
  );
}

function TweetBody({ tweet, clamp }: { tweet: TweetViewModel; clamp: boolean }) {
  if (tweet.text.length === 0) {
    return (
      <p className="text-sm text-muted-foreground italic">
        The post text could not be read. Fetch this post to try again.
      </p>
    );
  }
  return (
    <p
      className={cn(
        "text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
        clamp && "line-clamp-6",
      )}
    >
      {tweet.text}
    </p>
  );
}

function QuotedBlock({ tweet, clamp = true }: { tweet: TweetViewModel; clamp?: boolean }) {
  if (!tweet.quoted) {
    return null;
  }
  const label = tweet.quoted.name
    ? `${tweet.quoted.name}${tweet.quoted.handle ? ` @${tweet.quoted.handle}` : ""}`
    : tweet.quoted.handle
      ? `@${tweet.quoted.handle}`
      : "Quoted post";
  return (
    <blockquote className="mt-3 rounded-lg border bg-muted/20 px-3 py-2">
      <p className="text-xs font-medium text-muted-foreground">Quoting {label}</p>
      <p
        className={cn(
          "mt-1 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
          clamp && "line-clamp-3",
        )}
      >
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
    <div className="mt-3 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {photos.slice(0, 2).map((item) => (
          // Remote image URL only — binaries are never stored locally.
          <img
            key={item.url}
            src={item.previewUrl ?? item.url}
            alt={item.altText ?? ""}
            loading="lazy"
            className="h-28 w-auto rounded-lg border object-cover"
          />
        ))}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ImageIcon aria-hidden="true" className="size-3" />
        Media is not analyzed — only the post text is.
      </p>
    </div>
  );
}

export interface TweetCardProps {
  tweet: TweetViewModel;
  /** Whether selection controls are visible. */
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  onOpenDetail: () => void;
}

/**
 * One cached post as a readable text card. The card body is not a link:
 * selection is the checkbox, opening the full post is the explicit
 * "Read more" action, and "Open on X" is a separate link — never one
 * ambiguous click target (see the implementation plan).
 */
export function TweetCard({ tweet, selecting, selected, onToggle, onOpenDetail }: TweetCardProps) {
  const [expanded, setExpanded] = useState(false);
  const long = isLong(tweet);
  const published = tweet.publishedAt ? formatRelativeTime(tweet.publishedAt) : null;
  const publishedAbsolute = formatAbsoluteTimestamp(tweet.publishedAt);

  return (
    <li
      className={cn(
        "rounded-xl border bg-card text-card-foreground shadow-sm transition-colors motion-reduce:transition-none",
        selected ? "border-ring/60 bg-accent/20" : "hover:border-ring/40",
      )}
    >
      <div className="flex gap-3 p-4">
        {selecting ? (
          <div className="pt-1">
            <SelectionCheckbox
              checked={selected}
              onChange={onToggle}
              aria-label={`Select post by @${tweet.authorHandle}`}
            />
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <TweetAuthor tweet={tweet} size="sm" />
            <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
              <XLogo aria-hidden="true" className="size-3" />
              {tweet.publishedAt ? (
                <time dateTime={tweet.publishedAt} title={publishedAbsolute ?? undefined}>
                  {published}
                </time>
              ) : (
                <span>Date unknown</span>
              )}
            </span>
          </div>

          <div className="mt-2.5">
            <TweetBody tweet={tweet} clamp={long && !expanded} />
            <QuotedBlock tweet={tweet} />
            <MediaPreview tweet={tweet} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <TimelineKindBadge tweet={tweet} />
            <TweetMetrics tweet={tweet} />
            <TweetStatusBadge tweet={tweet} />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {long ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded((value) => !value)}
                aria-expanded={expanded}
              >
                {expanded ? "Show less" : "Read more"}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={onOpenDetail}>
              Details
            </Button>
            <a
              href={tweet.url}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open on X
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * The complete cached post: full body (never clamped), author, canonical
 * link, quote/reply context, metrics, and when it was cached.
 */
export function TweetDetailDialog({
  tweet,
  open,
  onClose,
  context,
}: {
  tweet: TweetViewModel | null;
  open: boolean;
  onClose: () => void;
  context?: React.ReactNode;
}) {
  if (!tweet) {
    return null;
  }
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Post details"
      description="Everything cached for this post, exactly as it was fetched."
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        <TweetAuthor tweet={tweet} />
        {context}
        <div className="rounded-lg border bg-muted/10 p-4">
          <TweetBody tweet={tweet} clamp={false} />
          <QuotedBlock tweet={tweet} clamp={false} />
          <MediaPreview tweet={tweet} />
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="font-medium text-foreground">Canonical link</dt>
            <dd className="truncate">
              <a
                href={tweet.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {tweet.url}
              </a>
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Published</dt>
            <dd>{formatAbsoluteTimestamp(tweet.publishedAt) ?? "Unknown"}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Fetched</dt>
            <dd>{formatAbsoluteTimestamp(tweet.fetchedAt) ?? "Unknown"}</dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Timeline event</dt>
            <dd>
              {tweet.isRepost
                ? `Repost${tweet.repostedByHandle ? ` by @${tweet.repostedByHandle}` : ""}`
                : tweet.timelineKind === "reply"
                  ? `Reply${tweet.inReplyToHandle ? ` to @${tweet.inReplyToHandle}` : ""}`
                  : "Original post"}
            </dd>
          </div>
          <div>
            <dt className="font-medium text-foreground">Cached content</dt>
            <dd>
              {tweet.contentStatus === "complete"
                ? "Complete text"
                : tweet.contentStatus === "summary"
                  ? "Preview only"
                  : "Unavailable"}
            </dd>
          </div>
        </dl>
        {tweet.media.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {tweet.media.length} media item{tweet.media.length === 1 ? "" : "s"} attached. Media is
            fetched as a URL only; its content is not analyzed.
          </p>
        ) : null}
        <div className="flex justify-end">
          <a
            href={tweet.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-secondary px-4 text-sm font-medium text-secondary-foreground shadow-sm outline-none transition-colors hover:bg-secondary/80 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            Open on X
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </div>
      </div>
    </AppDialog>
  );
}
