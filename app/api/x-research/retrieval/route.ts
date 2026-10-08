import { getDb } from "@/lib/db/connection";
import { readXMutation } from "@/lib/x/http";
import { calendarBounds } from "@/lib/x/research/dates";
import { researchError } from "@/lib/x/research/http";
import {
  creatorIds,
  getResearchList,
  parseId,
  ResearchInputError,
} from "@/lib/x/research/repository";
import { getRetrievalEngine } from "@/lib/x/research/retrieval";
import { MAX_PAGE_BUDGET } from "@/lib/x/research/retrieval-model";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  try {
    const ids = creatorIds(
      getDb(),
      (new URL(request.url).searchParams.get("creators") ?? "").split(",").filter(Boolean),
    );
    const engine = getRetrievalEngine();
    return Response.json(
      { jobs: engine.jobs(), coverage: engine.coverage(ids) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const input = body.value;
    if (input.kind !== "refresh" && input.kind !== "history")
      throw new ResearchInputError("Choose refresh or historical retrieval.");
    const db = getDb();
    const listId = input.listId == null ? null : parseId(input.listId);
    const list = listId === null ? null : getResearchList(db, listId);
    // A list refresh snapshots ALL members, independent of the displayed research selection.
    const ids =
      list && input.kind === "refresh" ? list.creatorIds : creatorIds(db, input.creatorIds);
    if (list && ids.some((id) => !list.creatorIds.includes(id)))
      throw new ResearchInputError("Choose creators from this list.");
    const bounded = (value: unknown, fallback: number, maximum: number) => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum)
        throw new ResearchInputError(`Choose a budget between 1 and ${maximum}.`);
      return value;
    };
    const initialDays = bounded(input.initialDays, 30, 365);
    // Omitted or null scales each creator's page budget to its retrieval window.
    const maxPages =
      input.maxPages == null ? null : bounded(input.maxPages, MAX_PAGE_BUDGET, MAX_PAGE_BUDGET);
    let bounds = {
      since: new Date(Date.now() - initialDays * 86400000).toISOString(),
      until: new Date().toISOString(),
    };
    if (input.kind === "history") {
      try {
        const timezone = typeof input.timezone === "string" ? input.timezone : "UTC";
        new Intl.DateTimeFormat("en", { timeZone: timezone });
        bounds =
          input.period === "24h"
            ? {
                since: new Date(Date.now() - 86400000).toISOString(),
                until: new Date().toISOString(),
              }
            : calendarBounds(String(input.start ?? ""), String(input.end ?? ""), timezone);
      } catch {
        throw new ResearchInputError("Choose valid dates and a timezone before fetching history.");
      }
    }
    const job = getRetrievalEngine().start({
      kind: input.kind,
      listId,
      label: list?.name ?? "Ad hoc selection",
      creatorIds: ids,
      ...bounds,
      initialDays,
      maxPages,
    });
    return Response.json({ job }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
