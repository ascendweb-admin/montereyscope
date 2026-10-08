import { getDb } from "@/lib/db/connection";
import { isSameOriginMutation, crossOriginRejection } from "@/lib/ai/auth/http";
import { readXMutation } from "@/lib/x/http";
import { getInsightEngine } from "@/lib/x/dashboard/insights";
import { saveInsightReport } from "@/lib/x/dashboard/report";
import { researchError } from "@/lib/x/research/http";
import { ResearchInputError } from "@/lib/x/research/input";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

/** GET — the analysis with its conversation (live text while running) and cited posts. */
export async function GET(_request: Request, context: Context) {
  try {
    return Response.json(
      { insight: getInsightEngine().detail((await context.params).id) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}

/** POST — {action: "ask", question} | {action: "stop"} | {action: "save"}. */
export async function POST(request: Request, context: Context) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const id = (await context.params).id;
    const engine = getInsightEngine();
    switch (body.value.action) {
      case "ask":
        return Response.json({ insight: await engine.followUp(id, body.value.question) });
      case "stop":
        return Response.json({ insight: engine.cancel(id) });
      case "save": {
        const report = saveInsightReport(getDb(), engine, id);
        return Response.json({ insight: engine.detail(id), reportId: report.id });
      }
      default:
        throw new ResearchInputError("Choose ask, stop or save.");
    }
  } catch (error) {
    return researchError(error);
  }
}

export async function DELETE(request: Request, context: Context) {
  if (!isSameOriginMutation(request)) return crossOriginRejection();
  try {
    getInsightEngine().remove((await context.params).id);
    return Response.json({ deleted: true });
  } catch (error) {
    return researchError(error);
  }
}
