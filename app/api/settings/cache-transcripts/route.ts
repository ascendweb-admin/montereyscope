import {
  getCacheTranscriptsEnabled,
  setCacheTranscriptsEnabled,
  validateCacheTranscriptsEnabled,
} from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

// Settings live in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";

/** GET /api/settings/cache-transcripts — whether transcripts are cached. */
export async function GET() {
  return Response.json(
    { enabled: getCacheTranscriptsEnabled(getDb()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface PutRequestBody {
  value?: unknown;
}

/** PUT /api/settings/cache-transcripts — enable or disable transcript caching. */
export async function PUT(request: Request) {
  let body: PutRequestBody;
  try {
    body = (await request.json()) as PutRequestBody;
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_body",
          message: 'Request body must be JSON with a boolean "value" field.',
        },
      },
      { status: 400 },
    );
  }

  const validated = validateCacheTranscriptsEnabled(body.value);
  if (!validated.ok) {
    return Response.json(
      { error: { code: "invalid_value", message: validated.message } },
      { status: 400 },
    );
  }

  try {
    const saved = setCacheTranscriptsEnabled(getDb(), validated.value);
    return Response.json({ enabled: saved });
  } catch {
    return Response.json(
      { error: { code: "unexpected_error", message: "The setting could not be saved." } },
      { status: 500 },
    );
  }
}
