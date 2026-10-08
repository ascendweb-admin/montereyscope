import { getDb } from "@/lib/db/connection";
import { readXMutation } from "@/lib/x/http";
import { markSeen } from "@/lib/x/dashboard/feed";
import { researchError } from "@/lib/x/research/http";
import { getResearchList, parseId } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

/** POST /api/x-dashboard/seen — {listId|null} marks a scope as read up to now. */
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const db = getDb();
    const listId = body.value.listId == null ? null : parseId(body.value.listId);
    if (listId !== null) getResearchList(db, listId);
    markSeen(db, listId);
    return Response.json({ ok: true });
  } catch (error) {
    return researchError(error);
  }
}
