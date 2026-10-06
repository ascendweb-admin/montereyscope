/**
 * Feed application service: refreshes a creator's cached Videos and
 * Livestreams via yt-dlp and reads the cached feed back for UI/API use.
 * Server-only.
 *
 * Refresh is strictly user-initiated (no polling/scheduler) and guarded so
 * concurrent refresh requests for the same creator collapse into one run.
 * A failed refresh never touches cached rows: parsing completes before the
 * single merge transaction runs. Merges are additive — rows that scroll
 * past the fetched window (and their transcripts) survive every refresh.
 */
import {
  fetchChannelFeedTab,
  isEmptyTabStderr,
  type ChannelFeedTab,
} from "@/lib/ytdlp/channel-feed";
import { YT_DLP_COMMAND } from "@/lib/ytdlp/version";
import { NETWORK_UNREACHABLE_MESSAGE, YTDLP_MISSING_MESSAGE } from "@/lib/ytdlp/user-messages";
import { runCommand } from "@/lib/ytdlp/runner";
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { getRecentItemsPerTab } from "@/lib/settings/settings";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  fetchRumbleListingPage,
  mergeRumbleListing,
} from "@/lib/rumble/feed";
import { mergeFeedResults, parseChannelFeedPayload, type VideoDraft } from "./mapper";
import {
  countCachedVideos,
  getVideoForCreator,
  listCachedVideos,
  mergeCreatorFeed,
  type VideoRecord,
} from "./repository";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type FeedErrorCode =
  | "invalid_creator"
  | "ytdlp_missing"
  | "unavailable_creator"
  | "throttled"
  | "network"
  | "timeout"
  | "output_limit"
  | "unexpected_response";

export interface FeedServiceError {
  code: FeedErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr or paths. */
  message: string;
}

export const FEED_ERROR_CODE_TO_STATUS: Record<FeedErrorCode, number> = {
  invalid_creator: 404,
  ytdlp_missing: 503,
  unavailable_creator: 422,
  throttled: 429,
  network: 502,
  timeout: 504,
  output_limit: 502,
  unexpected_response: 502,
};

function fail(code: FeedErrorCode, message: string): FeedServiceError {
  return { code, message };
}

/** Maps a raw runner failure to a typed, user-safe refresh error. */
export function classifyCommandFailure(
  result: Extract<ExecFileResult, { ok: false }>,
): FeedServiceError {
  switch (result.kind) {
    case "missing_executable":
      return fail("ytdlp_missing", YTDLP_MISSING_MESSAGE);
    case "timeout":
      return fail(
        "timeout",
        "Fetching this creator's feed took too long and was stopped. Please try again.",
      );
    case "output_limit":
      return fail(
        "output_limit",
        "The feed was too large to read. Try lowering “Recent items per tab” in Settings.",
      );
    default:
      break;
  }

  const stderrTail = result.stderrTail.toLowerCase();
  if (
    /does not exist|not found|404|has been terminated|is unavailable|no longer available|this channel/.test(
      stderrTail,
    )
  ) {
    return fail(
      "unavailable_creator",
      "YouTube would not serve that channel's feed (it may have been removed or made private).",
    );
  }
  if (
    /getaddrinfo|temporary failure|name or service not known|network|connection|unable to download|resolve|refused|reset by peer/.test(
      stderrTail,
    )
  ) {
    return fail("network", NETWORK_UNREACHABLE_MESSAGE);
  }
  return fail(
    "unexpected_response",
    "scope could not update this feed right now. Please try again later.",
  );
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------

export interface RefreshOutcomeSuccess {
  ok: true;
  status: "refreshed" | "already_in_progress";
  refreshedAt: string;
  videoCount: number;
  livestreamCount: number;
}

export interface RefreshOutcomeFailure {
  ok: false;
  status: "failed";
  error: FeedServiceError;
}

export type RefreshOutcome = RefreshOutcomeSuccess | RefreshOutcomeFailure;

interface RefreshDeps {
  command: string;
  run: typeof runCommand;
  now: () => Date;
  /** Overrides getRecentItemsPerTab; mainly for tests. */
  limitOverride?: number;
}

const defaultRefreshDeps: RefreshDeps = {
  command: YT_DLP_COMMAND,
  run: runCommand,
  now: () => new Date(),
};

/**
 * In-process guard: at most one refresh per creator id may execute at a
 * time; duplicate calls await the same outcome instead of racing yt-dlp
 * against itself. Sufficient for the single-user, single-process MVP.
 */
const inFlightRefreshes = new Map<number, Promise<RefreshOutcome>>();

/** Test seam: forget any in-flight refresh state. */
export function resetInFlightRefreshes(): void {
  inFlightRefreshes.clear();
}

/**
 * Fetches one tab, treating yt-dlp's "channel does not have a <tab> tab"
 * exit as a legitimate empty result rather than an error.
 */
async function fetchAndParseTab(
  deps: RefreshDeps,
  channelUrl: string,
  tab: ChannelFeedTab,
  limit: number,
): Promise<{ ok: true; drafts: VideoDraft[] } | { ok: false; error: FeedServiceError }> {
  let result: ExecFileResult;
  try {
    result = await fetchChannelFeedTab(channelUrl, tab, limit, {
      command: deps.command,
      run: deps.run,
    });
  } catch {
    return {
      ok: false,
      error: fail("unexpected_response", "scope could not update this feed right now."),
    };
  }

  if (!result.ok) {
    if (isEmptyTabStderr(result.stderrTail, tab)) {
      return { ok: true, drafts: [] };
    }
    return { ok: false, error: classifyCommandFailure(result) };
  }

  const parsed = parseChannelFeedPayload(result.stdout);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, drafts: parsed.videos };
}

/**
 * Refreshes both tabs for one saved creator and swaps the cache in a single
 * transaction. Resolves to the same outcome object for every caller that
 * races on the same creator while a refresh is already running.
 */
export async function refreshCreatorFeeds(
  db: ScopeDatabase,
  creatorId: number,
  overrides: Partial<RefreshDeps> = {},
): Promise<RefreshOutcome> {
  const existing = inFlightRefreshes.get(creatorId);
  if (existing) {
    const outcome = await existing;
    return outcome.ok ? { ...outcome, status: "already_in_progress" } : outcome;
  }

  const task = performRefresh(db, creatorId, overrides);
  inFlightRefreshes.set(creatorId, task);
  try {
    return await task;
  } finally {
    // Only clear while this task is still the registered one.
    if (inFlightRefreshes.get(creatorId) === task) {
      inFlightRefreshes.delete(creatorId);
    }
  }
}

async function performRefresh(
  db: ScopeDatabase,
  creatorId: number,
  overrides: Partial<RefreshDeps>,
): Promise<RefreshOutcome> {
  const deps: RefreshDeps = { ...defaultRefreshDeps, ...overrides };

  const creator = db
    .prepare<[number], { id: number; channel_url: string; platform: string | null }>(
      "SELECT id, channel_url, platform FROM creators WHERE id = ?",
    )
    .get(creatorId);
  if (!creator) {
    return {
      ok: false,
      status: "failed",
      error: fail("invalid_creator", "That creator is no longer in your library."),
    };
  }

  // Rumble creators refresh from their listing page, not yt-dlp.
  if (creator.platform === "rumble") {
    return performRumbleRefresh(db, creatorId, creator.channel_url, deps.now);
  }

  const limit = deps.limitOverride !== undefined ? deps.limitOverride : getRecentItemsPerTab(db);

  const videosResult = await fetchAndParseTab(deps, creator.channel_url, "videos", limit);
  if (!videosResult.ok) {
    return { ok: false, status: "failed", error: videosResult.error };
  }
  const streamsResult = await fetchAndParseTab(deps, creator.channel_url, "streams", limit);
  if (!streamsResult.ok) {
    return { ok: false, status: "failed", error: streamsResult.error };
  }

  // Both tabs parsed successfully — only now is the parsed feed merged into
  // the cached one, atomically, together with last_refreshed_at.
  const merged = mergeFeedResults(videosResult.drafts, streamsResult.drafts);
  const refreshedAt = deps.now().toISOString();
  const outcome = mergeCreatorFeed(db, {
    creatorId,
    videos: merged.videos,
    refreshedAt,
  });

  return {
    ok: true,
    status: "refreshed",
    refreshedAt,
    videoCount: outcome.fetchedCount - outcome.livestreamCount,
    livestreamCount: outcome.livestreamCount,
  };
}

// ---------------------------------------------------------------------------
// Rumble refresh path (platform: rumble)
// ---------------------------------------------------------------------------

/**
 * Refreshes a Rumble creator from one channel-listing page (~25 recent
 * uploads with real dates and thumbnails) and merges it into the cache.
 * Full back-catalog fetching is deliberately not supported — Rumble's
 * listing pagination is slow and throttled; the UI carries a disclaimer.
 */
async function performRumbleRefresh(
  db: ScopeDatabase,
  creatorId: number,
  channelUrl: string,
  now: () => Date,
): Promise<RefreshOutcome> {
  const result = await fetchRumbleListingPage(channelUrl);
  if (!result.ok) {
    return {
      ok: false,
      status: "failed",
      error: fail(
        result.failure.reason === "throttled"
          ? "throttled"
          : result.failure.reason === "unavailable_channel"
            ? "unavailable_creator"
            : result.failure.reason === "timeout"
              ? "timeout"
              : "unexpected_response",
        result.failure.message,
      ),
    };
  }

  const refreshedAt = now().toISOString();
  const outcome = mergeRumbleListing(db, creatorId, result.videos, refreshedAt);
  return {
    ok: true,
    status: "refreshed",
    refreshedAt,
    videoCount: outcome.fetchedCount - outcome.livestreamCount,
    livestreamCount: outcome.livestreamCount,
  };
}

// ---------------------------------------------------------------------------
// Cached reads
// ---------------------------------------------------------------------------

export interface CreatorCachedFeed {
  videos: VideoRecord[];
  livestreams: VideoRecord[];
  totalCachedCount: number;
}

/** Reads the cached feed grouped into the two UI tabs. */
export function getCachedCreatorFeed(db: ScopeDatabase, creatorId: number): CreatorCachedFeed {
  return {
    videos: listCachedVideos(db, creatorId, "videos"),
    livestreams: listCachedVideos(db, creatorId, "livestreams"),
    totalCachedCount: countCachedVideos(db, creatorId),
  };
}

// Re-exported for the AI Research page (stage 5) alongside the other reads.
export { listAllVideosWithCreator } from "./repository";
export type { VideoWithCreator } from "./repository";

export function getCachedVideo(
  db: ScopeDatabase,
  creatorId: number,
  videoId: string,
): VideoRecord | null {
  return getVideoForCreator(db, creatorId, videoId);
}
