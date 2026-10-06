import { getDb } from "@/lib/db/connection";
import { readXMutation } from "@/lib/x/http";
import { researchError } from "@/lib/x/research/http";
import { getResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { conversationForJob, startResearchConversation } from "@/lib/x/research/experience";
import { getCorpusScope } from "@/lib/x/research/corpus";
import { ResearchInputError } from "@/lib/x/research/input";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const result = await startResearchConversation(
      getDb(),
      getResearchAnalysisEngine(),
      body.value,
    );
    return Response.json(result, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
export function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("jobId");
    if (!id) throw new ResearchInputError("Choose a research turn.");
    const db = getDb(),
      job = getResearchAnalysisEngine().job(id);
    return Response.json(
      { conversation: conversationForJob(db, id), scope: getCorpusScope(db, job.scopeId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
