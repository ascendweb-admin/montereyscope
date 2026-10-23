import { getDb } from "@/lib/db/connection";
import { getXSyncSettings } from "@/lib/settings/settings";
import { setXFocus } from "@/lib/x/focus";
import { unreadCounts } from "@/lib/x/dashboard/feed";
import { isPeriod, periodDays, type DashboardStatus } from "@/lib/x/dashboard/model";
import { checkEveryMs, feedCoverage, kickXSync, scopeRevision, syncSnapshot } from "@/lib/x/dashboard/sync";
import { researchError } from "@/lib/x/research/http";
import { creatorIds, listResearchLists } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

/**
 * GET /api/x-dashboard/status?creators=…&period=… — the sync state of the
 * creators in view, unread counts for every list, and a revision that changes
 * whenever their posts change. Reads local state only; it also tells the sync
 * scheduler what is on screen, so those accounts are checked first and their
 * history is filled in back to the timeframe shown.
 */
export function GET(request: Request) {
  try {
    const db = getDb();
    const params = new URL(request.url).searchParams;
    const ids = creatorIds(db, (params.get("creators") ?? "").split(",").filter(Boolean));
    const period = params.get("period");
    const days = isPeriod(period) ? periodDays(period) : null;
    if (ids.length && isPeriod(period) && setXFocus(ids, days)) kickXSync();
    const all = (
      db.prepare("SELECT id FROM creators WHERE platform = 'x'").all() as Array<{ id: number }>
    ).map((row) => row.id);
    const status: DashboardStatus = {
      sync: syncSnapshot(ids),
      unread: unreadCounts(db, listResearchLists(db), all),
      revision: scopeRevision(db, ids),
      coverage: isPeriod(period) ? feedCoverage(ids, days) : null,
      checkEveryMs: checkEveryMs(ids.length, getXSyncSettings(db).autoSyncMinutes),
    };
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
