import { refreshCreatorFeeds } from "@/lib/videos/service";
import { FEED_ERROR_CODE_TO_STATUS } from "@/lib/videos/service";
import { getDb } from "@/lib/db/connection";

// Refreshes hit the network via yt-dlp and write SQLite at request time.
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/**
 * POST /api/creators/[id]/refresh — manually refresh one creator's cached
 * feed (both tabs) through yt-dlp. User-initiated only; concurrent requests
 * for the same creator collapse into a single run. A failed refresh keeps
 * the previous cached feed intact.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/creators/[id]/refresh">) {
  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return Response.json(
      { error: { code: "invalid_id", message: "Creator IDs are positive whole numbers." } },
      { status: 400 },
    );
  }

  try {
    const outcome = await refreshCreatorFeeds(getDb(), id);
    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error },
        { status: FEED_ERROR_CODE_TO_STATUS[outcome.error.code] },
      );
    }
    return Response.json(
      {
        status: outcome.status,
        refreshedAt: outcome.refreshedAt,
        videoCount: outcome.videoCount,
        livestreamCount: outcome.livestreamCount,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "unexpected_response",
          message: "The feed could not be updated right now. Please try again.",
        },
      },
      { status: 500 },
    );
  }
}
