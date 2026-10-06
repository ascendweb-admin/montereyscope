import { cancelClaudeLogin, startClaudeLogin } from "@/lib/ai/auth";
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

function currentBackend() {
  return getAiBackend(getDb());
}

/**
 * Starts the claude CLI's native subscription login
 * (`claude auth login --claudeai`). The CLI opens the machine's browser,
 * prints the official login URL, and finishes when the callback lands or the
 * browser's sign-in code is submitted to /api/ai/auth/claude-login/code. The
 * response carries the tracked attempt plus a fresh snapshot.
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const result = await startClaudeLogin(currentBackend());
  return authJson(result, result.ok ? 202 : statusForAuthError(result.error));
}

/**
 * Cancels the matching Claude sign-in. The body may pin the attempt id so a
 * stale dialog cannot cancel a newer attempt.
 */
export async function DELETE(request: Request) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const body = await readBoundedJson(request);
  if (!body.ok) {
    return body.response;
  }
  const attemptId =
    typeof body.value === "object" && body.value !== null
      ? (body.value as { attemptId?: unknown }).attemptId
      : undefined;
  const result = await cancelClaudeLogin(
    typeof attemptId === "string" && attemptId.length > 0 ? attemptId : undefined,
    currentBackend(),
  );
  return authJson(result, result.ok ? 200 : statusForAuthError(result.error));
}
