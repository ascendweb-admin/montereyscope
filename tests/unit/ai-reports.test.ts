import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  CodexChildProcess,
  CodexExitStatus,
  CodexSpawnRequest,
  CodexSpawner,
} from "@/lib/ai/codex";
import {
  buildReportPrompt,
  canTransitionReport,
  createReport,
  createReportQueue,
  findReportFile,
  getReport,
  listReports,
  recoverStalledReports,
  REPORT_FILE_NAME,
  REPORT_INSTRUCTION,
  resolveReportExecution,
  RESTARTED_WHILE_RUNNING_ERROR,
  ReportStateError,
  transitionReport,
  type AiReport,
} from "@/lib/ai/reports";
import { getReportProfile } from "@/lib/ai/report-profiles";
import { getReportStyle, REPORT_STYLES } from "@/lib/ai/report-styles";
import type { ClaudeRunOptions } from "@/lib/ai/claude";
import type { CodexRun } from "@/lib/ai/codex";
import { setAiBackend } from "@/lib/settings/settings";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

/**
 * Report queue, job state machine, and job runner tests (stage 6). The Codex
 * boundary is mocked at the spawner seam — the fake child records its argv
 * and stdin, optionally drops an HTML deliverable into the working directory
 * the way the real CLI is instructed to, and replays fixture JSONL — so the
 * real runCodex adapter, the real materializer, and the real queue all run.
 */

const VIDEO_ONE = "reportvid01";
const VIDEO_TWO = "reportvid02";
const VIDEO_NO_TRANSCRIPT = "nocaption01";
const UNKNOWN_VIDEO = "ghost000001";

const DELIVERABLE_HTML =
  '<!doctype html><html lang="en"><head><title>Report</title></head><body><h1>Report</h1></body></html>';

// ---------------------------------------------------------------------------
// Fake child process and spawner harness
// ---------------------------------------------------------------------------

interface ChildSpec {
  /** JSONL lines emitted on stdout, in order. */
  lines?: string[];
  stderr?: string;
  /** Exit status when the child exits; defaults to success. */
  exit?: CodexExitStatus;
  /** Keep the child running until finish() is called (queue serialization). */
  stayOpen?: boolean;
  /**
   * File name the "codex" run drops into its working directory at spawn time
   * (the deliverable the prompt asks for). Defaults to report.html; null
   * disables the write entirely.
   */
  deliverable?: string | null;
}

const SUCCESS_LINES = [
  JSON.stringify({ type: "thread.started", thread_id: "session-report" }),
  JSON.stringify({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "Report written." },
  }),
  JSON.stringify({ type: "turn.completed", usage: { total_tokens: 42 } }),
];

class FakeCodexChild implements CodexChildProcess {
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  readonly killCalls: string[] = [];

  private readonly queuedLines: string[];
  private readonly lineWaiters: Array<() => void> = [];
  private readonly exitWaiters: Array<(status: CodexExitStatus) => void> = [];
  private closed = false;
  private exitInfo: CodexExitStatus;

  constructor(
    private readonly spec: ChildSpec,
    private readonly onClosed?: () => void,
  ) {
    this.queuedLines = [...(spec.lines ?? SUCCESS_LINES)];
    this.exitInfo = spec.exit ?? { exitCode: 0, signal: null };
  }

  /** Ends the child with a normal exit status (releases held-open runs). */
  finish(exit: CodexExitStatus = { exitCode: 0, signal: null }): void {
    this.exitInfo = exit;
    this.close();
  }

  private close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    // Wake a stdout iterator parked on an empty queue so it can unwind.
    for (const waiter of this.lineWaiters.splice(0)) {
      waiter();
    }
    for (const waiter of this.exitWaiters.splice(0)) {
      waiter(this.exitInfo);
    }
    this.onClosed?.();
  }

  readonly stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
    },
    end: () => {
      this.stdinEnded = true;
    },
  };

  readonly stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]: (): AsyncGenerator<string> => this.iterateStdout(),
  };

  readonly stderr: AsyncIterable<string> = {
    [Symbol.asyncIterator]: (): AsyncGenerator<string> => this.iterateStderr(),
  };

  private async *iterateStdout(): AsyncGenerator<string> {
    try {
      for (;;) {
        if (this.queuedLines.length > 0) {
          yield this.queuedLines.shift() as string;
          continue;
        }
        if (this.closed || !this.spec.stayOpen) {
          return;
        }
        await new Promise<void>((resolve) => this.lineWaiters.push(resolve));
      }
    } finally {
      // A naturally drained stdout means the process exited, like the real
      // CLI; only a held-open child stays alive until finish()/kill().
      if (!this.spec.stayOpen && !this.closed) {
        this.close();
      }
    }
  }

  private async *iterateStderr(): AsyncGenerator<string> {
    if (this.spec.stderr) {
      yield this.spec.stderr;
    }
  }

  wait(): Promise<CodexExitStatus> {
    if (this.closed) {
      return Promise.resolve(this.exitInfo);
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? "SIGTERM");
    this.close();
  }
}

interface SpawnRecord {
  request: CodexSpawnRequest;
  child: FakeCodexChild;
}

/** Spawner harness: records requests, tracks concurrency, writes deliverables. */
class FakeCodexHarness {
  readonly spawns: SpawnRecord[] = [];
  active = 0;
  maxActive = 0;

  constructor(
    /** One spec per spawn, in order; the last spec repeats. */
    private readonly specs: ChildSpec[],
  ) {}

  readonly spawner: CodexSpawner = (request: CodexSpawnRequest): CodexChildProcess => {
    const spec =
      this.spawns.length < this.specs.length
        ? this.specs[this.spawns.length]
        : this.specs[this.specs.length - 1];
    // Unset means the default deliverable; null explicitly disables the write.
    const deliverable = spec.deliverable === undefined ? REPORT_FILE_NAME : spec.deliverable;
    if (deliverable !== null) {
      mkdirSync(request.cwd, { recursive: true });
      writeFileSync(path.join(request.cwd, deliverable), DELIVERABLE_HTML, "utf8");
    }
    const child = new FakeCodexChild(spec, () => {
      this.active -= 1;
    });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.spawns.push({ request, child });
    return child;
  };

  promptOf(index: number): string {
    const record = this.spawns[index];
    if (!record) {
      throw new Error(`no spawn #${index}`);
    }
    return record.child.stdinWrites.join("");
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let db: Database.Database;
let dir: string;
let jobsRoot: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "localtube-ai-reports-"));
  jobsRoot = path.join(dir, "ai-jobs");
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
  seedFeed();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function seedFeed(): void {
  db.prepare(
    "INSERT INTO creators (id, display_name, channel_url) VALUES (1, 'Sample Creator', 'https://example.invalid/c')",
  ).run();
  const insertVideo = db.prepare(
    "INSERT INTO videos (id, creator_id, title, url) VALUES (?, 1, ?, ?)",
  );
  const insertTranscript = db.prepare(
    "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, 'en', 'manual', ?)",
  );
  for (const videoId of [VIDEO_ONE, VIDEO_TWO, VIDEO_NO_TRANSCRIPT]) {
    insertVideo.run(videoId, `Video ${videoId}`, `https://www.youtube.com/watch?v=${videoId}`);
  }
  insertTranscript.run(VIDEO_ONE, `Transcript body for ${VIDEO_ONE}.`);
  insertTranscript.run(VIDEO_TWO, `Transcript body for ${VIDEO_TWO}.`);
}

/** Polls until the report reaches one of the wanted statuses. */
async function waitForStatus(
  reportId: number,
  statuses: readonly AiReport["status"][],
  timeoutMs = 10_000,
): Promise<AiReport> {
  const deadline = Date.now() + timeoutMs;
  let last: AiReport | null = null;
  for (;;) {
    last = getReport(db, reportId);
    if (last && statuses.includes(last.status)) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `report ${reportId} never reached ${statuses.join("|")}; last status: ${last?.status ?? "none"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe("report state machine", () => {
  it("allows exactly the queued → running → done|failed path", () => {
    const legal: Array<[AiReport["status"], AiReport["status"]]> = [
      ["queued", "running"],
      ["running", "done"],
      ["running", "failed"],
    ];
    for (const from of ["queued", "running", "done", "failed"] as const) {
      for (const to of ["queued", "running", "done", "failed"] as const) {
        expect(canTransitionReport(from, to)).toBe(legal.some(([f, t]) => f === from && t === to));
      }
    }
  });

  it("applies transitions, registers the file, and stamps completed_at", () => {
    const report = createReport(db, [VIDEO_ONE]);

    const running = transitionReport(db, report.id, "running");
    expect(running.status).toBe("running");
    expect(running.completedAt).toBeNull();

    const done = transitionReport(db, report.id, "done", { filePath: "/jobs/x/report.html" });
    expect(done.status).toBe("done");
    expect(done.filePath).toBe("/jobs/x/report.html");
    expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("carries the failure message on the failed transition", () => {
    const report = createReport(db, [VIDEO_ONE]);
    transitionReport(db, report.id, "running");
    const failed = transitionReport(db, report.id, "failed", { error: "Codex hit a limit." });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Codex hit a limit.");
    expect(failed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("refuses every illegal transition", () => {
    const skipped = createReport(db, [VIDEO_ONE]);
    expect(() => transitionReport(db, skipped.id, "done", { filePath: "/x" })).toThrow(
      ReportStateError,
    );

    const terminal = createReport(db, [VIDEO_ONE]);
    transitionReport(db, terminal.id, "running");
    transitionReport(db, terminal.id, "done", { filePath: "/x" });
    expect(() => transitionReport(db, terminal.id, "failed", { error: "again" })).toThrow(
      ReportStateError,
    );
    expect(() => transitionReport(db, terminal.id, "running")).toThrow(ReportStateError);

    const failedRow = createReport(db, [VIDEO_ONE]);
    transitionReport(db, failedRow.id, "running");
    transitionReport(db, failedRow.id, "failed", { error: "boom" });
    expect(() => transitionReport(db, failedRow.id, "running")).toThrow(ReportStateError);
  });
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

describe("report repository", () => {
  it("stores the scope as JSON and reads it back in request order", () => {
    const report = createReport(db, [VIDEO_TWO, VIDEO_ONE]);
    expect(report.status).toBe("queued");
    expect(report.videoIds).toEqual([VIDEO_TWO, VIDEO_ONE]);
    expect(report.filePath).toBeNull();
    expect(report.error).toBeNull();
    expect(report.completedAt).toBeNull();
    expect(getReport(db, report.id)?.videoIds).toEqual([VIDEO_TWO, VIDEO_ONE]);
  });

  it("defaults to the balanced profile and the editorial style", () => {
    const report = createReport(db, [VIDEO_ONE]);
    expect(report.profile).toBe("balanced");
    expect(report.style).toBe("editorial");
    expect(getReport(db, report.id)?.profile).toBe("balanced");
    expect(getReport(db, report.id)?.style).toBe("editorial");
  });

  it("persists the requested profile and style", () => {
    const report = createReport(db, [VIDEO_ONE], { profile: "brief", style: "terminal" });
    expect(report.profile).toBe("brief");
    expect(report.style).toBe("terminal");
    expect(getReport(db, report.id)).toMatchObject({ profile: "brief", style: "terminal" });

    const other = createReport(db, [VIDEO_TWO], { profile: "deep", style: "swiss" });
    expect(getReport(db, other.id)).toMatchObject({ profile: "deep", style: "swiss" });
  });

  it("returns null for unknown ids and lists newest first", () => {
    expect(getReport(db, 999)).toBeNull();
    const first = createReport(db, [VIDEO_ONE]);
    const second = createReport(db, [VIDEO_TWO]);
    expect(listReports(db).map((report) => report.id)).toEqual([second.id, first.id]);
  });
});

// ---------------------------------------------------------------------------
// Prompt template and deliverable detection
// ---------------------------------------------------------------------------

describe("report prompt template", () => {
  it("asks for one self-contained designed document", () => {
    const prompt = buildReportPrompt({ fileCount: 4, profile: "balanced", style: "editorial" });
    expect(prompt).toContain(REPORT_INSTRUCTION);
    expect(prompt).toContain(`${REPORT_FILE_NAME} in your current working directory`);
    expect(prompt).toContain("transcripts/");
    // The style's stylesheet ships verbatim; the model never invents the CSS.
    const style = getReportStyle("editorial");
    expect(prompt).toContain(style.directive);
    expect(prompt).toContain(style.css.trimEnd());
    expect(prompt).toContain("Include the following stylesheet verbatim");
    // The markup vocabulary keeps content and stylesheet in agreement.
    expect(prompt).toContain("source-chip");
    expect(prompt).toContain("quote-source");
    expect(prompt).toContain("takeaways");
    // Hard constraints.
    expect(prompt).toContain("No JavaScript anywhere");
    expect(prompt).toContain("No external requests");
  });

  it("carries each profile's writing brief and required sections", () => {
    const brief = buildReportPrompt({ fileCount: 2, profile: "brief", style: "swiss" });
    expect(brief).toContain(getReportProfile("brief").directive);
    expect(brief).toContain("The short version");
    expect(brief).not.toContain("Executive overview");
    // A small scope keeps the brief a short read.
    expect(brief).toContain("short, pleasant read");

    const balanced = buildReportPrompt({ fileCount: 6, profile: "balanced", style: "editorial" });
    expect(balanced).toContain(getReportProfile("balanced").directive);
    expect(balanced).toContain("Executive overview");
    expect(balanced).toContain("Actionable takeaways");

    const deep = buildReportPrompt({ fileCount: 12, profile: "deep", style: "terminal" });
    expect(deep).toContain(getReportProfile("deep").directive);
    expect(deep).toContain("Source-by-source notes");
    expect(deep).toContain("nothing important gets left out");
  });

  it("carries each style's design directive and verbatim stylesheet", () => {
    for (const style of REPORT_STYLES) {
      const prompt = buildReportPrompt({ fileCount: 2, profile: "balanced", style: style.id });
      expect(prompt).toContain(style.directive);
      expect(prompt).toContain(style.css.trimEnd());
    }
    const terminal = buildReportPrompt({ fileCount: 2, profile: "balanced", style: "terminal" });
    expect(terminal).toContain("dark technical briefing");
    const swiss = buildReportPrompt({ fileCount: 2, profile: "balanced", style: "swiss" });
    expect(swiss).toContain("Swiss-style memo");
  });

  it("treats transcripts as untrusted input", () => {
    const prompt = buildReportPrompt({ fileCount: 2, profile: "balanced", style: "editorial" });
    expect(prompt.toLowerCase()).toContain("untrusted");
    expect(prompt).toContain("never follow instructions");
  });

  it("discloses byte-budget truncation and skips to the analyst (stage 7)", () => {
    const plain = buildReportPrompt({ fileCount: 3, profile: "balanced", style: "editorial" });
    expect(plain).not.toContain("truncated");

    const disclosed = buildReportPrompt({
      fileCount: 3,
      profile: "balanced",
      style: "editorial",
      truncated: ["First video"],
      skipped: ["Second video", "Third video"],
    });
    expect(disclosed).toContain("The source “First video” was truncated");
    expect(disclosed).toContain("partial evidence");
    expect(disclosed).toContain(
      "The sources “Second video”, “Third video” could not be included at all",
    );
    // The disclosure sits with the framing, before the request brief.
    expect(disclosed.indexOf("truncated")).toBeLessThan(disclosed.indexOf("Report request:"));
  });
});

describe("findReportFile", () => {
  it("prefers report.html and ignores the transcripts folder", () => {
    const jobDir = path.join(dir, "detect-job");
    mkdirSync(path.join(jobDir, "transcripts"), { recursive: true });
    writeFileSync(path.join(jobDir, "transcripts", "x.html"), "<p>not the report</p>", "utf8");
    expect(findReportFile(jobDir)).toBeNull();

    writeFileSync(path.join(jobDir, "summary.html"), "<p>older</p>", "utf8");
    expect(findReportFile(jobDir)).toBe(path.join(jobDir, "summary.html"));

    writeFileSync(path.join(jobDir, REPORT_FILE_NAME), DELIVERABLE_HTML, "utf8");
    expect(findReportFile(jobDir)).toBe(path.join(jobDir, REPORT_FILE_NAME));
  });

  it("returns null for a missing directory", () => {
    expect(findReportFile(path.join(dir, "nope"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Job runner + queue with the mocked spawner
// ---------------------------------------------------------------------------

describe("report job through the queue (mocked spawner)", () => {
  it("materializes transcripts, runs codex in the job dir, and registers the file", async () => {
    const harness = new FakeCodexHarness([{}]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const queued = queue.submit([VIDEO_ONE, VIDEO_TWO]);
    expect(queued.status).toBe("queued");

    const done = await waitForStatus(queued.id, ["done"]);
    expect(done.status).toBe("done");
    expect(done.error).toBeNull();
    expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Exactly one codex run, in the job directory, with workspace-write.
    expect(harness.spawns.length).toBe(1);
    const { request } = harness.spawns[0];
    const jobDir = request.cwd;
    expect(jobDir.startsWith(jobsRoot)).toBe(true);
    expect(request.args).toEqual([
      "exec",
      "--json",
      "-m",
      expect.any(String),
      "-c",
      expect.any(String),
      "-s",
      "workspace-write",
      "-C",
      jobDir,
      "--skip-git-repo-check",
      "-",
    ]);

    // The job dir holds the materialized transcripts and the manifest.
    const entries = readdirSync(jobDir);
    expect(entries).toContain("manifest.json");
    expect(entries).toContain("transcripts");
    expect(existsSync(path.join(jobDir, "transcripts", `${VIDEO_ONE}.txt`))).toBe(true);
    expect(existsSync(path.join(jobDir, "transcripts", `${VIDEO_TWO}.txt`))).toBe(true);

    // The prompt frames the analyst, the layout, and the deliverable.
    const prompt = harness.promptOf(0);
    expect(prompt).toContain(REPORT_INSTRUCTION);
    expect(prompt).toContain("2 source files");
    expect(prompt).toContain(REPORT_FILE_NAME);

    // The produced file is registered by absolute path.
    expect(done.filePath).toBe(path.join(jobDir, REPORT_FILE_NAME));
  });

  it("runs each profile with its own model, effort, and writing brief", async () => {
    const harness = new FakeCodexHarness([{}, {}]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const brief = queue.submit([VIDEO_ONE], { profile: "brief", style: "terminal" });
    await waitForStatus(brief.id, ["done"]);
    const deep = queue.submit([VIDEO_TWO], { profile: "deep", style: "swiss" });
    await waitForStatus(deep.id, ["done"]);

    const modelArg = (args: readonly string[]): string => args[args.indexOf("-m") + 1] as string;
    const effortArg = (args: readonly string[]): string | undefined =>
      args.find((arg) => arg.startsWith("model_reasoning_effort="))?.split('"')[1];

    // Brief runs the fast model at low reasoning with the brief directive...
    expect(modelArg(harness.spawns[0].request.args)).toBe("gpt-5.6-luna");
    expect(effortArg(harness.spawns[0].request.args)).toBe("low");
    expect(harness.promptOf(0)).toContain(getReportProfile("brief").directive);
    expect(harness.promptOf(0)).toContain(getReportStyle("terminal").css.trimEnd());
    // ...and deep runs the flagship at xhigh with its own brief.
    expect(modelArg(harness.spawns[1].request.args)).toBe("gpt-5.6-sol");
    expect(effortArg(harness.spawns[1].request.args)).toBe("xhigh");
    expect(harness.promptOf(1)).toContain(getReportProfile("deep").directive);
    expect(harness.promptOf(1)).toContain(getReportStyle("swiss").css.trimEnd());
  });

  it("fails without spawning when nothing can be materialized", async () => {
    const harness = new FakeCodexHarness([{}]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const queued = queue.submit([VIDEO_NO_TRANSCRIPT, UNKNOWN_VIDEO]);
    const failed = await waitForStatus(queued.id, ["failed"]);

    expect(failed.error).toBe("None of the selected sources has cached content yet.");
    expect(failed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(harness.spawns.length).toBe(0);
  });

  it("maps codex failures to a client-safe error", async () => {
    const harness = new FakeCodexHarness([
      { exit: { exitCode: 1, signal: null }, stderr: "Error: usage limit reached for plan" },
    ]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const queued = queue.submit([VIDEO_ONE]);
    const failed = await waitForStatus(queued.id, ["failed"]);

    expect(failed.error).toBe(
      "The AI backend hit a usage or rate limit. Wait a bit and try again.",
    );
    expect(failed.filePath).toBeNull();
    expect(failed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("fails when codex finishes without writing a deliverable", async () => {
    const harness = new FakeCodexHarness([{ deliverable: null }]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const queued = queue.submit([VIDEO_ONE]);
    const failed = await waitForStatus(queued.id, ["failed"]);

    expect(failed.error).toBe("The AI run finished but did not write a report file.");
    expect(failed.filePath).toBeNull();
  });

  it("runs jobs strictly one at a time, in submit order", async () => {
    // The first spawn stays open until the test releases it; the second run
    // uses the default (immediately finishing) spec.
    const harness = new FakeCodexHarness([{ stayOpen: true }, {}]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const first = queue.submit([VIDEO_ONE]);
    const running = await waitForStatus(first.id, ["running"]);
    expect(running.status).toBe("running");

    const second = queue.submit([VIDEO_TWO]);
    const submitted = getReport(db, second.id)!;
    expect(submitted.jobDir).not.toBeNull();
    const snapshotFile = path.join(submitted.jobDir!, "transcripts", `${VIDEO_TWO}.txt`);
    const submittedEvidence = readFileSync(snapshotFile, "utf8");
    db.prepare("UPDATE transcripts SET plain_text = 'CHANGED AFTER SUBMISSION' WHERE video_id = ?").run(VIDEO_TWO);

    // A held-open first job means the second one must never start.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getReport(db, second.id)?.status).toBe("queued");
    expect(queue.pendingCount()).toBe(1);
    expect(harness.spawns.length).toBe(1);

    harness.spawns[0].child.finish();
    await waitForStatus(first.id, ["done"]);
    const secondDone = await waitForStatus(second.id, ["done"]);
    expect(secondDone.status).toBe("done");
    expect(readFileSync(snapshotFile, "utf8")).toBe(submittedEvidence);
    expect(readFileSync(snapshotFile, "utf8")).not.toContain("CHANGED AFTER SUBMISSION");

    expect(harness.spawns.length).toBe(2);
    // Never in parallel.
    expect(harness.maxActive).toBe(1);
    // In submit order: the first spawn served the first report's scope.
    expect(harness.spawns[0].request.cwd).not.toBe(harness.spawns[1].request.cwd);
    expect(queue.pendingCount()).toBe(0);
  }, 15_000);

  it("runs each submitted report exactly once", async () => {
    const harness = new FakeCodexHarness([{}, {}]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const report = queue.submit([VIDEO_ONE]);
    await waitForStatus(report.id, ["done"]);
    expect(harness.spawns.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Boot recovery (stage 7)
// ---------------------------------------------------------------------------

describe("boot recovery for stalled reports", () => {
  it("marks jobs stuck in running as failed with a client-safe message", () => {
    const stuck = createReport(db, [VIDEO_ONE]);
    transitionReport(db, stuck.id, "running");
    const finished = createReport(db, [VIDEO_ONE]);
    transitionReport(db, finished.id, "running");
    transitionReport(db, finished.id, "done", { filePath: "/x/report.html" });

    const recovery = recoverStalledReports(db);

    expect(recovery.failedIds).toEqual([stuck.id]);
    expect(recovery.requeuedIds).toEqual([]);
    const failed = getReport(db, stuck.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(RESTARTED_WHILE_RUNNING_ERROR);
    expect(failed?.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Terminal rows are left alone.
    expect(getReport(db, finished.id)?.status).toBe("done");
  });

  it("hands queued jobs back to the queue, which re-runs them in order", async () => {
    const first = createReport(db, [VIDEO_ONE]);
    const second = createReport(db, [VIDEO_TWO]);

    const harness = new FakeCodexHarness([{}, {}]);
    const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const firstDone = await waitForStatus(first.id, ["done"]);
    const secondDone = await waitForStatus(second.id, ["done"]);
    expect(firstDone.status).toBe("done");
    expect(secondDone.status).toBe("done");
    // Each queued row got its own codex run in its own job directory.
    expect(harness.spawns).toHaveLength(2);
    expect(harness.maxActive).toBe(1);
    expect(queue.pendingCount()).toBe(0);
  });

  it("recovery runs as part of queue creation, before the first submit drains", async () => {
    const orphan = createReport(db, [VIDEO_ONE]);
    transitionReport(db, orphan.id, "running"); // stuck by a "previous" server

    const harness = new FakeCodexHarness([{}]);
    createReportQueue({ db, jobsRoot, spawner: harness.spawner });

    const recovered = await waitForStatus(orphan.id, ["failed"]);
    expect(recovered.error).toBe(RESTARTED_WHILE_RUNNING_ERROR);
    expect(harness.spawns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Byte-budget truncation through the whole job (stage 7)
// ---------------------------------------------------------------------------

describe("report jobs disclose byte-budget truncation", () => {
  it("tells the analyst which transcripts were cut short", async () => {
    db.prepare("UPDATE transcripts SET plain_text = ? WHERE video_id = ?").run(
      "T".repeat(3000),
      VIDEO_ONE,
    );
    process.env.LOCALTUBE_AI_MAX_MATERIALIZED_BYTES = "500";

    try {
      const harness = new FakeCodexHarness([{}]);
      const queue = createReportQueue({ db, jobsRoot, spawner: harness.spawner });
      const queued = queue.submit([VIDEO_ONE]);
      const done = await waitForStatus(queued.id, ["done"]);

      expect(done.status).toBe("done");
      const prompt = harness.promptOf(0);
      expect(prompt).toContain("was truncated");
      expect(prompt).toContain("“Video reportvid01”");
      expect(prompt).toContain("partial evidence");
    } finally {
      delete process.env.LOCALTUBE_AI_MAX_MATERIALIZED_BYTES;
    }
  });
});

// ---------------------------------------------------------------------------
// Claude backend (stage 10)
// ---------------------------------------------------------------------------

describe("report execution resolution", () => {
  it("maps each backend explicitly, never leaking codex models elsewhere", () => {
    for (const profile of [
      getReportProfile("brief"),
      getReportProfile("balanced"),
      getReportProfile("deep"),
    ]) {
      // Codex keeps the profile's own ids (existing behavior).
      expect(resolveReportExecution("codex", profile)).toEqual({
        model: profile.model,
        reasoningEffort: profile.reasoningEffort,
      });
      // OpenCode runs its configured default: no codex-oriented ids.
      expect(resolveReportExecution("opencode", profile)).toEqual({});
      // Claude gets its runtime aliases and verified effort ladder.
      const claude = resolveReportExecution("claude", profile);
      expect(claude.model).toBe(
        { "claude-haiku": "haiku", "claude-sonnet": "sonnet", "claude-opus": "opus" }[
          profile.claudeModel
        ],
      );
      expect(claude.reasoningEffort).toBe(profile.claudeReasoningEffort ?? undefined);
    }
    expect(resolveReportExecution("claude", getReportProfile("brief"))).toEqual({ model: "haiku" });
    expect(resolveReportExecution("claude", getReportProfile("balanced"))).toEqual({
      model: "sonnet",
      reasoningEffort: "medium",
    });
    expect(resolveReportExecution("claude", getReportProfile("deep"))).toEqual({
      model: "opus",
      reasoningEffort: "xhigh",
    });
  });
});

describe("report jobs on the claude backend", () => {
  /** Fake claude runner that records options and drops the deliverable. */
  function claudeRecorder(runs: ClaudeRunOptions[]): (options: ClaudeRunOptions) => CodexRun {
    return (options) => {
      runs.push(options);
      writeFileSync(path.join(options.workDir, REPORT_FILE_NAME), DELIVERABLE_HTML, "utf8");
      return {
        events: (async function* () {})(),
        completed: Promise.resolve({
          sessionId: "5b35d928-2f44-489a-a7da-c493517fb797",
          finalMessage: "done",
          usage: null,
        }),
      };
    };
  }

  it("runs each profile with its Claude model, effort, and workspace-write sandbox", async () => {
    setAiBackend(db, "claude");
    const runs: ClaudeRunOptions[] = [];
    const queue = createReportQueue({ db, jobsRoot, runClaude: claudeRecorder(runs) });

    const brief = queue.submit([VIDEO_ONE], { profile: "brief" });
    const briefDone = await waitForStatus(brief.id, ["done"]);
    const deep = queue.submit([VIDEO_TWO], { profile: "deep" });
    const deepDone = await waitForStatus(deep.id, ["done"]);

    expect(briefDone.status).toBe("done");
    expect(deepDone.status).toBe("done");
    expect(runs).toHaveLength(2);
    expect(runs[0].model).toBe("haiku");
    expect(runs[0].reasoningEffort).toBeUndefined();
    expect(runs[0].sandbox).toBe("workspace-write");
    expect(runs[1].model).toBe("opus");
    expect(runs[1].reasoningEffort).toBe("xhigh");
    // The deliverable is registered by absolute path in the job directory.
    expect(briefDone.filePath).toBe(path.join(runs[0].workDir, REPORT_FILE_NAME));
    expect(briefDone.title).toBe("Report");
  });

  it("fails the job when the claude run writes no deliverable", async () => {
    setAiBackend(db, "claude");
    const queue = createReportQueue({
      db,
      jobsRoot,
      runClaude: () => ({
        events: (async function* () {})(),
        completed: Promise.resolve({ sessionId: "sid", finalMessage: "no file", usage: null }),
      }),
    });

    const queued = queue.submit([VIDEO_ONE]);
    const failed = await waitForStatus(queued.id, ["failed"]);
    expect(failed.error).toBe("The AI run finished but did not write a report file.");
  });
});
