/**
 * Cache maintenance service (stage 5): backs the two destructive Settings
 * actions. Deletion scope is resolved and reported BEFORE anything is
 * removed — the UI confirms with exact counts, and only then calls through.
 * Saved creators are never touched here.
 */
import { clearAllTranscripts, countTranscripts } from "@/lib/transcripts/repository";
import { clearAllCachedFeeds, countAllVideos } from "@/lib/videos/repository";
import { clearAllCachedTweets, countAllTweets } from "@/lib/x/repository";
import type { ScopeDatabase } from "@/lib/db/connection";

export interface CacheCounts {
  cachedTranscripts: number;
  cachedVideos: number;
  cachedTweets: number;
}

/** Reads the counts the confirmation dialogs display before deletion. */
export function getCacheCounts(db: ScopeDatabase): CacheCounts {
  return {
    cachedTranscripts: countTranscripts(db),
    cachedVideos: countAllVideos(db),
    cachedTweets: countAllTweets(db),
  };
}

export type ClearOutcome = { ok: true; deletedCount: number } | { ok: false; message: string };

/**
 * Deletes every cached transcript. Cached feeds and saved creators are
 * untouched; transcripts are simply fetched again on demand.
 */
export function clearTranscriptCache(db: ScopeDatabase): ClearOutcome {
  try {
    return { ok: true, deletedCount: clearAllTranscripts(db) };
  } catch {
    return {
      ok: false,
      message: "The transcript cache could not be cleared. Please try again.",
    };
  }
}

/**
 * Deletes every cached video entry (their transcripts cascade with them)
 * and resets last-refreshed times. The creator list itself is retained;
 * channel pages refill when feeds are refreshed again.
 */
export function clearCachedFeedMetadata(db: ScopeDatabase): ClearOutcome {
  try {
    return { ok: true, deletedCount: clearAllCachedFeeds(db) };
  } catch {
    return {
      ok: false,
      message: "The cached feed metadata could not be cleared. Please try again.",
    };
  }
}

/**
 * Deletes every cached X post (timeline links, feed state, and orphaned
 * post bodies) in one transaction. Saved creators stay; old reports remain
 * readable because their evidence lives in immutable job directories.
 */
export function clearTweetCache(db: ScopeDatabase): ClearOutcome {
  try {
    return { ok: true, deletedCount: clearAllCachedTweets(db) };
  } catch {
    return {
      ok: false,
      message: "The tweet cache could not be cleared. Please try again.",
    };
  }
}
