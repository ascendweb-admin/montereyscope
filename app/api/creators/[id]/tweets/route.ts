import { getCreator } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import { getCachedCreatorTimeline } from "@/lib/x";

// Cached timeline reads live in SQLite and must be current at request time.
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function parseQueryFlag(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }
  if (value === "1" || value === "true" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "off") {
    return false;
  }
  return fallback;
}

/**
 * GET /api/creators/[id]/tweets — the creator's cached X timeline (no
 * network): posts plus timeline/filter metadata and the stored refresh
 * state. Fetching happens via POST …/tweets/refresh and …/tweets/fetch.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/creators/[id]/tweets">) {
  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json(
      { error: { code: "invalid_id", message: "Creator IDs are positive whole numbers." } },
      { status: 400 },
    );
  }

  const db = getDb();
  const creator = getCreator(db, id);
  if (!creator) {
    return Response.json(
      { error: { code: "not_found", message: "No creator with that ID is in your library." } },
      { status: 404 },
    );
  }
  if (creator.platform !== "x") {
    return Response.json(
      { error: { code: "not_found", message: "That creator is not an X account." } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  const page = getCachedCreatorTimeline(db, id, {
    includeReplies: parseQueryFlag(url.searchParams.get("replies"), false),
    includeReposts: parseQueryFlag(url.searchParams.get("reposts"), true),
    limit: Number.isFinite(limit) ? limit : 100,
    offset: Number.isFinite(offset) ? offset : 0,
  });

  return Response.json(
    {
      creator: {
        id: creator.id,
        displayName: creator.displayName,
        handle: creator.handle,
        platformUserId: creator.platformUserId,
      },
      items: page.items.map((item) => ({
        tweet: item.tweet,
        timelineKind: item.timelineKind,
        timelineAt: item.timelineAt,
        savedAt: item.savedAt,
        fetchedAt: item.fetchedAt,
      })),
      totalCount: page.totalCount,
      hasMore: page.hasMore,
      state: page.state,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
