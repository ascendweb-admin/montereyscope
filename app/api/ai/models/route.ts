import { authJson, AUTH_NO_STORE } from "@/lib/ai/auth/http";
import { getModelCatalog } from "@/lib/ai/models/catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Safe model catalog snapshot (dynamic catalog stage): normalized models,
 * revisions, freshness, and client-safe status per provider. Read-only and
 * never cached; no credentials, account identifiers, or CLI output cross this
 * boundary.
 */
export async function GET() {
  try {
    const snapshot = await getModelCatalog().readSnapshot();
    return authJson(snapshot);
  } catch (error) {
    console.error("[api/ai/models] snapshot read failed:", error);
    return Response.json(
      { error: { code: "catalog_failed", message: "The model catalog could not be read." } },
      { status: 500, headers: AUTH_NO_STORE },
    );
  }
}
