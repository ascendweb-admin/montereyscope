import { getDb } from "@/lib/db/connection";
import {
  deleteResearchList,
  getResearchList,
  parseId,
  saveResearchList,
} from "@/lib/x/research/repository";
import { researchBody, researchError } from "@/lib/x/research/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    const id = parseId((await context.params).id);
    const body = await researchBody(request);
    return Response.json({
      list: saveResearchList(getDb(), { ...getResearchList(getDb(), id), ...body, id }),
    });
  } catch (error) {
    return researchError(error);
  }
}
export async function DELETE(_request: Request, context: Context) {
  try {
    deleteResearchList(getDb(), parseId((await context.params).id));
    return Response.json({ deleted: true });
  } catch (error) {
    return researchError(error);
  }
}
