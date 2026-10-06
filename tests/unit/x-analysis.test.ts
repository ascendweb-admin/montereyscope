import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { ResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { freezeCorpus, getCorpusPost, getCorpusScope, corpusPosts } from "@/lib/x/research/corpus";
import { saveResearchList, deleteResearchList } from "@/lib/x/research/repository";
import {
  analysisLimits,
  DEFAULT_ANALYSIS_LIMITS,
  type AnalysisConfig,
  type Finding,
} from "@/lib/x/research/analysis-model";
import { estimateTokens, planScan, fits } from "@/lib/x/research/analysis-planner";
import { analysisPrompt } from "@/lib/x/research/analysis-prompts";
import {
  parseAnalysisOutput,
  validateScan,
  validateSynthesis,
  validateVerification,
  validateReduction,
} from "@/lib/x/research/analysis-validation";
import { batchList } from "@/lib/x/research/analysis-store";
import {
  addXCreator,
  putPost,
  corpusInput,
  execution,
  fakeRunner,
  fixtureOutput,
  promptInput,
  runnerDeps,
} from "../helpers/x-analysis";

let db: Database.Database, directory: string, file: string, engine: ResearchAnalysisEngine;
const config: AnalysisConfig = {
  question: "What are their Ethereum theses?",
  strategy: "full_scan",
  backend: "codex",
  model: "fixture-model",
  reasoningEffort: null,
  mode: "quick",
  promptVersion: "fixture-v1",
  limits: { ...DEFAULT_ANALYSIS_LIMITS },
};
function open() {
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  runMigrations(db, ALL_MIGRATIONS);
}
function setup(runner = runnerDeps) {
  engine = new ResearchAnalysisEngine({
    database: () => db,
    resolve: execution,
    runner,
    autoRun: false,
  });
  return engine;
}
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "scope-analysis-test-"));
  file = path.join(directory, "db.sqlite");
  open();
  setup();
});
afterEach(async () => {
  await engine.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("immutable server-resolved corpus", () => {
  it("scopes memberships before deduplication, freezes attribution/context and survives deletion/reopening", () => {
    const outside = addXCreator(db, "outside"),
      a = addXCreator(db, "alpha"),
      b = addXCreator(db, "beta");
    putPost(db, outside, "100", "Ethereum authored claim", {
      quoted: { tweetId: "800", text: "Bitcoin quoted claim", handle: "quoted" },
      inReplyToTweetId: "900",
    });
    putPost(db, a, "100", "Ethereum authored claim", {
      quoted: { tweetId: "800", text: "Bitcoin quoted claim", handle: "quoted" },
      inReplyToTweetId: "900",
    });
    putPost(db, b, "100", "Ethereum authored claim", {
      quoted: { tweetId: "800", text: "Bitcoin quoted claim", handle: "quoted" },
      inReplyToTweetId: "900",
    });
    putPost(db, outside, "900", "Parent only", { publishedAt: "2020-01-01T00:00:00Z" });
    putPost(db, a, "101", "Incomplete", { contentStatus: "summary" });
    putPost(db, a, "102", "", { contentStatus: "unavailable" });
    putPost(db, a, "103", "Unknown date", { publishedAt: null });
    putPost(db, a, "104", "Outside window", { publishedAt: "2020-01-01T00:00:00Z" });
    putPost(
      db,
      b,
      "105",
      "Old original shared now",
      { publishedAt: "2020-01-01T00:00:00Z" },
      "repost",
    );
    const list = saveResearchList(db, { name: "Corpus", creatorIds: [a, b] });
    const scope = freezeCorpus(
      db,
      { ...corpusInput, listId: list.id, types: ["quote", "reply", "original", "repost"] },
      10_000_000,
    );
    expect(scope.summary).toMatchObject({
      total: 5,
      eligible: 2,
      excluded: { missing_date: 1, incomplete_text: 1, missing_text: 1 },
    });
    const source = getCorpusPost(db, scope.id, "100");
    expect(source.provenance.map((p) => p.creatorId)).toEqual([a, b]);
    expect(source.context).toMatchObject({ id: "900", text: "Parent only", role: "context_only" });
    expect(source.tweet.quoted?.text).toBe("Bitcoin quoted claim");
    putPost(db, a, "100", "Changed live cache");
    deleteResearchList(db, list.id);
    db.prepare("DELETE FROM creators").run();
    db.prepare("DELETE FROM tweets").run();
    expect(() => db.prepare("UPDATE x_research_scope_posts SET version = 'changed'").run()).toThrow(
      /immutable/,
    );
    expect(() => db.prepare("UPDATE x_research_scopes SET created_at = 'changed'").run()).toThrow(
      /immutable/,
    );
    db.close();
    open();
    expect(getCorpusPost(db, scope.id, "100")).toEqual(source);
    expect(getCorpusScope(db, scope.id)).toEqual(scope);
    expect([...corpusPosts(db, scope.id)]).toHaveLength(2);
  });
  it("validates list selections, exact authored-only scope, selected ids, DST and disk budget atomically", () => {
    const a = addXCreator(db, "alpha"),
      b = addXCreator(db, "outside");
    const list = saveResearchList(db, { name: "Dates", creatorIds: [a] });
    putPost(db, a, "100", "Ethereum authored", { publishedAt: "2026-03-29T20:00:00Z" });
    putPost(db, a, "101", "Quoted only", {
      publishedAt: "2026-03-29T20:00:00Z",
      quoted: { tweetId: "900", text: "Ethereum" },
    });
    putPost(db, a, "102", "Ethereum outside inclusive day", {
      publishedAt: "2026-03-29T22:00:00Z",
    });
    const input = {
      ...corpusInput,
      start: "2026-03-29",
      end: "2026-03-29",
      listId: list.id,
      selection: { kind: "exact", search: { terms: "Ethereum" } },
    };
    const scope = freezeCorpus(db, input, 10_000_000);
    expect(scope.request).toMatchObject({
      since: "2026-03-28T23:00:00.000Z",
      until: "2026-03-29T22:00:00.000Z",
    });
    expect(scope.summary.eligible).toBe(1);
    for (const override of [
      { creatorIds: [b] },
      { selection: { kind: "selected", tweetIds: ["102"] } },
      { selection: { kind: "selected", tweetIds: ["999"] } },
      { timezone: "bad" },
      { types: ["bad"] },
    ])
      expect(() => freezeCorpus(db, { ...input, ...override }, 10_000_000)).toThrow();
    const count = db.prepare("SELECT COUNT(*) AS n FROM x_research_scopes").get();
    expect(() => freezeCorpus(db, input, 1)).toThrow(/disk budget/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM x_research_scopes").get()).toEqual(count);
  });
});

describe("token planning and structured evidence validation", () => {
  it("splits long Unicode posts without dropping text, quote or parent context, and budgets both input and output", () => {
    const a = addXCreator(db, "alpha");
    const body = "Ethereum 🔬日本語 abc ".repeat(2000),
      quoted = "Quoted words ".repeat(400);
    putPost(db, a, "100", body, { quoted: { tweetId: "900", text: quoted } });
    for (let n = 0; n < 40; n++) putPost(db, a, String(200 + n), "ETH");
    const scope = freezeCorpus(db, { ...corpusInput, creatorIds: [a] }, 50_000_000);
    const batches = planScan(config, corpusPosts(db, scope.id));
    const units = batches.flatMap((b) => b.input.units!).filter((u) => u.postId === "100");
    expect(units.length).toBeGreaterThan(1);
    expect(units.map((u) => u.source.text).join("")).toBe(body.trim());
    expect(units.map((u) => u.source.quoted?.text ?? "").join("")).toBe(quoted.trim());
    expect(new Set(units.map((u) => u.id)).size).toBe(units.length);
    for (const batch of batches) {
      expect(fits(config, "scan", batch.input)).toBe(true);
      expect(estimateTokens(analysisPrompt(config, "scan", batch.input))).toBeLessThanOrEqual(
        config.limits.inputTokens,
      );
      expect(batch.input.units!.length * 600).toBeLessThanOrEqual(config.limits.outputTokens);
    }
  });
  it("rejects missing, duplicate, unknown dispositions, invented excerpts, quoted attribution errors and uncited synthesis", () => {
    const a = addXCreator(db, "alpha");
    putPost(db, a, "100", "Ethereum thesis", { quoted: { tweetId: "900", text: "Bitcoin quote" } });
    const scope = freezeCorpus(db, { ...corpusInput, creatorIds: [a] }, 10_000_000);
    const batch = planScan(config, corpusPosts(db, scope.id))[0];
    const valid = JSON.parse(
      fixtureOutput({ prompt: analysisPrompt(config, "scan", batch.input), workDir: directory }),
    );
    expect(validateScan(valid, batch.input)).toHaveLength(1);
    for (const change of [
      (v: typeof valid) => v.posts.pop(),
      (v: typeof valid) => v.posts.push(v.posts[0]),
      (v: typeof valid) => (v.posts[0].unitId = "outside"),
      (v: typeof valid) => (v.posts[0].findings[0].evidence[0].postId = "999"),
      (v: typeof valid) => (v.posts[0].findings[0].evidence[0].excerpt = "Invented"),
      (v: typeof valid) => (v.posts[0].findings[0].evidence[0].attribution = "quoted"),
      (v: typeof valid) => (v.posts[0].findings = []),
    ]) {
      const value = structuredClone(valid);
      change(value);
      expect(() => validateScan(value, batch.input)).toThrow();
    }
    const finding: Finding = valid.posts[0].findings[0];
    const lookup = (id: string, attr: string) =>
      id === "100" && attr === "author" ? "Ethereum thesis" : null;
    expect(() =>
      validateSynthesis(
        { claims: [{ ...finding, evidence: [] }] },
        { findings: [finding] },
        lookup,
      ),
    ).toThrow();
    expect(() =>
      validateReduction({ findings: [finding], covered: [] }, { findings: [finding] }, lookup),
    ).toThrow();
    expect(() => validateVerification({ checks: [] }, { candidates: [finding] })).toThrow();
    expect(() => parseAnalysisOutput("not JSON", config)).toThrow();
    expect(() => parseAnalysisOutput(JSON.stringify({ huge: "x".repeat(20000) }), config)).toThrow(
      /output budget/,
    );
    expect(() => analysisLimits({ inputTokens: 128000 })).toThrow(/context space/);
  });
});

describe("durable full scan engine", () => {
  it("persists every post, comparisons and citations independently of answer size, reuses compatible work only", async () => {
    const a = addXCreator(db, "alpha");
    db.transaction(() => {
      for (let n = 0; n < 65; n++)
        putPost(db, a, String(100000 + n), "Ethereum bullish if fees rise");
    })();
    const first = await engine.start({ ...corpusInput, creatorIds: [a] });
    await engine.drain();
    const done = engine.job(first.id);
    expect(done.state.status, done.state.reason ?? "").toBe("complete");
    expect(done.progress).toMatchObject({ reviewed: 65, relevant: 65, unfinished: 0 });
    expect(done.state.result!.claims).toHaveLength(1);
    expect([1, 2, 3].map((p) => engine.results(first.id, p).posts.length)).toEqual([30, 30, 5]);
    const second = await engine.start({ ...corpusInput, scopeId: done.scopeId });
    await engine.drain();
    expect(engine.job(second.id).state).toMatchObject({ status: "complete", calls: 0 });
    expect(engine.job(second.id).state.reusedBatches).toBeGreaterThan(0);
    const changed = await engine.start({
      ...corpusInput,
      scopeId: done.scopeId,
      question: "Compare Bitcoin arguments",
    });
    await engine.drain();
    expect(engine.job(changed.id).state.calls).toBeGreaterThan(0);
    const changedModel = await engine.start({
      ...corpusInput,
      scopeId: done.scopeId,
      model: "another-model",
    });
    await engine.drain();
    expect(engine.job(changedModel.id).state.calls).toBeGreaterThan(0);
  });
  it("checkpoints attempt budgets, cancellation and restart, resumes without recounting, and makes no X reads", async () => {
    const a = addXCreator(db, "alpha");
    for (let n = 0; n < 40; n++) putPost(db, a, String(100000 + n), "Ethereum claim");
    const started = await engine.start({
      ...corpusInput,
      creatorIds: [a],
      limits: { maxCalls: 1 },
    });
    await engine.drain();
    expect(engine.job(started.id)).toMatchObject({
      state: { status: "partial" },
      progress: { reviewed: 13, unfinished: 27 },
    });
    expect(engine.results(started.id, 1, "unfinished").total).toBe(27);
    engine.cancel(started.id);
    expect(engine.job(started.id).state.status).toBe("cancelled");
    await engine.close();
    db.close();
    open();
    setup();
    expect(engine.job(started.id).progress.reviewed).toBe(13);
    engine.resume(started.id, { maxCalls: 100 });
    await engine.drain();
    expect(engine.job(started.id)).toMatchObject({
      state: { status: "complete" },
      progress: { reviewed: 40, unfinished: 0 },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM x_retrieval_jobs").get()).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM x_analysis_post_results WHERE job_id = ?")
        .get(started.id),
    ).toEqual({ n: 40 });
  });
  it("recovers orphaned running/queued jobs as manual-only paused jobs", async () => {
    const a = addXCreator(db, "alpha");
    putPost(db, a, "100", "Ethereum claim");
    const started = await engine.start({ ...corpusInput, creatorIds: [a] });
    await engine.close();
    const state = engine.job(started.id).state;
    state.status = "waiting_for_provider";
    db.prepare("UPDATE x_analysis_jobs SET state_json = ? WHERE id = ?").run(
      JSON.stringify(state),
      started.id,
    );
    db.prepare("UPDATE x_analysis_batches SET status = 'running' WHERE job_id = ?").run(started.id);
    db.close();
    open();
    setup();
    expect(engine.job(started.id).state.status).toBe("paused");
    await engine.drain();
    expect(engine.job(started.id).state.calls).toBe(0);
    engine.resume(started.id);
    await engine.drain();
    expect(engine.job(started.id).state.status).toBe("complete");
  });
  it("splits context-limit and malformed multi-source output into durable smaller batches", async () => {
    const a = addXCreator(db, "alpha");
    for (let n = 0; n < 30; n++) putPost(db, a, String(100000 + n), "Ethereum claim");
    let failures = 0;
    setup(async () =>
      fakeRunner((options) => {
        const input = promptInput(options.prompt);
        if (input.units && !input.candidates && input.units.length > 3) {
          failures++;
          if (failures % 2) throw new Error("maximum context length exceeded");
          return '{"posts":[]}';
        }
        return fixtureOutput(options);
      }),
    );
    const started = await engine.start({ ...corpusInput, creatorIds: [a] });
    await engine.drain();
    expect(engine.job(started.id)).toMatchObject({
      state: { status: "complete" },
      progress: { reviewed: 30, unfinished: 0 },
    });
    expect(batchList(db, started.id).some((b) => b.status === "superseded")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM x_analysis_post_results").get()).toEqual({
      n: 30,
    });
  });
  it("never marks malformed singleton output or unsupported synthesis complete", async () => {
    const a = addXCreator(db, "alpha");
    putPost(db, a, "100", "Ethereum claim");
    setup(async () => fakeRunner(() => "malformed"));
    const first = await engine.start({ ...corpusInput, creatorIds: [a] });
    await engine.drain();
    expect(engine.job(first.id)).toMatchObject({
      state: { status: "failed", calls: 3 },
      progress: { reviewed: 0, unfinished: 1 },
    });
    setup(async () =>
      fakeRunner((options) =>
        promptInput(options.prompt).candidates
          ? JSON.stringify({
              checks: [
                { index: 0, supported: false, contradicted: true, reason: "Wrong attribution" },
              ],
            })
          : fixtureOutput(options),
      ),
    );
    const second = await engine.start({ ...corpusInput, creatorIds: [a] });
    await engine.drain();
    expect(engine.job(second.id)).toMatchObject({
      state: { status: "partial", result: null },
      progress: { reviewed: 1 },
    });
    expect(engine.job(second.id).state.reason).toMatch(/verification rejected/);
  });
  it("cancels an active provider call without accepting its late result, and serializes jobs", async () => {
    const a = addXCreator(db, "alpha");
    putPost(db, a, "100", "Ethereum claim");
    let active = 0,
      maximum = 0,
      enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    setup(async () =>
      fakeRunner(async (options) => {
        active++;
        maximum = Math.max(maximum, active);
        enter();
        await new Promise<void>((resolve) =>
          options.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        active--;
        return fixtureOutput(options);
      }),
    );
    const first = await engine.start({ ...corpusInput, creatorIds: [a] });
    const draining = engine.drain();
    await entered;
    const second = await engine.start({ ...corpusInput, creatorIds: [a] });
    expect(() => engine.resume(first.id)).toThrow(/still stopping/);
    engine.cancel(first.id);
    engine.cancel(second.id);
    await draining;
    expect(maximum).toBe(1);
    expect(engine.job(first.id).progress.reviewed).toBe(0);
    expect(engine.job(first.id).state.status).toBe("cancelled");
  });
  it("exposes estimates before execution, explicit exclusions, uncertain results, and qualified absence", async () => {
    const a = addXCreator(db, "alpha");
    putPost(db, a, "100", "UNRELATED Bitcoin");
    putPost(db, a, "101", "AMBIGUOUS Gas");
    putPost(db, a, "102", "Preview", { contentStatus: "summary" });
    const first = await engine.start({ ...corpusInput, creatorIds: [a], execute: false });
    expect(first.state).toMatchObject({ status: "paused", calls: 0 });
    expect(first.state.estimatedBatches).toBeGreaterThan(0);
    await engine.drain();
    expect(engine.job(first.id).state.calls).toBe(0);
    engine.resume(first.id);
    await engine.drain();
    expect(engine.job(first.id)).toMatchObject({
      state: { status: "complete" },
      progress: { reviewed: 2, uncertain: 1 },
      scope: { eligible: 2, excluded: { incomplete_text: 1 } },
    });
    expect(engine.results(first.id).total).toBe(1);
    expect(engine.job(first.id).state.result!.scopeNote).toMatch(/1 uncertain/);
  });
});

it("does not account for a long post until every segment is durably validated", async () => {
  const a = addXCreator(db, "alpha");
  putPost(
    db,
    a,
    "100000",
    "Ethereum long thesis | " + "Every sentence remains in the immutable original. ".repeat(600),
  );
  const job = await engine.start({ ...corpusInput, creatorIds: [a], limits: { maxCalls: 1 } });
  await engine.drain();
  expect(engine.job(job.id)).toMatchObject({
    state: { status: "paused" },
    progress: { reviewed: 0, unfinished: 1, completedBatches: 1 },
  });
  engine.resume(job.id, { maxCalls: 200 });
  await engine.drain();
  expect(engine.job(job.id).state.status, engine.job(job.id).state.reason ?? "").toBe("complete");
  expect(engine.job(job.id).progress.reviewed).toBe(1);
});
it("rolls back evidence on disk exhaustion, exposes the ceiling and resumes after increasing it", async () => {
  const a = addXCreator(db, "alpha");
  putPost(db, a, "100000", "Ethereum claim");
  const job = await engine.start({ ...corpusInput, creatorIds: [a], execute: false });
  const size =
    (
      db
        .prepare(
          "SELECT SUM(length(CAST(input_json AS BLOB))) AS n FROM x_analysis_batches WHERE job_id=?",
        )
        .get(job.id) as { n: number }
    ).n + job.scope.bytes;
  engine.resume(job.id, { maxSnapshotBytes: size + 100 });
  await engine.drain();
  expect(engine.job(job.id)).toMatchObject({
    state: { status: "failed" },
    progress: { reviewed: 0, unfinished: 1 },
  });
  expect(engine.job(job.id).state.reason).toMatch(/disk budget/);
  engine.resume(job.id, { maxSnapshotBytes: 1_000_000 });
  await engine.drain();
  expect(engine.job(job.id).state.status).toBe("complete");
});
it("accounts reported token usage and pauses before the next call exceeds the attempt budget", async () => {
  const a = addXCreator(db, "alpha");
  for (let n = 0; n < 30; n++) putPost(db, a, String(100000 + n), "Ethereum claim");
  setup(async () => {
    const runner = fakeRunner();
    return (options) => {
      const run = runner(options);
      return {
        events: run.events,
        completed: run.completed.then((result) => ({
          ...result,
          usage: {
            totalTokens: 40000,
            inputTokens: 39000,
            outputTokens: 1000,
            cachedInputTokens: null,
            cacheWriteInputTokens: null,
            reasoningOutputTokens: null,
          },
        })),
      };
    };
  });
  const job = await engine.start({ ...corpusInput, creatorIds: [a], limits: { maxTokens: 15000 } });
  await engine.drain();
  expect(engine.job(job.id)).toMatchObject({
    state: {
      status: "partial",
      calls: 1,
      reportedTokens: 40000,
      usageReportedCalls: 1,
      chargedTokens: 40000,
    },
    progress: { reviewed: 13, unfinished: 17 },
  });
});
it("keeps quota/provider failure details private and requires an explicit resume", async () => {
  const a = addXCreator(db, "alpha");
  putPost(db, a, "100000", "Ethereum claim");
  let blocked = true;
  setup(async () =>
    fakeRunner((options) => {
      if (blocked)
        throw Object.assign(new Error("private provider diagnostic"), { kind: "quota_exceeded" });
      return fixtureOutput(options);
    }),
  );
  const job = await engine.start({ ...corpusInput, creatorIds: [a] });
  await engine.drain();
  expect(engine.job(job.id)).toMatchObject({
    state: { status: "failed", calls: 1 },
    progress: { reviewed: 0 },
  });
  expect(engine.job(job.id).state.reason).toMatch(/usage limit/);
  expect(engine.job(job.id).state.reason).not.toMatch(/private/);
  blocked = false;
  await engine.drain();
  expect(engine.job(job.id).state.calls).toBe(1);
  engine.resume(job.id);
  await engine.drain();
  expect(engine.job(job.id).state.status).toBe("complete");
});
it("includes every scoped author/sharer in per-creator progress", async () => {
  const a = addXCreator(db, "alpha"),
    b = addXCreator(db, "beta");
  putPost(db, a, "100000", "Ethereum claim");
  putPost(db, b, "100000", "Ethereum claim");
  const job = await engine.start({ ...corpusInput, creatorIds: [a, b] });
  await engine.drain();
  expect(engine.job(job.id).progress.creators).toEqual([
    { id: a, total: 1, reviewed: 1 },
    { id: b, total: 1, reviewed: 1 },
  ]);
});
