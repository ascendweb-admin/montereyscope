import { readXMutation } from "@/lib/x/http";
import { getInsightEngine } from "@/lib/x/dashboard/insights";
import { researchError } from "@/lib/x/research/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/x-dashboard/insights — recent analyses, newest first. */
export function GET() {
  try {
    return Response.json(
      { insights: getInsightEngine().list() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}

/** POST /api/x-dashboard/insights — {scope, preset?|question?} starts an analysis. */
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const insight = await getInsightEngine().create(body.value);
    return Response.json({ insight }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
