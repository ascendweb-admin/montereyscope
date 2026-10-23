"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Newspaper, Users } from "lucide-react";

import type { RefreshTarget } from "@/components/background/creator-refresh";
import { FeedStream, type FeedItemModel } from "@/components/feed/feed-stream";
import { RefreshAllButton } from "@/components/library/refresh-all-button";
import type { CategorySummary } from "@/lib/categories";

export type {
  FeedItemLiveStatus,
  FeedItemModel,
  FeedTweetItemModel,
  FeedVideoItemModel,
} from "@/components/feed/feed-stream";

/**
 * The Feed page: the newest cached videos, livestreams, and X posts across
 * every saved creator, one list, newest first. The list itself — toolbar,
 * rows, transcripts, and Ask AI — is the shared FeedStream; this view adds
 * the page header, the library-wide Refresh all, and the empty states.
 */

/** One refreshable platform account. */
export type FeedRefreshTarget = RefreshTarget;

interface FeedViewProps {
  items: FeedItemModel[];
  /** How many people (creator profiles) the library holds, for the header copy. */
  creatorCount: number;
  /** Every platform account, for Refresh all. */
  refreshTargets: FeedRefreshTarget[];
  /** The user's categories, for the filter bar (with per-category creator counts). */
  categories: CategorySummary[];
  /** Creators that belong to no category — backs the bar's Uncategorized chip. */
  uncategorizedCreatorCount: number;
}

export function FeedView({
  items,
  creatorCount,
  refreshTargets,
  categories,
  uncategorizedCreatorCount,
}: FeedViewProps) {
  const router = useRouter();

  if (creatorCount === 0) {
    return (
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The newest videos and livestreams from every creator you save, in one list.
          </p>
        </header>
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Users className="size-7 text-muted-foreground" />
          </span>
          <h2 className="text-base font-semibold">Your library is empty</h2>
          <p className="max-w-md text-balance text-sm text-muted-foreground">
            Save a creator first — the feed collects the newest cached videos, livestreams, and X
            posts from your library.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go to your library
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Feed</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            The newest videos, livestreams, and X posts from your {creatorCount} saved{" "}
            {creatorCount === 1 ? "creator" : "creators"}.
          </p>
        </div>
        <RefreshAllButton creators={refreshTargets} onRefreshed={() => router.refresh()} />
      </header>

      {items.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-muted"
          >
            <Newspaper className="size-7 text-muted-foreground" />
          </span>
          <h2 className="text-base font-semibold">Nothing cached yet</h2>
          <p className="max-w-md text-balance text-sm text-muted-foreground">
            Refresh your creators to pull in their newest videos, livestreams, and posts —
            everything lands here, newest first.
          </p>
          <RefreshAllButton creators={refreshTargets} onRefreshed={() => router.refresh()} />
        </div>
      ) : (
        <div className="mt-6">
          <FeedStream
            items={items}
            categories={categories}
            uncategorizedCreatorCount={uncategorizedCreatorCount}
          />
        </div>
      )}
    </main>
  );
}
