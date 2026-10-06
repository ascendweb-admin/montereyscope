import { getCachedCreatorFeed } from "@/lib/videos/service";
import { getCreator } from "@/lib/creators/repository";
import { toCreatorSummary } from "@/lib/creators/service";
import { getDb } from "@/lib/db/connection";

// The cached feed lives in SQLite and must be read at request time.
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

/**
 * GET /api/creators/[id]/feed — the creator's cached feed (no network, no
 * yt-dlp): safe video fields grouped into the videos/livestreams tabs plus
 * last_refreshed_at. Refreshing happens via POST …/refresh.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/creators/[id]/feed">) {
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

  const feed = getCachedCreatorFeed(db, id);

  return Response.json(
    {
      creator: toCreatorSummary(creator),
      lastRefreshedAt: creator.lastRefreshedAt,
      videos: feed.videos.map(toVideoPayload),
      livestreams: feed.livestreams.map(toVideoPayload),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function toVideoPayload(video: {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  liveStatus: string;
}) {
  return {
    id: video.id,
    title: video.title,
    url: video.url,
    thumbnailUrl: video.thumbnailUrl,
    publishedAt: video.publishedAt,
    durationSeconds: video.durationSeconds,
    liveStatus: video.liveStatus,
  };
}
