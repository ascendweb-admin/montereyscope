import type { ScopeDatabase } from "@/lib/db/connection";
import type {
  AnalysisBatch,
  AnalysisConfig,
  AnalysisJob,
  AnalysisState,
  CorpusScope,
  PostResult,
  ScanResult,
} from "./analysis-model";
import { getCorpusScope, getCorpusPost, digest } from "./corpus";
import { ResearchInputError } from "./input";

interface JobRow {
  id: string;
  scope_id: string;
  config_json: string;
  state_json: string;
  created_at: string;
  updated_at: string;
}
interface BatchRow {
  batch_key: string;
  phase: AnalysisBatch["phase"];
  ordinal: number;
  cache_key: string;
  input_json: string;
  status: AnalysisBatch["status"];
  attempts: number;
  result_json: string | null;
  error: string | null;
}
export function readBatch(row: BatchRow): AnalysisBatch {
  return {
    key: row.batch_key,
    phase: row.phase,
    ordinal: row.ordinal,
    cacheKey: row.cache_key,
    input: JSON.parse(row.input_json),
    status: row.status,
    attempts: row.attempts,
    result: row.result_json ? JSON.parse(row.result_json) : null,
    error: row.error,
  };
}
export function jobRecord(db: ScopeDatabase, id: string): JobRow {
  const row = db.prepare("SELECT * FROM x_analysis_jobs WHERE id = ?").get(id) as
    JobRow | undefined;
  if (!row) throw new ResearchInputError("This research job does not exist.", 404);
  return row;
}
export function readJob(db: ScopeDatabase, id: string): AnalysisJob {
  const row = jobRecord(db, id),
    scope = getCorpusScope(db, row.scope_id);
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS reviewed,
    COALESCE(SUM(disposition = 'relevant'),0) AS relevant, COALESCE(SUM(disposition = 'uncertain'),0) AS uncertain
    FROM x_analysis_post_results WHERE job_id = ?`,
    )
    .get(id) as { reviewed: number; relevant: number; uncertain: number };
  const batches = db
    .prepare(
      `SELECT COALESCE(SUM(status = 'complete'),0) AS completedBatches,
    COALESCE(SUM(status IN ('pending','running','failed')),0) AS unfinishedBatches FROM x_analysis_batches WHERE job_id = ?`,
    )
    .get(id) as { completedBatches: number; unfinishedBatches: number };
  const creators = db
    .prepare(
      `SELECT m.creator_id AS id, COUNT(DISTINCT p.tweet_id) AS total, COUNT(DISTINCT r.tweet_id) AS reviewed
    FROM x_research_scope_posts p JOIN x_research_scope_memberships m ON m.scope_id = p.scope_id AND m.tweet_id = p.tweet_id
    LEFT JOIN x_analysis_post_results r ON r.tweet_id = p.tweet_id AND r.job_id = @job
    WHERE p.scope_id = @scope AND p.exclusion IS NULL GROUP BY m.creator_id ORDER BY m.creator_id`,
    )
    .all({ job: id, scope: scope.id }) as AnalysisJob["progress"]["creators"];
  return {
    id,
    scopeId: scope.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    config: JSON.parse(row.config_json),
    state: JSON.parse(row.state_json),
    scope: scope.summary,
    progress: {
      ...counts,
      ...batches,
      unfinished: scope.summary.eligible - counts.reviewed,
      creators,
    },
  };
}
export function saveState(
  db: ScopeDatabase,
  id: string,
  state: AnalysisState,
  config?: AnalysisConfig,
): void {
  if (config)
    db.prepare("UPDATE x_analysis_jobs SET config_json = ? WHERE id = ?").run(
      JSON.stringify(config),
      id,
    );
  db.prepare("UPDATE x_analysis_jobs SET state_json = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(state),
    new Date().toISOString(),
    id,
  );
  if (state.status === "complete" && state.result) {
    db.transaction(() => {
      const turn = db
        .prepare("SELECT thread_id, assistant_message_id FROM x_research_turns WHERE job_id=?")
        .get(id) as { thread_id: number; assistant_message_id: number | null } | undefined;
      if (!turn || turn.assistant_message_id !== null) return;
      const message = db
        .prepare("INSERT INTO ai_messages(thread_id,role,content) VALUES (?,'assistant',?)")
        .run(turn.thread_id, `${state.result!.text}\n\n${state.result!.scopeNote}`);
      db.prepare("UPDATE x_research_turns SET assistant_message_id=? WHERE job_id=?").run(
        message.lastInsertRowid,
        id,
      );
    })();
  }
}
export function insertBatch(db: ScopeDatabase, id: string, batch: AnalysisBatch): void {
  db.prepare("INSERT INTO x_analysis_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    batch.key,
    batch.phase,
    batch.ordinal,
    batch.cacheKey,
    JSON.stringify(batch.input),
    batch.status,
    batch.attempts,
    batch.result === null ? null : JSON.stringify(batch.result),
    batch.error,
  );
  const insert = db.prepare(
    "INSERT INTO x_analysis_segments(job_id,unit_id,post_id,batch_key) VALUES (?, ?, ?, ?)",
  );
  for (const unit of batch.phase === "scan" ? (batch.input.units ?? []) : [])
    insert.run(id, unit.id, unit.postId, batch.key);
}
export function batchList(
  db: ScopeDatabase,
  id: string,
  phase?: AnalysisBatch["phase"],
): AnalysisBatch[] {
  return (
    db
      .prepare(
        `SELECT * FROM x_analysis_batches WHERE job_id = ? ${phase ? "AND phase = ?" : ""} ORDER BY ordinal, batch_key`,
      )
      .all(...(phase ? [id, phase] : [id])) as BatchRow[]
  ).map(readBatch);
}
export function nextBatch(db: ScopeDatabase, id: string): AnalysisBatch | null {
  const row = db
    .prepare(
      "SELECT * FROM x_analysis_batches WHERE job_id = ? AND status = 'pending' ORDER BY ordinal, batch_key LIMIT 1",
    )
    .get(id) as BatchRow | undefined;
  return row ? readBatch(row) : null;
}
export function saveBatch(db: ScopeDatabase, id: string, batch: AnalysisBatch): void {
  db.prepare(
    "UPDATE x_analysis_batches SET status = ?, attempts = ?, result_json = ?, error = ? WHERE job_id = ? AND batch_key = ?",
  ).run(
    batch.status,
    batch.attempts,
    batch.result === null ? null : JSON.stringify(batch.result),
    batch.error,
    id,
    batch.key,
  );
}
export function createAnalysisJob(
  db: ScopeDatabase,
  id: string,
  scope: CorpusScope,
  config: AnalysisConfig,
  state: AnalysisState,
  batches: AnalysisBatch[],
): void {
  db.transaction(() => {
    db.prepare("INSERT INTO x_analysis_jobs VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      scope.id,
      JSON.stringify(config),
      JSON.stringify(state),
      scope.createdAt,
      scope.createdAt,
    );
    for (const batch of batches) insertBatch(db, id, batch);
  })();
}
/** Batch results, segment checkpoints and accounted-for post records commit together. */
export function commitBatch(
  db: ScopeDatabase,
  id: string,
  batch: AnalysisBatch,
  result: unknown,
): void {
  db.transaction(() => {
    batch.status = "complete";
    batch.result = result;
    batch.error = null;
    saveBatch(db, id, batch);
    if (batch.phase !== "scan") return;
    const results = result as ScanResult[];
    for (const item of results)
      db.prepare(
        "UPDATE x_analysis_segments SET result_json = ? WHERE job_id = ? AND unit_id = ? AND active = 1",
      ).run(JSON.stringify(item), id, item.unitId);
    for (const postId of new Set(results.map((r) => r.postId))) {
      const rows = db
        .prepare(
          "SELECT result_json FROM x_analysis_segments WHERE job_id = ? AND post_id = ? AND active = 1 ORDER BY unit_id",
        )
        .all(id, postId) as Array<{ result_json: string | null }>;
      if (rows.some((r) => !r.result_json)) continue;
      const parts = rows.map((r) => JSON.parse(r.result_json!) as ScanResult);
      const findings = [
        ...new Map(parts.flatMap((r) => r.findings).map((f) => [digest(f), f])).values(),
      ];
      const disposition = parts.some((r) => r.disposition === "relevant")
        ? "relevant"
        : parts.some((r) => r.disposition === "uncertain")
          ? "uncertain"
          : "not_relevant";
      const post: PostResult = {
        postId,
        disposition,
        findings,
        explanation: parts.map((p) => p.explanation).join("\n"),
      };
      db.prepare(
        "INSERT INTO x_analysis_post_results VALUES (?, ?, ?, ?) ON CONFLICT(job_id,tweet_id) DO UPDATE SET disposition=excluded.disposition,result_json=excluded.result_json",
      ).run(id, postId, disposition, JSON.stringify(post));
    }
  })();
}
export function analysisPostResults(
  db: ScopeDatabase,
  id: string,
  page: number,
  mode: "related" | "all" | "unfinished" = "related",
) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000)
    throw new ResearchInputError("Choose a valid result page.");
  const job = readJob(db, id);
  const condition =
    mode === "related"
      ? "AND r.disposition IN ('relevant','uncertain')"
      : mode === "unfinished"
        ? "AND p.exclusion IS NULL AND r.tweet_id IS NULL"
        : "";
  const query = `FROM x_research_scope_posts p LEFT JOIN x_analysis_post_results r ON r.tweet_id = p.tweet_id AND r.job_id = @job WHERE p.scope_id = @scope ${condition}`;
  return db.transaction(() => {
    const params = { job: id, scope: job.scopeId };
    const total = (db.prepare(`SELECT COUNT(*) AS n ${query}`).get(params) as { n: number }).n;
    const resolvedPage = Math.min(page, Math.max(1, Math.ceil(total / 30)));
    const rows = db
      .prepare(
        `SELECT p.tweet_id, r.result_json ${query} ORDER BY julianday(p.event_at) DESC, p.tweet_id DESC LIMIT 30 OFFSET @offset`,
      )
      .all({ ...params, offset: (resolvedPage - 1) * 30 }) as Array<{
      tweet_id: string;
      result_json: string | null;
    }>;
    return {
      total,
      page: resolvedPage,
      pageSize: 30,
      posts: rows.map((r) => ({
        post: getCorpusPost(db, job.scopeId, r.tweet_id),
        analysis: r.result_json ? (JSON.parse(r.result_json) as PostResult) : null,
      })),
    };
  })();
}
