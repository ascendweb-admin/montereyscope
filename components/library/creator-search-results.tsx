"use client";

import { useState } from "react";
import { BadgeCheck, Check, Lock, Plus, SearchX } from "lucide-react";

import { creatorAvatarStyle } from "@/components/library/creator-card";
import { Button } from "@/components/ui/button";
import type { CreatorPlatform } from "@/lib/creators/repository";
import {
  audienceNoun,
  formatFollowerCount,
  type CreatorSearchResult,
} from "@/lib/creators/search/model";
import { cn } from "@/lib/utils";

const PLATFORM_NAMES: Record<CreatorPlatform, string> = {
  youtube: "YouTube",
  rumble: "Rumble",
  x: "X",
};

const RESULT_NOUNS: Record<CreatorPlatform, [string, string]> = {
  youtube: ["channel", "channels"],
  rumble: ["channel", "channels"],
  x: ["account", "accounts"],
};

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      // Skip separators and emoji-only words, e.g. "Olivia | Onchain".
      .filter((word) => /^[\p{L}\p{N}]/u.test(word))
      .slice(0, 2)
      .map((word) => [...word][0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/** Remote avatar with an initials fallback when the image is missing or fails. */
export function SearchAvatar({
  name,
  src,
  className,
}: {
  name: string;
  src: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        ref={(image) => {
          // A failed request can finish before hydration attaches onError.
          if (image?.complete && image.naturalWidth === 0) setFailed(true);
        }}
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn(
          "shrink-0 rounded-full border border-border bg-muted object-cover",
          className,
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        creatorAvatarStyle(name),
        className,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}

/** "@pewdiepie · 109M subscribers" — whichever parts the platform exposed. */
export function creatorMetaLine(
  platform: CreatorPlatform,
  handle: string | null,
  followerCount: number | null,
): string {
  const parts: string[] = [];
  if (handle) {
    parts.push(`@${handle.replace(/^@/, "")}`);
  }
  if (followerCount !== null) {
    parts.push(`${formatFollowerCount(followerCount)} ${audienceNoun(platform, followerCount)}`);
  }
  return parts.join(" · ");
}

export function SearchResultsSkeleton({ platform }: { platform: CreatorPlatform }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <p role="status" className="sr-only">
        Searching {PLATFORM_NAMES[platform]}…
      </p>
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          aria-hidden="true"
          className="flex items-center gap-3 border-b px-3 py-3 last:border-b-0"
        >
          <span className="size-10 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <span className="flex min-w-0 flex-1 flex-col gap-2">
            <span
              className="h-3.5 animate-pulse rounded bg-muted motion-reduce:animate-none"
              style={{ width: `${[46, 58, 38, 52][row]}%` }}
            />
            <span
              className="h-3 animate-pulse rounded bg-muted/70 motion-reduce:animate-none"
              style={{ width: `${[30, 24, 34, 27][row]}%` }}
            />
          </span>
          <span className="h-8 w-16 shrink-0 animate-pulse rounded-md bg-muted/70 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}

export function SearchResultsEmpty({
  platform,
  query,
}: {
  platform: CreatorPlatform;
  query: string;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-8 text-center"
    >
      <SearchX aria-hidden="true" className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">
        No {RESULT_NOUNS[platform][1]} match “{query}” on {PLATFORM_NAMES[platform]}.
      </p>
      <p className="max-w-xs text-xs text-balance text-muted-foreground">
        Check the spelling or try a shorter name. You can also paste the{" "}
        {platform === "x" ? "profile" : "channel"} link instead.
      </p>
    </div>
  );
}

interface CreatorSearchResultsProps {
  platform: CreatorPlatform;
  query: string;
  results: readonly CreatorSearchResult[];
  onAdd: (result: CreatorSearchResult) => void;
}

/**
 * Search result list. Each row shows identity cues people use to tell the
 * real creator from clip and fan channels (verified badge, audience size,
 * handle, bio) and either an Add action or an "Added" state.
 */
export function CreatorSearchResults({
  platform,
  query,
  results,
  onAdd,
}: CreatorSearchResultsProps) {
  if (results.length === 0) {
    return <SearchResultsEmpty platform={platform} query={query} />;
  }
  const [singular, plural] = RESULT_NOUNS[platform];
  return (
    <section aria-label={`Search results for ${query}`} className="flex flex-col gap-2">
      <p role="status" className="text-xs text-muted-foreground">
        {results.length} {results.length === 1 ? singular : plural} on {PLATFORM_NAMES[platform]}{" "}
        for “<span className="font-medium text-foreground">{query}</span>”
      </p>
      <ul className="max-h-[min(22rem,38dvh)] overflow-y-auto overscroll-contain rounded-lg border [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        {results.map((result) => {
          const saved = result.savedCreatorId !== null;
          const meta = creatorMetaLine(result.platform, result.handle, result.followerCount);
          return (
            <li
              key={result.id}
              className="flex items-center gap-3 border-b px-3 py-2.5 transition-colors last:border-b-0 hover:bg-muted/40 motion-reduce:transition-none"
            >
              <SearchAvatar name={result.displayName} src={result.avatarUrl} className="size-10" />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1 text-sm font-medium">
                  <span className="truncate">{result.displayName}</span>
                  {result.verified ? (
                    <BadgeCheck
                      aria-label="Verified"
                      role="img"
                      className="size-3.5 shrink-0 text-sky-500"
                    />
                  ) : null}
                </p>
                {meta ? <p className="truncate text-xs text-muted-foreground">{meta}</p> : null}
                {result.description ? (
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/80">
                    {result.description}
                  </p>
                ) : null}
              </div>
              {saved ? (
                <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                  <Check aria-hidden="true" className="size-3.5" />
                  <span className="max-sm:sr-only">Added</span>
                </span>
              ) : result.protectedAccount ? (
                <span
                  title="Protected accounts only share posts with approved followers, so scope cannot collect them."
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground"
                >
                  <Lock aria-hidden="true" className="size-3.5" />
                  <span className="max-sm:sr-only">Protected</span>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0 max-sm:size-8 max-sm:px-0"
                  aria-label={`Add ${result.displayName}`}
                  onClick={() => onAdd(result)}
                >
                  <Plus aria-hidden="true" />
                  <span className="max-sm:hidden">Add</span>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
