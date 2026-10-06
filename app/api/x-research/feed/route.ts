import { getDb } from "@/lib/db/connection";
import { calendarBounds } from "@/lib/x/research/dates";
import {
  getResearchList,
  creatorIds,
  parseId,
  readCachedFeed,
  ResearchInputError,
} from "@/lib/x/research/repository";
import { POST_TYPES, type ResearchPostType } from "@/lib/x/research/model";
import { researchError } from "@/lib/x/research/http";
import { parseExactSearch } from "@/lib/x/research/search";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("mode") && !["feed", "exact"].includes(params.get("mode")!))
      throw new ResearchInputError(
        "Choose Feed or Exact terms. Related-topic analysis is not available yet.",
      );
    const db = getDb();
    const list = params.has("listId") ? getResearchList(db, parseId(params.get("listId"))) : null;
    const ids = params.has("creators")
      ? creatorIds(db, params.get("creators")!.split(",").filter(Boolean))
      : (list?.creatorIds ?? []);
    if (list && ids.some((id) => !list.creatorIds.includes(id)))
      throw new ResearchInputError("Choose creators belonging to this list.");
    let bounds: { since: string; until: string };
    try {
      const timezone = params.get("timezone") || "UTC";
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      bounds =
        params.get("period") === "24h"
          ? {
              since: new Date(Date.now() - 86400000).toISOString(),
              until: new Date().toISOString(),
            }
          : calendarBounds(params.get("start") || "", params.get("end") || "", timezone);
    } catch {
      throw new ResearchInputError(
        "Choose valid dates and an IANA timezone (for example Europe/Amsterdam).",
      );
    }
    const types = (params.get("types") ?? "original,quote,reply").split(",").filter(Boolean);
    if (types.some((type) => !(POST_TYPES as readonly string[]).includes(type)))
      throw new ResearchInputError("Choose valid post types.");
    return Response.json(
      readCachedFeed(db, {
        creatorIds: ids,
        ...bounds,
        types: types as ResearchPostType[],
        page: params.has("page") ? Number(params.get("page")) : 1,
        search:
          params.get("mode") === "exact"
            ? parseExactSearch({
                terms: params.get("terms"),
                aliases: params.get("aliases"),
                exclusions: params.get("exclusions"),
              })
            : undefined,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
