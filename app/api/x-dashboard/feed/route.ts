import { getDb } from "@/lib/db/connection";
import { parseSearchBox, readDashboardFeed } from "@/lib/x/dashboard/feed";
import { isPeriod, isShowFilter } from "@/lib/x/dashboard/model";
import { researchError } from "@/lib/x/research/http";
import { isResearchInputError } from "@/lib/x/research/input";
import { creatorIds, ResearchInputError } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

/** GET /api/x-dashboard/feed — one page of the local archive for the dashboard. */
export function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    try {
      parseSearchBox(params.get("q") ?? "");
    } catch (error) {
      // Name the search box, so the page asks for different words rather
      // than offering a retry that would fail the same way.
      if (isResearchInputError(error))
        return Response.json({ error: error.message, field: "q" }, { status: error.status });
      throw error;
    }
    const db = getDb();
    const period = params.get("period") ?? "7d";
    const show = params.get("show") ?? "posts";
    if (!isPeriod(period) || !isShowFilter(show))
      throw new ResearchInputError("Choose a valid time range and post filter.");
    const page = Number(params.get("page") ?? "1");
    return Response.json(
      readDashboardFeed(db, {
        creatorIds: creatorIds(db, (params.get("creators") ?? "").split(",").filter(Boolean)),
        period,
        show,
        query: params.get("q"),
        page: Number.isSafeInteger(page) && page > 0 ? page : 1,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
