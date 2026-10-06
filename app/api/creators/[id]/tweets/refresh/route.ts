import { readXMutation } from "@/lib/x/http";
import { getCreator } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import { refreshCreatorTweets, X_MAX_RECENT_LIMIT } from "@/lib/x";
import { xErrorStatus } from "@/lib/x/http";
import { X_ERROR_MESSAGES } from "@/lib/x/model";

// Refreshes reach the network through the X provider and write SQLite.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number.parseInt(raw, 10);
  return Number.isInteger(id) && id >= 1 ? id : null;
}

function jsonError(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * POST /api/creators/[id]/tweets/refresh — bounded user-initiated refresh:
 * `{mode:"recent"}` pulls the newest window, `{mode:"older"}` follows the
 * stored cursor. Concurrent refreshes for the same creator collapse into a
 * single provider run; failures leave cached posts untouched.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/creators/[id]/tweets/refresh">) {
  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return jsonError(400, "invalid_id", "Creator IDs are positive whole numbers.");
  }

  const parsed = await readXMutation(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  const mode = body.mode === "older" ? "older" : body.mode === undefined ? "recent" : null;
  if (mode === null) {
    return jsonError(400, "invalid_mode", "mode must be one of: recent, older.");
  }
  let limit: number | undefined;
  if (body.limit !== undefined) {
    if (typeof body.limit !== "number" || !Number.isFinite(body.limit)) {
      return jsonError(400, "invalid_limit", `limit must be a number up to ${X_MAX_RECENT_LIMIT}.`);
    }
    limit = body.limit;
  }

  const db = getDb();
  const creator = getCreator(db, id);
  if (!creator) {
    return jsonError(404, "not_found", "No creator with that ID is in your library.");
  }
  if (creator.platform !== "x") {
    return jsonError(404, "not_found", "That creator is not an X account.");
  }

  try {
    const outcome = await refreshCreatorTweets(db, id, { mode, limit });
    if (!outcome.ok) {
      return jsonError(
        xErrorStatus(outcome.error.code),
        outcome.error.code,
        outcome.error.message ||
          X_ERROR_MESSAGES[outcome.error.code] ||
          "The timeline could not be updated.",
      );
    }
    return Response.json(
      {
        status: outcome.status,
        refreshedAt: outcome.refreshedAt,
        newItemCount: outcome.newItemCount,
        skipped: outcome.skipped,
        hasOlderAvailable: outcome.hasOlderAvailable,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError(500, "invalid_response", "The timeline could not be updated right now.");
  }
}
