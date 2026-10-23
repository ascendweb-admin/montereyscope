/**
 * GET /api/ai/reports/search?q= — full-text search inside finished reports.
 *
 * The Reports page filters titles, standfirsts, and sources on the client as
 * the user types; this adds the documents themselves. Each match carries a
 * snippet of the body around the best hit, matched terms wrapped in the
 * \u0002…\u0003 markers the rail turns into highlights (null when only the
 * headline or standfirst matched). Every term must match as a word or word
 * prefix. The reading index is brought up to date first, so a report that
 * finished a moment ago is already searchable.
 */
import { searchReportText, syncReportIndex } from "@/lib/ai";
import { getDb } from "@/lib/db/connection";

// Reports finish and change in the background; never cache a result.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Longest query honoured, in characters. */
const MAX_QUERY_LENGTH = 200;

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
  const db = getDb();
  syncReportIndex(db);
  return Response.json(
    { matches: searchReportText(db, query) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
