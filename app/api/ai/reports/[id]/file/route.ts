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
 *
 * `?embed=1` serves the same document for the Reports page's inline reader:
 * framing is allowed from the app's own origin only, external links get
 * target="_blank" so they open outside the frame (the reader's sandboxed
 * iframe lets those popups escape) instead of navigating the frame itself,
 * and every section heading carries the id the page's outline jumps to.
 */
import { readFile } from "node:fs/promises";

import { anchorReportHeadings } from "@/lib/ai/report-document";
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

/**
 * Lands an outline jump a little below the frame's top edge rather than
 * flush against it. A style element is valid anywhere in the body, and the
 * CSP allows inline styles.
 */
const EMBED_STYLE = "<style>h2[id],h3[id]{scroll-margin-top:1.5rem}</style>";

/** Opens absolute links outside the frame; in-page anchors keep working. */
function targetExternalLinks(html: string): string {
  return html.replace(
    /<a\b(?![^>]*\btarget\s*=)(?=[^>]*\bhref\s*=\s*["']?https?:)/gi,
    '<a target="_blank" rel="noopener noreferrer"',
  );
}

export async function GET(request: Request, ctx: RouteParams) {
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

  const embed = new URL(request.url).searchParams.get("embed") === "1";

  const body = embed ? targetExternalLinks(anchorReportHeadings(html).html) + EMBED_STYLE : html;

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors ${embed ? "'self'" : "'none'"}`,
    },
  });
}
