/**
 * GET /api/ai/chat/threads — thread history for the chat sidebar.
 *
 * Returns every thread with a scope summary (the requested video ids and
 * counts) plus activity counts, most recently active first. Never includes
 * message bodies; GET /api/ai/chat/threads/[id] serves those.
 */
import { listThreads } from "@/lib/ai/threads";
import { getDb } from "@/lib/db/connection";

// Threads live in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const db = getDb();
  return Response.json({ threads: listThreads(db) }, { headers: { "Cache-Control": "no-store" } });
}
