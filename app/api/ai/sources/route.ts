/**
 * GET /api/ai/sources — the library a source picker chooses from.
 *
 * Every cached video and X post with its creator and categories, the saved
 * accounts grouped into people, and the category list: the same data the AI
 * Chat page renders its picker from. The Reports page's "New report" reads
 * it when the flow opens instead of with the page (see
 * lib/ai/source-library.ts).
 */
import { loadSourceLibrary } from "@/lib/ai/source-library";
import { getDb } from "@/lib/db/connection";

// The library lives in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = getDb();
  return Response.json(loadSourceLibrary(db), { headers: { "Cache-Control": "no-store" } });
}
