import { getDb } from "@/lib/db/connection";
import { isSameOriginMutation, crossOriginRejection } from "@/lib/ai/auth/http";
import { readXMutation } from "@/lib/x/http";
import { researchError } from "@/lib/x/research/http";
import {
  deleteResearchList,
  getResearchList,
  parseId,
  saveResearchList,
} from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

/** PATCH /api/x-dashboard/lists/:id — rename, describe, or change members. */
export async function PATCH(request: Request, context: Context) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const db = getDb();
    const id = parseId((await context.params).id);
    const current = getResearchList(db, id);
    const { name, description, creatorIds } = body.value;
    return Response.json({
      list: saveResearchList(db, {
        id,
        name: name ?? current.name,
        description: description ?? current.description,
        creatorIds: creatorIds ?? current.creatorIds,
      }),
    });
  } catch (error) {
    return researchError(error);
  }
}

/** DELETE /api/x-dashboard/lists/:id — removes the list only; creators and posts stay. */
export async function DELETE(request: Request, context: Context) {
  if (!isSameOriginMutation(request)) return crossOriginRejection();
  try {
    const db = getDb();
    deleteResearchList(db, parseId((await context.params).id));
    return Response.json({ deleted: true });
  } catch (error) {
    return researchError(error);
  }
}
