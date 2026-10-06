/**
 * /api/ai/reports/[id] — read and manage one report. GET mirrors the list
 * endpoint's public shape for the polling loop; PATCH renames the report
 * (the headline the list page shows); DELETE removes the row and its job
 * directory from disk. The file path stays public because the app is
 * loopback-only and the page offers a copy-path action.
 */
import {
  deleteReport,
  getReport,
  publicReportFor,
  renameReport,
  REPORT_TITLE_MAX_LENGTH,
} from "@/lib/ai/reports";
import { getDb } from "@/lib/db/connection";

// Report status changes in the background; always read at request time.
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

  return Response.json(
    { report: publicReportFor(getDb(), report) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PATCH(request: Request, ctx: RouteParams) {
  const { id: rawReportId } = await ctx.params;
  const reportId = parseReportId(rawReportId);
  if (reportId === null) {
    return jsonError(400, "invalid_report", "That report reference is not valid.");
  }

  let body: { title?: unknown };
  try {
    body = (await request.json()) as { title?: unknown };
  } catch {
    return jsonError(400, "invalid_body", "Request body must be JSON.");
  }
  if (typeof body.title !== "string") {
    return jsonError(400, "invalid_title", "title must be a string.");
  }
  const cleaned = body.title.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return jsonError(400, "empty_title", "The report title cannot be empty.");
  }
  if (cleaned.length > REPORT_TITLE_MAX_LENGTH) {
    return jsonError(
      400,
      "title_too_long",
      `The report title is capped at ${REPORT_TITLE_MAX_LENGTH} characters.`,
    );
  }

  const db = getDb();
  const report = getReport(db, reportId);
  if (report === null) {
    return jsonError(404, "report_not_found", "That report does not exist.");
  }

  const renamed = renameReport(db, reportId, cleaned);
  return Response.json(
    { report: publicReportFor(db, renamed) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(_request: Request, ctx: RouteParams) {
  const { id: rawReportId } = await ctx.params;
  const reportId = parseReportId(rawReportId);
  if (reportId === null) {
    return jsonError(400, "invalid_report", "That report reference is not valid.");
  }

  const db = getDb();
  const report = getReport(db, reportId);
  if (report === null) {
    return jsonError(404, "report_not_found", "That report does not exist.");
  }
  if (report.status === "running") {
    return jsonError(
      409,
      "report_running",
      "This report is generating right now — wait for it to finish before deleting it.",
    );
  }

  deleteReport(db, report);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
