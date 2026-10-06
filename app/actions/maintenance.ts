"use server";

/**
 * Server Actions backing the destructive Settings → Local cache controls.
 * Each action deletes exactly one resolved scope after the UI has shown a
 * confirmation with live counts. Saved creators are never deleted here.
 */
import { revalidatePath } from "next/cache";

import {
  clearCachedFeedMetadata,
  clearTranscriptCache,
  clearTweetCache,
  getCacheCounts,
  type CacheCounts,
} from "@/lib/maintenance/service";
import { getDb } from "@/lib/db/connection";

export interface ClearCacheOutcome {
  ok: boolean;
  deletedCount?: number;
  message?: string;
}

/** Reads the counts the confirmation dialogs display. */
export async function getCacheCountsAction(): Promise<CacheCounts> {
  return getCacheCounts(getDb());
}

/** Deletes every cached transcript after the user confirmed the scope. */
export async function clearTranscriptCacheAction(): Promise<ClearCacheOutcome> {
  try {
    const outcome = clearTranscriptCache(getDb());
    if (!outcome.ok) {
      return { ok: false, message: outcome.message };
    }
    revalidatePath("/", "layout");
    return { ok: true, deletedCount: outcome.deletedCount };
  } catch {
    return {
      ok: false,
      message: "The transcript cache could not be cleared. Please try again.",
    };
  }
}

/**
 * Deletes every cached video entry (transcripts cascade) and resets
 * last-refreshed times after the user confirmed the scope. The saved
 * creator list is retained.
 */
export async function clearFeedMetadataAction(): Promise<ClearCacheOutcome> {
  try {
    const outcome = clearCachedFeedMetadata(getDb());
    if (!outcome.ok) {
      return { ok: false, message: outcome.message };
    }
    revalidatePath("/", "layout");
    return { ok: true, deletedCount: outcome.deletedCount };
  } catch {
    return {
      ok: false,
      message: "The cached feed metadata could not be cleared. Please try again.",
    };
  }
}

/**
 * Deletes every cached X post after the user confirmed the scope. Saved
 * creators stay, old reports keep their materialized snapshots, and the
 * next fetch re-populates the timeline.
 */
export async function clearTweetCacheAction(): Promise<ClearCacheOutcome> {
  try {
    const outcome = clearTweetCache(getDb());
    if (!outcome.ok) {
      return { ok: false, message: outcome.message };
    }
    revalidatePath("/", "layout");
    return { ok: true, deletedCount: outcome.deletedCount };
  } catch {
    return {
      ok: false,
      message: "The tweet cache could not be cleared. Please try again.",
    };
  }
}
