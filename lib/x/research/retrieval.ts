import { randomUUID } from "node:crypto";
import type { ScopeDatabase } from "@/lib/db/connection";
import { getDb } from "@/lib/db/connection";
import { getCreator } from "@/lib/creators/repository";
import { getXProvider } from "@/lib/x/providers";
import { runXExclusive, toXServiceError, type XExclusiveOptions } from "@/lib/x/service";
import { getTweetById, mergeCreatorTimeline } from "@/lib/x/repository";
import { XProviderError, type XProvider, type XTimelinePage } from "@/lib/x/model";
import { X_PRIORITY, type XBucket } from "@/lib/x/scheduler";
import { xReadPriority } from "@/lib/x/focus";
import { ResearchInputError } from "./repository";
import {
  autoPageBudget,
  type RetrievalCoverage,
  type RetrievalCreatorProgress,
  type RetrievalCreatorState,
  type RetrievalJob,
  type RetrievalRequest,
  type RetrievalStatus,
} from "./retrieval-model";

interface Checkpoint {
  initialized: boolean;
  anchors: string[];
  lastSuccessfulRefresh: string | null;
  newestObserved: string | null;
  pendingTask: string | null;
  // Time of the user-started head traversal whose anchors were established.
  boundaryAt?: string;
  since?: string;
  until?: string;
  status?: string;
  // Head lane only: the last profile lookup, reused so a catch-up costs one timeline read.
  pinnedId?: string | null;
  resolvedAt?: string;
  // Head lane only: every post from here to the last sync is archived, and where to read on from.
  coveredSince?: string | null;
  coverageCursor?: string | null;
}
interface Task {
  id: string;
  creatorId: number;
  userId: string;
  handle: string;
  name: string;
  config: string;
  mode: "initial" | "catchup" | "history";
  since: string;
  until: string;
  status: RetrievalStatus;
  owner: string | null;
  cursor: string | null;
  cursors: string[];
  pinnedId: string | null;
  resolved: boolean;
  anchors: string[];
  matched: string[];
  candidateAnchors: string[];
  anchorPages: number;
  beforePages: number;
  pageSignatures: string[];
  pages: number;
  newPosts: number;
  updatedPosts: number;
  skipped: number;
  oldest: string | null;
  newest: string | null;
  reason: string | null;
  error: string | null;
  /** Provider failure code behind `error`; decides whether a retry is worthwhile. */
  errorCode?: string | null;
  retryAt: string | null;
  maxPages: number;
  /** Oldest ordinary post seen, unlike `oldest` never moved by a pin or repost. */
  reach?: string | null;
  /** An initial import whose newest pages went to the head lane; the rest is background history. */
  promoted?: boolean;
  /**
   * A catch-up handed to the background after its newest pages: it fills the gap back to the
   * previous sync and ends where it meets it, without claiming the history lane.
   */
  gap?: boolean;
  /** A backfill extending the covered history; it started where the archive already reached. */
  extend?: boolean;
  updatedAt?: string;
}
interface JobRow {
  id: string;
  request_json: string;
  cancelled: number;
  created_at: string;
  finished_at: string | null;
}
const now = () => new Date().toISOString();
/** X launched in 2006: a timeline that ends is covered back to here. */
const EPOCH = "2006-01-01T00:00:00.000Z";
const laneOf = (task: Pick<Task, "mode">) => (task.mode === "history" ? "history" : "head");
const emptyCheckpoint = (): Checkpoint => ({
  initialized: false,
  anchors: [],
  lastSuccessfulRefresh: null,
  newestObserved: null,
  pendingTask: null,
});
// Increment this key when provider/filter semantics change. Never reuse old cursors across keys.
export const retrievalConfigKey = (providerId: string) =>
  `${providerId}:user-timeline:all-types:v1`;
const resetTraversal = (task: Task) => {
  task.cursor = null;
  task.cursors = [];
  task.matched = [];
  task.candidateAnchors = [];
  task.anchorPages = 0;
  task.beforePages = 0;
  task.pageSignatures = [];
  task.skipped = 0;
  task.resolved = false;
};
const pageBudget = (request: RetrievalRequest, task: Pick<Task, "since" | "until">) =>
  request.maxPages ??
  autoPageBudget((Date.parse(task.until) - Date.parse(task.since)) / 86_400_000);

export interface RetrievalEngineOptions {
  /**
   * Keep unfinished work going without another click: continue after a page or
   * time budget, wait out X rate limits, and retry transient network failures.
   * Every continuation is bounded; anything else still stops for the user.
   */
  autoContinue?: boolean;
  /** Budget continuations per launch (each walks one page/time budget). */
  maxRounds?: number;
  /** Rate-limit waits per launch. */
  maxWaits?: number;
  /** Transient network/timeout retries per launch. */
  maxFaults?: number;
  /** Delay before retrying a transient failure. */
  faultDelayMs?: number;
  /** Longest single rate-limit wait honored automatically. */
  maxWaitMs?: number;
  /**
   * Newer posts first: once an initial import has read this many days (or `headPages` pages),
   * the creator counts as synced and the rest of its window continues as background history.
   * Off when unset.
   */
  headDays?: number;
  headPages?: number;
  /**
   * A catch-up that has read this many pages without meeting the last sync hands the rest to
   * the background, so one busy or long-unsynced account never holds up new posts. Off when unset.
   */
  catchupPages?: number;
  /** Reuse a creator's last profile lookup (pinned post) for this long instead of asking X again. */
  resolveTtlMs?: number;
  /** A catch-up left from an earlier run is replaced once its window ended this long ago. */
  staleHeadMs?: number;
  /** Read priority for a creator's new posts ("head") or older posts ("history"); lower goes first. */
  priority?: (creatorId: number, lane: "head" | "history") => number;
  /** Pace timeline reads against this X quota bucket (the host's real X connection). Off when unset. */
  timelineBucket?: XBucket;
}
const CONTINUE_REASONS = new Set(["page_budget", "time_budget", "cursor_stall"]);
const TRANSIENT_CODES = new Set(["network", "timeout", "rate_limited", "invalid_response"]);
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });

/** One engine per server process, shared across route bundles/HMR. Reading never starts work. */
export class RetrievalEngine {
  private readonly owner = randomUUID();
  private readonly running = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  constructor(
    private readonly database: () => ScopeDatabase,
    private readonly provider: () => XProvider,
    private readonly exclusive: <T>(
      operation: () => Promise<T>,
      options?: XExclusiveOptions,
    ) => Promise<T> = runXExclusive,
    private readonly durationMs = 180_000,
    // Larger page budgets earn proportionally more active time.
    private readonly pageMs = 6_000,
    private readonly options: RetrievalEngineOptions = {},
  ) {}
  private task(id: string): Task | null {
    const row = this.database()
      .prepare("SELECT state_json FROM x_retrieval_tasks WHERE id = ?")
      .get(id) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as Task) : null;
  }
  private save(task: Task) {
    task.updatedAt = now();
    this.database()
      .prepare("UPDATE x_retrieval_tasks SET state_json = ? WHERE id = ?")
      .run(JSON.stringify(task), task.id);
  }
  private checkpoint(creatorId: number, config: string, lane: string): Checkpoint {
    const row = this.database()
      .prepare(
        "SELECT state_json FROM x_retrieval_checkpoints WHERE creator_id = ? AND config_key = ? AND lane = ?",
      )
      .get(creatorId, config, lane) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as Checkpoint) : emptyCheckpoint();
  }
  private saveCheckpoint(task: Task, cp: Checkpoint, lane: "head" | "history" = laneOf(task)) {
    this.database()
      .prepare(
        `INSERT INTO x_retrieval_checkpoints VALUES (?, ?, ?, ?)
      ON CONFLICT (creator_id, config_key, lane) DO UPDATE SET state_json = excluded.state_json`,
      )
      .run(task.creatorId, task.config, lane, JSON.stringify(cp));
  }
  /** The creator's most recently written configuration, read without constructing a provider. */
  private recordedConfig(creatorId: number): string {
    const row = this.database()
      .prepare(
        "SELECT config_key FROM x_retrieval_checkpoints WHERE creator_id = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(creatorId) as { config_key: string } | undefined;
    return row?.config_key ?? "";
  }
  /**
   * How far back the archive is complete. Archives synced before Scope tracked this fall back to
   * the oldest post read from the timeline.
   */
  private coveredSince(creatorId: number, head: Checkpoint): string | null {
    if (head.coveredSince) return head.coveredSince;
    if (!head.initialized) return null;
    const row = this.database()
      .prepare(
        "SELECT MIN(timeline_at) AS oldest FROM creator_tweets WHERE creator_id = ? AND source = 'timeline'",
      )
      .get(creatorId) as { oldest: string | null };
    return row.oldest ?? head.boundaryAt ?? null;
  }
  private effective(task: Task): RetrievalStatus {
    return task.status === "running" && task.owner !== this.owner ? "interrupted" : task.status;
  }
  private tasks(jobId: string): Task[] {
    return (
      this.database()
        .prepare(
          `SELECT t.state_json FROM x_retrieval_tasks t JOIN x_retrieval_job_tasks j ON j.task_id = t.id WHERE j.job_id = ? ORDER BY t.creator_id`,
        )
        .all(jobId) as Array<{ state_json: string }>
    ).map((row) => JSON.parse(row.state_json) as Task);
  }
  jobs(): RetrievalJob[] {
    return (
      this.database()
        .prepare(
          `SELECT j.* FROM x_retrieval_jobs j
          WHERE j.id IN (SELECT id FROM x_retrieval_jobs ORDER BY created_at DESC, rowid DESC LIMIT 50)
             OR EXISTS (SELECT 1 FROM x_retrieval_job_tasks jt JOIN x_retrieval_tasks t ON t.id = jt.task_id
                        WHERE jt.job_id = j.id AND json_extract(t.state_json, '$.status') <> 'complete')
          ORDER BY j.created_at DESC, j.rowid DESC`,
        )
        .all() as JobRow[]
    ).map((row) => this.summary(row));
  }
  job(id: string): RetrievalJob {
    const row = this.database().prepare("SELECT * FROM x_retrieval_jobs WHERE id = ?").get(id) as
      JobRow | undefined;
    if (!row) throw new ResearchInputError("This retrieval job no longer exists.", 404);
    return this.summary(row);
  }
  private summary(row: JobRow): RetrievalJob {
    const tasks = this.tasks(row.id);
    const statuses = tasks.map((t) => this.effective(t));
    const status: RetrievalStatus = row.cancelled
      ? "cancelled"
      : statuses.includes("running")
        ? "running"
        : statuses.includes("interrupted")
          ? "interrupted"
          : statuses.length === 0
            ? "failed"
            : statuses.every((s) => s === "complete")
              ? "complete"
              : statuses.every((s) => s === "failed")
                ? "failed"
                : "partial";
    return {
      id: row.id,
      request: JSON.parse(row.request_json),
      status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      creators: tasks.map((t) => ({
        creatorId: t.creatorId,
        name: t.name,
        mode: t.mode,
        status: this.effective(t),
        pages: t.pages,
        newPosts: t.newPosts,
        updatedPosts: t.updatedPosts,
        oldest: t.oldest,
        newest: t.newest,
        reason: this.effective(t) === "interrupted" ? "interrupted" : t.reason,
        error: t.error,
        errorCode: t.errorCode ?? null,
        retryAt: t.retryAt,
      })),
    };
  }
  coverage(ids: number[]): RetrievalCoverage[] {
    return ids.map((creatorId) => {
      const config = this.recordedConfig(creatorId);
      const head = this.checkpoint(creatorId, config, "head");
      const history = this.checkpoint(creatorId, config, "history");
      return {
        creatorId,
        initialized: head.initialized,
        lastSuccessfulRefresh: head.lastSuccessfulRefresh,
        newestObserved: head.newestObserved,
        pendingHead: head.pendingTask !== null,
        historySince: history.since ?? null,
        historyUntil: history.until ?? null,
        historyStatus: history.status ?? null,
        coveredSince: this.coveredSince(creatorId, head),
      };
    });
  }
  /**
   * Each creator's latest read of new posts and any older posts importing right now, read from
   * the tasks themselves so it never depends on which job started them. Reading never starts work.
   */
  creatorStates(ids: number[]): RetrievalCreatorState[] {
    const db = this.database();
    const latestHead = db.prepare(
      `SELECT state_json FROM x_retrieval_tasks WHERE creator_id = ?
         AND (json_extract(state_json, '$.mode') <> 'history' OR json_extract(state_json, '$.promoted') = 1)
       ORDER BY rowid DESC LIMIT 1`,
    );
    const runningHistory = db.prepare(
      `SELECT state_json FROM x_retrieval_tasks WHERE creator_id = ?
         AND json_extract(state_json, '$.mode') = 'history' AND json_extract(state_json, '$.status') = 'running'
       ORDER BY rowid DESC`,
    );
    const progress = (t: Task): RetrievalCreatorProgress => ({
      creatorId: t.creatorId,
      name: t.name,
      mode: t.mode,
      status: this.effective(t),
      pages: t.pages,
      newPosts: t.newPosts,
      updatedPosts: t.updatedPosts,
      oldest: t.oldest,
      newest: t.newest,
      reason: this.effective(t) === "interrupted" ? "interrupted" : t.reason,
      error: t.error,
      errorCode: t.errorCode ?? null,
      retryAt: t.retryAt,
    });
    return ids.map((creatorId) => {
      const config = this.recordedConfig(creatorId);
      const head = this.checkpoint(creatorId, config, "head");
      const headRow = latestHead.get(creatorId) as { state_json: string } | undefined;
      const headTask = headRow ? (JSON.parse(headRow.state_json) as Task) : null;
      const history = (runningHistory.all(creatorId) as Array<{ state_json: string }>)
        .map((row) => JSON.parse(row.state_json) as Task)
        .find((t) => this.effective(t) === "running");
      return {
        creatorId,
        initialized: head.initialized,
        lastSuccessfulRefresh: head.lastSuccessfulRefresh,
        coveredSince: this.coveredSince(creatorId, head),
        head: headTask
          ? {
              ...progress(headTask),
              // Its newest pages are in: what remains is background history.
              ...(headTask.promoted ? { mode: headTask.gap ? "catchup" : "initial", status: "complete", reason: "promoted" } : {}),
              updatedAt: headTask.updatedAt ?? null,
            }
          : null,
        history: history
          ? { ...progress(history), since: history.since, reach: history.reach ?? null, extend: Boolean(history.extend) }
          : null,
      };
    });
  }
  /**
   * Creators with an import of older posts that is still going (running, between rounds, or
   * waiting to be resumed); a second one would read the same pages again.
   */
  importingOlder(ids: number[]): Set<number> {
    if (!ids.length) return new Set();
    const rows = this.database()
      .prepare(
        `SELECT DISTINCT creator_id FROM x_retrieval_tasks
         WHERE creator_id IN (SELECT value FROM json_each(?))
           AND json_extract(state_json, '$.mode') = 'history'
           AND json_extract(state_json, '$.status') IN ('running', 'partial', 'interrupted')`,
      )
      .all(JSON.stringify(ids)) as Array<{ creator_id: number }>;
    return new Set(rows.map((row) => row.creator_id));
  }
  start(request: RetrievalRequest): RetrievalJob {
    if (!request.creatorIds.length) throw new ResearchInputError("Choose at least one X creator.");
    const db = this.database();
    const config = retrievalConfigKey(this.provider().id);
    const scopeKey = JSON.stringify({
      ...request,
      creatorIds: [...request.creatorIds].sort((a, b) => a - b),
      since: request.kind === "refresh" ? null : request.since,
      until: request.kind === "history" ? request.until : null,
    });
    const existing = db
      .prepare(
        "SELECT * FROM x_retrieval_jobs WHERE scope_key = ? AND cancelled = 0 ORDER BY created_at DESC LIMIT 1",
      )
      .get(scopeKey) as JobRow | undefined;
    if (existing && this.summary(existing).status === "running") return this.summary(existing);
    const id = randomUUID();
    const taskIds = db.transaction(() => {
      db.prepare(
        "INSERT INTO x_retrieval_jobs(id, scope_key, request_json, created_at) VALUES (?, ?, ?, ?)",
      ).run(id, scopeKey, JSON.stringify(request), now());
      const ids = request.creatorIds.flatMap((creatorId) => {
        const creator = getCreator(db, creatorId);
        if (!creator || creator.platform !== "x" || !creator.platformUserId || !creator.handle)
          throw new ResearchInputError("An X creator is no longer available.");
        const head = this.checkpoint(creatorId, config, "head");
        // A backfill reads down from where the archive already reaches; nothing to do when it reaches far enough.
        const reaches = request.kind === "backfill" ? this.coveredSince(creatorId, head) : null;
        if (request.kind === "backfill" && (!head.initialized || !reaches || reaches <= request.since))
          return [];
        const workKey = `${config}:${creator.platformUserId}:${request.kind}${
          request.kind === "history"
            ? `:${request.since}:${request.until}`
            : request.kind === "backfill"
              ? `:${request.since}`
              : ""
        }`;
        const candidates = db
          .prepare(
            "SELECT state_json FROM x_retrieval_tasks WHERE work_key = ? ORDER BY rowid DESC",
          )
          .all(workKey) as Array<{ state_json: string }>;
        let task = candidates
          .map((row) => JSON.parse(row.state_json) as Task)
          .find((t) => t.status !== "complete");
        if (task && this.running.get(task.id)?.controller.signal.aborted) {
          throw new ResearchInputError("Cancellation is finishing. Try again in a moment.", 409);
        }
        // A catch-up left from an earlier run reads a window that ended long ago: its pages so far
        // become background history, and a fresh catch-up reads the newest posts first.
        if (task && request.kind === "refresh" && this.retirable(task)) {
          this.retire(task);
          task = undefined;
        }
        if (!task) {
          const fresh = this.checkpoint(creatorId, config, "head");
          const since =
            request.kind === "refresh" && fresh.initialized
              ? (fresh.boundaryAt ?? fresh.lastSuccessfulRefresh ?? request.since)
              : request.since;
          const until = reaches ?? request.until;
          const ttl = this.options.resolveTtlMs ?? 0;
          const resolved = Boolean(
            ttl > 0 && fresh.resolvedAt && Date.now() - Date.parse(fresh.resolvedAt) < ttl,
          );
          task = {
            id: randomUUID(),
            creatorId,
            userId: creator.platformUserId,
            handle: creator.handle.replace(/^@/, ""),
            name: creator.displayName,
            config,
            mode: request.kind !== "refresh" ? "history" : fresh.initialized ? "catchup" : "initial",
            since,
            until,
            status: "partial",
            owner: null,
            // Continue below the covered history when the earlier traversal left a cursor.
            cursor: request.kind === "backfill" ? (fresh.coverageCursor ?? null) : null,
            cursors: [],
            pinnedId: resolved ? (fresh.pinnedId ?? null) : null,
            resolved,
            anchors: fresh.anchors,
            matched: [],
            candidateAnchors: [],
            anchorPages: 0,
            beforePages: 0,
            pageSignatures: [],
            pages: 0,
            newPosts: 0,
            updatedPosts: 0,
            skipped: 0,
            oldest: null,
            newest: null,
            reason: null,
            error: null,
            retryAt: null,
            maxPages: pageBudget(request, { since, until }),
            ...(request.kind === "backfill" ? { extend: true } : {}),
          };
          db.prepare("INSERT INTO x_retrieval_tasks VALUES (?, ?, ?, ?, ?)").run(
            task.id,
            creatorId,
            config,
            workKey,
            JSON.stringify(task),
          );
        }
        db.prepare("INSERT INTO x_retrieval_job_tasks VALUES (?, ?)").run(id, task.id);
        const cp = this.checkpoint(creatorId, config, laneOf(task));
        cp.pendingTask = task.id;
        if (task.mode === "history") {
          cp.since = task.since;
          cp.until = task.until;
          cp.status = "partial";
        }
        this.saveCheckpoint(task, cp);
        return [task.id];
      });
      if (!ids.length) throw new ResearchInputError("These accounts' history already reaches that far back.");
      return ids;
    })();
    for (const taskId of taskIds) this.launch(taskId, request);
    return this.job(id);
  }
  /** True for a catch-up nobody here is running whose window ended a while ago. */
  private retirable(task: Task): boolean {
    return (
      task.mode === "catchup" &&
      !this.running.has(task.id) &&
      Date.now() - Date.parse(task.until) > (this.options.staleHeadMs ?? 5 * 60_000)
    );
  }
  /**
   * Retires a leftover catch-up. With pages read, it becomes the background fill of the gap back
   * to the previous sync (head moves to where it started); with none, it is simply replaced.
   */
  private retire(task: Task) {
    if (task.pages > 0 && task.candidateAnchors.length) {
      if (task.status === "running") task.status = "interrupted";
      task.owner = null;
      this.promote(task);
      return;
    }
    const db = this.database();
    task.status = "cancelled";
    task.reason = "superseded";
    task.owner = null;
    task.retryAt = null;
    this.save(task);
    db.prepare("UPDATE x_retrieval_tasks SET work_key = ? WHERE id = ?").run(
      `${task.config}:${task.userId}:superseded:${task.id}`,
      task.id,
    );
    const head = this.checkpoint(task.creatorId, task.config, "head");
    if (head.pendingTask === task.id) {
      head.pendingTask = null;
      this.saveCheckpoint(task, head, "head");
    }
  }
  resume(id: string): RetrievalJob {
    const job = this.job(id);
    const config = retrievalConfigKey(this.provider().id);
    const tasks = this.tasks(id);
    if (tasks.some((t) => t.config !== config))
      throw new ResearchInputError(
        "Provider configuration changed. Start a new retrieval; your archive is preserved.",
      );
    if (job.status === "complete" || job.status === "running") return job;
    if (tasks.some((task) => this.running.get(task.id)?.controller.signal.aborted)) {
      throw new ResearchInputError("Cancellation is finishing. Try Resume again in a moment.", 409);
    }
    if (tasks.some((t) => t.retryAt && Date.parse(t.retryAt) > Date.now()))
      throw new ResearchInputError("X asked Scope to wait. Retry after the displayed time.", 429);
    this.database()
      .prepare("UPDATE x_retrieval_jobs SET cancelled = 0, finished_at = NULL WHERE id = ?")
      .run(id);
    for (const task of tasks) if (task.status !== "complete") this.launch(task.id, job.request);
    return this.job(id);
  }
  cancel(id: string): RetrievalJob {
    this.job(id);
    const db = this.database();
    db.prepare("UPDATE x_retrieval_jobs SET cancelled = 1, finished_at = ? WHERE id = ?").run(
      now(),
      id,
    );
    for (const task of this.tasks(id)) {
      const interested = db
        .prepare(
          `SELECT 1 FROM x_retrieval_job_tasks jt JOIN x_retrieval_jobs j ON j.id = jt.job_id WHERE jt.task_id = ? AND j.cancelled = 0 AND j.finished_at IS NULL LIMIT 1`,
        )
        .get(task.id);
      if (!interested && task.status !== "complete") {
        this.running.get(task.id)?.controller.abort();
        task.status = "cancelled";
        task.reason = "cancelled";
        task.owner = null;
        this.save(task);
      }
    }
    return this.job(id);
  }
  /**
   * Stops every task these creators have in flight, in whichever jobs share it, and leaves other
   * creators' work running. Committed pages are kept; the next sync continues from them.
   */
  stopCreators(creatorIds: number[]): void {
    const db = this.database();
    const ids = new Set(creatorIds);
    const touched = new Set<string>();
    for (const [taskId, run] of this.running) {
      const task = this.task(taskId);
      if (!task || !ids.has(task.creatorId) || task.status === "complete") continue;
      run.controller.abort();
      task.status = "cancelled";
      task.reason = "cancelled";
      task.owner = null;
      task.retryAt = null;
      this.save(task);
      const jobs = db
        .prepare("SELECT job_id FROM x_retrieval_job_tasks WHERE task_id = ?")
        .all(taskId) as Array<{ job_id: string }>;
      for (const { job_id } of jobs) touched.add(job_id);
    }
    for (const jobId of touched)
      if (this.tasks(jobId).every((t) => this.effective(t) !== "running"))
        db.prepare(
          "UPDATE x_retrieval_jobs SET finished_at = COALESCE(finished_at, ?) WHERE id = ?",
        ).run(now(), jobId);
  }
  /**
   * Picks unfinished background imports of older posts back up for these creators. Stopped ones
   * resume only when asked (a manual sync). Returns how many were relaunched.
   */
  resumeBackfills(creatorIds: number[], { includeStopped = false } = {}): number {
    if (!creatorIds.length) return 0;
    const db = this.database();
    const rows = db
      .prepare(
        `SELECT state_json FROM x_retrieval_tasks
         WHERE creator_id IN (${creatorIds.map(() => "?").join(",")})
           AND json_extract(state_json, '$.promoted') = 1
           AND json_extract(state_json, '$.status') <> 'complete'`,
      )
      .all(...creatorIds) as Array<{ state_json: string }>;
    let resumed = 0;
    for (const task of rows.map((row) => JSON.parse(row.state_json) as Task)) {
      if (this.running.has(task.id) || (task.status === "cancelled" && !includeStopped)) continue;
      if (task.retryAt && Date.parse(task.retryAt) > Date.now()) continue;
      if (task.config !== retrievalConfigKey(this.provider().id)) continue;
      const job = db
        .prepare(
          `SELECT j.* FROM x_retrieval_jobs j JOIN x_retrieval_job_tasks jt ON jt.job_id = j.id
           WHERE jt.task_id = ? ORDER BY j.cancelled, j.created_at DESC LIMIT 1`,
        )
        .get(task.id) as JobRow | undefined;
      if (!job || (job.cancelled && !includeStopped)) continue;
      if (job.cancelled) db.prepare("UPDATE x_retrieval_jobs SET cancelled = 0 WHERE id = ?").run(job.id);
      this.reopenJobs(task.id);
      this.launch(task.id, JSON.parse(job.request_json) as RetrievalRequest);
      resumed++;
    }
    return resumed;
  }
  /**
   * Forgets finished sync bookkeeping older than `maxAgeMs`. Posts, checkpoints and unfinished
   * work are kept; automatic syncs would otherwise add a job every few minutes forever.
   */
  prune(maxAgeMs = 7 * 86_400_000): void {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const db = this.database();
    db.transaction(() => {
      db.prepare(
        `DELETE FROM x_retrieval_jobs WHERE created_at < ? AND NOT EXISTS (
           SELECT 1 FROM x_retrieval_job_tasks jt JOIN x_retrieval_tasks t ON t.id = jt.task_id
           WHERE jt.job_id = x_retrieval_jobs.id
             AND json_extract(t.state_json, '$.status') NOT IN ('complete', 'cancelled', 'failed'))`,
      ).run(cutoff);
      db.prepare(
        `DELETE FROM x_retrieval_tasks WHERE json_extract(state_json, '$.status') IN ('complete', 'cancelled', 'failed')
           AND NOT EXISTS (SELECT 1 FROM x_retrieval_job_tasks jt WHERE jt.task_id = x_retrieval_tasks.id)`,
      ).run();
    })();
  }
  /** Test/host shutdown seam: abort in-flight work; never launch recovery. */
  async stop() {
    for (const run of this.running.values()) run.controller.abort();
    await Promise.all([...this.running.values()].map((run) => run.promise));
  }
  async wait(id: string) {
    await Promise.all(this.tasks(id).map((t) => this.running.get(t.id)?.promise));
    return this.job(id);
  }
  private launch(id: string, request: RetrievalRequest) {
    if (this.running.has(id)) return;
    const task = this.task(id);
    if (!task || task.status === "complete") return;
    if (task.retryAt && Date.parse(task.retryAt) > Date.now()) return;
    this.prime(task, request);
    const controller = new AbortController();
    // Defer until the registry is populated, so overlapping requests attach to the same task.
    const promise = Promise.resolve()
      .then(() => this.drive(task, request, controller))
      .finally(() => this.running.delete(id));
    this.running.set(id, { controller, promise });
  }
  /** Readies a task for an attempt under the budget of the request launching it. */
  private prime(task: Task, request: RetrievalRequest) {
    if (["cursor_stall", "gap", "skipped"].includes(task.reason ?? "")) resetTraversal(task);
    // Reused and resumed work walks the budget of the job launching it, not the one that created it.
    task.maxPages = pageBudget(request, task);
    task.status = "running";
    task.owner = this.owner;
    task.reason = null;
    task.error = null;
    task.errorCode = null;
    task.retryAt = null;
    this.save(task);
  }
  /** Runs attempts until the task settles, continuing automatically when enabled. */
  private async drive(task: Task, request: RetrievalRequest, controller: AbortController) {
    let current = task;
    let rounds = 0,
      waits = 0,
      faults = 0;
    const {
      autoContinue = false,
      maxRounds = 8,
      maxWaits = 6,
      maxFaults = 3,
      faultDelayMs = 30_000,
      maxWaitMs = 20 * 60_000,
    } = this.options;
    for (;;) {
      await this.run(current, controller);
      if (!autoContinue || controller.signal.aborted) return;
      const next = this.task(current.id);
      if (!next || !this.wanted(next.id)) return;
      let delay: number | null = null;
      if (next.status === "partial" && CONTINUE_REASONS.has(next.reason ?? "")) {
        const limit = next.reason === "cursor_stall" ? 2 : maxRounds;
        if (++rounds <= limit) delay = 0;
      } else if (next.status === "failed" && TRANSIENT_CODES.has(next.errorCode ?? "")) {
        if (next.retryAt) {
          const wait = Date.parse(next.retryAt) - Date.now() + 1_000;
          if (++waits <= maxWaits && wait <= maxWaitMs) delay = Math.max(0, wait);
        } else if (++faults <= maxFaults) delay = faultDelayMs;
      }
      if (delay === null) return;
      if (delay > 0) {
        // Stay visibly "running" while X asks us to wait, so nothing looks stuck or failed.
        next.status = "running";
        next.owner = this.owner;
        next.reason = "waiting";
        next.retryAt = new Date(Date.now() + delay).toISOString();
        this.save(next);
        this.reopenJobs(next.id);
        try {
          await sleep(delay, controller.signal);
        } catch {
          const stopped = this.task(next.id);
          if (stopped && stopped.status === "running") {
            stopped.status = "cancelled";
            stopped.reason = "cancelled";
            stopped.owner = null;
            stopped.retryAt = null;
            this.save(stopped);
          }
          return;
        }
      }
      const resumed = this.task(next.id);
      if (!resumed || !this.wanted(resumed.id) || resumed.status === "complete") return;
      // Resume restores the job's own budget; a retry clears the wait it just honored.
      resumed.retryAt = null;
      this.prime(resumed, request);
      this.reopenJobs(resumed.id);
      current = resumed;
    }
  }
  /** True while at least one job still wants this task's work. */
  private wanted(taskId: string): boolean {
    return Boolean(
      this.database()
        .prepare(
          `SELECT 1 FROM x_retrieval_job_tasks jt JOIN x_retrieval_jobs j ON j.id = jt.job_id
           WHERE jt.task_id = ? AND j.cancelled = 0 LIMIT 1`,
        )
        .get(taskId),
    );
  }
  private reopenJobs(taskId: string) {
    this.database()
      .prepare(
        `UPDATE x_retrieval_jobs SET finished_at = NULL WHERE cancelled = 0
         AND id IN (SELECT job_id FROM x_retrieval_job_tasks WHERE task_id = ?)`,
      )
      .run(taskId);
  }
  /**
   * Boot recovery for the app: picks interrupted or budget-paused work from the
   * last day back up. Never runs unless the host asks for it.
   */
  recover(maxAgeMs = 24 * 3600_000): string[] {
    const resumed: string[] = [];
    for (const listed of this.jobs()) {
      if (Date.now() - Date.parse(listed.createdAt) > maxAgeMs) continue;
      // Catch-ups from the last run would read an old window first; the next sync reads from the top.
      for (const task of this.tasks(listed.id))
        if (task.status !== "complete" && this.retirable(task)) this.retire(task);
      const job = this.job(listed.id);
      const continuable =
        job.status === "interrupted" ||
        (job.status === "partial" &&
          job.creators.some(
            (c) => c.status === "interrupted" || CONTINUE_REASONS.has(c.reason ?? ""),
          ));
      if (!continuable) continue;
      try {
        this.resume(job.id);
        resumed.push(job.id);
      } catch {
        /* A rate-limit wait or config change leaves it for the next sync. */
      }
    }
    return resumed;
  }
  /** True once a read of new posts has its newest pages and more of its window is left to read. */
  private promotable(task: Task): boolean {
    const { headDays, headPages = 5, catchupPages } = this.options;
    if (!task.candidateAnchors.length) return false;
    if (task.mode === "catchup") return catchupPages !== undefined && task.pages >= catchupPages;
    if (headDays === undefined || task.mode !== "initial") return false;
    const cutoff = Date.parse(task.until) - headDays * 86_400_000;
    return task.pages >= headPages || (task.reach != null && Date.parse(task.reach) < cutoff);
  }
  /**
   * Newer posts first: hands a read's newest pages to the head lane, so the creator counts as
   * synced and the next catch-up can run, then keeps walking the same traversal for the rest of
   * its window as lower-priority history. A catch-up's rest is a gap fill that ends where it meets
   * the previous sync; a first import's rest is the creator's history.
   */
  private promote(task: Task) {
    const db = this.database();
    db.transaction(() => {
      const gap = task.mode === "catchup";
      const head = this.checkpoint(task.creatorId, task.config, "head");
      head.initialized = true;
      head.anchors = task.candidateAnchors;
      // Current as of when this traversal started, so a catch-up picks up anything newer.
      // Never moved back: an old leftover catch-up must not undo a newer sync.
      const later = (a: string | null | undefined, b: string) => (a && a > b ? a : b);
      head.boundaryAt = later(head.boundaryAt, task.until);
      head.lastSuccessfulRefresh = later(head.lastSuccessfulRefresh, task.until);
      if (head.pendingTask === task.id || !gap) head.pendingTask = null;
      this.saveCheckpoint(task, head, "head");
      task.mode = "history";
      task.promoted = true;
      if (gap) task.gap = true;
      else {
        const history = this.checkpoint(task.creatorId, task.config, "history");
        history.pendingTask = task.id;
        history.since = task.since;
        history.until = task.until;
        history.status = "running";
        this.saveCheckpoint(task, history, "history");
      }
      db.prepare("UPDATE x_retrieval_tasks SET work_key = ? WHERE id = ?").run(
        gap
          ? `${task.config}:${task.userId}:gap:${task.id}`
          : `${task.config}:${task.userId}:history:${task.since}:${task.until}`,
        task.id,
      );
      this.save(task);
    })();
  }
  /**
   * After a completed read, records how far back the archive is now complete: a first import
   * covers its window, and a backfill or history window that reaches down from the covered edge
   * extends it. Catch-ups and gap fills only fill in above it.
   */
  private extendCoverage(task: Task, reason: string) {
    if (task.gap || task.mode === "catchup") return;
    const head = this.checkpoint(task.creatorId, task.config, "head");
    const current = head.coveredSince ?? null;
    const joins =
      current === null
        ? task.mode === "initial" || Boolean(task.promoted) || Boolean(task.extend)
        : Date.parse(task.until) >= Date.parse(current) - 60_000;
    const floor = reason === "provider_end" ? EPOCH : task.since;
    if (!joins || (current !== null && floor >= current)) return;
    head.coveredSince = floor;
    head.coverageCursor = reason === "provider_end" ? null : task.cursor;
    this.saveCheckpoint(task, head, "head");
  }
  /** Lower goes first; reads for new posts outrank older posts unless the host says otherwise. */
  private priorityOf(task: Task): number {
    const lane = laneOf(task);
    return (
      this.options.priority?.(task.creatorId, lane) ??
      (lane === "history" ? X_PRIORITY.backfill : X_PRIORITY.head)
    );
  }
  /** Keeps the creator's pinned post on the head lane so later reads can skip the lookup. */
  private rememberProfile(task: Task) {
    const head = this.checkpoint(task.creatorId, task.config, "head");
    head.pinnedId = task.pinnedId;
    head.resolvedAt = now();
    this.saveCheckpoint(task, head, "head");
  }
  private async run(task: Task, controller: AbortController) {
    // Creators share one X connection, so only time spent reading or backing off counts against
    // this attempt; waiting for other creators' reads does not.
    const budgetMs = Math.max(this.durationMs, task.maxPages * this.pageMs);
    const budget = new AbortController();
    const signal = AbortSignal.any([controller.signal, budget.signal]);
    let spentMs = 0;
    const spend = async <T>(work: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      const timer = setTimeout(
        () => budget.abort(new DOMException("The attempt time budget expired.", "TimeoutError")),
        Math.max(0, budgetMs - spentMs),
      );
      try {
        return await work();
      } finally {
        clearTimeout(timer);
        spentMs += Date.now() - startedAt;
      }
    };
    let attemptPages = 0;
    let cursorReset = false;
    const provider = this.provider();
    // Timeline reads spend X's tight per-account quota; profile lookups have their own.
    const read = async <T>(operation: () => Promise<T>, bucket?: XBucket): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          return await this.exclusive(
            () => {
              signal.throwIfAborted();
              return spend(operation);
            },
            {
              background: task.mode === "history",
              // Re-read at every turn: switching lists or a promotion changes it while waiting.
              priority: () => this.priorityOf(task),
              bucket,
              signal,
            },
          );
        } catch (error) {
          const failure = toXServiceError(error);
          if (
            signal.aborted ||
            !["network", "timeout", "rate_limited"].includes(failure.code) ||
            attempt >= 2
          )
            throw error;
          const delay = Math.max(1000 * 2 ** attempt, (failure.retryAfterSeconds ?? 0) * 1000);
          if (failure.code === "rate_limited") {
            task.retryAt = new Date(Date.now() + delay).toISOString();
            this.save(task);
          }
          if (delay >= budgetMs - spentMs) throw error;
          await spend(
            () =>
              new Promise<void>((resolve, reject) => {
                const abort = () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                };
                const timer = setTimeout(() => {
                  signal.removeEventListener("abort", abort);
                  resolve();
                }, delay);
                signal.addEventListener("abort", abort, { once: true });
              }),
          );
        }
      }
    };
    try {
      if (!task.resolved) {
        const lookup = await read(() => provider.resolveUser(task.handle, signal));
        if (lookup.user.userId !== task.userId)
          throw new XProviderError(
            "not_found",
            "The saved handle now belongs to another X account. Resolve the creator again.",
          );
        task.pinnedId = lookup.pinnedTweetId;
        task.resolved = true;
        this.save(task);
        this.rememberProfile(task);
      }
      if (this.promotable(task)) this.promote(task);
      while (attemptPages < task.maxPages) {
        signal.throwIfAborted();
        let page: XTimelinePage;
        try {
          page = await read(
            () =>
              provider.listUserTweets(
                { userId: task.userId, handle: task.handle, cursor: task.cursor, limit: 100 },
                signal,
              ),
            this.options.timelineBucket,
          );
        } catch (error) {
          if (
            !cursorReset &&
            task.cursor &&
            error instanceof XProviderError &&
            ["invalid_response", "not_found"].includes(error.code)
          ) {
            cursorReset = true;
            resetTraversal(task);
            task.reason = "cursor_reset";
            this.save(task);
            const lookup = await read(() => provider.resolveUser(task.handle, signal));
            if (lookup.user.userId !== task.userId) throw new XProviderError("not_found");
            task.pinnedId = lookup.pinnedTweetId;
            task.resolved = true;
            this.rememberProfile(task);
            continue;
          }
          throw error;
        }
        signal.throwIfAborted(); // A cancelled response cannot overwrite a stopped task/checkpoint.
        if (!this.task(task.id)) throw new XProviderError("cancelled");
        const ordinary = page.items.filter(
          (i) =>
            i.tweet.id !== task.pinnedId &&
            i.timelineKind !== "repost" &&
            i.tweet.author.userId === task.userId &&
            i.tweet.publishedAt !== null,
        );
        const ids = ordinary.map((i) => i.tweet.id);
        for (const i of ordinary)
          if (!task.reach || Date.parse(i.tweet.publishedAt!) < Date.parse(task.reach))
            task.reach = i.tweet.publishedAt;
        if (task.anchorPages < 2 && ids.length) {
          task.candidateAnchors = [...new Set([...task.candidateAnchors, ...ids])];
          task.anchorPages++;
        }
        task.matched = [
          ...new Set([...task.matched, ...ids.filter((id) => task.anchors.includes(id))]),
        ];
        // Two successive ordinary pages beyond the boundary tolerate a recurring pin and local inversions.
        // Unknown dates/foreign entries/skips prevent a boundary assertion.
        const boundaryItems = page.items.filter((i) => i.tweet.id !== task.pinnedId);
        const before =
          boundaryItems.length > 0 &&
          page.skipped === 0 &&
          boundaryItems.every((i) => {
            const at = i.timelineKind === "repost" ? i.timelineAt : i.tweet.publishedAt;
            return (
              at !== null &&
              Number.isFinite(Date.parse(at)) &&
              Date.parse(at) < Date.parse(task.since)
            );
          });
        task.beforePages = before ? task.beforePages + 1 : 0;
        const signature = page.items
          .filter((i) => i.tweet.id !== task.pinnedId)
          .map((i) => i.tweet.id)
          .sort()
          .join(",");
        const stalled =
          page.nextCursor !== null &&
          (page.nextCursor === task.cursor ||
            task.cursors.includes(page.nextCursor) ||
            (signature !== "" && task.pageSignatures.includes(signature)));
        if (signature) task.pageSignatures.push(signature);
        // A catch-up has met the last sync once it has seen a remembered post and this page reaches
        // back past that sync. Waiting for every remembered post let one deleted post send a catch-up
        // through the creator's whole history. A catch-up's background gap fill ends the same way.
        const last = ordinary.at(-1);
        const overlap =
          (task.mode === "catchup" || task.gap === true) &&
          task.matched.length > 0 &&
          last !== undefined &&
          Date.parse(last.tweet.publishedAt!) < Date.parse(task.since);
        // For a catch-up `since` is the last sync, so this also ends one whose remembered posts are all gone.
        const boundary = task.beforePages >= 2;
        const end = page.nextCursor === null;
        task.pages++;
        attemptPages++;
        task.skipped += page.skipped;
        let reason = overlap
          ? "overlap"
          : boundary
            ? "boundary"
            : end
              ? task.mode === "catchup"
                ? "gap"
                : "provider_end"
              : stalled
                ? "cursor_stall"
                : null;
        if (reason && task.skipped > 0) reason = "skipped";
        const complete = ["overlap", "boundary", "provider_end"].includes(reason ?? "");
        task.reason = reason;
        task.status = reason ? (complete ? "complete" : "partial") : "running";
        if (page.nextCursor) task.cursors.push(page.nextCursor);
        task.cursor = page.nextCursor;
        for (const item of page.items) {
          const at = item.timelineKind === "repost" ? item.timelineAt : item.tweet.publishedAt;
          if (at && Number.isFinite(Date.parse(at))) {
            if (!task.oldest || Date.parse(at) < Date.parse(task.oldest)) task.oldest = at;
            if (!task.newest || Date.parse(at) > Date.parse(task.newest)) task.newest = at;
          }
        }
        // Canonical text, memberships and this page's next cursor/progress are one SQLite commit.
        this.database().transaction(() => {
          const ids = [...new Set(page.items.map((item) => item.tweet.id))];
          const before = new Map(ids.map((id) => [id, getTweetById(this.database(), id)]));
          // Merge every payload so a weaker duplicate within this page cannot erase an earlier full body.
          mergeCreatorTimeline(this.database(), task.creatorId, page.items);
          for (const id of ids) {
            const old = before.get(id);
            if (!old) task.newPosts++;
            else if (JSON.stringify(old) !== JSON.stringify(getTweetById(this.database(), id)))
              task.updatedPosts++;
          }
          // A gap fill never claims the history lane: that records the creator's own older imports.
          if (!task.gap) {
            const cp = this.checkpoint(task.creatorId, task.config, laneOf(task));
            if (
              task.newest &&
              (!cp.newestObserved || Date.parse(task.newest) > Date.parse(cp.newestObserved))
            )
              cp.newestObserved = task.newest;
            cp.pendingTask = complete ? null : task.id;
            if (task.mode === "history") {
              cp.since = task.since;
              cp.until = task.until;
              cp.status = reason ?? "running";
            } else if (complete) {
              cp.initialized = true;
              cp.anchors = task.candidateAnchors;
              cp.boundaryAt = task.until;
              cp.lastSuccessfulRefresh = now();
            }
            this.saveCheckpoint(task, cp);
          }
          if (complete) this.extendCoverage(task, reason!);
          this.save(task);
        })();
        if (reason) break;
        if (this.promotable(task)) this.promote(task);
      }
      if (task.status === "running") {
        task.status = "partial";
        task.reason = "page_budget";
        this.save(task);
      }
    } catch (error) {
      // Restore the durable page state: a rolled-back merge must never persist its cursor or counters.
      const committed = this.task(task.id);
      if (!committed) return;
      Object.assign(task, committed);
      // Re-read cancellation to avoid making a cancelled shared job look failed.
      if (controller.signal.aborted) {
        task.status = "cancelled";
        task.reason = "cancelled";
      } else if (signal.aborted) {
        task.status = "partial";
        task.reason = "time_budget";
      } else {
        const failure = toXServiceError(error);
        task.status = "failed";
        task.error = failure.message;
        task.errorCode = failure.code;
        if (failure.retryAfterSeconds !== null)
          task.retryAt = new Date(Date.now() + failure.retryAfterSeconds * 1000).toISOString();
      }
      this.save(task);
    } finally {
      const db = this.database();
      const cp = this.checkpoint(task.creatorId, task.config, laneOf(task));
      if (cp.pendingTask === task.id && task.mode === "history" && !task.gap) {
        cp.status = task.reason ?? task.status;
        this.saveCheckpoint(task, cp);
      }
      const jobs = db
        .prepare("SELECT job_id FROM x_retrieval_job_tasks WHERE task_id = ?")
        .all(task.id) as Array<{ job_id: string }>;
      for (const job of jobs) {
        if (this.tasks(job.job_id).every((t) => this.effective(t) !== "running"))
          db.prepare(
            "UPDATE x_retrieval_jobs SET finished_at = COALESCE(finished_at, ?) WHERE id = ?",
          ).run(now(), job.job_id);
      }
    }
  }
}
const shared = globalThis as typeof globalThis & { __scopeXRetrieval?: RetrievalEngine };
export function getRetrievalEngine(): RetrievalEngine {
  return (shared.__scopeXRetrieval ??= new RetrievalEngine(
    getDb,
    getXProvider,
    runXExclusive,
    180_000,
    6_000,
    {
      // Real X rate-limit windows run up to 15 minutes; one request per window is cheap to keep trying.
      autoContinue: true,
      maxWaits: 12,
      headDays: 2,
      // New posts never wait behind more than three pages of one account.
      catchupPages: 3,
      // Pinned posts rarely change; one profile lookup a day instead of one per sync.
      resolveTtlMs: 24 * 3600_000,
      priority: (creatorId, lane) => xReadPriority(creatorId, lane),
      timelineBucket: "timeline",
    },
  ));
}
