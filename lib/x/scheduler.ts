/**
 * The one door every X read goes through. One request at a time (the X
 * session is shared), the most urgent waiter first, and timeline reads paced
 * against X's quota so background work never spends the requests that keep
 * the list on screen fresh.
 *
 * X allows 50 profile-timeline reads per 15 minutes per account. When X
 * reports its quota headers, Scope follows them exactly; otherwise it counts
 * its own reads. Each priority keeps a reserve for the ones above it, so a
 * large import of older posts slows down long before "Update now" would have
 * to wait. A 429 blocks only the timeline bucket, not profile lookups or
 * search. Server-only; shared through globalThis across route bundles.
 */
import { XProviderError, type XRateLimit } from "./model";

/** Lower runs first. Evaluated each time the connection frees up, so a waiter can move up. */
export const X_PRIORITY = {
  /** Someone is waiting on screen: adding an account, searching, connecting. */
  interactive: 0,
  /** "Update now" for the accounts on screen. */
  manual: 5,
  /** New posts for the accounts on screen. */
  focusHead: 10,
  /** New posts for everyone else. */
  head: 20,
  /** Older posts for the timeframe on screen. */
  focusBackfill: 30,
  /** Everything else: older posts of first imports, research history. */
  backfill: 40,
} as const;

export type XBucket = "timeline";

/**
 * Timeline reads each priority leaves untouched for more urgent work. Imports of older posts
 * always leave enough for one "Update now" of the accounts on screen.
 */
export function reserveFor(priority: number): number {
  if (priority <= X_PRIORITY.manual) return 0;
  if (priority <= X_PRIORITY.focusHead) return 2;
  if (priority <= X_PRIORITY.head) return 6;
  const onScreen = state().onScreen;
  if (priority <= X_PRIORITY.focusBackfill) return Math.max(12, Math.min(25, onScreen + 2));
  return Math.max(20, Math.min(30, onScreen + 8));
}

/** How many accounts are on screen, so older-post imports keep enough reads to check them all. */
export function setXOnScreen(accounts: number): void {
  state().onScreen = accounts;
}

const DEFAULT_LIMIT = 50;
const WINDOW_MS = 15 * 60_000;

interface Quota {
  limit: number;
  /** Requests left until `resetAt`, as X last reported (null: never reported). */
  remaining: number | null;
  resetAt: number;
  /** Requests started since X's last report. */
  spentSinceReport: number;
  /** When each of our own requests started, for the estimate without X's headers. */
  log: number[];
  /** X answered 429: nothing in this bucket before then. */
  blockedUntil: number;
}

interface Waiter {
  priority: () => number;
  bucket: XBucket | null;
  start: () => void;
}

interface SchedulerState {
  busy: boolean;
  waiting: Waiter[];
  timer: ReturnType<typeof setTimeout> | null;
  quota: Record<XBucket, Quota>;
  onScreen: number;
}

const newQuota = (): Quota => ({
  limit: DEFAULT_LIMIT,
  remaining: null,
  resetAt: 0,
  spentSinceReport: 0,
  log: [],
  blockedUntil: 0,
});

const shared = globalThis as typeof globalThis & { __scopeXScheduler?: SchedulerState };
function state(): SchedulerState {
  return (shared.__scopeXScheduler ??= {
    busy: false,
    waiting: [],
    timer: null,
    quota: { timeline: newQuota() },
    onScreen: 0,
  });
}

/** Test seam: forget queued work and quota knowledge. */
export function resetXScheduler(): void {
  const current = shared.__scopeXScheduler;
  if (current?.timer) clearTimeout(current.timer);
  delete shared.__scopeXScheduler;
}

function available(quota: Quota, now: number): number {
  if (quota.blockedUntil > now) return 0;
  quota.log = quota.log.filter((at) => at > now - WINDOW_MS);
  if (quota.remaining !== null && quota.resetAt > now)
    return Math.max(0, quota.remaining - quota.spentSinceReport);
  // After a reported window ends, the next one starts fresh: count only reads since its reset.
  if (quota.resetAt > 0)
    return Math.max(0, quota.limit - quota.log.filter((at) => at >= quota.resetAt).length);
  return Math.max(0, quota.limit - quota.log.length);
}

/** The next moment a held-back bucket can have more room, if any is known. */
function nextChange(quota: Quota, now: number): number | null {
  const candidates = [
    quota.blockedUntil,
    quota.resetAt,
    ...(quota.log.length ? [quota.log[0] + WINDOW_MS] : []),
  ];
  const future = candidates.filter((at) => at > now);
  return future.length ? Math.min(...future) : null;
}

function pump(): void {
  const s = state();
  if (s.busy) return;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  const now = Date.now();
  let best = -1;
  let bestPriority = Infinity;
  s.waiting.forEach((waiter, index) => {
    const priority = waiter.priority();
    if (waiter.bucket && available(s.quota[waiter.bucket], now) <= reserveFor(priority)) return;
    // Strictly lower wins, so equal priorities keep arrival order.
    if (priority < bestPriority) {
      best = index;
      bestPriority = priority;
    }
  });
  if (best >= 0) {
    const [next] = s.waiting.splice(best, 1);
    s.busy = true;
    next.start();
    return;
  }
  if (s.waiting.length) {
    // Look again when the quota frees up, and at least every minute in case it was misjudged.
    const at = Math.min(nextChange(s.quota.timeline, now) ?? Infinity, now + 60_000);
    s.timer = setTimeout(pump, Math.max(250, at - now));
    s.timer.unref?.();
  }
}

export interface XScheduleOptions {
  /** Shorthand for the lowest priority, kept for older callers. */
  background?: boolean;
  /** Lower runs first; a function is re-read whenever the connection frees up. */
  priority?: number | (() => number);
  /** The X quota this read spends. Timeline reads wait while the quota is down to their reserve. */
  bucket?: XBucket;
  /** Leaves the queue without running when aborted. */
  signal?: AbortSignal;
}

/**
 * Runs one X operation when it is this waiter's turn. Callers waiting here
 * hold no database locks.
 */
export async function scheduleX<T>(
  operation: () => Promise<T>,
  options: XScheduleOptions = {},
): Promise<T> {
  const s = state();
  const fixed =
    options.priority ?? (options.background ? X_PRIORITY.backfill : X_PRIORITY.interactive);
  const priority = typeof fixed === "function" ? fixed : () => fixed;
  const bucket = options.bucket ?? null;
  const free =
    !s.busy &&
    !s.waiting.length &&
    (!bucket || available(s.quota[bucket], Date.now()) > reserveFor(priority()));
  if (free) s.busy = true;
  else
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { priority, bucket, start: resolve };
      const signal = options.signal;
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener(
        "abort",
        () => {
          const index = s.waiting.indexOf(waiter);
          if (index === -1) return;
          s.waiting.splice(index, 1);
          reject(signal.reason);
        },
        { once: true },
      );
      s.waiting.push(waiter);
      pump();
    });
  try {
    if (bucket) {
      const quota = s.quota[bucket];
      quota.log.push(Date.now());
      quota.spentSinceReport++;
    }
    const result = await operation();
    if (bucket)
      recordRateLimit(
        bucket,
        (result as { rateLimit?: XRateLimit | null } | null)?.rateLimit ?? null,
      );
    return result;
  } catch (error) {
    if (bucket && error instanceof XProviderError && error.code === "rate_limited")
      recordRateLimited(bucket, error.retryAfterSeconds);
    throw error;
  } finally {
    s.busy = false;
    pump();
  }
}

/** Follows the quota X reported with a response. */
export function recordRateLimit(bucket: XBucket, rate: XRateLimit | null, now = Date.now()): void {
  if (!rate || !Number.isInteger(rate.remaining) || !Number.isInteger(rate.reset)) return;
  const quota = state().quota[bucket];
  const resetAt = rate.reset * 1000;
  // A reset far in the past or future is clock skew, not a real window.
  if (resetAt < now - 60_000 || resetAt > now + 2 * WINDOW_MS) return;
  quota.remaining = rate.remaining;
  quota.resetAt = resetAt;
  if (Number.isInteger(rate.limit) && rate.limit! > 0) quota.limit = rate.limit!;
  quota.spentSinceReport = 0;
}

/** X answered 429: hold this bucket until X said to try again. */
export function recordRateLimited(
  bucket: XBucket,
  retryAfterSeconds: number | null,
  now = Date.now(),
): void {
  const quota = state().quota[bucket];
  const until = now + Math.max(1, retryAfterSeconds ?? 60) * 1000;
  quota.blockedUntil = Math.max(quota.blockedUntil, until);
  quota.remaining = 0;
  quota.resetAt = Math.max(quota.resetAt, until);
  quota.spentSinceReport = 0;
  pump();
}

export interface XQuotaStatus {
  available: number;
  limit: number;
  /** When more requests free up, if the bucket is held back now. */
  nextAt: string | null;
  /** True when Scope counts its own reads because X sent no quota headers. */
  estimated: boolean;
}

export function xQuotaStatus(bucket: XBucket = "timeline", now = Date.now()): XQuotaStatus {
  const quota = state().quota[bucket];
  const left = available(quota, now);
  const next = left < quota.limit ? nextChange(quota, now) : null;
  return {
    available: left,
    limit: quota.limit,
    nextAt: next === null ? null : new Date(next).toISOString(),
    estimated: quota.remaining === null,
  };
}

/** True while a read at this priority would wait for X's quota. */
export function heldByQuota(
  priority: number,
  bucket: XBucket = "timeline",
  now = Date.now(),
): boolean {
  return available(state().quota[bucket], now) <= reserveFor(priority);
}
