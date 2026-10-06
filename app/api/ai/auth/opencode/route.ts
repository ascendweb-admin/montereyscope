import { saveOpenCodeApiKey } from "@/lib/ai/auth";
import {
  authJson,
  crossOriginRejection,
  isSameOriginMutation,
  readBoundedJson,
  statusForAuthError,
} from "@/lib/ai/auth/http";
import { getAiBackend } from "@/lib/settings/settings";
import { getDb } from "@/lib/db/connection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Saves (or replaces) an OpenCode Go API key in opencode's own credential
 * store, preserving every other provider entry. The body cap is small: an
 * OpenCode key is at most a few hundred characters. The key never leaves
 * this machine, is never echoed back, and is never logged.
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const body = await readBoundedJson(request, 4_096);
  if (!body.ok) {
    return body.response;
  }
  const apiKey =
    typeof body.value === "object" && body.value !== null
      ? (body.value as { apiKey?: unknown }).apiKey
      : null;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    return authJson(
      { ok: false, error: { code: "invalid_key", message: "Paste your OpenCode API key first." } },
      400,
    );
  }
  const result = await saveOpenCodeApiKey(apiKey, getAiBackend(getDb()));
  return authJson(result, result.ok ? 200 : statusForAuthError(result.error));
}
