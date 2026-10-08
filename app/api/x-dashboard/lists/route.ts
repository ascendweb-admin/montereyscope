import { getDb } from "@/lib/db/connection";
import { readXMutation } from "@/lib/x/http";
import { researchError } from "@/lib/x/research/http";
import { listResearchLists, saveResearchList } from "@/lib/x/research/repository";
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json(
      { lists: listResearchLists(getDb()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}

/** POST /api/x-dashboard/lists — {name, description?, creatorIds} creates a list. */
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const { name, description, creatorIds } = body.value;
    return Response.json(
      { list: saveResearchList(getDb(), { name, description: description ?? "", creatorIds }) },
      { status: 201 },
    );
  } catch (error) {
    return researchError(error);
  }
}
