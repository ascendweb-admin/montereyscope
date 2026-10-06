import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { ResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { batchList } from "@/lib/x/research/analysis-store";
import { addXCreator, putPost, execution, runnerDeps, corpusInput } from "../helpers/x-analysis";

it("accounts for 10,000 posts across 20 creators exceeding 4 MB, including early/late contradictions and quiet voices", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "scope-analysis-benchmark-"));
  const db = new Database(path.join(directory, "benchmark.sqlite"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  runMigrations(db, ALL_MIGRATIONS);
  const engine = new ResearchAnalysisEngine({
    database: () => db,
    resolve: execution,
    runner: runnerDeps,
    autoRun: false,
  });
  try {
    const ids = Array.from({ length: 20 }, (_, n) => addXCreator(db, `fixture${n}`));
    let textBytes = 0;
    const seedStart = performance.now();
    db.transaction(() => {
      for (let n = 0; n < 20; n++) {
        // Two quiet creators and eighteen prolific ones: still exactly 10,000.
        const count = n < 2 ? 5 : 555;
        for (let p = 0; p < count; p++) {
          const claim =
            p === count - 1
              ? `Creator ${n} bearish if Ethereum fees fall`
              : `Creator ${n} bullish if Ethereum fees rise`;
          const text = `${claim} | ${"Archived fixture text keeps the original source available. ".repeat(12)}`;
          textBytes += Buffer.byteLength(text);
          putPost(db, ids[n], String((n + 1) * 100000 + p), text, {
            publishedAt: `2026-09-${p < count / 2 ? "02" : "29"}T12:00:00Z`,
          });
        }
      }
    })();
    // 2*5 + 18*555 = 10,000.
    expect(textBytes).toBeGreaterThan(4 * 1024 * 1024);
    const seedMs = performance.now() - seedStart,
      start = performance.now();
    const submitted = await engine.start({
      ...corpusInput,
      creatorIds: ids,
      limits: { maxCalls: 5000, maxTokens: 100_000_000 },
    });
    const snapshotMs = performance.now() - start;
    await engine.drain();
    const job = engine.job(submitted.id),
      elapsedMs = performance.now() - start;
    expect(job.scope.total).toBe(10000);
    expect(job.scope.eligible).toBe(10000);
    expect(job.state.status, job.state.reason ?? "").toBe("complete");
    expect(job.progress).toMatchObject({ reviewed: 10000, unfinished: 0, relevant: 10000 });
    expect(job.progress.creators).toHaveLength(20);
    expect(job.progress.creators.every((c) => c.total === c.reviewed)).toBe(true);
    expect(job.state.result!.claims).toHaveLength(40);
    expect(job.state.result!.claims.filter((c) => c.claim.includes("bearish"))).toHaveLength(20);
    expect(
      new Set(
        job.state.result!.claims.flatMap((c) =>
          c.evidence.map((e) => Math.floor(Number(e.postId) / 100000)),
        ),
      ).size,
    ).toBe(20);
    const all = new Set<string>();
    for (let page = 1; page <= 334; page++)
      for (const row of engine.results(job.id, page).posts) all.add(row.post.tweet.id);
    expect(all.size).toBe(10000);
    const batches = batchList(db, job.id);
    const evidence = {
      fixture:
        "deterministic injected AI adapter; measures pipeline capacity, not live model speed or semantic accuracy",
      posts: 10000,
      creators: 20,
      textBytes,
      snapshotBytes: job.scope.bytes,
      seedMs: Math.round(seedMs),
      snapshotMs: Math.round(snapshotMs),
      engineMs: Math.round(elapsedMs),
      calls: job.state.calls,
      batches: batches.length,
      phases: Object.fromEntries(
        ["scan", "reduce", "synthesize", "verify"].map((phase) => [
          phase,
          batches.filter((b) => b.phase === phase).length,
        ]),
      ),
      reviewed: job.progress.reviewed,
      unfinished: job.progress.unfinished,
      related: all.size,
      claims: job.state.result!.claims.length,
      contradictoryCreatorPairs: 20,
      quietCreators: 2,
    };
    console.info("X_ANALYSIS_BENCHMARK", JSON.stringify(evidence));
    if (process.env.SCOPE_ANALYSIS_EVIDENCE_DIR) {
      mkdirSync(process.env.SCOPE_ANALYSIS_EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.SCOPE_ANALYSIS_EVIDENCE_DIR, "benchmark.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    }
  } finally {
    await engine.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 120000);
