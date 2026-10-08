import { getAiBackend } from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

// Settings live in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";

/**
 * GET /api/settings/ai-backend — the provider the AI features currently run
 * on. A plain settings read: unlike /api/ai/auth it never probes the CLIs.
 */
export async function GET() {
  return Response.json(
    { value: getAiBackend(getDb()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
