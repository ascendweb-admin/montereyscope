import { crossOriginRejection, isSameOriginMutation, readBoundedJson } from "@/lib/ai/auth/http";
import { getModelCatalog } from "@/lib/ai/models/catalog";
import type { AiBackendId } from "@/lib/ai/backend-id";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isProviderId(value: unknown): value is AiBackendId {
  return value === "codex" || value === "opencode" || value === "claude";
}

/**
 * Refreshes discovered model catalogs. Automatic requests respect TTL and
 * backoff; explicit manual requests bypass them while sharing any
 * in-flight discovery, and applies a short cooldown. Providers refresh
 * independently; one failing provider never blocks the others. The response
 * is the same safe snapshot the GET route serves.
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const body = await readBoundedJson(request);
  if (!body.ok) {
    return body.response;
  }
  const record =
    typeof body.value === "object" && body.value !== null
      ? (body.value as Record<string, unknown>)
      : {};
  const provider = record.provider;
  if (provider !== undefined && !isProviderId(provider)) {
    return Response.json(
      {
        error: {
          code: "invalid_provider",
          message: "Provider must be one of: codex, opencode, claude.",
        },
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    if (record.manual !== undefined && typeof record.manual !== "boolean") {
      return Response.json(
        { error: { code: "invalid_refresh", message: "manual must be a boolean." } },
        { status: 400 },
      );
    }
    const catalog = getModelCatalog();
    if (isProviderId(provider)) {
      await catalog.refresh(provider, { manual: record.manual === true });
    } else {
      await catalog.refreshAll({ manual: record.manual === true });
    }
    return Response.json(catalog.getFullSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[api/ai/models/refresh] refresh failed:", error);
    return Response.json(
      {
        error: {
          code: "refresh_failed",
          message: "The model list could not be refreshed.",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
