import { getCreator } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import { getCachedTweet } from "@/lib/x";

// Cached detail reads live in SQLite; rendering never contacts X.
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/**
 * GET /api/creators/[id]/tweets/[tweetId] — the complete cached post:
 * full body, timestamps, author, canonical link, quote/reply context, and
 * fetch time. Purely local.
 */
export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/creators/[id]/tweets/[tweetId]">,
) {
  const { id: rawId, tweetId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null || !/^\d{1,20}$/.test(tweetId)) {
    return Response.json(
      { error: { code: "invalid_id", message: "Creator IDs and post IDs must be numeric." } },
      { status: 400 },
    );
  }

  const db = getDb();
  const creator = getCreator(db, id);
  if (!creator || creator.platform !== "x") {
    return Response.json(
      { error: { code: "not_found", message: "That X creator is not in your library." } },
      { status: 404 },
    );
  }

  const record = getCachedTweet(db, id, tweetId);
  if (!record) {
    return Response.json(
      { error: { code: "not_found", message: "That post is not in the local cache." } },
      { status: 404 },
    );
  }

  return Response.json(
    {
      tweet: record.tweet,
      timelineKind: record.timelineKind,
      timelineAt: record.timelineAt,
      savedAt: record.savedAt,
      fetchedAt: record.fetchedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
