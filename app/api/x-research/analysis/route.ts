import { readXMutation } from "@/lib/x/http";
import { researchError } from "@/lib/x/research/http";
import { getResearchAnalysisEngine } from "@/lib/x/research/analysis";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET() {
  try {
    return Response.json(
      { jobs: getResearchAnalysisEngine().jobs() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const job = await getResearchAnalysisEngine().start(body.value);
    return Response.json({ job }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
