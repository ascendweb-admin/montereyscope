import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { ResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { GET, POST } from "@/app/api/x-research/analysis/route";
import { GET as status, POST as control } from "@/app/api/x-research/analysis/[id]/route";
import { execution, runnerDeps, addXCreator, putPost, corpusInput } from "../helpers/x-analysis";
let db: Database.Database, directory: string, engine: ResearchAnalysisEngine;
vi.mock("@/lib/x/research/analysis", async (original) => ({
  ...(await original<typeof import("@/lib/x/research/analysis")>()),
  getResearchAnalysisEngine: () => engine,
}));
function request(body: unknown, overrides: HeadersInit = {}) {
  return new Request("http://localhost/api/x-research/analysis", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "scope-analysis-routes-"));
  db = new Database(path.join(directory, "db.sqlite"));
  db.pragma("foreign_keys=ON");
  runMigrations(db, ALL_MIGRATIONS);
  engine = new ResearchAnalysisEngine({
    database: () => db,
    resolve: execution,
    runner: runnerDeps,
    autoRun: false,
  });
});
afterEach(async () => {
  await engine.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
it("submits, observes local paginated results, inspects immutable evidence and controls jobs", async () => {
  const a = addXCreator(db, "alpha");
  for (let n = 0; n < 45; n++) putPost(db, a, String(100000 + n), "Ethereum claim");
  const submitted = await POST(request({ ...corpusInput, creatorIds: [a], execute: false }));
  expect(submitted.status).toBe(202);
  const { job } = await submitted.json(),
    context = { params: Promise.resolve({ id: job.id }) };
  expect(job.state.status).toBe("paused");
  expect(job.state.estimatedBatches).toBeGreaterThan(0);
  expect((await control(request({ action: "resume" }), context)).status).toBe(200);
  await engine.drain();
  const response = await status(
    new Request(`http://localhost/api/x-research/analysis/${job.id}?page=2&tweetId=100000`),
    context,
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json();
  expect(body.job.state.status).toBe("complete");
  expect(body.results).toMatchObject({ total: 45, page: 2 });
  expect(body.results.posts).toHaveLength(15);
  expect(body.source.tweet.text).toBe("Ethereum claim");
  expect((await GET()).status).toBe(200);
  expect((await control(request({ action: "cancel" }), context)).status).toBe(200);
  const followup = await POST(
    request({ question: "Now compare conditions", scopeId: job.scopeId, execute: false }),
  );
  expect(followup.status).toBe(202);
  expect((await followup.json()).job.scopeId).toBe(job.scopeId);
});
it("rejects cross-origin, oversized, invalid scope and unrecognized controls without side effects", async () => {
  const a = addXCreator(db, "alpha");
  putPost(db, a, "100", "Ethereum claim");
  const input = { ...corpusInput, creatorIds: [a] };
  expect((await POST(request(input, { origin: "https://evil.invalid" }))).status).toBe(403);
  expect((await POST(request(input, { "content-type": "text/plain" }))).status).toBe(415);
  expect((await POST(request({ padding: "x".repeat(9000) }))).status).toBe(413);
  for (const override of [
    { question: "" },
    { strategy: "focused" },
    { creatorIds: [999] },
    { types: ["bad"] },
    { scopeId: "missing" },
    { limits: { maxCalls: 0 } },
  ])
    expect((await POST(request({ ...input, ...override }))).status).toBeGreaterThanOrEqual(400);
  expect(db.prepare("SELECT COUNT(*) AS n FROM x_analysis_jobs").get()).toEqual({ n: 0 });
  const context = { params: Promise.resolve({ id: "missing" }) };
  expect((await control(request({ action: "delete" }), context)).status).toBe(400);
  expect(
    (await status(new Request("http://localhost/api/x-research/analysis/missing"), context)).status,
  ).toBe(404);
  expect(db.prepare("SELECT COUNT(*) AS n FROM x_retrieval_jobs").get()).toEqual({ n: 0 });
});

it("maps branded validation errors across separately bundled module graphs", async () => {
  const { researchError } = await import("@/lib/x/research/http");
  const error = Object.assign(new Error("Choose a question."), {
    status: 400,
    [Symbol.for("scope.x.research.input-error.v1")]: true,
  });
  expect(researchError(error).status).toBe(400);
  expect(await researchError(error).json()).toEqual({ error: "Choose a question." });
  expect(researchError(new Error("private failure")).status).toBe(500);
});
