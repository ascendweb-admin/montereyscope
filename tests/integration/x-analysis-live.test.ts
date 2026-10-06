import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { createAiRunner } from "@/lib/ai/backend";
import { ResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { addXCreator, corpusInput, putPost } from "../helpers/x-analysis";

/** Small fictional corpus only. Opt-in consumes the locally connected provider's
 * quota, never reads X or the user's archive, and stores no credentials. */
it.skipIf(process.env.SCOPE_X_ANALYSIS_LIVE !== "1")(
  "evaluates indirect/ambiguous Ethereum references, sarcasm, contradictions and quoted attribution using the real backend",
  async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "scope-analysis-live-"));
    const db = new Database(path.join(directory, "live.sqlite"));
    db.pragma("foreign_keys=ON");
    runMigrations(db, ALL_MIGRATIONS);
    const outputs: Array<{ phase: string; wire: string }> = [];
    const engine = new ResearchAnalysisEngine({
      database: () => db,
      autoRun: false,
      runner: async (config) => {
        const runner = await createAiRunner(config.backend);
        return (options) => {
          const run = runner(options);
          return {
            events: run.events,
            completed: run.completed.then((result) => {
              outputs.push({
                phase: options.prompt.includes("Check each proposed")
                  ? "verify"
                  : options.prompt.includes("Full scan:")
                    ? "scan"
                    : options.prompt.includes("Reduce the supplied")
                      ? "reduce"
                      : "synthesize",
                wire: result.finalMessage,
              });
              return result;
            }),
          };
        };
      },
    });
    const fixtures = JSON.parse(
      readFileSync(path.join(process.cwd(), "tests/fixtures/x-analysis-relevance.json"), "utf8"),
    ) as Array<{
      id: string;
      text: string;
      quote?: string;
      expected: string;
      quoteOnly?: boolean;
      sarcasm?: boolean;
    }>;
    try {
      const a = addXCreator(db, "fictional-analyst");
      for (const row of fixtures)
        putPost(
          db,
          a,
          row.id,
          row.text,
          row.quote
            ? { quoted: { tweetId: "999", text: row.quote, handle: "fictional-quoted-speaker" } }
            : {},
        );
      // A date outside the requested window must never enter analysis.
      putPost(db, a, "100014", "ETH out-of-scope forecast", {
        publishedAt: "2026-10-01T12:00:00Z",
      });
      const submitted = await engine.start({
        ...corpusInput,
        creatorIds: [a],
        backend: "codex",
        mode: "quick",
        model: process.env.SCOPE_X_ANALYSIS_MODEL ?? "gpt-5.6-luna",
        reasoningEffort: "low",
        question:
          "Find the Ethereum/ETH investment and monetary theses in these posts. Include relevant quoted discourse while distinguishing the creator's position from quoted speakers. Compare reasons, conditions, time horizon, disagreements and changed views. Generic settlement or fee comments that do not identify Ethereum are uncertain. Do not use outside market facts; the corpus cannot establish a price target or compare assets beyond what the posts actually say.",
        limits: { maxCalls: 30, maxTokens: 400000, maxRunMs: 600000, timeoutMs: 180000 },
      });
      await engine.drain();
      const job = engine.job(submitted.id),
        rows = engine.results(job.id, 1, "all").posts;
      const scored = fixtures.map((fixture) => {
        const actual = rows.find((r) => r.post.tweet.id === fixture.id)!.analysis;
        const correct =
          fixture.expected === "relevant_or_uncertain"
            ? ["relevant", "uncertain"].includes(actual?.disposition ?? "")
            : actual?.disposition === fixture.expected;
        return { ...fixture, actual, correct };
      });
      const positive = scored.filter((s) => s.expected === "relevant");
      const truePositive = positive.filter((s) => s.actual?.disposition === "relevant").length;
      const predictedPositive = scored.filter(
        (s) => s.actual?.disposition === "relevant" && s.expected !== "relevant_or_uncertain",
      ).length;
      const metrics = {
        precision: truePositive / Math.max(1, predictedPositive),
        recall: truePositive / positive.length,
        accuracy: scored.filter((s) => s.correct).length / scored.length,
      };
      const evidence = {
        backend: job.config.backend,
        model: job.config.model,
        question: job.config.question,
        status: job.state.status,
        reason: job.state.reason,
        calls: job.state.calls,
        usage: {
          reportedTokens: job.state.reportedTokens,
          reportedCalls: job.state.usageReportedCalls,
        },
        progress: job.progress,
        metrics,
        fixtures: scored,
        outputs,
        answer: job.state.result,
      };
      if (process.env.SCOPE_ANALYSIS_EVIDENCE_DIR) {
        mkdirSync(process.env.SCOPE_ANALYSIS_EVIDENCE_DIR, { recursive: true });
        writeFileSync(
          path.join(process.env.SCOPE_ANALYSIS_EVIDENCE_DIR, "live-relevance.json"),
          JSON.stringify(evidence, null, 2) + "\n",
        );
      }
      console.info(
        "X_ANALYSIS_LIVE",
        JSON.stringify({
          status: job.state.status,
          reason: job.state.reason,
          calls: job.state.calls,
          metrics,
        }),
      );
      expect(job.state.status, job.state.reason ?? "").toBe("complete");
      expect(job.progress.reviewed).toBe(13);
      expect(rows.some((r) => r.post.tweet.id === "100014")).toBe(false);
      expect(metrics.precision).toBeGreaterThanOrEqual(0.85);
      expect(metrics.recall).toBeGreaterThanOrEqual(0.85);
      expect(scored.find((s) => s.id === "100004")!.actual?.disposition).toBe("relevant");
      expect(scored.find((s) => s.id === "100007")!.actual?.disposition).toBe("not_relevant");
      expect(scored.find((s) => s.id === "100013")!.actual?.disposition).toBe("not_relevant");
      expect(
        scored
          .find((s) => s.quoteOnly)!
          .actual?.findings.every((f) => f.evidence.every((e) => e.attribution === "quoted")),
      ).toBe(true);
    } finally {
      await engine.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  660000,
);
