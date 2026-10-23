import Link from "next/link";
import { ChevronRight, Newspaper } from "lucide-react";

import { PlatformLogo } from "@/components/creators/profile-ui";
import { FeedStream, type FeedItemModel } from "@/components/feed/feed-stream";
import { PLATFORM_LABELS, formatHandle } from "@/lib/creators/labels";
import type { CreatorAccountSummary } from "@/lib/creators/profile-service";
import type { AccountContentCounts } from "@/lib/creators/profiles";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const PLATFORM_TILE: Record<CreatorAccountSummary["platform"], string> = {
  youtube: "bg-[#FF0000]/10",
  rumble: "bg-[#85C742]/10",
  x: "bg-foreground/10",
};

function describeCounts(counts: AccountContentCounts | undefined, isX: boolean): string {
  if (!counts) {
    return "Nothing cached yet";
  }
  if (isX) {
    return counts.posts > 0
      ? `${counts.posts} ${counts.posts === 1 ? "post" : "posts"}`
      : "No posts cached yet";
  }
  const parts = [
    counts.videos > 0 ? `${counts.videos} ${counts.videos === 1 ? "video" : "videos"}` : null,
    counts.livestreams > 0
      ? `${counts.livestreams} ${counts.livestreams === 1 ? "livestream" : "livestreams"}`
      : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "No videos cached yet";
}

/**
 * A creator page's Overview: one card per linked account (what is cached
 * and how fresh it is, each opening its tab), then everything the person
 * published across platforms in one newest-first stream.
 */
export function CreatorOverview({
  profileId,
  profileName,
  accounts,
  counts,
  items,
}: {
  profileId: number;
  profileName: string;
  accounts: readonly CreatorAccountSummary[];
  counts: ReadonlyMap<number, AccountContentCounts>;
  items: FeedItemModel[];
}) {
  return (
    <div className="flex flex-col gap-6">
      <ul
        aria-label={`${profileName}'s accounts`}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      >
        {accounts.map((account) => {
          const relative = formatRelativeTime(account.lastRefreshedAt);
          return (
            <li key={account.id}>
              <Link
                href={`/creators/${profileId}?account=${account.id}`}
                scroll={false}
                className="group flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 shadow-sm outline-none transition-colors hover:border-ring/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    PLATFORM_TILE[account.platform],
                  )}
                >
                  <PlatformLogo
                    platform={account.platform}
                    className={account.platform === "youtube" ? "size-5" : "size-4"}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {formatHandle(account.handle) ?? account.displayName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {PLATFORM_LABELS[account.platform]}
                    </span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {describeCounts(counts.get(account.id), account.platform === "x")}
                  </span>
                  <span
                    className="block truncate text-[11px] text-muted-foreground/80"
                    suppressHydrationWarning
                  >
                    {relative ? `Refreshed ${relative}` : "Never refreshed"}
                  </span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                />
              </Link>
            </li>
          );
        })}
      </ul>

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Newspaper className="size-7 text-muted-foreground" />
          </span>
          <h2 className="text-base font-semibold">Nothing cached yet</h2>
          <p className="max-w-md text-balance text-sm text-muted-foreground">
            Refresh {profileName}&apos;s accounts to pull in their newest videos, livestreams, and
            posts — everything from every platform lands here, newest first.
          </p>
        </div>
      ) : (
        <section aria-label={`Everything ${profileName} published`}>
          <FeedStream
            items={items}
            byline="account"
            showPlatformFilter={false}
            searchPlaceholder="Search titles and posts…"
          />
        </section>
      )}
    </div>
  );
}
