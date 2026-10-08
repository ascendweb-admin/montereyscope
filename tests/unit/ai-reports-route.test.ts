/*
 * Route tests for the AI reports API (stage 6), driving the real route
 * handlers against a real migrated SQLite file. The Codex boundary is mocked
 * exactly where the chat route tests mock it: runCodex is replaced with a
 * scripted fake that records its options and writes the HTML deliverable the
 * prompt asks for, while the process-wide sequential queue drains in the
 * background.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodexNonZeroExitError,
  type CodexRun,
  type CodexRunOptions,
  type CodexStreamEvent,
} from "@/lib/ai/codex";
import { closeReportQueue } from "@/lib/ai/reports";
import { POST as POST_REPORTS, GET as LIST_REPORTS } from "@/app/api/ai/reports/route";
import {
  DELETE as DELETE_REPORT,
  GET as GET_REPORT,
  PATCH as PATCH_REPORT,
} from "@/app/api/ai/reports/[id]/route";
import { GET as GET_REPORT_FILE } from "@/app/api/ai/reports/[id]/file/route";
import { closeDatabase, getDb } from "@/lib/db/connection";
import { saveTranscript } from "@/lib/transcripts/repository";
import { setTranscriptResolverForTests } from "@/lib/transcripts/prepare";

const { runCodexMock } = vi.hoisted(() => ({ runCodexMock: vi.fn() }));

vi.mock("@/lib/ai/codex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/codex")>();
  return { ...actual, runCodex: runCodexMock };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIDEO_WITH_TRANSCRIPT = "abc12345678";
const SECOND_VIDEO_WITH_TRANSCRIPT = "def12345678";
const VIDEO_WITHOUT_TRANSCRIPT = "without1111";
const UNKNOWN_VIDEO = "ghost000001";

const DELIVERABLE_HTML =
  '<!doctype html><html lang="en"><head><title>Scope report</title></head><body><h1>Scope report</h1></body></html>';

const TITLED_DELIVERABLE_HTML = [
  '<!doctype html><html lang="en"><head><title>Ignored title tag</title></head>',
  "<body><h1>GTA, Jackson Hole, and the Attention Economy</h1>",
  '<p class="dek">A Friday read on a market waiting for the Fed.</p></body></html>',
].join("");

interface RunScript {
  events?: CodexStreamEvent[];
  failure?: Error;
  sessionId?: string;
  finalMessage?: string;
  /** Write the deliverable into the run's work dir (default: report.html). */
  writeDeliverable?: boolean;
}

/** Builds a CodexRun from a script, mirroring the real adapter's contract. */
function scriptRun(script: RunScript): CodexRun {
  const completed = script.failure
    ? Promise.reject(script.failure)
    : Promise.resolve({
        sessionId: script.sessionId ?? "session-report",
        finalMessage: script.finalMessage ?? "",
        usage: null,
      });
  completed.catch(() => {});

  async function* iterate(): AsyncGenerator<CodexStreamEvent> {
    for (const event of script.events ?? []) {
      yield event;
    }
    if (script.failure) {
      throw script.failure;
    }
  }
  return { events: iterate(), completed };
}

function seedFeed(): void {
  const db = getDb();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
    .run("Test Channel", "https://www.youtube.com/@testchannel");
  const creatorId = Number(lastInsertRowid);
  const insertVideo = db.prepare(
    "INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)",
  );
  const insertTranscript = db.prepare(
    "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
  );
  const entries = [
    { videoId: VIDEO_WITH_TRANSCRIPT, withTranscript: true },
    { videoId: SECOND_VIDEO_WITH_TRANSCRIPT, withTranscript: true },
    { videoId: VIDEO_WITHOUT_TRANSCRIPT, withTranscript: false },
  ];
  for (const entry of entries) {
    insertVideo.run(
      entry.videoId,
      creatorId,
      `Video ${entry.videoId}`,
      `https://www.youtube.com/watch?v=${entry.videoId}`,
    );
    if (entry.withTranscript) {
      insertTranscript.run(entry.videoId, "en", "manual", `Transcript body for ${entry.videoId}.`);
    }
  }
}

function insertThread(videoIds: string[]): number {
  const db = getDb();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids) VALUES (?, ?, ?)")
    .run("A thread", "/tmp/job", JSON.stringify(videoIds));
  return Number(lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function postReports(body: unknown): Promise<Response> {
  return POST_REPORTS(
    new Request("http://127.0.0.1:3000/api/ai/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function listReportsRequest(): Promise<Response> {
  return LIST_REPORTS();
}

function reportRequest(reportId: number | string): Promise<Response> {
  return GET_REPORT(new Request(`http://127.0.0.1:3000/api/ai/reports/${reportId}`), {
    params: Promise.resolve({ id: String(reportId) }),
  });
}

function reportFileRequest(reportId: number | string): Promise<Response> {
  return GET_REPORT_FILE(new Request(`http://127.0.0.1:3000/api/ai/reports/${reportId}/file`), {
    params: Promise.resolve({ id: String(reportId) }),
  });
}

function patchReport(body: unknown, reportId: number | string): Promise<Response> {
  return PATCH_REPORT(
    new Request(`http://127.0.0.1:3000/api/ai/reports/${reportId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(reportId) }) },
  );
}

function deleteReportRequest(reportId: number | string): Promise<Response> {
  return DELETE_REPORT(
    new Request(`http://127.0.0.1:3000/api/ai/reports/${reportId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: String(reportId) }) },
  );
}

interface ReportVideoBody {
  id: string;
  title: string;
  creatorId: number;
  creatorName: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
}

interface ReportBody {
  id: number;
  status: string;
  title: string | null;
  dek: string | null;
  videoIds: string[];
  videoCount: number;
  videos: ReportVideoBody[];
  profile: string;
  style: string;
  filePath: string | null;
  fileUrl: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Polls the status route until the report reaches one of the statuses. */
async function pollUntil(
  reportId: number,
  statuses: readonly string[],
  timeoutMs = 10_000,
): Promise<ReportBody> {
  const deadline = Date.now() + timeoutMs;
  let last: ReportBody | null = null;
  for (;;) {
    const response = await reportRequest(reportId);
    expect(response.status).toBe(200);
    last = ((await response.json()) as { report: ReportBody }).report;
    if (statuses.includes(last.status)) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(`report ${reportId} never reached ${statuses.join("|")}: ${last.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "localtube-reports-route-"));
  process.env.LOCALTUBE_DB_PATH = path.join(tempDir, "reports.db");
  process.env.LOCALTUBE_AI_JOBS_ROOT = path.join(tempDir, "ai-jobs");
  runCodexMock.mockReset();
  runCodexMock.mockImplementation(() => {
    throw new Error("this test must script runCodex before making a request");
  });
  // Background caption fetching never reaches yt-dlp in these tests.
  setTranscriptResolverForTests(async () => ({
    ok: false,
    error: { code: "no_captions", message: "No original English captions are available." },
  }));
});

afterEach(() => {
  setTranscriptResolverForTests(null);
  // The process-wide queue must not carry a stale database into the next test.
  closeReportQueue();
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  delete process.env.LOCALTUBE_AI_JOBS_ROOT;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

// ---------------------------------------------------------------------------
// POST /api/ai/reports
// ---------------------------------------------------------------------------

describe("POST /api/ai/reports", () => {
  it("queues a job from videoIds and runs it to a registered file", async () => {
    seedFeed();
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      expect(options.sandbox).toBe("workspace-write");
      expect(options.workDir.startsWith(process.env.LOCALTUBE_AI_JOBS_ROOT ?? "")).toBe(true);
      writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
      return scriptRun({ finalMessage: "Report written." });
    });

    const response = await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] });
    expect(response.status).toBe(202);
    const { report } = (await response.json()) as { report: ReportBody };
    expect(report.status).toBe("queued");
    expect(report.fileUrl).toBeNull();
    expect(report.videoIds).toEqual([VIDEO_WITH_TRANSCRIPT]);
    // Omitted options read as the defaults.
    expect(report.profile).toBe("balanced");
    expect(report.style).toBe("editorial");

    const done = await pollUntil(report.id, ["done"]);
    expect(done.status).toBe("done");
    expect(done.fileUrl).toBe(`/api/ai/reports/${report.id}/file`);
    expect(done.filePath).toMatch(/report\.html$/);
    expect(done.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("queues with the requested profile and style, refusing unknown ids", async () => {
    seedFeed();
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      // The run brief carries the profile's directive and the style's CSS.
      expect(options.prompt).toContain("Write a complete, rigorous brief");
      expect(options.prompt).toContain("#101419");
      writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
      return scriptRun({});
    });

    const response = await postReports({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      profile: "deep",
      style: "terminal",
    });
    expect(response.status).toBe(202);
    const { report } = (await response.json()) as { report: ReportBody };
    expect(report.profile).toBe("deep");
    expect(report.style).toBe("terminal");
    const done = await pollUntil(report.id, ["done"]);
    expect(done.status).toBe("done");

    const badProfile = await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT], profile: "ultra" });
    expect(badProfile.status).toBe(400);
    const profileError = (await badProfile.json()) as { error: { code: string } };
    expect(profileError.error.code).toBe("invalid_profile");

    const badStyle = await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT], style: "neon" });
    expect(badStyle.status).toBe(400);
    const styleError = (await badStyle.json()) as { error: { code: string } };
    expect(styleError.error.code).toBe("invalid_style");
  });

  it("uses a thread's scope when given threadId", async () => {
    seedFeed();
    const threadId = insertThread([SECOND_VIDEO_WITH_TRANSCRIPT]);
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
      return scriptRun({});
    });

    const response = await postReports({ threadId });
    expect(response.status).toBe(202);
    const { report } = (await response.json()) as { report: ReportBody };
    expect(report.videoIds).toEqual([SECOND_VIDEO_WITH_TRANSCRIPT]);

    const done = await pollUntil(report.id, ["done"]);
    expect(done.status).toBe("done");
    // One materialized transcript: only the thread's video.
    expect(done.videoCount).toBe(1);
  });

  it("rejects invalid bodies, unknown threads, and unknown scopes", async () => {
    seedFeed();

    const badJson = await postReports("not json");
    expect(badJson.status).toBe(400);

    const noIds = await postReports({});
    expect(noIds.status).toBe(400);

    const badIds = await postReports({ videoIds: [42] });
    expect(badIds.status).toBe(400);

    const badThread = await postReports({ threadId: 0 });
    expect(badThread.status).toBe(400);

    const missingThread = await postReports({ threadId: 999 });
    expect(missingThread.status).toBe(404);

    const unknown = await postReports({ videoIds: [UNKNOWN_VIDEO] });
    expect(unknown.status).toBe(422);
  });

  it("fetches missing transcripts in the job before the report is written", async () => {
    seedFeed();
    const fetched: string[] = [];
    setTranscriptResolverForTests(async (db, videoId) => {
      fetched.push(videoId);
      const fetchedAt = new Date().toISOString();
      saveTranscript(
        db,
        { videoId, language: "en", source: "automatic", plainText: "Fresh captions." },
        fetchedAt,
      );
      return {
        ok: true,
        transcript: {
          text: "Fresh captions.",
          language: "en",
          captionSource: "automatic",
          fetchedAt,
          fromCache: false,
        },
      };
    });
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      expect(
        existsSync(path.join(options.workDir, "transcripts", `${VIDEO_WITHOUT_TRANSCRIPT}.txt`)),
      ).toBe(true);
      writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
      return scriptRun({ finalMessage: "Report written." });
    });

    const response = await postReports({
      videoIds: [VIDEO_WITH_TRANSCRIPT, VIDEO_WITHOUT_TRANSCRIPT],
    });
    expect(response.status).toBe(202);
    const { report } = (await response.json()) as { report: ReportBody };

    const done = await pollUntil(report.id, ["done", "failed"]);
    expect(done.status).toBe("done");
    expect(fetched).toEqual([VIDEO_WITHOUT_TRANSCRIPT]);
    expect(runCodexMock).toHaveBeenCalledTimes(1);
  });

  it("fails a report whose videos' captions cannot be read, naming them", async () => {
    seedFeed();
    const response = await postReports({ videoIds: [VIDEO_WITHOUT_TRANSCRIPT] });
    expect(response.status).toBe(202);
    const { report } = (await response.json()) as { report: ReportBody };

    const failed = await pollUntil(report.id, ["done", "failed"]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(
      `Left out 1 video scope couldn't read captions for: “Video ${VIDEO_WITHOUT_TRANSCRIPT}” (no English captions).`,
    );
    expect(runCodexMock).not.toHaveBeenCalled();
  });

  it("refuses selections beyond the analysis cap with a readable 422 (stage 7)", async () => {
    seedFeed();
    const tooMany = [
      VIDEO_WITH_TRANSCRIPT,
      ...Array.from({ length: 26 }, (_, index) => `capvid${String(index).padStart(5, "0")}`),
    ];
    const tooLarge = await postReports({ videoIds: tooMany });
    expect(tooLarge.status).toBe(422);
    const body = (await tooLarge.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("scope_too_large");
    expect(body.error.message).toContain("capped at 25");

    // A pre-cap thread with an oversized scope gets the same refusal.
    const oversizedThreadId = insertThread(
      Array.from({ length: 26 }, (_, index) => `oldvid${String(index).padStart(5, "0")}`),
    );
    const viaThread = await postReports({ threadId: oversizedThreadId });
    expect(viaThread.status).toBe(422);
    const threadBody = (await viaThread.json()) as { error: { code: string } };
    expect(threadBody.error.code).toBe("scope_too_large");
  });
});

// ---------------------------------------------------------------------------
// GET endpoints
// ---------------------------------------------------------------------------

describe("GET /api/ai/reports", () => {
  it("lists reports newest first with their public shape", async () => {
    seedFeed();
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
      return scriptRun({});
    });

    const first = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
      report: ReportBody;
    };
    const second = (await (
      await postReports({ videoIds: [SECOND_VIDEO_WITH_TRANSCRIPT] })
    ).json()) as { report: ReportBody };
    await pollUntil(first.report.id, ["done"]);
    await pollUntil(second.report.id, ["done"]);

    const response = await listReportsRequest();
    expect(response.status).toBe(200);
    const { reports } = (await response.json()) as { reports: ReportBody[] };
    expect(reports.map((report) => report.id)).toEqual([second.report.id, first.report.id]);
    for (const report of reports) {
      expect(report.videoCount).toBe(1);
      expect(report.fileUrl).toBe(`/api/ai/reports/${report.id}/file`);
      // Absolute paths are server data, but this app is loopback-only and the
      // page deliberately shows where the file lives.
      expect(report.filePath).toMatch(/report\.html$/);
    }
  });

  it("returns 404 for unknown ids and 400 for malformed ids", async () => {
    const missing = await reportRequest(999);
    expect(missing.status).toBe(404);

    const malformed = await reportRequest("abc");
    expect(malformed.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/ai/reports/[id]/file
// ---------------------------------------------------------------------------

describe("GET /api/ai/reports/[id]/file", () => {
  it("serves the finished report as self-contained HTML with a strict CSP", async () => {
    seedFeed();
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
      return scriptRun({});
    });
    const queued = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
      report: ReportBody;
    };
    await pollUntil(queued.report.id, ["done"]);

    const response = await reportFileRequest(queued.report.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("style-src 'unsafe-inline'");
    const html = await response.text();
    expect(html).toContain("<!doctype html>");
  });

  it("refuses to serve reports that are not done", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() => {
      // Never writes a deliverable and fails: the report ends up failed.
      return scriptRun({ failure: new CodexNonZeroExitError("codex exited with 1: boom") });
    });
    const queued = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
      report: ReportBody;
    };
    const failed = await pollUntil(queued.report.id, ["failed"]);
    expect(failed.error).toBe("The AI backend failed to complete the report.");

    const response = await reportFileRequest(queued.report.id);
    expect(response.status).toBe(409);

    const missing = await reportFileRequest(999);
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Report identity and management (PATCH / DELETE)
// ---------------------------------------------------------------------------

/** A CodexRun whose events and completion never settle: keeps a job running. */
function neverEndingRun(): CodexRun {
  const never = new Promise<never>(() => {});
  async function* iterate(): AsyncGenerator<CodexStreamEvent> {
    await never;
    return;
  }
  return { events: iterate(), completed: never };
}

describe("report identity and management", () => {
  it("extracts the run's headline and standfirst and resolves the scope", async () => {
    seedFeed();
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      writeFileSync(path.join(options.workDir, "report.html"), TITLED_DELIVERABLE_HTML, "utf8");
      return scriptRun({});
    });

    const queued = (await (
      await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT, SECOND_VIDEO_WITH_TRANSCRIPT] })
    ).json()) as { report: ReportBody };
    // Queued rows have no identity yet.
    expect(queued.report.title).toBeNull();
    expect(queued.report.dek).toBeNull();

    const done = await pollUntil(queued.report.id, ["done"]);
    expect(done.title).toBe("GTA, Jackson Hole, and the Attention Economy");
    expect(done.dek).toBe("A Friday read on a market waiting for the Fed.");

    const detail = await reportRequest(queued.report.id);
    const { report } = (await detail.json()) as { report: ReportBody };
    expect(report.videos.map((video) => video.id)).toEqual([
      VIDEO_WITH_TRANSCRIPT,
      SECOND_VIDEO_WITH_TRANSCRIPT,
    ]);
    expect(report.videos[0].creatorName).toBe("Test Channel");
    expect(report.videos[0].creatorId).toBeGreaterThan(0);
    expect(report.videos[0].title).toBe(`Video ${VIDEO_WITH_TRANSCRIPT}`);
    expect(report.videos[0].thumbnailUrl).toBeNull();
  });

  describe("PATCH /api/ai/reports/[id]", () => {
    it("renames a report and returns the updated public shape", async () => {
      seedFeed();
      runCodexMock.mockImplementation((options: CodexRunOptions) => {
        writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
        return scriptRun({});
      });
      const queued = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
        report: ReportBody;
      };
      await pollUntil(queued.report.id, ["done"]);

      const response = await patchReport({ title: "  The Friday   brief  " }, queued.report.id);
      expect(response.status).toBe(200);
      const { report } = (await response.json()) as { report: ReportBody };
      expect(report.title).toBe("The Friday brief");
      expect(report.videos).toHaveLength(1);
    });

    it("rejects non-string, empty, and over-long titles, and unknown reports", async () => {
      seedFeed();
      runCodexMock.mockImplementation((options: CodexRunOptions) => {
        writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
        return scriptRun({});
      });
      const queued = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
        report: ReportBody;
      };
      await pollUntil(queued.report.id, ["done"]);

      const notAString = await patchReport({ title: 42 }, queued.report.id);
      expect(notAString.status).toBe(400);
      const empty = await patchReport({ title: "   " }, queued.report.id);
      expect(empty.status).toBe(400);
      const tooLong = await patchReport({ title: "x".repeat(201) }, queued.report.id);
      expect(tooLong.status).toBe(400);
      const missing = await patchReport({ title: "Fine" }, 999);
      expect(missing.status).toBe(404);
    });
  });

  describe("DELETE /api/ai/reports/[id]", () => {
    it("deletes a finished report's row and job directory", async () => {
      seedFeed();
      runCodexMock.mockImplementation((options: CodexRunOptions) => {
        writeFileSync(path.join(options.workDir, "report.html"), DELIVERABLE_HTML, "utf8");
        return scriptRun({});
      });
      const queued = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
        report: ReportBody;
      };
      const done = await pollUntil(queued.report.id, ["done"]);
      expect(done.filePath).toMatch(/report\.html$/);
      const jobDir = path.dirname(done.filePath ?? "");

      const response = await deleteReportRequest(queued.report.id);
      expect(response.status).toBe(204);
      expect(existsSync(jobDir)).toBe(false);
      expect((await reportRequest(queued.report.id)).status).toBe(404);
      expect((await reportFileRequest(queued.report.id)).status).toBe(404);

      const missing = await deleteReportRequest(queued.report.id);
      expect(missing.status).toBe(404);
    });

    it("refuses to delete a report that is currently running", async () => {
      seedFeed();
      runCodexMock.mockImplementation(() => neverEndingRun());
      const queued = (await (await postReports({ videoIds: [VIDEO_WITH_TRANSCRIPT] })).json()) as {
        report: ReportBody;
      };
      await pollUntil(queued.report.id, ["running"]);

      const response = await deleteReportRequest(queued.report.id);
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("report_running");
    });
  });
});
