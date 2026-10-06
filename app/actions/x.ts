"use server";

/**
 * Server Actions backing the X connection card and tweet timeline UI. Thin:
 * they delegate to the X service and return client-safe shapes only — no
 * credentials, cookies, stderr, paths, or stack traces.
 */
import { revalidatePath } from "next/cache";

import { getCreator } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import {
  connectX,
  disconnectX,
  fetchTweetsForCreator,
  getCachedCreatorTimeline,
  getCachedTweet,
  getXConnectionStatus,
  refreshCreatorTweets,
  toXServiceError,
  type CreatorTimelinePageResult,
  type XConnectionStatus,
  type XFetchBatchOutcome,
  type XRefreshOutcome,
} from "@/lib/x";

export interface XStatusOutcome {
  ok: boolean;
  status?: XConnectionStatus;
  message?: string;
}

export async function getXStatusAction(): Promise<XStatusOutcome> {
  try {
    return { ok: true, status: await getXConnectionStatus() };
  } catch {
    return { ok: false, message: "The X connection status could not be read." };
  }
}

export async function connectXAction(): Promise<XStatusOutcome> {
  try {
    const status = await connectX();
    revalidatePath("/settings");
    return {
      ok: status.capability === "connected",
      status,
      message:
        status.capability === "connected"
          ? undefined
          : "Scope could not finish connecting to X on this machine.",
    };
  } catch (error) {
    const serviceError = toXServiceError(error);
    return { ok: false, message: serviceError.message };
  }
}

export async function disconnectXAction(): Promise<{ ok: boolean; message?: string }> {
  try {
    await disconnectX();
    revalidatePath("/settings");
    revalidatePath("/");
    return { ok: true };
  } catch {
    return { ok: false, message: "X could not be disconnected. Please try again." };
  }
}

export interface XRefreshActionOutcome {
  ok: boolean;
  status?: XRefreshOutcome["status"];
  refreshedAt?: string;
  newItemCount?: number;
  skipped?: number;
  hasOlderAvailable?: boolean;
  errorCode?: string;
  message?: string;
}

/** Explicit, user-initiated timeline refresh (recent head or older page). */
export async function refreshCreatorTweetsAction(
  creatorId: number,
  mode: "recent" | "older" = "recent",
  limit?: number,
): Promise<XRefreshActionOutcome> {
  if (!Number.isInteger(creatorId) || creatorId < 1) {
    return { ok: false, errorCode: "not_found", message: "That creator ID is not valid." };
  }
  try {
    const db = getDb();
    const creator = getCreator(db, creatorId);
    if (!creator || creator.platform !== "x") {
      return { ok: false, errorCode: "not_found", message: "That creator is not an X account." };
    }
    const outcome = await refreshCreatorTweets(db, creatorId, { mode, limit });
    if (!outcome.ok) {
      return {
        ok: false,
        status: "failed",
        errorCode: outcome.error.code,
        message: outcome.error.message,
      };
    }
    revalidatePath(`/channels/${creatorId}`);
    revalidatePath("/");
    revalidatePath("/feed");
    return {
      ok: true,
      status: outcome.status,
      refreshedAt: outcome.refreshedAt,
      newItemCount: outcome.newItemCount,
      skipped: outcome.skipped,
      hasOlderAvailable: outcome.hasOlderAvailable,
    };
  } catch {
    return {
      ok: false,
      status: "failed",
      errorCode: "invalid_response",
      message: "The timeline could not be updated right now. Please try again.",
    };
  }
}

export interface XFetchActionOutcome {
  ok: boolean;
  batch?: XFetchBatchOutcome;
  message?: string;
}

/** Hydrates a validated batch of selected posts. */
export async function fetchTweetsAction(
  creatorId: number,
  tweetIds: readonly string[],
): Promise<XFetchActionOutcome> {
  if (!Number.isInteger(creatorId) || creatorId < 1 || !Array.isArray(tweetIds)) {
    return { ok: false, message: "That selection is not valid." };
  }
  try {
    const outcome = await fetchTweetsForCreator(getDb(), creatorId, tweetIds);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidatePath(`/channels/${creatorId}`);
    revalidatePath("/");
    revalidatePath("/feed");
    return { ok: true, batch: outcome };
  } catch {
    return { ok: false, message: "Fetching the selected posts failed. Please try again." };
  }
}

export interface XTimelineReadOutcome {
  ok: boolean;
  page?: CreatorTimelinePageResult;
  message?: string;
}

/** Cached-read helper for clients that re-fetch after a mutation. */
export async function getCachedTimelineAction(
  creatorId: number,
  options: { includeReplies?: boolean; includeReposts?: boolean; limit?: number; offset?: number } = {},
): Promise<XTimelineReadOutcome> {
  if (!Number.isInteger(creatorId) || creatorId < 1) {
    return { ok: false, message: "That creator ID is not valid." };
  }
  return { ok: true, page: getCachedCreatorTimeline(getDb(), creatorId, options) };
}

export interface XTweetDetailOutcome {
  ok: boolean;
  tweet?: ReturnType<typeof getCachedTweet>;
  message?: string;
}

/** Opens the complete cached post for the detail view. */
export async function getTweetDetailAction(
  creatorId: number,
  tweetId: string,
): Promise<XTweetDetailOutcome> {
  if (!Number.isInteger(creatorId) || creatorId < 1 || typeof tweetId !== "string") {
    return { ok: false, message: "That post reference is not valid." };
  }
  const tweet = getCachedTweet(getDb(), creatorId, tweetId);
  if (tweet === null) {
    return { ok: false, message: "That post is not in the local cache." };
  }
  return { ok: true, tweet };
}
