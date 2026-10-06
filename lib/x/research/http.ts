import { ResearchInputError, isResearchInputError } from "./input";
export function researchError(error: unknown): Response {
  if (isResearchInputError(error))
    return Response.json({ error: error.message }, { status: error.status });
  return Response.json(
    { error: "The local research data could not be loaded or saved. Please try again." },
    { status: 500 },
  );
}
export async function researchBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new ResearchInputError("Provide a valid JSON object.");
  }
}
