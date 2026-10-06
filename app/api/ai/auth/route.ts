import { getAiAuthStatus } from "@/lib/ai/auth";
import { authJson } from "@/lib/ai/auth/http";
import { getAiBackend } from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Shared safe snapshot of every provider's login state (provider-auth
 * stage): installation/compatibility, account method, Go key presence, and
 * any tracked sign-in attempt. Read-only, never cached, and never includes
 * tokens, keys, codes, or raw CLI output.
 */
export async function GET() {
  try {
    const backend = getAiBackend(getDb());
    const snapshot = await getAiAuthStatus(backend);
    return authJson(snapshot);
  } catch (error) {
    console.error("[api/ai/auth] status read failed:", error);
    return authJson(
      {
        error: {
          code: "status_failed",
          message: "The AI authentication status could not be read.",
        },
      },
      500,
    );
  }
}
