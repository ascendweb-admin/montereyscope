import {
  addCreatorFromUrl,
  httpStatusForServiceError,
  toCreatorSummary,
} from "@/lib/creators/service";
import { listCreators } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import { listCreatorCategoryAssignments } from "@/lib/categories";

// The library reads and writes the local SQLite file at request time.
export const dynamic = "force-dynamic";

/** GET /api/creators — list saved creators (safe summaries only). */
export async function GET() {
  const db = getDb();
  const assignments = listCreatorCategoryAssignments(db);
  return Response.json(
    {
      creators: listCreators(db).map((creator) => ({
        ...toCreatorSummary(creator),
        categories: assignments.get(creator.id) ?? [],
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface AddCreatorRequestBody {
  url?: unknown;
}

/**
 * POST /api/creators — resolve a channel URL via yt-dlp and save it.
 * Body: { "url": "https://www.youtube.com/@…" }
 */
export async function POST(request: Request) {
  let body: AddCreatorRequestBody;
  try {
    body = (await request.json()) as AddCreatorRequestBody;
  } catch {
    return Response.json(
      { error: { code: "invalid_body", message: 'Request body must be JSON with a "url" field.' } },
      { status: 400 },
    );
  }

  if (typeof body.url !== "string") {
    return Response.json(
      {
        error: {
          code: "invalid_url",
          message: 'Provide the creator\'s YouTube channel URL as "url".',
        },
      },
      { status: 400 },
    );
  }

  try {
    const outcome = await addCreatorFromUrl(getDb(), body.url);
    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error },
        { status: httpStatusForServiceError(outcome.error) },
      );
    }
    const status = outcome.status === "created" ? 201 : 200;
    return Response.json({ status: outcome.status, creator: outcome.creator }, { status });
  } catch {
    return Response.json(
      { error: { code: "unexpected_error", message: "The creator could not be added right now." } },
      { status: 500 },
    );
  }
}
