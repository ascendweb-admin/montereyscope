import { submitClaudeLoginCode } from "@/lib/ai/auth";
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
 * Hands the browser's sign-in code to the matching in-flight
 * `claude auth login` child on stdin, so the native subscription flow can
 * finish without a terminal. The code is bound to the attempt id, validated
 * as a single bounded line, and never stored, echoed, or logged.
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
      ? (body.value as { code?: unknown; attemptId?: unknown })
      : {};
  const code = typeof record.code === "string" ? record.code : null;
  const attemptId =
    typeof record.attemptId === "string" && record.attemptId.length > 0
      ? record.attemptId
      : undefined;
  if (code === null || code.trim().length === 0) {
    return authJson(
      {
        ok: false,
        error: { code: "invalid_code", message: "Paste the code from the browser first." },
      },
      400,
    );
  }
  const result = await submitClaudeLoginCode(code, attemptId, getAiBackend(getDb()));
  return authJson(result, result.ok ? 200 : statusForAuthError(result.error));
}
