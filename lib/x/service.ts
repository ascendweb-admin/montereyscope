/**
 * X application service: provider orchestration, connection lifecycle, and
 * cache reads/writes shared by Server Actions and Route Handlers.
 * Server-only.
 *
 * All network work goes through the active provider under a process-wide
 * mutex (one X worker operation at a time) and per-creator refresh
 * coalescing. Failures never erase cached posts: merges happen only after a
 * page was fetched and mapped successfully.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { addCreator, getCreator, type CreatorRecord } from "@/lib/creators/repository";

import {
  X_MAX_DETAIL_BATCH,
  X_MAX_RECENT_LIMIT,
  XProviderError,
  type XConnectionStatus,
  type XErrorCode,
  type XTimelinePage,
  type XUserIdentity,
  type XUserSearchResult,
} from "./model";
import { parseXTarget, xProfileUrl } from "./urls";
import { getXProvider } from "./providers";
import {
  countCreatorTweets,
  countCreatorTweetsFiltered,
  getTweetForCreator,
  getXFeedState,
  listCreatorTweets,
  mergeCreatorTimeline,
  recordTweetNotRetrievable,
  upsertXFeedState,
  type CreatorTweetRecord,
  type XFeedStateRecord,
} from "./repository";

export interface XServiceError {
  code: XErrorCode;
  message: string;
  retryAfterSeconds: number | null;
}

export function toXServiceError(error: unknown): XServiceError {
  if (error instanceof XProviderError) {
    return {
      code: error.code,
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  return {
    code: "invalid_response",
    message: "Scope could not read that X data. Please try again.",
    retryAfterSeconds: null,
  };
}

// ---------------------------------------------------------------------------
// Process-wide serialization
// ---------------------------------------------------------------------------

// Next builds route handlers and actions into separate bundles. Share the queue
// through globalThis so research jobs and existing channel reads serialize together.
const xOperationState = globalThis as typeof globalThis & {
  __scopeXOperationQueue?: {
    busy: boolean;
    waiting: Array<{ background: boolean; start: () => void }>;
  };
};

export interface XExclusiveOptions {
  /** Yields to every non-background caller waiting at the time the X connection frees up. */
  background?: boolean;
}

/**
 * Serializes every X provider call in this process: one network operation at
 * a time, no nested retries. Callers waiting here do not hold database locks.
 * Background work (backfilling older posts) waits behind everything else.
 */
export async function runXExclusive<T>(
  operation: () => Promise<T>,
  { background = false }: XExclusiveOptions = {},
): Promise<T> {
  const queue = (xOperationState.__scopeXOperationQueue ??= { busy: false, waiting: [] });
  if (queue.busy) await new Promise<void>((start) => queue.waiting.push({ background, start }));
  else queue.busy = true;
  try {
    return await operation();
  } finally {
    const urgent = queue.waiting.findIndex((waiter) => !waiter.background);
    const [next] = queue.waiting.splice(urgent === -1 ? 0 : urgent, 1);
    if (next) next.start();
    else queue.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export async function getXConnectionStatus(signal?: AbortSignal): Promise<XConnectionStatus> {
  return getXProvider().status(signal);
}

export async function connectX(signal?: AbortSignal): Promise<XConnectionStatus> {
  const provider = getXProvider();
  if (!provider.canConnect || !provider.connect) {
    return {
      capability: "unavailable",
      providerId: provider.id,
      user: null,
      errorCode: "unsupported_runtime",
      sessionOnly: false,
    };
  }
  return runXExclusive(() => provider.connect!(signal));
}

export async function disconnectX(): Promise<void> {
  const provider = getXProvider();
  if (provider.disconnect) {
    await provider.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Preview / resolution
// ---------------------------------------------------------------------------

export interface XResolvedCreator {
  platform: "x";
  platformUserId: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  channelUrl: string;
  description: string | null;
  pinnedTweetId: string | null;
  /** Status-link imports preview the post before saving. */
  tweetId: string | null;
  tweetText: string | null;
  tweetUrl: string | null;
  tweetPublishedAt: string | null;
}

export type XResolveResult =
  | { ok: true; creator: XResolvedCreator }
  | { ok: false; error: XServiceError };

/**
 * Resolves X input into a creator preview. `@handle` is only accepted when
 * the caller explicitly selected X (allowBareHandle).
 */
export async function resolveXCreator(
  rawInput: string,
  signal?: AbortSignal,
): Promise<XResolveResult> {
  const parsed = parseXTarget(rawInput, { allowBareHandle: true });
  if (!parsed.ok) {
    return { ok: false, error: { code: "not_found", message: parsed.message, retryAfterSeconds: null } };
  }
  const target = parsed.target;
  try {
    return await runXExclusive(async () => {
      const provider = getXProvider();
      const lookup = await provider.resolveUser(target.handle, signal);
      const channelUrl = xProfileUrl(lookup.user.handle);
      let tweetId: string | null = null;
      let tweetText: string | null = null;
      let tweetUrl: string | null = null;
      let tweetPublishedAt: string | null = null;

      if (target.kind === "status") {
        const tweet = await provider.getTweet(target.tweetId, target.handle, signal);
        if (tweet === null) {
          return {
            ok: false,
            error: {
              code: "not_found",
              message: "That post could not be found, so it cannot be imported.",
              retryAfterSeconds: null,
            },
          } satisfies XResolveResult;
        }
        tweetId = tweet.id;
        tweetText = tweet.text;
        tweetUrl = tweet.url;
        tweetPublishedAt = tweet.publishedAt;
      }

      return {
        ok: true,
        creator: {
          platform: "x",
          platformUserId: lookup.user.userId,
          handle: lookup.user.handle,
          displayName: lookup.user.displayName,
          avatarUrl: lookup.user.avatarUrl,
          channelUrl,
          description: lookup.user.description ?? null,
          pinnedTweetId: lookup.pinnedTweetId,
          tweetId,
          tweetText,
          tweetUrl,
          tweetPublishedAt,
        },
      } satisfies XResolveResult;
    });
  } catch (error) {
    return { ok: false, error: toXServiceError(error) };
  }
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

const X_HANDLE_PATTERN = /^[0-9A-Za-z_]{1,15}$/;
const X_USER_ID_PATTERN = /^\d{1,20}$/;

export interface XCreatorPayloadInput {
  platformUserId: string;
  handle: string;
  displayName: string;
  channelUrl: string;
  avatarUrl: string | null;
}

export type XPayloadValidation =
  | { ok: true; input: XCreatorPayloadInput }
  | { ok: false; error: XServiceError };

/**
 * Re-validates a client-confirmed X preview before persisting it. The client
 * never supplies tweet bodies: a status-link import re-fetches server side.
 */
export function validateXCreatorPayload(payload: unknown): XPayloadValidation {
  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      error: {
        code: "invalid_response",
        message: "That X account was not resolved correctly. Start again from the link.",
        retryAfterSeconds: null,
      },
    };
  }
  const candidate = payload as Record<string, unknown>;
  const platformUserId = typeof candidate.platformUserId === "string" ? candidate.platformUserId : "";
  const handleRaw = typeof candidate.handle === "string" ? candidate.handle.replace(/^@/, "") : "";
  const displayName =
    typeof candidate.displayName === "string" ? candidate.displayName.trim().slice(0, 100) : "";
  const channelUrl = typeof candidate.channelUrl === "string" ? candidate.channelUrl : "";

  const profile = parseXTarget(channelUrl);
  const urlHandle = profile.ok && profile.target.kind === "profile" ? profile.target.handle : null;

  if (
    !X_USER_ID_PATTERN.test(platformUserId) ||
    !X_HANDLE_PATTERN.test(handleRaw) ||
    displayName.length === 0 ||
    urlHandle === null ||
    urlHandle.toLowerCase() !== handleRaw.toLowerCase()
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_response",
        message: "That X account was not resolved correctly. Start again from the link.",
        retryAfterSeconds: null,
      },
    };
  }

  return {
    ok: true,
    input: {
      platformUserId,
      handle: handleRaw,
      displayName,
      channelUrl: xProfileUrl(handleRaw),
      avatarUrl: typeof candidate.avatarUrl === "string" ? candidate.avatarUrl : null,
    },
  };
}

export interface SaveXCreatorInput {
  payload: unknown;
  /** Import this post into the new creator's timeline after saving. */
  importTweetId?: string | null;
  now?: () => Date;
}

export type SaveXCreatorOutcome =
  | { ok: true; status: "created" | "already_saved"; creator: CreatorRecord; importedTweet: boolean }
  | { ok: false; error: XServiceError };

/**
 * Saves a confirmed X creator. When a status link was used, the post is
 * fetched from the provider and linked as an `import` — the tweet body is
 * never accepted from the client.
 */
export async function saveXCreator(
  db: ScopeDatabase,
  input: SaveXCreatorInput,
): Promise<SaveXCreatorOutcome> {
  const validated = validateXCreatorPayload(input.payload);
  if (!validated.ok) {
    return validated;
  }
  const outcome = addCreator(db, {
    youtubeChannelId: null,
    platformUserId: validated.input.platformUserId,
    handle: validated.input.handle,
    displayName: validated.input.displayName,
    channelUrl: validated.input.channelUrl,
    avatarUrl: validated.input.avatarUrl,
    platform: "x",
  });

  let importedTweet = false;
  const importTweetId =
    typeof input.importTweetId === "string" && /^\d{1,20}$/.test(input.importTweetId)
      ? input.importTweetId
      : null;
  if (importTweetId !== null) {
    try {
      importedTweet = await runXExclusive(async () => {
        const provider = getXProvider();
        const tweet = await provider.getTweet(importTweetId, validated.input.handle);
        if (tweet === null) {
          return false;
        }
        mergeCreatorTimeline(db, outcome.creator.id, [
          { tweet, timelineKind: "post", timelineAt: tweet.publishedAt },
        ]);
        return true;
      });
    } catch {
      // The creator is saved either way; the post import can be retried by
      // fetching the timeline.
      importedTweet = false;
    }
  }

  return { ok: true, status: outcome.status, creator: outcome.creator, importedTweet };
}

// ---------------------------------------------------------------------------
// People search
// ---------------------------------------------------------------------------

export type XUserSearchOutcome =
  { ok: true; users: XUserSearchResult[] } | { ok: false; error: XServiceError };

const SEARCHABLE_HANDLE = /^@?([0-9A-Za-z_]{1,15})$/;

/**
 * Searches X accounts by name through the connected session. When the
 * people search returns nothing (or its endpoint stops answering in a form
 * Scope can read) and the query is shaped like a handle, the exact
 * `@handle` is looked up instead, so typing "pewdiepie" still finds
 * @pewdiepie. Connection and rate-limit failures are reported as is.
 */
export async function searchXUsers(
  query: string,
  signal?: AbortSignal,
): Promise<XUserSearchOutcome> {
  const handle = SEARCHABLE_HANDLE.exec(query.trim())?.[1] ?? null;
  try {
    return await runXExclusive(async () => {
      const provider = getXProvider();
      let users: XUserSearchResult[] = [];
      try {
        users = await provider.searchUsers(query, signal);
      } catch (error) {
        if (
          !(error instanceof XProviderError) ||
          error.code !== "invalid_response" ||
          handle === null
        ) {
          throw error;
        }
      }
      if (users.length > 0 || handle === null) {
        return { ok: true, users } satisfies XUserSearchOutcome;
      }
      try {
        const lookup = await provider.resolveUser(handle, signal);
        return {
          ok: true,
          users: [{ ...lookup.user, verified: false, protected: false }],
        } satisfies XUserSearchOutcome;
      } catch (error) {
        if (
          error instanceof XProviderError &&
          (error.code === "not_found" || error.code === "protected_account")
        ) {
          return { ok: true, users: [] } satisfies XUserSearchOutcome;
        }
        throw error;
      }
    });
  } catch (error) {
    return { ok: false, error: toXServiceError(error) };
  }
}

// ---------------------------------------------------------------------------
// Refresh / fetch
// ---------------------------------------------------------------------------

export interface XRefreshSuccess {
  ok: true;
  status: "refreshed" | "already_in_progress" | "exhausted";
  refreshedAt: string;
  newItemCount: number;
  skipped: number;
  hasOlderAvailable: boolean;
}

export interface XRefreshFailure {
  ok: false;
  status: "failed";
  error: XServiceError;
}

export type XRefreshOutcome = XRefreshSuccess | XRefreshFailure;

/** The account/filter configuration a cursor belongs to. */
export function xFeedConfigKey(providerId: string, accountUserId: string | null): string {
  return `x1:${providerId}:${accountUserId ?? "unknown"}`;
}

function coerceLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(X_MAX_RECENT_LIMIT, Math.floor(value)));
}

const inFlightRefreshes = new Map<number, Promise<XRefreshOutcome>>();

/** Test seam: forget any in-flight refresh state. */
export function resetXInFlightRefreshes(): void {
  inFlightRefreshes.clear();
}

async function requireAccount(): Promise<{ status: XConnectionStatus; user: XUserIdentity }> {
  const status = await getXProvider().status();
  if (status.capability !== "connected" || status.user === null) {
    throw new XProviderError(status.errorCode ?? "not_connected");
  }
  return { status, user: status.user };
}

/**
 * Refreshes a creator's cached timeline from the provider. `mode` picks the
 * newest window ("recent", explicit user action) or the next older page
 * ("older") following the stored cursor.
 */
export async function refreshCreatorTweets(
  db: ScopeDatabase,
  creatorId: number,
  options: { mode?: "recent" | "older"; limit?: number; now?: () => Date } = {},
): Promise<XRefreshOutcome> {
  const mode = options.mode ?? "recent";
  const existing = inFlightRefreshes.get(creatorId);
  if (existing && mode === "recent") {
    const outcome = await existing;
    return outcome.ok ? { ...outcome, status: "already_in_progress" } : outcome;
  }

  const task = performTimelineRefresh(db, creatorId, mode, options);
  inFlightRefreshes.set(creatorId, task);
  try {
    return await task;
  } finally {
    if (inFlightRefreshes.get(creatorId) === task) {
      inFlightRefreshes.delete(creatorId);
    }
  }
}

async function performTimelineRefresh(
  db: ScopeDatabase,
  creatorId: number,
  mode: "recent" | "older",
  options: { limit?: number; now?: () => Date },
): Promise<XRefreshOutcome> {
  const now = options.now ?? (() => new Date());
  const creator = getCreator(db, creatorId);
  if (!creator || creator.platform !== "x") {
    return {
      ok: false,
      status: "failed",
      error: {
        code: "not_found",
        message: "That creator is no longer in your library.",
        retryAfterSeconds: null,
      },
    };
  }

  const stateBefore = getXFeedState(db, creatorId);

  try {
    return await runXExclusive(async () => {
      const provider = getXProvider();
      const { user } = await requireAccount();
      const configKey = xFeedConfigKey(provider.id, user.userId);

      // Account or provider changes invalidate stored cursors.
      const configChanged = stateBefore !== null && stateBefore.configKey !== configKey;
      const storedCursor = configChanged ? null : (stateBefore?.olderCursor ?? null);
      const alreadyExhausted = configChanged ? false : (stateBefore?.exhausted ?? false);

      if (mode === "older" && (storedCursor === null || alreadyExhausted)) {
        upsertXFeedState(db, {
          creatorId,
          configKey,
          olderCursor: storedCursor,
          exhausted: true,
          lastError: null,
        });
        return {
          ok: true,
          status: "exhausted",
          refreshedAt: stateBefore?.lastRefreshedAt ?? now().toISOString(),
          newItemCount: 0,
          skipped: 0,
          hasOlderAvailable: false,
        };
      }

      const limit = coerceLimit(options.limit, 20);
      if (!creator.platformUserId) {
        throw new XProviderError("invalid_response");
      }
      const page: XTimelinePage = await provider.listUserTweets({
        userId: creator.platformUserId,
        handle: creator.handle ?? "",
        cursor: mode === "older" ? storedCursor : null,
        limit,
      });

      const merged = mergeCreatorTimeline(db, creatorId, page.items);
      const refreshedAt = now().toISOString();
      // A recent refresh seeds the older cursor only when none is stored;
      // deeper pagination progress is never regressed.
      const nextCursor = mode === "older" ? page.nextCursor : (storedCursor ?? page.nextCursor);
      const nextExhausted =
        mode === "older" ? page.exhausted : storedCursor !== null ? alreadyExhausted : page.exhausted;
      upsertXFeedState(db, {
        creatorId,
        configKey,
        lastRefreshedAt: mode === "recent" ? refreshedAt : (stateBefore?.lastRefreshedAt ?? refreshedAt),
        olderCursor: nextCursor,
        exhausted: nextExhausted,
        lastError: null,
      });

      const hasOlderAvailable = !nextExhausted;

      return {
        ok: true,
        status: "refreshed",
        refreshedAt,
        newItemCount: merged.mergedCount,
        skipped: page.skipped,
        hasOlderAvailable,
      };
    });
  } catch (error) {
    const serviceError = toXServiceError(error);
    // Record the last safe error for display; cached posts are untouched.
    const providerId = getXProvider().id;
    upsertXFeedState(db, {
      creatorId,
      configKey: stateBefore?.configKey ?? xFeedConfigKey(providerId, null),
      olderCursor: stateBefore?.olderCursor ?? null,
      exhausted: stateBefore?.exhausted ?? false,
      lastError: serviceError.code,
    });
    return { ok: false, status: "failed", error: serviceError };
  }
}

export type XFetchItemStatus = "saved" | "already_complete" | "unavailable" | "failed";

export interface XFetchItemOutcome {
  tweetId: string;
  status: XFetchItemStatus;
  errorCode: XErrorCode | null;
}

export interface XFetchBatchOutcome {
  ok: true;
  results: XFetchItemOutcome[];
  savedCount: number;
  alreadyCompleteCount: number;
  unavailableCount: number;
  failedCount: number;
}

/**
 * Hydrates a validated batch of tweet ids associated with this creator.
 * Items with complete cached text are reported as already saved; the
 * timeline fetch is not repeated for them.
 */
export async function fetchTweetsForCreator(
  db: ScopeDatabase,
  creatorId: number,
  tweetIds: readonly string[],
): Promise<XFetchBatchOutcome | { ok: false; error: XServiceError }> {
  const creator = getCreator(db, creatorId);
  if (!creator || creator.platform !== "x") {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: "That creator is no longer in your library.",
        retryAfterSeconds: null,
      },
    };
  }
  const unique = [...new Set(tweetIds)].slice(0, X_MAX_DETAIL_BATCH);
  const results: XFetchItemOutcome[] = [];

  try {
    await runXExclusive(async () => {
      const provider = getXProvider();
      await requireAccount();
      for (const tweetId of unique) {
        if (!/^\d{1,20}$/.test(tweetId)) {
          results.push({ tweetId, status: "failed", errorCode: "invalid_response" });
          continue;
        }
        const cached = getTweetForCreator(db, creatorId, tweetId);
        if (!cached) {
          results.push({ tweetId, status: "failed", errorCode: "not_found" });
          continue;
        }
        if (cached && cached.tweet.contentStatus === "complete" && cached.tweet.text.length > 0) {
          results.push({ tweetId, status: "already_complete", errorCode: null });
          continue;
        }
        try {
          const tweet = await provider.getTweet(tweetId, creator.handle);
          if (tweet === null) {
            recordTweetNotRetrievable(db, tweetId);
            results.push({ tweetId, status: "unavailable", errorCode: "not_found" });
            continue;
          }
          if (tweet.contentStatus !== "complete" || tweet.text.length === 0) {
            results.push({ tweetId, status: "unavailable", errorCode: null });
            continue;
          }
          mergeCreatorTimeline(db, creatorId, [
            { tweet, timelineKind: cached.timelineKind, timelineAt: cached.timelineAt },
          ]);
          results.push({ tweetId, status: "saved", errorCode: null });
        } catch (error) {
          const serviceError = toXServiceError(error);
          results.push({ tweetId, status: "failed", errorCode: serviceError.code });
          // Authentication/verification failures stop the batch.
          if (
            serviceError.code === "session_expired" ||
            serviceError.code === "not_connected" ||
            serviceError.code === "verification_required"
          ) {
            break;
          }
        }
      }
    });
  } catch (error) {
    return { ok: false, error: toXServiceError(error) };
  }

  const savedCount = results.filter((result) => result.status === "saved").length;
  const alreadyCompleteCount = results.filter((result) => result.status === "already_complete").length;
  const unavailableCount = results.filter((result) => result.status === "unavailable").length;
  const failedCount = results.filter((result) => result.status === "failed").length;
  return { ok: true, results, savedCount, alreadyCompleteCount, unavailableCount, failedCount };
}

// ---------------------------------------------------------------------------
// Cached reads
// ---------------------------------------------------------------------------

export interface CreatorTimelinePageResult {
  items: CreatorTweetRecord[];
  totalCount: number;
  hasMore: boolean;
  state: XFeedStateRecord | null;
}

export interface TimelineQueryOptions {
  includeReplies?: boolean;
  includeReposts?: boolean;
  limit?: number;
  offset?: number;
}

/** Local-only read of a creator's cached timeline. Never calls the provider. */
export function getCachedCreatorTimeline(
  db: ScopeDatabase,
  creatorId: number,
  query: TimelineQueryOptions = {},
): CreatorTimelinePageResult {
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 100)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const filters = {
    includeReplies: query.includeReplies === true,
    includeReposts: query.includeReposts !== false,
  };
  const items = listCreatorTweets(db, creatorId, { ...filters, limit, offset });
  const totalCount = countCreatorTweetsFiltered(db, creatorId, filters);
  return {
    items,
    totalCount,
    hasMore: offset + items.length < totalCount,
    state: getXFeedState(db, creatorId),
  };
}

export function getCachedTweet(
  db: ScopeDatabase,
  creatorId: number,
  tweetId: string,
): CreatorTweetRecord | null {
  return getTweetForCreator(db, creatorId, tweetId);
}

export function countCachedCreatorTweets(db: ScopeDatabase, creatorId: number): number {
  return countCreatorTweets(db, creatorId);
}
