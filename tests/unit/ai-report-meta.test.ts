import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backfillReportTitles,
  deleteReport,
  extractReportMeta,
  getReport,
  renameReport,
  REPORT_DEK_MAX_LENGTH,
  REPORT_TITLE_MAX_LENGTH,
  ReportRenameError,
  transitionReport,
} from "@/lib/ai/reports";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

/**
 * Report identity and lifecycle extras: extracting the headline/standfirst
 * the analyst wrote into the finished document, backfilling them for reports
 * that finished before extraction existed, user renames (and their
 * interaction with the run's own headline), and deletion — which must remove
 * the job directory but never touch anything outside the jobs root.
 */

const REPORT_HTML = [
  "<!doctype html><html lang=\"en\"><head><title>Fallback Title — Transcript Analysis</title></head>",
  "<body>",
  '<header><p class="eyebrow">Transcript report</p>',
  "<h1>GTA, Jackson Hole &amp; the &#8220;Attention&#8221; Economy</h1>",
  '<p class="dek">A streamer&#8217;s Friday read on a market waiting for the Fed.</p></header>',
  "</body></html>",
].join("");

let db: Database.Database;
let dir: string;
let jobsRoot: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "localtube-report-meta-"));
  jobsRoot = path.join(dir, "ai-jobs");
  process.env.SCOPE_AI_JOBS_ROOT = jobsRoot;
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterEach(() => {
  db.close();
  delete process.env.SCOPE_AI_JOBS_ROOT;
  rmSync(dir, { recursive: true, force: true });
  dir = "";
});

/** Inserts a report row directly and moves it through to the given status. */
function insertReport(
  status: "queued" | "running" | "done" | "failed",
  filePath: string | null = null,
): ReturnType<typeof getReport> & { id: number } {
  const result = db
    .prepare("INSERT INTO ai_reports (selected_video_ids) VALUES (?)")
    .run(JSON.stringify(["metavid00001"]));
  const id = Number(result.lastInsertRowid);
  if (status !== "queued") {
    transitionReport(db, id, "running");
  }
  if (status === "done" || status === "failed") {
    transitionReport(db, id, status, filePath ? { filePath } : undefined);
  }
  const row = getReport(db, id);
  if (row === null) {
    throw new Error("insert failed");
  }
  return row;
}

describe("extractReportMeta", () => {
  it("prefers the h1 headline over the title tag and decodes entities", () => {
    const meta = extractReportMeta(REPORT_HTML);
    expect(meta.title).toBe("GTA, Jackson Hole & the “Attention” Economy");
    expect(meta.dek).toBe("A streamer’s Friday read on a market waiting for the Fed.");
  });

  it("falls back to the title tag when there is no h1", () => {
    const meta = extractReportMeta(
      "<html><head><title>Markets at a Fork</title></head><body><p>no heading</p></body></html>",
    );
    expect(meta.title).toBe("Markets at a Fork");
    expect(meta.dek).toBeNull();
  });

  it("strips inline tags and collapses whitespace", () => {
    const meta = extractReportMeta("<html><h1>Crypto’s <em>attention</em>\n  race</h1></html>");
    expect(meta.title).toBe("Crypto’s attention race");
  });

  it("returns nulls for a document without any headline", () => {
    expect(extractReportMeta("<html><body><p>Nothing here.</p></body></html>")).toEqual({
      title: null,
      dek: null,
    });
  });

  it("clamps oversized headlines and standfirsts with an ellipsis", () => {
    const long = "Attention".repeat(60);
    const meta = extractReportMeta(
      `<html><h1>${long}</h1><p class="dek">${long}</p></html>`,
    );
    expect(meta.title).toMatch(/\u2026$/);
    expect(meta.title?.length).toBe(REPORT_TITLE_MAX_LENGTH);
    expect(meta.title?.startsWith("Attention")).toBe(true);
    expect(meta.dek?.length).toBe(REPORT_DEK_MAX_LENGTH);
  });
});

describe("backfillReportTitles", () => {
  it("extracts titles for finished reports that predate extraction", () => {
    const jobDir = path.join(jobsRoot, "20260101T000000Z-abcdefghijk");
    mkdirSync(jobDir, { recursive: true });
    const filePath = path.join(jobDir, "report.html");
    writeFileSync(filePath, REPORT_HTML, "utf8");
    const report = insertReport("done", filePath);

    expect(backfillReportTitles(db)).toBe(1);

    const updated = getReport(db, report.id);
    expect(updated?.title).toBe("GTA, Jackson Hole & the “Attention” Economy");
    expect(updated?.dek).toBe("A streamer’s Friday read on a market waiting for the Fed.");
    expect(updated?.jobDir).toBe(jobDir);
    // Steady state: a second boot finds nothing to do.
    expect(backfillReportTitles(db)).toBe(0);
  });

  it("skips reports whose file is gone or that never finished", () => {
    insertReport("done", path.join(jobsRoot, "missing", "report.html"));
    insertReport("failed");

    expect(backfillReportTitles(db)).toBe(0);
  });
});

describe("renameReport", () => {
  it("stores the user's wording, collapsed and clamped", () => {
    const report = insertReport("done");
    const renamed = renameReport(db, report.id, "  A   spaced  out title  ");
    expect(renamed.title).toBe("A spaced out title");
    expect(
      renameReport(db, report.id, "Renamed".repeat(100)).title?.length,
    ).toBe(REPORT_TITLE_MAX_LENGTH);
  });

  it("refuses empty titles", () => {
    const report = insertReport("done");
    expect(() => renameReport(db, report.id, "   ")).toThrow(ReportRenameError);
  });

  it("an explicit rename is never clobbered by the run's extracted headline", () => {
    const report = insertReport("running");
    renameReport(db, report.id, "My own name for this");
    const done = transitionReport(db, report.id, "done", {
      filePath: "/jobs/x/report.html",
      title: "The Analyst's Headline",
      dek: "Dek",
    });
    expect(done.title).toBe("My own name for this");
    expect(done.dek).toBe("Dek");
  });
});

describe("deleteReport", () => {
  it("removes the row and the whole job directory", () => {
    const jobDir = path.join(jobsRoot, "20260101T000000Z-abcdefghijk");
    mkdirSync(path.join(jobDir, "transcripts"), { recursive: true });
    const filePath = path.join(jobDir, "report.html");
    writeFileSync(filePath, "<html></html>", "utf8");
    const report = insertReport("done", filePath);
    db.prepare("UPDATE ai_reports SET job_dir = ? WHERE id = ?").run(jobDir, report.id);

    deleteReport(db, getReport(db, report.id) ?? report);

    expect(getReport(db, report.id)).toBeNull();
    expect(existsSync(jobDir)).toBe(false);
  });

  it("falls back to the file path's directory for rows without job_dir", () => {
    const jobDir = path.join(jobsRoot, "20260101T000000Z-legacydir1");
    mkdirSync(jobDir, { recursive: true });
    const filePath = path.join(jobDir, "report.html");
    writeFileSync(filePath, "<html></html>", "utf8");
    const report = insertReport("done", filePath);

    deleteReport(db, getReport(db, report.id) ?? report);

    expect(getReport(db, report.id)).toBeNull();
    expect(existsSync(jobDir)).toBe(false);
  });

  it("never deletes anything outside the jobs root", () => {
    const outside = path.join(dir, "precious");
    mkdirSync(outside, { recursive: true });
    const filePath = path.join(outside, "report.html");
    writeFileSync(filePath, "<html></html>", "utf8");
    const report = insertReport("done", filePath);

    deleteReport(db, getReport(db, report.id) ?? report);

    expect(getReport(db, report.id)).toBeNull();
    expect(existsSync(outside)).toBe(true);
  });
});
