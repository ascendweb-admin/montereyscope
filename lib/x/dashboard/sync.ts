/**
 * X Dashboard syncing.
 *
 * X allows about 50 profile-timeline reads per 15 minutes per account, and a
 * check for new posts usually costs one read per account. So instead of one
 * "sync everyone" job every half hour, each account is checked when it is
 * due: the accounts on screen every few minutes (as often as the budget
 * allows for that many accounts), everyone else on the interval chosen in
 * Settings. The timeframe on screen decides how far back history is filled
 * in. Every read still goes through the retrieval engine, which continues
 * unfinished work, waits out rate limits, and paces reads by priority.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { getDb } from "@/lib/db/connection";
import { getXSyncSettings } from "@/lib/settings/settings";
import { getXConnectionStatus } from "@/lib/x/service";
import { boostX, currentXFocus, xReadPriority } from "@/lib/x/focus";
import type { XConnectionStatus } from "@/lib/x/model";
import { heldByQuota, xQuotaStatus } from "@/lib/x/scheduler";
import { getRetrievalEngine, type RetrievalEngine } from "@/lib/x/research/retrieval";
import { ResearchInputError } from "@/lib/x/research/input";
import type { RetrievalCreatorState, RetrievalJob } from "@/lib/x/research/retrieval-model";
import type { FeedCoverage, SyncCreatorState, SyncSnapshot, SyncState } from "./model";

const DISCONNECTED = new Set([
  "not_connected",
  "session_expired",
  "verification_required",
  "unsupported_runtime",
]);
/** Failures only someone can fix; retrying them on every interval would only spend quota. */
const ACCOUNT_PROBLEMS = new Set(["protected_account", "not_found"]);
const MESSAGES: Record<string, string> = {
  not_connected: "Connect your X account in Settings to get new posts.",
  session_expired: "Your X session expired. Reconnect in Settings.",
  verification_required: "X wants you to verify your account. Reconnect in Settings.",
  unsupported_runtime: "Getting posts from X needs the Scope desktop app.",
  rate_limited: "X is limiting how fast apps can read posts. Scope tries again on the next update.",
  protected_account: "This account is protected, so its posts can't be read.",
  not_found: "This account couldn't be found. It may have been renamed or suspended.",
  network: "Couldn't reach X. Scope tries again on the next update.",
  timeout: "X took too long to answer. Scope tries again on the next update.",
  invalid_response: "X returned something unexpected. Scope tries again on the next update.",
};
const WAITING =
  "X limits how fast apps can read posts, so Scope is waiting a moment. It continues automatically.";

/**
 * Why X can't be read right now, in the words the sync states use; null while it can. Lets a
 * manual refresh say so once instead of starting a read per account that can only fail.
 */
export function connectionProblem(status: XConnectionStatus): string | null {
  if (status.capability === "connected" || status.capability === "session_only") return null;
  if (status.errorCode && DISCONNECTED.has(status.errorCode)) return MESSAGES[status.errorCode];
  return status.capability === "unavailable"
    ? MESSAGES.unsupported_runtime
    : MESSAGES.not_connected;
}

/** Reads per 15-minute window the accounts on screen may use for new posts; the rest stays for others. */
const FOCUS_READS_PER_WINDOW = 20;
/** Never check the same account more often than this, however short the list. */
const MIN_CHECK_MS = 3 * 60_000;
/** "All time" fills history automatically back this far; older posts load on request. */
export const AUTO_HISTORY_DAYS = 90;

/**
 * How often the accounts on screen are checked for new posts: as often as their share of X's
 * quota allows, from every 3 minutes for a short list up to the Settings interval. 0 when
 * automatic updates are off.
 */
export function checkEveryMs(accounts: number, autoSyncMinutes: number): number {
  if (!autoSyncMinutes) return 0;
  const share = (Math.max(1, accounts) * 15 * 60_000) / FOCUS_READS_PER_WINDOW;
  return Math.min(autoSyncMinutes * 60_000, Math.max(MIN_CHECK_MS, Math.round(share)));
}

function creatorState(s: RetrievalCreatorState, now: number): SyncCreatorState {
  const lastSyncedAt = s.lastSuccessfulRefresh;
  const history = s.history;
  const base: SyncCreatorState = {
    creatorId: s.creatorId,
    lastSyncedAt,
    retryAt: null,
    message: null,
    errorCode: null,
    newPosts: 0,
    firstSync: !lastSyncedAt,
    olderPosts: history
      ? {
          since: history.since,
          waiting:
            history.reason === "waiting" &&
            Boolean(history.retryAt && Date.parse(history.retryAt) > now),
        }
      : null,
    coveredSince: s.coveredSince,
    state: lastSyncedAt ? "idle" : "never",
  };
  const head = s.head;
  if (!head) return base;
  const newPosts = head.newPosts;
  if (head.status === "running") {
    if (head.reason === "waiting" && head.retryAt && Date.parse(head.retryAt) > now)
      return { ...base, newPosts, state: "waiting", retryAt: head.retryAt, message: WAITING };
    // Queued behind X's quota: as good as waiting, and honest about when it continues.
    const quota = xQuotaStatus("timeline", now);
    if (heldByQuota(xReadPriority(s.creatorId, "head", now), "timeline", now) && quota.nextAt)
      return { ...base, newPosts, state: "waiting", retryAt: quota.nextAt, message: WAITING };
    return { ...base, newPosts, state: "syncing" };
  }
  if (head.status === "failed") {
    const code = head.errorCode ?? "invalid_response";
    if (code === "rate_limited")
      return {
        ...base,
        newPosts,
        state: "paused",
        retryAt: head.retryAt,
        errorCode: code,
        message: MESSAGES.rate_limited,
      };
    return {
      ...base,
      newPosts,
      errorCode: code,
      state: DISCONNECTED.has(code) ? "disconnected" : "error",
      message: MESSAGES[code] ?? head.error ?? MESSAGES.invalid_response,
    };
  }
  return { ...base, newPosts };
}

export function syncSnapshot(
  creatorIds: number[],
  engine: RetrievalEngine = getRetrievalEngine(),
  now = Date.now(),
): SyncSnapshot {
  const creators = engine.creatorStates(creatorIds).map((s) => creatorState(s, now));
  const count = (state: SyncState) => creators.filter((c) => c.state === state).length;
  const synced = creators.map((c) => c.lastSyncedAt).filter((at): at is string => at !== null);
  const waiting = creators.filter((c) => c.state === "waiting");
  const paused = creators.filter((c) => c.state === "paused");
  const problem =
    creators.find((c) => c.state === "disconnected") ?? creators.find((c) => c.state === "error");
  const failing = count("error") + count("disconnected");
  const state: SyncState = !creators.length
    ? "idle"
    : count("syncing")
      ? "syncing"
      : waiting.length
        ? "waiting"
        : count("disconnected")
          ? "disconnected"
          : count("error")
            ? "error"
            : paused.length
              ? "paused"
              : count("never")
                ? "never"
                : "idle";
  const never = count("never");
  const retryAt = (list: SyncCreatorState[]) =>
    list
      .map((c) => c.retryAt)
      .filter((at): at is string => at !== null)
      .sort()[0] ?? null;
  return {
    state,
    // The stalest successful sync, so one lagging creator is never hidden.
    lastSyncedAt: synced.length ? synced.sort()[0] : null,
    pending: count("syncing") + waiting.length,
    total: creators.length,
    retryAt: state === "paused" ? retryAt(paused) : retryAt(waiting),
    message:
      state === "waiting"
        ? waiting[0].message
        : state === "paused"
          ? paused[0].message
          : state === "error" && failing > 1
            ? `${failing} accounts couldn't be synced. ${problem!.message}`
            : state === "disconnected" || state === "error"
              ? problem!.message
              : state === "never" && never < creators.length
                ? `${never} of ${creators.length} accounts haven't synced yet.`
                : null,
    newPosts: creators.reduce((n, c) => n + c.newPosts, 0),
    backfilling: creators.filter((c) => c.olderPosts).length,
    creators,
  };
}

/** Changes whenever a post is saved for (or removed from) these creators. */
export function scopeRevision(db: ScopeDatabase, creatorIds: number[]): string {
  if (!creatorIds.length) return "0";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS last FROM creator_tweets
       WHERE creator_id IN (SELECT value FROM json_each(?))`,
    )
    .get(JSON.stringify(creatorIds)) as { n: number; last: number };
  return `${row.n}.${row.last}`;
}

/** Start of the UTC day `days` ago: stable all day, so one backfill per timeframe per day. */
export function historyHorizon(days: number | null, now = Date.now()): string {
  const start = new Date(now - (days ?? AUTO_HISTORY_DAYS) * 86_400_000);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

/** How much of the timeframe in view is saved for these creators. */
export function feedCoverage(
  creatorIds: number[],
  days: number | null,
  engine: RetrievalEngine = getRetrievalEngine(),
  now = Date.now(),
): FeedCoverage | null {
  if (!creatorIds.length) return null;
  const since = historyHorizon(days, now);
  const states = engine.creatorStates(creatorIds);
  // Up to an hour short still counts: the window's edge moves while the page is open.
  const reaches = (s: RetrievalCreatorState) =>
    s.coveredSince !== null && Date.parse(s.coveredSince) <= Date.parse(since) + 3600_000;
  const edges = states
    .map((s) => s.coveredSince ?? (s.history?.extend ? s.history.reach : null))
    .filter((at): at is string => at !== null);
  return {
    since,
    covered: states.filter(reaches).length,
    total: states.length,
    importing: states.filter((s) => s.history !== null).length,
    reach: edges.length === states.length ? edges.sort().at(-1)! : null,
  };
}

/** Creators synced at least once whose saved posts stop short of `since`, with no older import going. */
function historyNeeded(creatorIds: number[], since: string, engine: RetrievalEngine): number[] {
  if (!creatorIds.length) return [];
  const busy = engine.importingOlder(creatorIds);
  return engine
    .creatorStates(creatorIds)
    .filter(
      (s) =>
        s.initialized &&
        s.coveredSince !== null &&
        Date.parse(s.coveredSince) > Date.parse(since) + 3600_000 &&
        !busy.has(s.creatorId),
    )
    .map((s) => s.creatorId);
}

/**
 * Fills in history back to the timeframe in view: one background backfill for the creators whose
 * saved posts stop short of it, continuing from where each archive already reaches.
 */
export function ensureHistory(
  creatorIds: number[],
  days: number | null,
  engine: RetrievalEngine = getRetrievalEngine(),
  now = Date.now(),
): RetrievalJob | null {
  const since = historyHorizon(days, now);
  const need = historyNeeded(creatorIds, since, engine);
  if (!need.length) return null;
  try {
    return engine.start({
      kind: "backfill",
      listId: null,
      label: `Older posts · ${days ?? AUTO_HISTORY_DAYS} days`,
      creatorIds: need,
      since,
      until: new Date(now).toISOString(),
      initialDays: days ?? AUTO_HISTORY_DAYS,
      maxPages: null,
    });
  } catch (error) {
    if (error instanceof ResearchInputError) return null;
    throw error;
  }
}

/**
 * The creators whose new posts are due for a check: never synced, or last synced longer ago than
 * their interval. Work in progress is left alone, and failures wait an interval before retrying
 * (account problems four).
 */
export function dueCreators(
  states: RetrievalCreatorState[],
  intervalFor: (creatorId: number) => number,
  now = Date.now(),
): number[] {
  return states
    .filter((s) => {
      const interval = intervalFor(s.creatorId);
      if (!interval) return false;
      const head = s.head;
      if (head?.status === "running") return false;
      if (head && (head.status === "failed" || head.status === "cancelled")) {
        if (head.retryAt && Date.parse(head.retryAt) > now) return false;
        const wait = ACCOUNT_PROBLEMS.has(head.errorCode ?? "") ? interval * 4 : interval;
        if (head.updatedAt && now - Date.parse(head.updatedAt) < wait) return false;
      }
      return !s.lastSuccessfulRefresh || now - Date.parse(s.lastSuccessfulRefresh) >= interval;
    })
    .map((s) => s.creatorId);
}

export interface SyncRequest {
  listId: number | null;
  label: string;
  creatorIds: number[];
  /**
   * Only check creators whose last sync is older than this (opening a list). Without it, every
   * creator is checked now and goes ahead of all automatic work ("Update now").
   */
  ifStaleMs?: number;
}

export async function startSync(
  db: ScopeDatabase,
  input: SyncRequest,
  engine: RetrievalEngine = getRetrievalEngine(),
): Promise<{
  started: boolean;
  reason?: "fresh" | "disconnected" | "running";
  job?: RetrievalJob;
}> {
  if (!input.creatorIds.length) throw new ResearchInputError("Add creators before syncing.");
  let ids = input.creatorIds;
  if (input.ifStaleMs !== undefined) {
    const states = engine.creatorStates(ids);
    const due = dueCreators(states, () => input.ifStaleMs!);
    if (!due.length) {
      // Older posts that stopped importing still pick up where they left off.
      engine.resumeBackfills(ids);
      const busy = states.some((s) => s.head?.status === "running");
      return { started: false, reason: busy ? "running" : "fresh" };
    }
    // Automatic syncs never knock on X while the account is disconnected.
    const status = await getXConnectionStatus();
    if (status.capability !== "connected" && status.capability !== "session_only")
      return { started: false, reason: "disconnected" };
    ids = due;
  } else boostX(ids);
  const days = getXSyncSettings(db).initialHistoryDays;
  const now = Date.now();
  const job = engine.start({
    kind: "refresh",
    listId: input.listId,
    label: input.label,
    creatorIds: ids,
    // From the start of that day, like the timeframes, so a first import covers them exactly.
    since: historyHorizon(days, now),
    until: new Date(now).toISOString(),
    initialDays: days,
    maxPages: null,
  });
  // A manual sync also restarts older-post imports someone stopped.
  engine.resumeBackfills(ids, { includeStopped: input.ifStaleMs === undefined });
  return { started: true, job };
}

const shared = globalThis as typeof globalThis & {
  __scopeXAutoSync?: {
    timer: ReturnType<typeof setInterval>;
    running: boolean;
    kicked: ReturnType<typeof setTimeout> | null;
    prunedAt: number;
  };
};

/**
 * One pass of the background scheduler: checks every creator that is due (the accounts on screen
 * at their faster interval), fills in history for the timeframe on screen, and now and then
 * forgets old sync bookkeeping. Safe to call at any time; overlapping calls are skipped.
 */
export async function runXSyncPass(
  db: ScopeDatabase = getDb(),
  engine: RetrievalEngine = getRetrievalEngine(),
  now = Date.now(),
): Promise<{ due: number[]; backfill: number[] }> {
  const ids = (
    db.prepare("SELECT id FROM creators WHERE platform = 'x' ORDER BY id").all() as Array<{
      id: number;
    }>
  ).map((row) => row.id);
  if (!ids.length) return { due: [], backfill: [] };
  const minutes = getXSyncSettings(db).autoSyncMinutes;
  const focus = currentXFocus(now);
  const inView = focus ? [...focus.creatorIds].filter((id) => ids.includes(id)) : [];
  const fast = checkEveryMs(inView.length, minutes);
  const due = dueCreators(
    engine.creatorStates(ids),
    (id) => (focus?.creatorIds.has(id) ? fast : minutes * 60_000),
    now,
  );
  const history = focus ? historyNeeded(inView, historyHorizon(focus.days, now), engine) : [];
  if (!due.length && !history.length) return { due, backfill: [] };
  // Automatic work never knocks on X while the account is disconnected.
  const status = await getXConnectionStatus();
  if (status.capability !== "connected" && status.capability !== "session_only")
    return { due: [], backfill: [] };
  if (due.length) {
    const days = getXSyncSettings(db).initialHistoryDays;
    engine.start({
      kind: "refresh",
      listId: null,
      label: "Automatic update",
      creatorIds: due,
      since: historyHorizon(days, now),
      until: new Date(now).toISOString(),
      initialDays: days,
      maxPages: null,
    });
    engine.resumeBackfills(due);
  }
  const backfill = history.length ? ensureHistory(history, focus!.days, engine, now) : null;
  return { due, backfill: backfill?.creators.map((c) => c.creatorId) ?? [] };
}

/**
 * Starts the background scheduler once per server process: recovers work an app restart
 * interrupted, then runs a pass every 30 seconds.
 */
export function ensureXAutoSync(tickMs = 30_000): void {
  if (shared.__scopeXAutoSync) return;
  const state = {
    timer: setInterval(() => void tick(), tickMs),
    running: false,
    kicked: null as ReturnType<typeof setTimeout> | null,
    prunedAt: 0,
  };
  state.timer.unref?.();
  shared.__scopeXAutoSync = state;
  const recovery = setTimeout(() => {
    try {
      getRetrievalEngine().recover();
    } catch {
      /* Recovery is best-effort; the next sync picks unfinished work up anyway. */
    }
  }, 15_000);
  recovery.unref?.();
}

async function tick(): Promise<void> {
  const state = shared.__scopeXAutoSync;
  if (!state || state.running) return;
  state.running = true;
  try {
    await runXSyncPass();
    if (Date.now() - state.prunedAt > 3600_000) {
      state.prunedAt = Date.now();
      getRetrievalEngine().prune();
    }
  } catch {
    /* A failed pass never stops the loop. */
  } finally {
    state.running = false;
  }
}

/** Runs a pass right away (debounced): what's on screen changed. */
export function kickXSync(): void {
  const state = shared.__scopeXAutoSync;
  if (!state) return;
  if (state.kicked) clearTimeout(state.kicked);
  state.kicked = setTimeout(() => {
    state.kicked = null;
    void tick();
  }, 300);
  state.kicked.unref?.();
}
