/**
 * YouTube channel search through yt-dlp's search-URL extractor: one flat
 * extraction of YouTube's own results page filtered to channels. Returns
 * identity-only rows (no feeds are read). Server-only.
 *
 * Verified against live results 2026-10-07: each flat entry carries the
 * channel ID, name, @handle, subscriber count, verified flag, description,
 * and protocol-relative avatar thumbnails.
 */
import { isAllowedImageUrl } from "@/lib/creators/avatar";
import { pickAvatarUrl } from "@/lib/creators/resolver";
import { runCommand, type ExecFileResult } from "@/lib/ytdlp/runner";
import { NETWORK_UNREACHABLE_MESSAGE, YTDLP_MISSING_MESSAGE } from "@/lib/ytdlp/user-messages";
import { YT_DLP_COMMAND } from "@/lib/ytdlp/version";

import type { CreatorSearchError, CreatorSearchOutcome, CreatorSearchResult } from "./model";

export const YOUTUBE_SEARCH_LIMIT = 12;

/** YouTube's "Type: Channel" results filter. */
const CHANNEL_FILTER = "EgIQAg==";
const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;
const HANDLE_PATTERN = /^[0-9a-z._-]{3,30}$/;

export interface YouTubeSearchDeps {
  command: string;
  run: typeof runCommand;
  timeoutMs: number;
  maxOutputBytes: number;
}

const DEFAULT_DEPS: YouTubeSearchDeps = {
  command: YT_DLP_COMMAND,
  run: runCommand,
  timeoutMs: 20_000,
  maxOutputBytes: 4 * 1024 * 1024,
};

export function youtubeChannelSearchUrl(query: string): string {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  url.searchParams.set("sp", CHANNEL_FILTER);
  return url.toString();
}

/** Argument array for one flat, channel-filtered search page. */
export function buildYouTubeSearchArgs(query: string, limit = YOUTUBE_SEARCH_LIMIT): string[] {
  return [
    "--dump-single-json",
    "--flat-playlist",
    "--playlist-items",
    `1-${limit}`,
    "--no-warnings",
    "--no-progress",
    youtubeChannelSearchUrl(query),
  ];
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Search thumbnails are protocol-relative (`//yt3.ggpht.com/…`). */
function absolutizeThumbnails(thumbnails: unknown): unknown {
  if (!Array.isArray(thumbnails)) {
    return thumbnails;
  }
  return thumbnails.map((item: unknown) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }
    const url = (item as { url?: unknown }).url;
    return typeof url === "string" && url.startsWith("//")
      ? { ...item, url: `https:${url}` }
      : item;
  });
}

/**
 * Maps yt-dlp's search JSON to result rows. Entries that are not channels
 * (or lack a channel ID or name) are skipped rather than failing the page.
 */
export function parseYouTubeSearchPayload(payload: unknown): CreatorSearchResult[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    return [];
  }
  const results: CreatorSearchResult[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const channelId = asNonEmptyString(entry.channel_id) ?? asNonEmptyString(entry.id);
    if (channelId === null || !CHANNEL_ID_PATTERN.test(channelId) || seen.has(channelId)) {
      continue;
    }
    const displayName = asNonEmptyString(entry.title) ?? asNonEmptyString(entry.channel);
    if (displayName === null) {
      continue;
    }
    seen.add(channelId);
    const uploaderId = asNonEmptyString(entry.uploader_id);
    const handleCandidate = uploaderId?.startsWith("@") ? uploaderId.slice(1).toLowerCase() : null;
    const avatarUrl = pickAvatarUrl(absolutizeThumbnails(entry.thumbnails));
    const followers = entry.channel_follower_count;
    const description = asNonEmptyString(entry.description);
    results.push({
      platform: "youtube",
      id: channelId,
      displayName: displayName.slice(0, 100),
      handle:
        handleCandidate !== null && HANDLE_PATTERN.test(handleCandidate) ? handleCandidate : null,
      channelUrl: `https://www.youtube.com/channel/${channelId}`,
      avatarUrl: isAllowedImageUrl(avatarUrl) ? avatarUrl : null,
      followerCount:
        typeof followers === "number" && Number.isFinite(followers) && followers >= 0
          ? Math.round(followers)
          : null,
      verified: entry.channel_is_verified === true,
      protectedAccount: false,
      description: description === null ? null : description.slice(0, 300),
      youtubeChannelId: channelId,
      platformUserId: null,
      savedCreatorId: null,
    });
  }
  return results;
}

function classifySearchFailure(result: Extract<ExecFileResult, { ok: false }>): CreatorSearchError {
  if (result.kind === "missing_executable") {
    return { code: "ytdlp_missing", message: YTDLP_MISSING_MESSAGE };
  }
  if (result.kind === "timeout") {
    return {
      code: "timeout",
      message: "YouTube search took too long and was stopped. Please try again.",
    };
  }
  if (
    /getaddrinfo|temporary failure|name or service not known|network|connection|unable to download|resolve|refused|reset by peer/.test(
      result.stderrTail.toLowerCase(),
    )
  ) {
    return { code: "network", message: NETWORK_UNREACHABLE_MESSAGE };
  }
  return {
    code: "unexpected_response",
    message: "YouTube search is not responding right now. Try again, or paste the channel link.",
  };
}

/** Searches YouTube for channels matching an already-normalized query. */
export async function searchYouTubeChannels(
  query: string,
  overrides: Partial<YouTubeSearchDeps> = {},
): Promise<CreatorSearchOutcome> {
  const deps: YouTubeSearchDeps = { ...DEFAULT_DEPS, ...overrides };
  const result = await deps.run(deps.command, buildYouTubeSearchArgs(query), {
    timeoutMs: deps.timeoutMs,
    maxOutputBytes: deps.maxOutputBytes,
  });
  if (!result.ok) {
    return { ok: false, error: classifySearchFailure(result) };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      error: {
        code: "unexpected_response",
        message: "scope could not read YouTube's search results. Please try again.",
      },
    };
  }
  return { ok: true, results: parseYouTubeSearchPayload(payload) };
}
