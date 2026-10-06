import { logoutProvider } from "@/lib/ai/auth";
import {
  authJson,
  crossOriginRejection,
  isSameOriginMutation,
  statusForAuthError,
} from "@/lib/ai/auth/http";
import { isAuthProviderId } from "@/lib/ai/auth-types";
import { getAiBackend } from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ provider: string }>;
}

/**
 * Explicit sign-out for one allowlisted provider. This is shared-machine CLI
 * sign-out, not subscription cancellation: codex/claude stop the shared CLI
 * login, and opencode removes only the local Go key. A pending login is
 * settled first so a late callback cannot restore the credential, and
 * logout is refused while that provider has an AI run in flight.
 */
export async function POST(request: Request, ctx: RouteParams) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const { provider } = await ctx.params;
  if (!isAuthProviderId(provider)) {
    return authJson(
      { ok: false, error: { code: "unknown_provider", message: "Unknown AI provider." } },
      404,
    );
  }
  const backend = getAiBackend(getDb());
  try {
    const result = await logoutProvider(provider, backend);
    return authJson(result, result.ok ? 200 : statusForAuthError(result.error));
  } catch (error) {
    console.error("[api/ai/auth/logout] sign-out failed:", error);
    return authJson(
      {
        ok: false,
        error: { code: "logout_failed", message: "The provider could not be signed out." },
      },
      500,
    );
  }
}
