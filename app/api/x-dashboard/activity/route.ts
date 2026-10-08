import { getDb } from "@/lib/db/connection";
import { getInsightEngine } from "@/lib/x/dashboard/insights";
import { syncSnapshot } from "@/lib/x/dashboard/sync";
import { researchError } from "@/lib/x/research/http";
export const dynamic = "force-dynamic";

/** GET /api/x-dashboard/activity — recent AI analyses and the sync state of all X accounts. */
export function GET() {
  try {
    const ids = (
      getDb().prepare("SELECT id FROM creators WHERE platform = 'x'").all() as Array<{ id: number }>
    ).map((row) => row.id);
    const recent = Date.now() - 10 * 60_000;
    return Response.json(
      {
        insights: getInsightEngine()
          .list(20)
          .filter((i) => i.status === "running" || Date.parse(i.updatedAt) > recent),
        sync: ids.length ? syncSnapshot(ids) : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
