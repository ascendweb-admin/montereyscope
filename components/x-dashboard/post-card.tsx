"use client";

import { memo, useState, type ReactNode } from "react";
import { Check, ExternalLink, Maximize2, Repeat2, Sparkles } from "lucide-react";

import { TweetMetrics } from "@/components/channel/tweet-card";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { formatAbsoluteTimestamp } from "@/lib/format";
import type { ResearchPost } from "@/lib/x/research/model";
import { cn } from "@/lib/utils";

/** X-style compact time: "now", "5m", "3h", "Oct 3", "Oct 3, 2025". */
export function shortTime(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}),
  });
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function highlight(text: string, terms: string[], keyPrefix: string): ReactNode[] {
  const words = terms.map((t) => t.replace(/^\$/, "")).filter((t) => t.length > 1);
  if (!words.length) return [text];
  // Search matches whole words, so highlight whole words only ("eth", not "Ethereum").
  const pattern = new RegExp(
    `((?<![\\p{L}\\p{N}])(?:${words.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}]))`,
    "giu",
  );
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <mark
        key={`${keyPrefix}-${index}`}
        className="rounded-sm bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-400/25"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function displayUrl(url: string): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/, "");
  return bare.length > 40 ? `${bare.slice(0, 39)}…` : bare;
}

/** Post text with links, @mentions and search-term highlights. */
export function RichText({ text, terms = [] }: { text: string; terms?: string[] }) {
  const parts = text.split(/(https?:\/\/[^\s]+|@[A-Za-z0-9_]{1,15}\b)/g);
  return (
    <>
      {parts.map((part, index) => {
        if (index % 2 === 0) return highlight(part, terms, String(index));
        const external = part.startsWith("@") ? `https://x.com/${part.slice(1)}` : part;
        return (
          <a
            key={index}
            href={external}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="text-sky-600 hover:underline dark:text-sky-400"
          >
            {part.startsWith("http") ? displayUrl(part) : part}
          </a>
        );
      })}
    </>
  );
}

function Media({ post }: { post: ResearchPost }) {
  const photos = post.tweet.media.filter((m) => m.kind === "photo" && (m.previewUrl || m.url));
  const others = post.tweet.media.length - photos.length;
  if (!post.tweet.media.length) return null;
  return (
    <div className="mt-3">
      {photos.length ? (
        <div
          className={cn(
            "grid gap-0.5 overflow-hidden rounded-2xl border",
            photos.length > 1 ? "grid-cols-2" : "grid-cols-1",
          )}
        >
          {photos.slice(0, 4).map((item) => (
            // Remote preview only — media binaries are never stored locally.
            <img
              key={item.url}
              src={item.previewUrl ?? item.url}
              alt={item.altText ?? ""}
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
              className={cn(
                "w-full bg-muted object-cover",
                photos.length === 1 ? "max-h-[28rem]" : "aspect-[4/3]",
              )}
            />
          ))}
        </div>
      ) : null}
      {others > 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {others} video or other attachment{others === 1 ? "" : "s"} — open on X to view
        </p>
      ) : null}
    </div>
  );
}

const actionClass =
  "inline-flex size-8 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

export const PostCard = memo(function PostCard({
  post,
  terms,
  selected,
  selecting,
  onToggleSelect,
  onAsk,
  onOpen,
}: {
  post: ResearchPost;
  terms: string[];
  selected: boolean;
  /** Some post is selected: every card shows its checkbox. */
  selecting: boolean;
  onToggleSelect: (id: string) => void;
  onAsk: (post: ResearchPost) => void;
  onOpen: (post: ResearchPost) => void;
}) {
  const { tweet } = post;
  const [expanded, setExpanded] = useState(false);
  const long = tweet.text.length > 420 || tweet.text.split("\n").length > 9;
  const reposter = post.postType === "repost" ? post.provenance.find((p) => p.kind === "repost") : null;
  const absolute = formatAbsoluteTimestamp(post.eventAt) ?? undefined;
  return (
    <article
      data-post-id={tweet.id}
      aria-label={`Post by ${tweet.authorName}`}
      className={cn(
        "group/post relative px-4 py-3.5 transition-colors motion-reduce:transition-none sm:px-5",
        selected ? "bg-accent/60" : "hover:bg-accent/30",
      )}
    >
      {reposter ? (
        <p className="mb-1 flex items-center gap-2 pl-7 text-xs font-medium text-muted-foreground">
          <Repeat2 aria-hidden="true" className="size-3.5" />
          {reposter.name} reposted
        </p>
      ) : null}
      <div className="flex gap-3">
        <CreatorAvatar
          creator={{ id: tweet.creatorId, displayName: tweet.authorName, avatarUrl: tweet.authorAvatarUrl }}
          className="size-10 text-xs"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <p className="flex min-w-0 flex-1 items-baseline gap-1 text-[15px] leading-5">
              <span className="truncate font-semibold">{tweet.authorName}</span>
              <span className="truncate text-muted-foreground">@{tweet.authorHandle}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <button
                type="button"
                onClick={() => onOpen(post)}
                title={absolute}
                className="shrink-0 text-muted-foreground outline-none hover:underline focus-visible:underline"
              >
                <time dateTime={post.eventAt} suppressHydrationWarning>
                  {shortTime(post.eventAt)}
                </time>
              </button>
            </p>
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={selected ? "Deselect post" : "Select post for analysis"}
              title={selected ? "Deselect" : "Select for analysis"}
              onClick={() => onToggleSelect(tweet.id)}
              className={cn(
                "-mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 outline-none transition focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-muted-foreground/40 text-transparent hover:border-foreground/70",
                !selected && !selecting && "opacity-0 group-hover/post:opacity-100 focus-visible:opacity-100",
              )}
            >
              <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
            </button>
          </div>
          {post.postType === "reply" ? (
            <p className="text-sm text-muted-foreground">
              Replying to{" "}
              <span className="text-sky-600 dark:text-sky-400">@{tweet.inReplyToHandle ?? "…"}</span>
            </p>
          ) : null}
          {tweet.text ? (
            <div className="mt-1">
              <p
                className={cn(
                  "text-[15px] leading-[1.4rem] whitespace-pre-wrap [overflow-wrap:anywhere]",
                  long && !expanded && "line-clamp-[9]",
                )}
              >
                <RichText text={tweet.text} terms={terms} />
              </p>
              {long ? (
                <button
                  type="button"
                  onClick={() => setExpanded((value) => !value)}
                  className="mt-0.5 text-sm font-medium text-sky-600 outline-none hover:underline focus-visible:underline dark:text-sky-400"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </div>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground italic">
              Only a preview of this post was saved. Open details to fetch the full text.
            </p>
          )}
          {tweet.quoted ? (
            <div className="mt-3 rounded-2xl border px-3.5 py-2.5">
              <p className="truncate text-sm">
                <span className="font-semibold">{tweet.quoted.name ?? tweet.quoted.handle ?? "Quoted post"}</span>{" "}
                {tweet.quoted.handle ? (
                  <span className="text-muted-foreground">@{tweet.quoted.handle}</span>
                ) : null}
              </p>
              <p className="mt-0.5 line-clamp-6 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
                <RichText text={tweet.quoted.text} terms={terms} />
              </p>
            </div>
          ) : null}
          <Media post={post} />
          <div className="mt-2 -mb-1 flex items-center gap-1">
            <span className="mr-auto">
              <TweetMetrics tweet={tweet} />
            </span>
            <span className="flex items-center opacity-0 transition-opacity group-hover/post:opacity-100 focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100">
              <button
                type="button"
                className={actionClass}
                title="Ask AI about this post"
                aria-label="Ask AI about this post"
                onClick={() => onAsk(post)}
              >
                <Sparkles aria-hidden="true" className="size-4" />
              </button>
              <button
                type="button"
                className={actionClass}
                title="Post details"
                aria-label="Post details"
                onClick={() => onOpen(post)}
              >
                <Maximize2 aria-hidden="true" className="size-4" />
              </button>
              <a
                href={tweet.url}
                target="_blank"
                rel="noreferrer"
                className={actionClass}
                title="Open on X"
                aria-label="Open on X (opens in a new tab)"
              >
                <ExternalLink aria-hidden="true" className="size-4" />
              </a>
            </span>
          </div>
        </div>
      </div>
    </article>
  );
});

/** Shown in place of posts while the first page loads. */
export function PostSkeleton() {
  return (
    <div className="flex gap-3 px-4 py-4 sm:px-5" aria-hidden="true">
      <span className="size-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
      <span className="flex-1 space-y-2.5 pt-1">
        <span className="block h-3 w-44 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        <span className="block h-3 w-full animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
        <span className="block h-3 w-4/5 animate-pulse rounded bg-muted/70 motion-reduce:animate-none" />
      </span>
    </div>
  );
}

