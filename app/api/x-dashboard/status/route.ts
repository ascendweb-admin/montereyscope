import { getDb } from "@/lib/db/connection";
import { unreadCounts } from "@/lib/x/dashboard/feed";
import { syncSnapshot } from "@/lib/x/dashboard/sync";
import { researchError } from "@/lib/x/research/http";
import { creatorIds, listResearchLists } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

/**
 * GET /api/x-dashboard/status?creators=… — the sync state of the creators in
 * view plus unread counts for every list. Reads local state only.
 */
export function GET(request: Request) {
  try {
    const db = getDb();
    const ids = creatorIds(
      db,
      (new URL(request.url).searchParams.get("creators") ?? "").split(",").filter(Boolean),
    );
    const all = (
      db.prepare("SELECT id FROM creators WHERE platform = 'x'").all() as Array<{ id: number }>
    ).map((row) => row.id);
    return Response.json(
      { sync: syncSnapshot(ids), unread: unreadCounts(db, listResearchLists(db), all) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
