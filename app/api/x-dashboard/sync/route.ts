import { getDb } from "@/lib/db/connection";
import { getXSyncSettings } from "@/lib/settings/settings";
import { readXMutation } from "@/lib/x/http";
import { checkEveryMs, connectionProblem, startSync, syncSnapshot } from "@/lib/x/dashboard/sync";
import { getXConnectionStatus } from "@/lib/x/service";
import { getRetrievalEngine } from "@/lib/x/research/retrieval";
import { researchError } from "@/lib/x/research/http";
import { creatorIds, ResearchInputError } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

/**
 * GET /api/x-dashboard/sync?creators=1,2 — the sync state of these creators
 * alone: what the source pickers poll while their refresh of X runs. Reads
 * local state only.
 */
export function GET(request: Request) {
  try {
    const db = getDb();
    const param = new URL(request.url).searchParams.get("creators") ?? "";
    const ids = creatorIds(db, param.split(",").filter(Boolean));
    return Response.json({ sync: syncSnapshot(ids) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}

/**
 * POST /api/x-dashboard/sync — {creatorIds, listId?, label?, ifStale?} checks
 * the creators for new posts now, ahead of all automatic work; with ifStale
 * only the ones not checked recently. With ifConnected, nothing starts while
 * X can't be read: the answer says why instead (reason "disconnected").
 * {action: "stop", creatorIds} stops these creators' syncing, leaving other
 * creators running.
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
      return Response.json(
        { sync: syncSnapshot(ids) },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (input.ifConnected === true) {
      const problem = connectionProblem(await getXConnectionStatus());
      if (problem) {
        return Response.json(
          { started: false, reason: "disconnected", message: problem, sync: syncSnapshot(ids) },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }
    const stale = checkEveryMs(ids.length, getXSyncSettings(db).autoSyncMinutes) || 10 * 60_000;
    const result = await startSync(db, {
      listId: Number.isSafeInteger(input.listId) ? (input.listId as number) : null,
      label:
        typeof input.label === "string" && input.label.trim()
          ? input.label.slice(0, 100)
          : "Creators",
      creatorIds: ids,
      ...(input.ifStale === true ? { ifStaleMs: stale } : {}),
    });
    return Response.json(
      { started: result.started, reason: result.reason ?? null, sync: syncSnapshot(ids) },
      { status: result.started ? 202 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
