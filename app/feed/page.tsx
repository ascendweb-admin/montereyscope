import { FeedView } from "./feed-view";
import { listCategories, listProfileCategoryAssignments } from "@/lib/categories";
import { PLATFORM_LABELS } from "@/lib/creators/labels";
import { listProfiles } from "@/lib/creators/profiles";
import { getDb } from "@/lib/db/connection";
import { buildFeedItems } from "@/lib/feed/items";

// The cached feed lives in SQLite and must reflect refreshes and transcript
// extractions immediately.
export const dynamic = "force-dynamic";

/**
 * The unified feed: the newest cached videos, livestreams, and X posts
 * across every saved creator, straight from the local cache. Pure reads —
 * extraction, fetching, and chat run from the row actions, and kind /
 * platform / category filtering happens on the prebuilt items in the client
 * view. Rows are labelled per person, so a creator's YouTube videos and X
 * posts read as one voice.
 */
export default function FeedPage() {
  const db = getDb();
  const profiles = listProfiles(db);
  const categories = listCategories(db);
  const profileCategories = listProfileCategoryAssignments(db);
  const uncategorizedCreatorCount = profiles.filter(
    (profile) => (profileCategories.get(profile.id) ?? []).length === 0,
  ).length;

  return (
    <FeedView
      items={buildFeedItems(db)}
      creatorCount={profiles.length}
      refreshTargets={profiles.flatMap((profile) =>
        profile.accounts.map((account) => ({
          id: account.id,
          displayName:
            profile.accounts.length > 1
              ? `${profile.displayName} (${PLATFORM_LABELS[account.platform]})`
              : profile.displayName,
          platform: account.platform,
          updatedAt: account.lastRefreshedAt,
        })),
      )}
      categories={categories}
      uncategorizedCreatorCount={uncategorizedCreatorCount}
    />
  );
}
