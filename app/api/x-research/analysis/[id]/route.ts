import { readXMutation } from "@/lib/x/http";
import { researchError } from "@/lib/x/research/http";
import { getResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { ResearchInputError } from "@/lib/x/research/input";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    const engine = getResearchAnalysisEngine();
    const job = engine.job(id);
    const mode = params.get("collection") ?? "related";
    if (!["related", "all", "unfinished"].includes(mode))
      throw new ResearchInputError("Choose a valid result collection.");
    const results = engine.results(
      id,
      params.has("page") ? Number(params.get("page")) : 1,
      mode as "related" | "all" | "unfinished",
    );
    return Response.json(
      {
        job,
        results,
        citationAuthors: Object.fromEntries(
          [
            ...new Set(
              job.state.result?.claims.flatMap((c) => c.evidence.map((e) => e.postId)) ?? [],
            ),
          ].map((postId) => {
            const source = engine.source(id, postId);
            return [
              postId,
              {
                name: source.tweet.authorName,
                handle: source.tweet.authorHandle,
                quotedName:
                  source.tweet.quoted?.name ??
                  source.tweet.quoted?.handle ??
                  "Unspecified quoted speaker",
                provenance: source.provenance,
              },
            ];
          }),
        ),
        ...(params.has("tweetId") ? { source: engine.source(id, params.get("tweetId")!) } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return researchError(error);
  }
}
export async function POST(request: Request, context: Context) {
  const body = await readXMutation(request);
  if (!body.ok) return body.response;
  try {
    const { id } = await context.params;
    const engine = getResearchAnalysisEngine();
    if (!["cancel", "resume"].includes(String(body.value.action)))
      throw new ResearchInputError("Choose Cancel or Resume.");
    const job =
      body.value.action === "cancel" ? engine.cancel(id) : engine.resume(id, body.value.limits);
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return researchError(error);
  }
}
