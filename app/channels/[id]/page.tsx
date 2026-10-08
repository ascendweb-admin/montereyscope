import { notFound } from "next/navigation";

import { ChannelView } from "./channel-view";
import { getCreatorById } from "@/lib/creators/service";
import { getCachedCreatorFeed } from "@/lib/videos/service";
import { getCachedCreatorTimeline } from "@/lib/x";
import { toTweetViewModel } from "@/lib/x/view-model";
import { getDb } from "@/lib/db/connection";
import { listCategories, listCategoriesForCreator } from "@/lib/categories";

// Cached feeds live in SQLite and must reflect refreshes immediately.
export const dynamic = "force-dynamic";

interface ChannelPageProps {
  params: Promise<{ id: string }>;
}

function parseCreatorId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/**
 * A saved creator's channel page. Unknown or removed IDs — and anything
 * that is not a plain numeric ID — fall through to the designed
 * not-found state for this segment.
 */
export default async function ChannelPage({ params }: ChannelPageProps) {
  const { id: rawId } = await params;
  const creatorId = parseCreatorId(rawId);
  if (creatorId === null) {
    notFound();
  }

  const db = getDb();
  const creator = getCreatorById(db, creatorId);
  if (!creator) {
    notFound();
  }

  const categories = listCategories(db);
  const creatorCategories = listCategoriesForCreator(db, creatorId);

  // X accounts render their cached post timeline; video platforms render the
  // cached videos/livestreams tabs. Both are pure local reads.
  if (creator.platform === "x") {
    const timeline = getCachedCreatorTimeline(db, creatorId, {
      limit: 100,
      offset: 0,
      includeReplies: true,
      includeReposts: true,
    });
    return (
      <ChannelView
        creator={creator}
        timeline={{
          tweets: timeline.items.map((item) => toTweetViewModel(item, creatorId)),
          totalCount: timeline.totalCount,
          hasMoreCached: timeline.hasMore,
          state: timeline.state
            ? {
                lastRefreshedAt: timeline.state.lastRefreshedAt,
                lastError: timeline.state.lastError,
                exhausted: timeline.state.exhausted,
              }
            : null,
        }}
        categories={categories}
        creatorCategories={creatorCategories}
      />
    );
  }

  const feed = getCachedCreatorFeed(db, creatorId);

  return (
    <ChannelView
      creator={creator}
      feed={feed}
      categories={categories}
      creatorCategories={creatorCategories}
    />
  );
}
