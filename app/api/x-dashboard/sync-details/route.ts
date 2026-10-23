import { getDb } from "@/lib/db/connection";
import { listCreators } from "@/lib/creators/repository";
import { syncSnapshot } from "@/lib/x/dashboard/sync";
import { researchError } from "@/lib/x/research/http";
export const dynamic = "force-dynamic";

/**
 * GET /api/x-dashboard/sync-details — every X account with its full technical
 * sync state (rate-limit waits, retries, older posts importing) for Settings.
 * Reads local state only.
 */
export function GET() {
  try {
    const creators = listCreators(getDb())
      .filter((c) => c.platform === "x")
      .map(({ id, displayName, handle, avatarUrl }) => ({ id, displayName, handle, avatarUrl }));
    return Response.json(
      { creators, sync: creators.length ? syncSnapshot(creators.map((c) => c.id)) : null },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
