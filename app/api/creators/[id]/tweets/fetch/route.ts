import { readXMutation } from "@/lib/x/http";
import { getCreator } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import { fetchTweetsForCreator, X_MAX_DETAIL_BATCH } from "@/lib/x";
import { xErrorStatus } from "@/lib/x/http";
import { X_ERROR_MESSAGES } from "@/lib/x/model";

// Fetching hydrates cached detail through the X provider.
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
 * POST /api/creators/[id]/tweets/fetch — hydrate a bounded batch of cached
 * post ids (`{tweetIds: string[]}`). Items already complete are reported as
 * `already_complete`; partial failures return per-item outcomes and keep the
 * successes.
 */
export async function POST(
  request: Request,
  ctx: RouteContext<"/api/creators/[id]/tweets/fetch">,
) {
  const { id: rawId } = await ctx.params;
  const id = parseId(rawId);
  if (id === null) {
    return jsonError(400, "invalid_id", "Creator IDs are positive whole numbers.");
  }

  const parsed = await readXMutation(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;

  if (
    !Array.isArray(body.tweetIds) ||
    body.tweetIds.length === 0 ||
    body.tweetIds.some((tweetId) => typeof tweetId !== "string")
  ) {
    return jsonError(400, "invalid_tweet_ids", "tweetIds must be a non-empty array of id strings.");
  }
  const tweetIds = body.tweetIds as string[];
  if (tweetIds.length > X_MAX_DETAIL_BATCH) {
    return jsonError(
      422,
      "batch_too_large",
      `Details are fetched in batches of at most ${X_MAX_DETAIL_BATCH}.`,
    );
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
    const outcome = await fetchTweetsForCreator(db, id, tweetIds);
    if (!outcome.ok) {
      return jsonError(
        xErrorStatus(outcome.error.code),
        outcome.error.code,
        outcome.error.message || X_ERROR_MESSAGES[outcome.error.code],
      );
    }
    return Response.json(
      {
        results: outcome.results,
        savedCount: outcome.savedCount,
        alreadyCompleteCount: outcome.alreadyCompleteCount,
        unavailableCount: outcome.unavailableCount,
        failedCount: outcome.failedCount,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return jsonError(500, "invalid_response", "Fetching the selected posts failed. Try again.");
  }
}
