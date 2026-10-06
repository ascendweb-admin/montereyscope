import { getDb } from "@/lib/db/connection";
import { listResearchLists, saveResearchList } from "@/lib/x/research/repository";
import { researchBody, researchError } from "@/lib/x/research/http";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(
      { lists: listResearchLists(getDb()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
export async function POST(request: Request) {
  try {
    const body = await researchBody(request);
    return Response.json(
      {
        list: saveResearchList(getDb(), {
          name: body.name,
          description: body.description,
          creatorIds: body.creatorIds,
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    return researchError(error);
  }
}
