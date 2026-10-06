import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { ResearchAnalysisEngine } from "@/lib/x/research/analysis";
import {
  startResearchConversation,
  conversationForJob,
  researchReportHtml,
  saveResearchReport,
} from "@/lib/x/research/experience";
import { listMessages, deleteThread } from "@/lib/ai/threads";
import { publicReportFor } from "@/lib/ai/reports";
import { POST as chat } from "@/app/api/ai/chat/route";
import { POST as reports } from "@/app/api/ai/reports/route";
import { GET as reportFile } from "@/app/api/ai/reports/[id]/file/route";
import {
  addXCreator,
  putPost,
  corpusInput,
  execution,
  runnerDeps,
  fakeRunner,
  fixtureOutput,
} from "../helpers/x-analysis";
let db: Database.Database, engine: ResearchAnalysisEngine;
vi.mock("@/lib/db/connection", async (original) => ({
  ...(await original<typeof import("@/lib/db/connection")>()),
  getDb: () => db,
}));
vi.mock("@/lib/x/research/analysis", async (original) => ({
  ...(await original<typeof import("@/lib/x/research/analysis")>()),
  getResearchAnalysisEngine: () => engine,
}));
beforeEach(() => {
  db = new Database(":memory:");
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
});
function request(body: unknown, origin = "http://localhost") {
  return new Request("http://localhost/api/ai/chat", {
    method: "POST",
    headers: { host: "localhost", origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
it("retains a full >25-post corpus for coherent follow-ups, immutable reports and deleted library/thread records", async () => {
  const creator = addXCreator(db, "alpha");
  for (let n = 0; n < 45; n++) putPost(db, creator, String(100000 + n), "Ethereum claim");
  const first = await startResearchConversation(db, engine, {
    ...corpusInput,
    creatorIds: [creator],
  });
  await engine.drain();
  const job = engine.job(first.job.id);
  expect(job.state.status).toBe("complete");
  expect(job.state.result!.claims.flatMap((c) => c.evidence)).toHaveLength(1);
  expect(listMessages(db, first.threadId).map((m) => m.role)).toEqual(["user", "assistant"]);
  engine.resume(job.id);
  await engine.drain();
  expect(listMessages(db, first.threadId)).toHaveLength(2);
  const report = saveResearchReport(db, job.id);
  expect(saveResearchReport(db, job.id).id).toBe(report.id);
  expect(publicReportFor(db, report)).toMatchObject({
    sourceCount: 45,
    fileUrl: `/api/ai/reports/${report.id}/file`,
  });
  putPost(db, creator, "100000", "CHANGED mutable archive");
  putPost(db, creator, "100045", "Newly cached claim");
  const response = await chat(
    request({
      threadId: first.threadId,
      message: "How do their conditions differ?",
      mode: "quick",
    }),
  );
  expect(response.status).toBe(202);
  const second = await response.json();
  await engine.drain();
  expect(second.job.scopeId).toBe(job.scopeId);
  expect(second.job.scope.total).toBe(45);
  expect(second.job.config.conversation).toMatchObject({
    question: job.config.question,
    answer: job.state.result!.text,
  });
  expect(engine.source(second.job.id, "100000").tweet.text).toBe("Ethereum claim");
  expect(conversationForJob(db, job.id)?.turns).toHaveLength(2);
  const saved = await reports(request({ threadId: first.threadId }));
  expect(saved.status).toBe(202);
  expect((await saved.json()).report.sourceCount).toBe(45);
  const htmlBefore = researchReportHtml(db, report.id)!;
  expect(htmlBefore.match(/<details id="post-/g) || []).toHaveLength(45);
  expect(htmlBefore).not.toContain("CHANGED");
  db.prepare("DELETE FROM creators WHERE id=?").run(creator);
  deleteThread(db, first.threadId);
  expect(researchReportHtml(db, report.id)).toBe(htmlBefore);
  const file = await reportFile(new Request("http://localhost"), {
    params: Promise.resolve({ id: String(report.id) }),
  });
  expect(file.status).toBe(200);
  expect(await file.text()).toBe(htmlBefore);
  expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");
});
it("routes a >4 MB corpus through engine estimates for chat and Reports without materialization or sampling", async () => {
  await engine.close();
  engine = new ResearchAnalysisEngine({
    database: () => db,
    resolve: execution,
    autoRun: false,
    runner: async () =>
      fakeRunner((options) => {
        const output = JSON.parse(fixtureOutput(options));
        if (output.posts)
          for (const post of output.posts)
            for (const finding of post.findings) finding.claim = "Deterministic corpus argument";
        return JSON.stringify(output);
      }),
  });
  const creator = addXCreator(db, "large");
  for (let n = 0; n < 45; n++)
    putPost(
      db,
      creator,
      String(200000 + n),
      "Ethereum claim | " + "long original context ".repeat(5000),
    );
  const first = await startResearchConversation(db, engine, {
    ...corpusInput,
    creatorIds: [creator],
    execute: false,
    limits: { maxCalls: 5000, maxTokens: 100000000 },
  });
  expect(first.job.scope.bytes).toBeGreaterThan(4_000_000);
  const follow = await startResearchConversation(db, engine, {
    threadId: first.threadId,
    question: "And their BTC arguments?",
    execute: false,
  });
  expect(follow.job.scope.total).toBe(45);
  expect(follow.job.scopeId).toBe(first.job.scopeId);
  expect(follow.job.progress.unfinished).toBe(45);
  expect(follow.job.state.estimatedBatches).toBeGreaterThan(45);
  engine.resume(first.job.id);
  await engine.drain();
  expect(
    engine.job(first.job.id).state.status,
    JSON.stringify(engine.job(first.job.id).state),
  ).toBe("complete");
  const report = saveResearchReport(db, first.job.id);
  expect(researchReportHtml(db, report.id)!.length).toBeGreaterThan(4_000_000);
  expect(publicReportFor(db, report).sourceCount).toBe(45);
  expect(db.prepare("SELECT COUNT(*) AS n FROM x_retrieval_jobs").get()).toEqual({ n: 0 });
}, 30_000);
it("refuses unverified reports, mismatched scopes, foreign turns and ambiguous legacy selections", async () => {
  const creator = addXCreator(db, "alpha");
  putPost(db, creator, "123", "Ethereum <script>alert(1)</script>");
  const first = await startResearchConversation(db, engine, {
    ...corpusInput,
    creatorIds: [creator],
    execute: false,
  });
  expect(() => saveResearchReport(db, first.job.id)).toThrow("Finish and verify");
  await expect(
    startResearchConversation(db, engine, {
      threadId: first.threadId,
      scopeId: "foreign",
      question: "Why?",
      execute: false,
    }),
  ).rejects.toThrow("new revision");
  await expect(
    startResearchConversation(db, engine, {
      threadId: first.threadId,
      parentJobId: "foreign",
      question: "Why?",
      execute: false,
    }),
  ).rejects.toThrow("previous turn");
  expect(
    (
      await chat(
        request({
          threadId: first.threadId,
          message: "Why?",
          sources: [{ kind: "tweet", id: "123" }],
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (await reports(request({ researchJobId: first.job.id, threadId: first.threadId }))).status,
  ).toBe(400);
  expect(
    (await reports(request({ researchJobId: first.job.id }, "https://evil.test"))).status,
  ).toBe(403);
  engine.resume(first.job.id);
  await engine.drain();
  const report = saveResearchReport(db, first.job.id);
  const html = researchReportHtml(db, report.id)!;
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});

it("serializes conversation execution and rejects scope changes or invalid execution flags before writes", async () => {
  const creator = addXCreator(db, "alpha");
  putPost(db, creator, "123", "Ethereum claim");
  const first = await startResearchConversation(db, engine, {
    ...corpusInput,
    creatorIds: [creator],
    execute: false,
  });
  const second = await startResearchConversation(db, engine, {
    threadId: first.threadId,
    question: "Why?",
    execute: false,
  });
  engine.resume(first.job.id);
  expect(() => engine.resume(second.job.id)).toThrow("active conversation turn");
  await expect(
    startResearchConversation(db, engine, {
      threadId: first.threadId,
      question: "Next?",
      execute: false,
    }),
  ).rejects.toThrow("active turn");
  engine.cancel(first.job.id);
  engine.resume(second.job.id);
  await engine.drain();
  expect(engine.job(second.job.id).state.status).toBe("complete");
  const before = (db.prepare("SELECT COUNT(*) AS n FROM x_analysis_jobs").get() as { n: number }).n;
  await expect(
    startResearchConversation(db, engine, {
      scopeId: first.job.scopeId,
      question: "Why?",
      creatorIds: [creator],
    }),
  ).rejects.toThrow("new revision");
  await expect(
    startResearchConversation(db, engine, {
      ...corpusInput,
      creatorIds: [creator],
      execute: "yes",
    }),
  ).rejects.toThrow("execute");
  expect((db.prepare("SELECT COUNT(*) AS n FROM x_analysis_jobs").get() as { n: number }).n).toBe(
    before,
  );
});

it("bounds prior-turn context explicitly while preserving the full immutable corpus", async () => {
  const creator = addXCreator(db, "alpha");
  putPost(db, creator, "123", "Ethereum claim");
  const first = await startResearchConversation(db, engine, {
    ...corpusInput,
    creatorIds: [creator],
    execute: false,
  });
  const state = {
    ...first.job.state,
    status: "complete",
    result: {
      text: "Long prior answer ".repeat(3000),
      claims: [],
      scopeNote: "fixture",
      verified: true,
    },
  };
  db.prepare("UPDATE x_analysis_jobs SET state_json=? WHERE id=?").run(
    JSON.stringify(state),
    first.job.id,
  );
  const next = await startResearchConversation(db, engine, {
    threadId: first.threadId,
    question: "Explain that.",
    execute: false,
  });
  expect(next.job.config.conversation?.abridged).toBe(true);
  expect(next.job.config.conversation?.answer!.length).toBeLessThan(4000);
  expect(next.job.scopeId).toBe(first.job.scopeId);
  expect(engine.source(next.job.id, "123").tweet.text).toBe("Ethereum claim");
});
