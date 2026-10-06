import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDb, type ScopeDatabase } from "@/lib/db/connection";
import { createAiRunner, type AiRunner } from "@/lib/ai/backend";
import { getAiBackend, getAiChatModeSelection } from "@/lib/settings/settings";
import { getModelCatalog } from "@/lib/ai/models/catalog";
import { resolveCatalogExecution } from "@/lib/ai/models/resolve";
import { isAiBackendId } from "@/lib/ai/backend-id";
import { DEFAULT_CHAT_MODE, isChatModeId } from "@/lib/ai/chat-modes";
import type { CodexUsage } from "@/lib/ai/codex";
import { ResearchInputError } from "./input";
import { corpusPosts, freezeCorpus, getCorpusPost, getCorpusScope } from "./corpus";
import { analysisPrompt } from "./analysis-prompts";
import {
  estimateTokens,
  fits,
  makeBatch,
  packInputs,
  planScan,
  postUnits,
  splitUnit,
} from "./analysis-planner";
import {
  AnalysisOutputError,
  parseAnalysisOutput,
  validateReduction,
  validateScan,
  validateSynthesis,
  validateVerification,
  type EvidenceLookup,
} from "./analysis-validation";
import {
  analysisLimits,
  ANALYSIS_PROMPT_VERSION,
  type AnalysisAnswer,
  type AnalysisBatch,
  type AnalysisConfig,
  type AnalysisJob,
  type AnalysisState,
  type BatchInput,
  type Finding,
} from "./analysis-model";
import {
  batchList,
  commitBatch,
  createAnalysisJob,
  insertBatch,
  nextBatch,
  readJob,
  saveBatch,
  saveState,
  analysisPostResults,
} from "./analysis-store";

export interface AnalysisDeps {
  database: () => ScopeDatabase;
  runner?: (config: AnalysisConfig) => Promise<AiRunner>;
  resolve?: (
    input: Record<string, unknown>,
    db: ScopeDatabase,
  ) => Promise<Pick<AnalysisConfig, "backend" | "mode" | "model" | "reasoningEffort">>;
  /** Tests can explicitly drive the scheduler instead of starting provider work. */
  autoRun?: boolean;
}
async function resolveExecution(input: Record<string, unknown>, db: ScopeDatabase) {
  const backend = input.backend ?? getAiBackend(db),
    mode = input.mode ?? DEFAULT_CHAT_MODE;
  if (!isAiBackendId(backend) || !isChatModeId(mode))
    throw new ResearchInputError("Choose an available AI provider and reasoning mode.");
  const saved = getAiChatModeSelection(db, backend, mode);
  if (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim()))
    throw new ResearchInputError("Choose a valid model.");
  if (
    input.reasoningEffort !== undefined &&
    input.reasoningEffort !== null &&
    (typeof input.reasoningEffort !== "string" || input.reasoningEffort.length > 64)
  )
    throw new ResearchInputError("Choose a valid reasoning effort.");
  const catalog = getModelCatalog();
  // The catalog intentionally hides models until the connection is probed.
  // Freeze resolution once; later discovery/settings changes cannot alter this job.
  await catalog.checkConnection(backend);
  const execution = resolveCatalogExecution(catalog.getSnapshot(backend, db), {
    model: typeof input.model === "string" ? input.model : saved.model,
    reasoningEffort:
      input.reasoningEffort === undefined
        ? saved.reasoningEffort
        : (input.reasoningEffort as string | null),
  });
  if (execution.problem) throw new ResearchInputError(execution.problem.message, 422);
  return {
    backend,
    mode,
    model: execution.model!,
    reasoningEffort: execution.reasoningEffort ?? null,
  };
}
function usageTokens(usage: CodexUsage | null): number | null {
  if (!usage) return null;
  if (usage.totalTokens !== null) return usage.totalTokens;
  if (usage.inputTokens === null && usage.outputTokens === null) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0);
}
const safeProviderReason = (error: unknown) => {
  const kind =
    error && typeof error === "object" && "kind" in error ? String(error.kind) : "provider_failure";
  if (/quota|rate/.test(kind))
    return "The AI provider reached a usage limit. Resume manually when available.";
  if (/auth|not_found|signing/.test(kind))
    return "The AI provider is unavailable. Check Settings and Resume manually.";
  if (/timeout/.test(kind))
    return "The AI call timed out. Completed checkpoints are saved; Resume manually.";
  return "The AI provider could not complete this batch. Completed checkpoints are saved; Resume manually.";
};

/** A server-owned, serialized AI scheduler, independent of the X read queue.
 * Restart recovery changes state only: retrieval and inference never resume on boot. */
export class ResearchAnalysisEngine {
  private queue: string[] = [];
  private draining: Promise<void> | null = null;
  private active: { id: string; controller: AbortController } | null = null;
  private stopped = false;
  constructor(private readonly deps: AnalysisDeps) {
    const db = deps.database();
    db.transaction(() => {
      const rows = db.prepare("SELECT id,state_json FROM x_analysis_jobs").all() as Array<{
        id: string;
        state_json: string;
      }>;
      for (const row of rows) {
        const state: AnalysisState = JSON.parse(row.state_json);
        if (["queued", "running", "waiting_for_provider"].includes(state.status)) {
          state.status = "paused";
          state.reason = "Application restarted. Resume manually from saved checkpoints.";
          saveState(db, row.id, state);
        }
      }
      db.prepare("UPDATE x_analysis_batches SET status = 'pending' WHERE status = 'running'").run();
    })();
  }
  job(id: string): AnalysisJob {
    return readJob(this.deps.database(), id);
  }
  jobs(): AnalysisJob[] {
    return (
      this.deps
        .database()
        .prepare("SELECT id FROM x_analysis_jobs ORDER BY created_at DESC, rowid DESC LIMIT 50")
        .all() as Array<{ id: string }>
    ).map((r) => this.job(r.id));
  }
  results(id: string, page = 1, mode: "related" | "all" | "unfinished" = "related") {
    return analysisPostResults(this.deps.database(), id, page, mode);
  }
  source(id: string, tweetId: string) {
    return getCorpusPost(this.deps.database(), this.job(id).scopeId, tweetId);
  }
  async start(input: Record<string, unknown>): Promise<AnalysisJob> {
    if (this.stopped) throw new ResearchInputError("The research engine is shutting down.", 503);
    if (
      typeof input.question !== "string" ||
      !input.question.trim() ||
      input.question.length > 4000
    )
      throw new ResearchInputError("Enter a research question of 1–4,000 characters.");
    if (input.strategy !== undefined && input.strategy !== "full_scan")
      throw new ResearchInputError("Choose Full scan. Other strategies are not implemented.");
    if (input.execute !== undefined && typeof input.execute !== "boolean")
      throw new ResearchInputError("Choose whether to execute or prepare an estimate.");
    const limits = analysisLimits(input.limits),
      db = this.deps.database();
    const execution = await (this.deps.resolve ?? resolveExecution)(input, db);
    const parent = input.parentJobId === undefined ? null : this.job(String(input.parentJobId));
    if (parent && input.scopeId !== undefined && input.scopeId !== parent.scopeId)
      throw new ResearchInputError("A follow-up must use the previous turn's saved scope.");
    const contextPrefix = (value: string, tokens: number) => {
      let prefix = "";
      for (const character of value) {
        if (estimateTokens(prefix + character) > tokens) break;
        prefix += character;
      }
      return prefix;
    };
    const previousQuestion = parent ? contextPrefix(parent.config.question, 1000) : "";
    const previousAnswer = parent?.state.result
      ? contextPrefix(parent.state.result.text, 1500)
      : null;
    const config: AnalysisConfig = {
      question: input.question.trim(),
      ...(parent
        ? {
            conversation: {
              question: previousQuestion,
              answer: previousAnswer,
              abridged:
                previousQuestion !== parent.config.question ||
                previousAnswer !== (parent.state.result?.text ?? null),
            },
          }
        : {}),
      strategy: "full_scan",
      ...execution,
      promptVersion: ANALYSIS_PROMPT_VERSION,
      limits,
    };
    // Fail before writing a scope if instructions/question alone cannot fit.
    if (estimateTokens(analysisPrompt(config, "scan", { units: [] })) >= limits.inputTokens)
      throw new ResearchInputError(
        "The question/instructions exceed the input budget. Increase the budget or shorten the question.",
      );
    const id = randomUUID();
    db.transaction(() => {
      // A saved scope is the immutable execution branch for follow-ups. It is
      // never re-resolved against a changed live list/archive.
      const scope =
        input.scopeId === undefined && !parent
          ? freezeCorpus(db, input, limits.maxSnapshotBytes)
          : parent
            ? getCorpusScope(db, parent.scopeId)
            : typeof input.scopeId === "string"
              ? getCorpusScope(db, input.scopeId)
              : (() => {
                  throw new ResearchInputError("Choose a valid saved corpus scope.");
                })();
      if (scope.summary.bytes > limits.maxSnapshotBytes)
        throw new ResearchInputError("The saved corpus exceeds the configured disk budget.", 413);
      const batches = planScan(config, corpusPosts(db, scope.id));
      const state: AnalysisState = {
        status: "queued",
        phase: "scan",
        reason: null,
        calls: 0,
        chargedTokens: 0,
        reportedTokens: 0,
        usageReportedCalls: 0,
        reusedBatches: 0,
        estimatedBatches: batches.length,
        estimatedTokens: batches.reduce(
          (n, batch) =>
            n +
            estimateTokens(analysisPrompt(config, batch.phase, batch.input)) +
            limits.outputTokens,
          0,
        ),
        result: null,
      };
      createAnalysisJob(db, id, scope, config, state, batches);
      this.assertDisk(id);
    })();
    if (input.execute === false) {
      const job = this.job(id);
      job.state.status = "paused";
      job.state.reason =
        "Ready to start. Estimates cover Full scan; reduction and verification require additional calls.";
      saveState(db, id, job.state);
    } else this.enqueue(id);
    return this.job(id);
  }
  cancel(id: string): AnalysisJob {
    const job = this.job(id);
    if (job.state.status === "complete") return job;
    job.state.status = "cancelled";
    job.state.reason = "Cancelled. Completed evidence is saved; Resume manually.";
    saveState(this.deps.database(), id, job.state);
    this.queue = this.queue.filter((queued) => queued !== id);
    if (this.active?.id === id) this.active.controller.abort();
    return this.job(id);
  }
  resume(id: string, budgets?: unknown): AnalysisJob {
    if (this.stopped) throw new ResearchInputError("The research engine is shutting down.", 503);
    if (this.active?.id === id)
      throw new ResearchInputError("This batch is still stopping. Wait before resuming.", 409);
    const job = this.job(id);
    if (job.config.promptVersion !== ANALYSIS_PROMPT_VERSION)
      throw new ResearchInputError(
        "The research prompt changed. Create a new job against this saved scope.",
        409,
      );
    if (this.queue.includes(id)) return job;
    const limits = analysisLimits(budgets, job.config.limits);
    // Planning/model identity is immutable after submission. Work ceilings may
    // grow on Resume, while cache compatibility remains exact.
    for (const key of ["contextTokens", "inputTokens", "outputTokens"] as const)
      if (limits[key] !== job.config.limits[key])
        throw new ResearchInputError(
          "Changed model context/output limits require a new job against this saved scope.",
        );
    if (job.state.status === "complete") return job;
    const competing = this.deps
      .database()
      .prepare(
        `SELECT peer.job_id FROM x_research_turns own
      JOIN x_research_turns peer ON peer.thread_id=own.thread_id AND peer.job_id<>own.job_id
      JOIN x_analysis_jobs j ON j.id=peer.job_id WHERE own.job_id=?
      AND json_extract(j.state_json,'$.status') IN ('queued','running','waiting_for_provider') LIMIT 1`,
      )
      .get(id);
    if (competing)
      throw new ResearchInputError(
        "Finish or cancel the active conversation turn before resuming another.",
        409,
      );
    job.config.limits = limits;
    job.state.status = "queued";
    job.state.reason = null;
    const db = this.deps.database();
    db.transaction(() => {
      db.prepare(
        "UPDATE x_analysis_batches SET status = 'pending', attempts = 0, error = NULL WHERE job_id = ? AND status IN ('failed','running')",
      ).run(id);
      saveState(db, id, job.state, job.config);
    })();
    this.enqueue(id);
    return this.job(id);
  }
  /** Estimates can be created with execute:false and explicitly resumed. */
  private enqueue(id: string) {
    if (!this.queue.includes(id)) this.queue.push(id);
    if (this.deps.autoRun !== false) void this.drain();
  }
  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length && !this.stopped) {
        const id = this.queue.shift()!;
        const controller = new AbortController();
        this.active = { id, controller };
        try {
          await this.execute(id, controller.signal);
        } catch (error) {
          const job = this.job(id);
          if (!["cancelled", "paused"].includes(job.state.status)) {
            job.state.status = job.progress.reviewed ? "partial" : "failed";
            job.state.reason =
              error instanceof ResearchInputError || error instanceof AnalysisOutputError
                ? error.message
                : safeProviderReason(error);
            saveState(this.deps.database(), id, job.state);
          }
        } finally {
          this.active = null;
        }
      }
    })().finally(() => {
      this.draining = null;
      if (this.queue.length && !this.stopped && this.deps.autoRun !== false) void this.drain();
    });
    return this.draining;
  }
  async close(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.queue, ...(this.active ? [this.active.id] : [])]) {
      const job = this.job(id);
      if (job.state.status !== "cancelled") {
        job.state.status = "paused";
        job.state.reason = "Engine stopped. Resume manually.";
        saveState(this.deps.database(), id, job.state);
      }
    }
    this.queue = [];
    this.active?.controller.abort();
    await this.draining;
  }
  private lookup(scopeId: string): EvidenceLookup {
    return (id, attribution) => {
      try {
        const post = getCorpusPost(this.deps.database(), scopeId, id);
        if (post.exclusion) return null;
        return attribution === "author" ? post.tweet.text : (post.tweet.quoted?.text ?? null);
      } catch {
        return null;
      }
    };
  }
  private validate(
    job: AnalysisJob,
    batch: AnalysisBatch,
    output: Record<string, unknown>,
  ): unknown {
    const lookup = this.lookup(job.scopeId);
    switch (batch.phase) {
      case "scan":
        return validateScan(output, batch.input);
      case "reduce": {
        const result = validateReduction(output, batch.input, lookup);
        // A quieter creator cannot disappear during a cross-creator reduction.
        const creatorSet = (findings: Finding[]) =>
          new Set(
            findings.flatMap((f) =>
              f.evidence.flatMap((e) =>
                getCorpusPost(this.deps.database(), job.scopeId, e.postId).provenance.map(
                  (p) => p.creatorId,
                ),
              ),
            ),
          );
        const before = creatorSet(batch.input.findings!),
          after = creatorSet(result.findings);
        if ([...before].some((creator) => !after.has(creator)))
          throw new AnalysisOutputError("Reduction omitted a creator's evidence.");
        return result;
      }
      case "synthesize":
        return validateSynthesis(output, batch.input, lookup);
      case "verify":
        return validateVerification(output, batch.input);
    }
  }
  private async execute(id: string, signal: AbortSignal) {
    const db = this.deps.database(),
      started = Date.now();
    let runner: AiRunner | null = null;
    const attemptStart = this.job(id).state;
    const initialCalls = attemptStart.calls,
      initialTokens = attemptStart.chargedTokens;
    while (!signal.aborted && !this.stopped) {
      let job = this.job(id);
      if (job.state.status === "cancelled" || job.state.status === "paused") return;
      if (Date.now() - started >= job.config.limits.maxRunMs) {
        this.pause(id, "Execution time budget reached. Resume manually from saved checkpoints.");
        return;
      }
      const batch = nextBatch(db, id);
      if (!batch) {
        if (this.advance(job)) return;
        continue;
      }
      job.state.phase = batch.phase;
      job.state.status = "running";
      saveState(db, id, job.state);
      // Revalidate cached outputs against THIS immutable manifest before reuse.
      const cached = db
        .prepare(
          `SELECT b.result_json FROM x_analysis_batches b JOIN x_analysis_jobs j ON j.id = b.job_id
           WHERE b.cache_key = ? AND b.status = 'complete' AND b.job_id <> ?
             AND (b.phase IN ('scan','reduce') OR json_extract(j.state_json, '$.status') = 'complete') LIMIT 1`,
        )
        .get(batch.cacheKey, id) as { result_json: string } | undefined;
      if (cached) {
        try {
          const output = JSON.parse(cached.result_json);
          const wire = batch.phase === "scan" ? { posts: output } : output;
          const valid = this.validate(job, batch, wire);
          db.transaction(() => {
            commitBatch(db, id, batch, valid);
            saveState(db, id, { ...job.state, reusedBatches: job.state.reusedBatches + 1 });
            this.assertDisk(id);
          })();
          continue;
        } catch (error) {
          if (error instanceof ResearchInputError) throw error;
          /* A stale/corrupt cache entry is never trusted. */
        }
      }
      const prompt = analysisPrompt(job.config, batch.phase, batch.input);
      const reserve = estimateTokens(prompt) + job.config.limits.outputTokens;
      if (
        job.state.calls - initialCalls >= job.config.limits.maxCalls ||
        job.state.chargedTokens - initialTokens + reserve > job.config.limits.maxTokens ||
        Date.now() - started >= job.config.limits.maxRunMs
      ) {
        this.pause(
          id,
          "Execution attempt budget reached. Resume/Continue from saved checkpoints; unfinished posts remain explicit.",
        );
        return;
      }
      batch.status = "running";
      batch.attempts++;
      job.state.calls++;
      job.state.chargedTokens += reserve;
      job.state.status = "waiting_for_provider";
      db.transaction(() => {
        saveBatch(db, id, batch);
        saveState(db, id, job.state);
      })();
      let workDir: string | null = null;
      try {
        if (!runner)
          runner = await (this.deps.runner ?? ((config) => createAiRunner(config.backend)))(
            job.config,
          );
        if (signal.aborted) return;
        // Only the bounded prompt is exposed to the provider. No giant legacy
        // materialization, client path, live archive or unrelated job directory.
        workDir = mkdtempSync(path.join(tmpdir(), "scope-x-analysis-"));
        const run = runner({
          prompt,
          workDir,
          sandbox: "read-only",
          skipGitRepoCheck: true,
          model: job.config.model,
          reasoningEffort: job.config.reasoningEffort,
          signal,
          timeoutMs: Math.min(
            job.config.limits.timeoutMs,
            Math.max(1, job.config.limits.maxRunMs - (Date.now() - started)),
          ),
        });
        const consume = (async () => {
          for await (const event of run.events) void event;
        })();
        const [result] = await Promise.all([run.completed, consume]);
        if (signal.aborted || ["cancelled", "paused"].includes(this.job(id).state.status)) return;
        job = this.job(id);
        const reported = usageTokens(result.usage);
        if (reported !== null) {
          job.state.reportedTokens += reported;
          job.state.usageReportedCalls++;
          job.state.chargedTokens += Math.max(0, reported - reserve);
        }
        // Persist usage even when structured output fails validation.
        saveState(db, id, job.state);
        const output = parseAnalysisOutput(result.finalMessage, job.config);
        const validated = this.validate(job, batch, output);
        db.transaction(() => {
          commitBatch(db, id, batch, validated);
          this.assertDisk(id);
        })();
      } catch (error) {
        if (signal.aborted || ["cancelled", "paused"].includes(this.job(id).state.status)) return;
        const contextLimit =
          /context.{0,30}(limit|length|window)|too many tokens|output budget|exceeds.*output/i.test(
            error instanceof Error ? error.message : "",
          );
        if (error instanceof AnalysisOutputError || contextLimit) {
          if (this.splitBatch(job, batch, contextLimit)) continue;
          if (batch.attempts <= job.config.limits.retries) {
            batch.status = "pending";
            batch.error = "Structured output failed validation; retrying.";
            saveBatch(db, id, batch);
            continue;
          }
          batch.status = "failed";
          batch.error =
            error instanceof AnalysisOutputError
              ? error.message
              : "The provider's context limit prevented this batch.";
          saveBatch(db, id, batch);
          throw new AnalysisOutputError(batch.error);
        }
        batch.status = "failed";
        batch.error =
          error instanceof ResearchInputError ? error.message : safeProviderReason(error);
        saveBatch(db, id, batch);
        throw error;
      } finally {
        if (workDir) rmSync(workDir, { recursive: true, force: true });
      }
    }
  }
  private pause(id: string, reason: string) {
    const job = this.job(id);
    job.state.status = job.progress.reviewed ? "partial" : "paused";
    job.state.reason = reason;
    saveState(this.deps.database(), id, job.state);
  }
  private assertDisk(id: string) {
    const db = this.deps.database(),
      job = this.job(id);
    const bytes =
      (
        db
          .prepare(
            `SELECT
      (SELECT COALESCE(SUM(length(CAST(input_json AS BLOB))+length(CAST(COALESCE(result_json,'') AS BLOB))),0) FROM x_analysis_batches WHERE job_id = @id)
      + (SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))),0) FROM x_analysis_post_results WHERE job_id = @id)
      + (SELECT COALESCE(SUM(length(CAST(COALESCE(result_json,'') AS BLOB))),0) FROM x_analysis_segments WHERE job_id = @id) AS n`,
          )
          .get({ id }) as { n: number }
      ).n + job.scope.bytes;
    if (bytes > job.config.limits.maxSnapshotBytes)
      throw new ResearchInputError(
        "The analysis reached its configured disk budget. Increase it and Resume from saved checkpoints.",
      );
  }
  private addInputs(job: AnalysisJob, phase: AnalysisBatch["phase"], inputs: BatchInput[]) {
    const db = this.deps.database();
    db.transaction(() => {
      const ordinal =
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(ordinal), -1) AS n FROM x_analysis_batches WHERE job_id = ?",
            )
            .get(job.id) as { n: number }
        ).n + 1;
      inputs.forEach((input, index) =>
        insertBatch(db, job.id, makeBatch(job.config, phase, input, ordinal + index)),
      );
      job.state.phase = phase;
      saveState(db, job.id, job.state);
      this.assertDisk(job.id);
    })();
  }
  private splitBatch(job: AnalysisJob, batch: AnalysisBatch, contextLimit: boolean): boolean {
    const input = batch.input;
    let inputs: BatchInput[];
    if (batch.phase === "scan") {
      const units = input.units!;
      if (units.length > 1) {
        const mid = Math.ceil(units.length / 2);
        inputs = [{ units: units.slice(0, mid) }, { units: units.slice(mid) }];
      } else if (contextLimit) {
        try {
          inputs = splitUnit(units[0]).map((unit, index) => ({
            units: [{ ...unit, id: `${units[0].id}:${index + 1}` }],
          }));
        } catch {
          return false;
        }
      } else return false;
    } else if (batch.phase === "reduce" && input.findings!.length > 1) {
      const mid = Math.ceil(input.findings!.length / 2);
      inputs = [
        { ...input, findings: input.findings!.slice(0, mid) },
        { ...input, findings: input.findings!.slice(mid) },
      ];
    } else return false;
    const db = this.deps.database();
    db.transaction(() => {
      batch.status = "superseded";
      batch.error = "Split into smaller retry batches.";
      saveBatch(db, job.id, batch);
      if (batch.phase === "scan")
        db.prepare("DELETE FROM x_analysis_segments WHERE job_id = ? AND batch_key = ?").run(
          job.id,
          batch.key,
        );
      const start =
        (
          db
            .prepare("SELECT MAX(ordinal) AS n FROM x_analysis_batches WHERE job_id = ?")
            .get(job.id) as { n: number }
        ).n + 1;
      inputs.forEach((child, index) =>
        insertBatch(db, job.id, makeBatch(job.config, batch.phase, child, start + index)),
      );
      this.assertDisk(job.id);
    })();
    return true;
  }
  /** Advance only after every leaf checkpoint in the preceding phase validates. */
  private advance(job: AnalysisJob): boolean {
    const db = this.deps.database();
    const batches = batchList(db, job.id).filter((b) => b.status !== "superseded");
    if (batches.some((b) => b.status !== "complete"))
      throw new AnalysisOutputError("Unfinished batches prevent a complete research result.");
    const latest = batches.at(-1)?.phase ?? "scan";
    if (latest === "scan") {
      if (job.progress.unfinished)
        throw new AnalysisOutputError("Unfinished post segments prevent a complete Full scan.");
      const rows = db
        .prepare(
          `SELECT p.creator_id, r.result_json FROM x_analysis_post_results r JOIN x_research_scope_posts p ON p.scope_id = ? AND p.tweet_id = r.tweet_id WHERE r.job_id = ? ORDER BY p.creator_id, julianday(p.event_at), p.tweet_id`,
        )
        .all(job.scopeId, job.id) as Array<{ creator_id: number; result_json: string }>;
      const groups = new Map<number, Finding[]>();
      for (const row of rows) {
        const findings = (JSON.parse(row.result_json) as { findings: Finding[] }).findings;
        const group = groups.get(row.creator_id) ?? [];
        group.push(...findings);
        groups.set(row.creator_id, group);
      }
      const inputs = [...groups].flatMap(([creatorId, findings]) =>
        packInputs(job.config, "reduce", findings, (items) => ({
          findings: items,
          creatorId,
          level: 0,
        })),
      );
      if (!inputs.length) {
        this.finish(
          job,
          [],
          job.progress.uncertain
            ? "No supported claims were extracted. Uncertain posts are available in the related collection."
            : "No relevant mentions found in the eligible retrieved posts.",
        );
        return true;
      }
      this.addInputs(job, "reduce", inputs);
      return false;
    }
    if (latest === "reduce") {
      const reductions = batches.filter((b) => b.phase === "reduce");
      const level = Math.max(...reductions.map((b) => b.input.level ?? 0));
      const last = reductions.filter((b) => b.input.level === level);
      const findings = last.flatMap((b) => (b.result as { findings: Finding[] }).findings);
      if (fits(job.config, "synthesize", { findings }))
        this.addInputs(job, "synthesize", [{ findings }]);
      else {
        const before = last.reduce(
            (n, b) => n + estimateTokens(JSON.stringify(b.input.findings)),
            0,
          ),
          after = estimateTokens(JSON.stringify(findings));
        if (level >= 8 || (level > 0 && after >= before))
          throw new AnalysisOutputError(
            "Findings cannot be condensed within the model budget without losing evidence. Full scan is saved; create a new job with a larger context budget or an explicit narrower question.",
          );
        const inputs = packInputs(job.config, "reduce", findings, (items) => ({
          findings: items,
          level: level + 1,
        }));
        this.addInputs(job, "reduce", inputs);
      }
      return false;
    }
    const synthesis = batches.find((b) => b.phase === "synthesize")!;
    const claims = (synthesis.result as { claims: Finding[] }).claims;
    if (latest === "synthesize") {
      const inputs: BatchInput[] = [];
      claims.forEach((claim, index) => {
        for (const postId of new Set(claim.evidence.map((e) => e.postId))) {
          const post = getCorpusPost(db, job.scopeId, postId);
          const pending = postUnits(job.config, post);
          while (pending.length) {
            const unit = pending.shift()!;
            const input: BatchInput = {
              units: [unit],
              candidates: [claim],
              candidateIndices: [index],
            };
            if (fits(job.config, "verify", input)) inputs.push(input);
            else pending.unshift(...splitUnit(unit));
          }
        }
      });
      this.addInputs(job, "verify", inputs);
      return false;
    }
    const verdicts = batches.filter((b) => b.phase === "verify");
    for (let index = 0; index < claims.length; index++) {
      const checks = verdicts
        .filter((b) => b.input.candidateIndices!.includes(index))
        .flatMap((b) => (b.result as ReturnType<typeof validateVerification>).checks);
      if (
        !checks.length ||
        !checks.some((c) => c.supported) ||
        checks.some((c) => c.contradicted)
      ) {
        db.transaction(() => {
          db.prepare("DELETE FROM x_analysis_batches WHERE job_id = ? AND phase = 'verify'").run(
            job.id,
          );
          synthesis.status = "failed";
          synthesis.result = null;
          synthesis.error = "Source verification rejected a proposed claim.";
          saveBatch(db, job.id, synthesis);
        })();
        throw new AnalysisOutputError(
          "Source verification rejected a proposed claim. Validated post findings remain available; the answer is withheld. Resume regenerates and checks the answer.",
        );
      }
    }
    this.finish(job, claims);
    return true;
  }
  private finish(job: AnalysisJob, claims: Finding[], emptyText?: string) {
    // Render prose exclusively from verified, evidence-bearing claims: a free
    // answer string cannot smuggle uncited assertions past mechanical checks.
    const text =
      emptyText ??
      claims
        .map(
          (claim) =>
            `${claim.interpretation ? "Interpretation: " : ""}${claim.claim}${claim.horizon ? ` Time horizon: ${claim.horizon}.` : ""}${claim.condition ? ` Condition: ${claim.condition}.` : ""} ${[...new Set(claim.evidence.map((e) => `[tweet:${e.postId}]`))].join(" ")}`,
        )
        .join("\n\n");
    const scopeNote = `${job.progress.reviewed} of ${job.scope.eligible} eligible cached posts reviewed across ${job.scope.creators.length} selected creators. ${job.scope.total - job.scope.eligible} excluded (${job.scope.excluded.incomplete_text} incomplete text, ${job.scope.excluded.missing_text} missing text, ${job.scope.excluded.missing_date} missing date). ${job.progress.uncertain} uncertain. ${job.progress.unfinished} unfinished. Cached scope ${getCorpusScope(this.deps.database(), job.scopeId).request.since} to ${getCorpusScope(this.deps.database(), job.scopeId).request.until} (end exclusive). Upstream coverage remains unverified; relevance is model judgment. Media and linked pages were not analyzed.`;
    const result: AnalysisAnswer = { text, claims, scopeNote, verified: true };
    job.state.result = result;
    job.state.status = "complete";
    job.state.reason = null;
    saveState(this.deps.database(), job.id, job.state);
  }
}
const ENGINE = Symbol.for("scope.x.research.analysis.v1");
export function getResearchAnalysisEngine(): ResearchAnalysisEngine {
  const global = globalThis as typeof globalThis & { [ENGINE]?: ResearchAnalysisEngine };
  return (global[ENGINE] ??= new ResearchAnalysisEngine({ database: getDb }));
}
