import { researchReportHtml } from "@/lib/x/research/experience";
/**
 * GET /api/ai/reports/[id]/file — serves a finished report's HTML file from
 * the job directory it was written to (the app stays loopback-only, so no
 * further path guarding is needed beyond the registered file_path).
 *
 * The report is AI output quoting untrusted transcripts, so it is served
 * with a CSP that enforces what the prompt already demands of the document:
 * inline styles only, no scripts, and no requests of any kind — external or
 * otherwise.
 */
import { readFile } from "node:fs/promises";

import { getReport } from "@/lib/ai/reports";
import { getDb } from "@/lib/db/connection";

// The underlying file appears once a background job finishes; never cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function parseReportId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number.parseInt(raw, 10);
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(_request: Request, ctx: RouteParams) {
  const { id: rawReportId } = await ctx.params;
  const reportId = parseReportId(rawReportId);
  if (reportId === null) {
    return jsonError(400, "invalid_report", "That report reference is not valid.");
  }

  const report = getReport(getDb(), reportId);
  if (report === null) {
    return jsonError(404, "report_not_found", "That report does not exist.");
  }
  const researchHtml = researchReportHtml(getDb(), reportId);
  if (report.status !== "done" || (report.filePath === null && researchHtml === null)) {
    return jsonError(
      409,
      "report_not_ready",
      report.status === "failed"
        ? "That report failed to generate."
        : "That report is still being generated.",
    );
  }

  let html: string;
  try {
    html = researchHtml ?? (await readFile(report.filePath!, "utf8"));
  } catch {
    return jsonError(404, "report_file_missing", "The report file is no longer on disk.");
  }

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
