import {
  getPreferredCaptionLanguages,
  setPreferredCaptionLanguages,
  validatePreferredCaptionLanguages,
} from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

// Settings live in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";

/** GET /api/settings/preferred-caption-languages — ordered caption language list. */
export async function GET() {
  return Response.json(
    { languages: getPreferredCaptionLanguages() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface PutRequestBody {
  value?: unknown;
}

/**
 * PUT /api/settings/preferred-caption-languages — set the ordered caption
 * compatibility setting. Only English is supported.
 */
export async function PUT(request: Request) {
  let body: PutRequestBody;
  try {
    body = (await request.json()) as PutRequestBody;
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_body",
          message: 'Request body must be JSON with a "value" field.',
        },
      },
      { status: 400 },
    );
  }

  const validated = validatePreferredCaptionLanguages(body.value);
  if (!validated.ok) {
    return Response.json(
      { error: { code: "invalid_value", message: validated.message } },
      { status: 400 },
    );
  }

  try {
    const saved = setPreferredCaptionLanguages(getDb(), validated.value);
    return Response.json({ languages: saved, adjusted: validated.adjusted });
  } catch {
    return Response.json(
      { error: { code: "unexpected_error", message: "The setting could not be saved." } },
      { status: 500 },
    );
  }
}
