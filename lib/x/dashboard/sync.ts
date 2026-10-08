/**
 * X Dashboard syncing: one plain status per scope built from the durable
 * retrieval engine, "sync if stale" for opening a list, and the background
 * auto-sync timer. All X reads still go through the retrieval engine, which
 * continues unfinished work and waits out rate limits on its own.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { getDb } from "@/lib/db/connection";
import { getXSyncSettings } from "@/lib/settings/settings";
import { getXConnectionStatus } from "@/lib/x/service";
import { getRetrievalEngine, type RetrievalEngine } from "@/lib/x/research/retrieval";
import { ResearchInputError } from "@/lib/x/research/input";
import type { RetrievalJob } from "@/lib/x/research/retrieval-model";
import type { SyncCreatorState, SyncSnapshot, SyncState } from "./model";

const DISCONNECTED = new Set([
  "not_connected",
  "session_expired",
  "verification_required",
  "unsupported_runtime",
]);
const MESSAGES: Record<string, string> = {
  not_connected: "Connect your X account in Settings to sync.",
  session_expired: "Your X session expired. Reconnect in Settings.",
  verification_required: "X wants you to verify your account. Reconnect in Settings.",
  unsupported_runtime: "Syncing X needs the Scope desktop app.",
  rate_limited: "X is limiting requests right now. Scope will retry on the next sync.",
  protected_account: "This account is protected, so its posts can't be read.",
  not_found: "This account couldn't be found. It may have been renamed or suspended.",
  network: "Couldn't reach X. Scope will retry on the next sync.",
  timeout: "X took too long to answer. Scope will retry on the next sync.",
  invalid_response: "X returned something unexpected. Scope will retry on the next sync.",
};

/** A sync counts as fresh for this long when a list is opened. */
export const STALE_AFTER_MS = 10 * 60_000;

function creatorState(
  creatorId: number,
  jobs: RetrievalJob[],
  lastSyncedAt: string | null,
  now: number,
): SyncCreatorState {
  const entries = jobs.flatMap((job) =>
    job.creators.filter((c) => c.creatorId === creatorId).map((progress) => ({ job, progress })),
  );
  // Recent posts come from the newest refresh; older posts import as background history.
  const head = entries.find((e) => e.progress.mode !== "history");
  const older = entries.find((e) => e.progress.mode === "history" && e.progress.status === "running");
  const base: SyncCreatorState = {
    creatorId,
    lastSyncedAt,
    retryAt: null,
    message: null,
    newPosts: 0,
    firstSync: !lastSyncedAt,
    olderPosts: older
      ? {
          since: older.job.request.since,
          waiting:
            older.progress.reason === "waiting" &&
            Boolean(older.progress.retryAt && Date.parse(older.progress.retryAt) > now),
        }
      : null,
    state: lastSyncedAt ? "idle" : "never",
  };
  if (!head) return base;
  const { job, progress } = head;
  const newPosts = progress.newPosts;
  if (progress.status === "running") {
    const waiting =
      progress.reason === "waiting" && progress.retryAt && Date.parse(progress.retryAt) > now;
    return waiting
      ? {
          ...base,
          newPosts,
          state: "waiting",
          retryAt: progress.retryAt,
          message: "X asked Scope to slow down. Syncing continues automatically.",
        }
      : { ...base, newPosts, state: "syncing" };
  }
  if (progress.status === "failed" && job.status !== "cancelled") {
    const code = progress.errorCode ?? "invalid_response";
    if (code === "rate_limited")
      return {
        ...base,
        newPosts,
        state: "paused",
        retryAt: progress.retryAt,
        message: "X is limiting requests, so Scope paused. It tries again on the next sync.",
      };
    return {
      ...base,
      newPosts,
      state: DISCONNECTED.has(code) ? "disconnected" : "error",
      message: MESSAGES[code] ?? progress.error ?? MESSAGES.invalid_response,
    };
  }
  return { ...base, newPosts };
}

export function syncSnapshot(
  creatorIds: number[],
  engine: RetrievalEngine = getRetrievalEngine(),
  now = Date.now(),
): SyncSnapshot {
  const jobs = engine.jobs();
  const coverage = new Map(engine.coverage(creatorIds).map((c) => [c.creatorId, c]));
  const creators = creatorIds.map((id) =>
    creatorState(id, jobs, coverage.get(id)?.lastSuccessfulRefresh ?? null, now),
  );
  const count = (state: SyncState) => creators.filter((c) => c.state === state).length;
  const synced = creators.map((c) => c.lastSyncedAt).filter((at): at is string => at !== null);
  const latest = jobs.find((j) => j.creators.some((c) => creatorIds.includes(c.creatorId)));
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
    newPosts: latest
      ? latest.creators
          .filter((c) => creatorIds.includes(c.creatorId))
          .reduce((n, c) => n + c.newPosts, 0)
      : 0,
    backfilling: creators.filter((c) => c.olderPosts).length,
    creators,
  };
}

export interface SyncRequest {
  listId: number | null;
  label: string;
  creatorIds: number[];
  /** Only start when some creator's last successful sync is older than this. */
  ifStaleMs?: number;
}

export async function startSync(
  db: ScopeDatabase,
  input: SyncRequest,
  engine: RetrievalEngine = getRetrievalEngine(),
): Promise<{ started: boolean; reason?: "fresh" | "disconnected" | "running"; job?: RetrievalJob }> {
  if (!input.creatorIds.length) throw new ResearchInputError("Add creators before syncing.");
  if (input.ifStaleMs !== undefined) {
    const snapshot = syncSnapshot(input.creatorIds, engine);
    const now = Date.now();
    const busy = snapshot.state === "syncing" || snapshot.state === "waiting";
    // A creator X paused is not stale until its retry time: switching lists never knocks early.
    const fresh = snapshot.creators.every(
      (c) =>
        (c.lastSyncedAt !== null && now - Date.parse(c.lastSyncedAt) < input.ifStaleMs!) ||
        (c.state === "paused" && c.retryAt !== null && Date.parse(c.retryAt) > now),
    );
    if (busy || fresh) {
      // Older posts that stopped importing still pick up where they left off.
      engine.resumeBackfills(input.creatorIds);
      return { started: false, reason: busy ? "running" : "fresh" };
    }
    // Automatic syncs never knock on X while the account is disconnected.
    const status = await getXConnectionStatus();
    if (status.capability !== "connected" && status.capability !== "session_only")
      return { started: false, reason: "disconnected" };
  }
  const days = getXSyncSettings(db).initialHistoryDays;
  const now = Date.now();
  const job = engine.start({
    kind: "refresh",
    listId: input.listId,
    label: input.label,
    creatorIds: input.creatorIds,
    since: new Date(now - days * 86_400_000).toISOString(),
    until: new Date(now).toISOString(),
    initialDays: days,
    maxPages: null,
  });
  // A manual sync also restarts older-post imports someone stopped.
  engine.resumeBackfills(input.creatorIds, { includeStopped: input.ifStaleMs === undefined });
  return { started: true, job };
}

const shared = globalThis as typeof globalThis & {
  __scopeXAutoSync?: { timer: ReturnType<typeof setInterval>; lastRunAt: number };
};

/**
 * Starts the background sync loop once per server process: recovers work an
 * app restart interrupted, then syncs every saved X creator on the interval
 * chosen in Settings (off when 0).
 */
export function ensureXAutoSync(tickMs = 60_000): void {
  if (shared.__scopeXAutoSync) return;
  const state = { timer: setInterval(() => void tick(), tickMs), lastRunAt: Date.now() };
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
  async function tick() {
    try {
      const db = getDb();
      const minutes = getXSyncSettings(db).autoSyncMinutes;
      if (!minutes || Date.now() - state.lastRunAt < minutes * 60_000) return;
      state.lastRunAt = Date.now();
      const ids = (
        db.prepare("SELECT id FROM creators WHERE platform = 'x' ORDER BY id").all() as Array<{
          id: number;
        }>
      ).map((row) => row.id);
      if (!ids.length) return;
      await startSync(db, {
        listId: null,
        label: "All creators",
        creatorIds: ids,
        ifStaleMs: minutes * 60_000 - 60_000,
      });
    } catch {
      /* A failed tick never stops the loop. */
    }
  }
}
