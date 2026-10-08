/**
 * Creator search orchestration: validates the query, runs the selected
 * platform's search, and marks results already saved in the library so the
 * dialog can show "Added" instead of a second add button. Server-only.
 */
import { listCreators, type CreatorPlatform, type CreatorRecord } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { searchRumbleChannels } from "@/lib/rumble/channel-search";
import { searchXUsers } from "@/lib/x/service";
import { xProfileUrl } from "@/lib/x/urls";

import {
  normalizeSearchQuery,
  type CreatorSearchErrorCode,
  type CreatorSearchOutcome,
  type CreatorSearchResult,
} from "./model";
import { searchYouTubeChannels } from "./youtube";

export interface CreatorSearchDeps {
  youtube: typeof searchYouTubeChannels;
  rumble: typeof searchRumbleChannels;
  x: typeof searchXUsers;
}

const DEFAULT_DEPS: CreatorSearchDeps = {
  youtube: searchYouTubeChannels,
  rumble: searchRumbleChannels,
  x: searchXUsers,
};

const X_CODES = new Set<CreatorSearchErrorCode>([
  "not_connected",
  "unsupported_runtime",
  "session_expired",
  "verification_required",
  "rate_limited",
  "network",
  "timeout",
  "cancelled",
  "invalid_response",
]);

async function searchX(
  query: string,
  search: typeof searchXUsers,
  signal?: AbortSignal,
): Promise<CreatorSearchOutcome> {
  const outcome = await search(query, signal);
  if (!outcome.ok) {
    const code = outcome.error.code as CreatorSearchErrorCode;
    return {
      ok: false,
      error: {
        code: X_CODES.has(code) ? code : "invalid_response",
        message: outcome.error.message,
        retryAfterSeconds: outcome.error.retryAfterSeconds,
      },
    };
  }
  return {
    ok: true,
    results: outcome.users.map((user) => ({
      platform: "x",
      id: user.userId,
      displayName: user.displayName,
      handle: user.handle,
      channelUrl: xProfileUrl(user.handle),
      avatarUrl: user.avatarUrl,
      followerCount: null,
      verified: user.verified,
      protectedAccount: user.protected,
      description: user.description ?? null,
      youtubeChannelId: null,
      platformUserId: user.userId,
      savedCreatorId: null,
    })),
  };
}

/** Finds the library row a result refers to, using the duplicate rules. */
function savedMatcher(creators: readonly CreatorRecord[]) {
  const byChannelId = new Map<string, number>();
  const byUserId = new Map<string, number>();
  const byUrl = new Map<string, number>();
  for (const creator of creators) {
    if (creator.youtubeChannelId) byChannelId.set(creator.youtubeChannelId, creator.id);
    if (creator.platformUserId) byUserId.set(creator.platformUserId, creator.id);
    byUrl.set(`${creator.platform}:${creator.channelUrl.toLowerCase()}`, creator.id);
  }
  return (result: CreatorSearchResult): number | null =>
    (result.youtubeChannelId ? byChannelId.get(result.youtubeChannelId) : undefined) ??
    (result.platformUserId ? byUserId.get(result.platformUserId) : undefined) ??
    byUrl.get(`${result.platform}:${result.channelUrl.toLowerCase()}`) ??
    null;
}

/** Runs one platform search and annotates each result's saved state. */
export async function searchCreators(
  db: ScopeDatabase,
  platform: CreatorPlatform,
  rawQuery: unknown,
  options: { signal?: AbortSignal; deps?: Partial<CreatorSearchDeps> } = {},
): Promise<CreatorSearchOutcome> {
  const query = normalizeSearchQuery(rawQuery);
  if (query === null) {
    return {
      ok: false,
      error: {
        code: "invalid_query",
        message: "Type a creator's name to search (up to 100 characters).",
      },
    };
  }
  const deps = { ...DEFAULT_DEPS, ...options.deps };
  const outcome =
    platform === "youtube"
      ? await deps.youtube(query)
      : platform === "rumble"
        ? await deps.rumble(query, { signal: options.signal })
        : await searchX(query, deps.x, options.signal);
  if (!outcome.ok) {
    return outcome;
  }
  const savedIdFor = savedMatcher(listCreators(db));
  return {
    ok: true,
    results: outcome.results.map((result) => ({ ...result, savedCreatorId: savedIdFor(result) })),
  };
}
