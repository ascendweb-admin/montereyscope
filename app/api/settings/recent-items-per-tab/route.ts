import {
  getRecentItemsPerTab,
  setRecentItemsPerTab,
  validateRecentItemsPerTab,
} from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

// Settings live in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";

/** GET /api/settings/recent-items-per-tab — current feed window setting. */
export async function GET() {
  return Response.json(
    { value: getRecentItemsPerTab(getDb()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

interface PutRequestBody {
  value?: unknown;
}

/**
 * PUT /api/settings/recent-items-per-tab — set the recent-item limit per
 * channel tab (whole number 5–300). Applies to future refreshes only.
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
          message: 'Request body must be JSON with a numeric "value" field.',
        },
      },
      { status: 400 },
    );
  }

  const validated = validateRecentItemsPerTab(body.value);
  if (!validated.ok) {
    return Response.json(
      { error: { code: "invalid_value", message: validated.message } },
      {
        status: 400,
      },
    );
  }

  try {
    const saved = setRecentItemsPerTab(getDb(), validated.value);
    return Response.json({ value: saved });
  } catch {
    return Response.json(
      { error: { code: "unexpected_error", message: "The setting could not be saved." } },
      { status: 500 },
    );
  }
}
