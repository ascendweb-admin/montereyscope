import { readXMutation } from "@/lib/x/http";
import { researchError } from "@/lib/x/research/http";
import { ResearchInputError } from "@/lib/x/research/repository";
import { getRetrievalEngine } from "@/lib/x/research/retrieval";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const { id } = await context.params;
    const engine = getRetrievalEngine();
    if (!["cancel", "resume"].includes(String(body.value.action)))
      throw new ResearchInputError("Choose Cancel or Resume.");
    const job = body.value.action === "cancel" ? engine.cancel(id) : engine.resume(id);
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
