import { getDb } from "@/lib/db/connection";
import { readXMutation } from "@/lib/x/http";
import { STALE_AFTER_MS, startSync, syncSnapshot } from "@/lib/x/dashboard/sync";
import { getRetrievalEngine } from "@/lib/x/research/retrieval";
import { researchError } from "@/lib/x/research/http";
import { creatorIds, ResearchInputError } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

/**
 * POST /api/x-dashboard/sync — {creatorIds, listId?, label?, ifStale?} syncs
 * the creators from X; with ifStale it only starts when something is stale.
 * {action: "stop", creatorIds} stops these creators' syncing, leaving other creators running.
 */
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const db = getDb();
    const input = body.value;
    const ids = creatorIds(db, input.creatorIds);
    if (input.action === "stop") {
      if (!ids.length) throw new ResearchInputError("Choose accounts to stop syncing.");
      getRetrievalEngine().stopCreators(ids);
      return Response.json({ sync: syncSnapshot(ids) }, { headers: { "Cache-Control": "no-store" } });
    }
    const result = await startSync(db, {
      listId: Number.isSafeInteger(input.listId) ? (input.listId as number) : null,
      label: typeof input.label === "string" && input.label.trim() ? input.label.slice(0, 100) : "Creators",
      creatorIds: ids,
      ...(input.ifStale === true ? { ifStaleMs: STALE_AFTER_MS } : {}),
    });
    return Response.json(
      { started: result.started, reason: result.reason ?? null, sync: syncSnapshot(ids) },
      { status: result.started ? 202 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
