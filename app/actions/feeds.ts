"use server";

/**
 * Server Actions backing the stage 3 channel feed UI. Thin wrappers that
 * delegate to the videos service and return client-safe shapes only —
 * no raw database records, stderr, paths, or stack traces.
 */
import { revalidatePath } from "next/cache";

import { refreshCreatorFeeds } from "@/lib/videos/service";
import { refreshCreatorContent } from "@/lib/content/service";
import { getDb } from "@/lib/db/connection";

export interface RefreshFeedOutcome {
  ok: boolean;
  status?: "refreshed" | "already_in_progress" | "failed";
  refreshedAt?: string;
  videoCount?: number;
  livestreamCount?: number;
  errorCode?: string;
  message?: string;
}

export interface RefreshContentOutcome {
  ok: boolean;
  status?: "refreshed" | "already_in_progress";
  refreshedAt?: string;
  addedVideos?: number;
  addedLivestreams?: number;
  addedTweets?: number;
  skipped?: number;
  errorCode?: string;
  message?: string;
}

/**
 * Platform-aware refresh for one creator: YouTube/Rumble feeds via yt-dlp or
 * Rumble pages, X timelines via the X provider. Used by library-wide
 * "Refresh all"; the channel pages use their own platform actions.
 */
export async function refreshCreatorContentAction(
  creatorId: number,
): Promise<RefreshContentOutcome> {
  if (!Number.isInteger(creatorId) || creatorId < 1) {
    return { ok: false, errorCode: "invalid_creator", message: "That creator ID is not valid." };
  }
  try {
    const outcome = await refreshCreatorContent(getDb(), creatorId);
    if (!outcome.ok) {
      return {
        ok: false,
        errorCode: outcome.errorCode,
        message: outcome.message,
      };
    }
    revalidatePath(`/channels/${creatorId}`);
    revalidatePath("/");
    revalidatePath("/feed");
    return {
      ok: true,
      status: outcome.status,
      refreshedAt: outcome.refreshedAt,
      addedVideos: outcome.addedVideos,
      addedLivestreams: outcome.addedLivestreams,
      addedTweets: outcome.addedTweets,
      skipped: outcome.skipped,
    };
  } catch {
    return {
      ok: false,
      errorCode: "unexpected_response",
      message: "The feed could not be updated right now. Please try again.",
    };
  }
}

/**
 * Manual refresh for one creator's cached video feed. User-initiated only —
 * there is deliberately no polling or background scheduler. Concurrent
 * calls for the same creator collapse into a single yt-dlp run.
 */
export async function refreshCreatorFeedsAction(creatorId: number): Promise<RefreshFeedOutcome> {
  if (!Number.isInteger(creatorId) || creatorId < 1) {
    return { ok: false, errorCode: "invalid_creator", message: "That creator ID is not valid." };
  }
  try {
    const outcome = await refreshCreatorFeeds(getDb(), creatorId);
    if (!outcome.ok) {
      return {
        ok: false,
        status: "failed",
        errorCode: outcome.error.code,
        message: outcome.error.message,
      };
    }
    revalidatePath(`/channels/${creatorId}`);
    return {
      ok: true,
      status: outcome.status,
      refreshedAt: outcome.refreshedAt,
      videoCount: outcome.videoCount,
      livestreamCount: outcome.livestreamCount,
    };
  } catch {
    // Never leak unexpected server errors to the UI.
    return {
      ok: false,
      status: "failed",
      errorCode: "unexpected_response",
      message: "The feed could not be updated right now. Please try again.",
    };
  }
}
