import { describe, expect, it } from "vitest";

import { closeReportQueue, createReportQueue, getReport, type AiReport } from "@/lib/ai/reports";
import { closeDatabase, getDb, type ScopeDatabase } from "@/lib/db/connection";

/**
 * Opt-in live report (stage 6): guarded by SCOPE_AI_LIVE_TEST=1, this
 * runs the real job pipeline end to end against the machine's cached
 * transcripts and the real codex CLI — materialization, a workspace-write
 * run in the job directory, and deliverable registration in the real
 * database. It consumes plan quota and takes several minutes; `npm test`
 * skips it. The finished report is printed with its on-disk path so it can
 * be opened straight from disk, and it appears on the app's Reports page.
 */

const live = process.env.SCOPE_AI_LIVE_TEST === "1" || process.env.LOCALTUBE_AI_LIVE_TEST === "1";

describe("live report generation", () => {
  it.skipIf(!live)(
    "generates one real HTML report from a small cached scope",
    { timeout: 20 * 60_000 },
    async () => {
      const db = getDb();
      // Small selection: the two shortest cached transcripts keep the run
      // quick while still giving the report more than one source to weave.
      const rows = db
        .prepare<[], { id: string; title: string; chars: number }>(
          `SELECT t.video_id AS id, v.title, LENGTH(t.plain_text) AS chars
           FROM transcripts t
           JOIN videos v ON v.id = t.video_id
           ORDER BY LENGTH(t.plain_text) ASC
           LIMIT 2`,
        )
        .all();
      expect(rows.length).toBeGreaterThan(0);
      const videoIds = rows.map((row) => row.id);
      console.log("LIVE REPORT SCOPE:", JSON.stringify(rows, null, 2));

      // Real jobs root (data/ai-jobs) so the finished file persists for the
      // user to open and shows up on the app's Reports page.
      const queue = createReportQueue({ db });
      const queued = queue.submit(videoIds);
      console.log("LIVE REPORT QUEUED: report id", queued.id);

      const report = await pollUntilTerminal(db, queued.id);
      console.log("LIVE REPORT RESULT:", JSON.stringify(report, null, 2));

      expect(report.status).toBe("done");
      expect(report.error).toBeNull();
      expect(report.filePath).toBeTruthy();
      closeReportQueue();
      closeDatabase();
    },
  );
});

async function pollUntilTerminal(
  db: ScopeDatabase,
  reportId: number,
  timeoutMs = 19 * 60_000,
): Promise<AiReport> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const report = getReport(db, reportId);
    if (report && (report.status === "done" || report.status === "failed")) {
      return report;
    }
    if (Date.now() > deadline) {
      throw new Error(`live report ${reportId} did not finish in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
