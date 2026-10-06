/**
 * Shared content facade: platform-aware refresh and feed reads over the
 * video and tweet caches. Server-only. Existing video callers keep their
 * service; X callers keep theirs; "refresh everything" flows use this.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { getCreator } from "@/lib/creators/repository";
import { refreshCreatorFeeds } from "@/lib/videos/service";
import { refreshCreatorTweets, X_DEFAULT_RECENT_LIMIT } from "@/lib/x";

export interface ContentRefreshOutcome {
  ok: boolean;
  status?: "refreshed" | "already_in_progress";
  refreshedAt?: string;
  /** Videos added/updated by this refresh (videos/livestreams). */
  addedVideos?: number;
  addedLivestreams?: number;
  /** Posts added/updated by this refresh. */
  addedTweets?: number;
  skipped?: number;
  errorCode?: string;
  message?: string;
}

/**
 * Refreshes one creator's cached content, dispatching on its platform:
 * YouTube/Rumble go through yt-dlp/Rumble listing pages, X through the X
 * provider. Never throws; failures leave the previous cache intact.
 */
export async function refreshCreatorContent(
  db: ScopeDatabase,
  creatorId: number,
): Promise<ContentRefreshOutcome> {
  const creator = getCreator(db, creatorId);
  if (!creator) {
    return { ok: false, errorCode: "invalid_creator", message: "That creator is not in your library." };
  }

  if (creator.platform === "x") {
    const outcome = await refreshCreatorTweets(db, creatorId, {
      mode: "recent",
      limit: X_DEFAULT_RECENT_LIMIT,
    });
    if (!outcome.ok) {
      return {
        ok: false,
        errorCode: outcome.error.code,
        message: outcome.error.message,
      };
    }
    return {
      ok: true,
      status: outcome.status === "exhausted" ? "already_in_progress" : outcome.status,
      refreshedAt: outcome.refreshedAt,
      addedTweets: outcome.newItemCount,
      skipped: outcome.skipped,
    };
  }

  const outcome = await refreshCreatorFeeds(db, creatorId);
  if (!outcome.ok) {
    return { ok: false, errorCode: outcome.error.code, message: outcome.error.message };
  }
  return {
    ok: true,
    status: outcome.status === "already_in_progress" ? "already_in_progress" : "refreshed",
    refreshedAt: outcome.refreshedAt,
    addedVideos: outcome.videoCount,
    addedLivestreams: outcome.livestreamCount,
  };
}
