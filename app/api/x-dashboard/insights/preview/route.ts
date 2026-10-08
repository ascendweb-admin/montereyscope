import { readXMutation } from "@/lib/x/http";
import { getInsightEngine } from "@/lib/x/dashboard/insights";
import { researchError } from "@/lib/x/research/http";
export const dynamic = "force-dynamic";

/** POST /api/x-dashboard/insights/preview — {scope} counts the posts an analysis would read. */
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    return Response.json(getInsightEngine().preview(body.value.scope), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return researchError(error);
  }
}
