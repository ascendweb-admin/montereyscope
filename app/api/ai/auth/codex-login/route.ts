import { cancelCodexLogin, startCodexLogin } from "@/lib/ai/auth";
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
 * Starts the official codex sign-in. The body may select the device-code
 * variant (`{ mode: "device" }`); the default is the browser flow. The
 * response carries the tracked attempt plus a fresh snapshot, so an
 * immediate completion is never lost to polling.
 */
export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return crossOriginRejection();
  }
  const body = await readBoundedJson(request);
  if (!body.ok) {
    return body.response;
  }
  const mode =
    typeof body.value === "object" &&
    body.value !== null &&
    (body.value as { mode?: unknown }).mode === "device"
      ? "device"
      : "browser";
  const result = await startCodexLogin(mode, currentBackend());
  return authJson(result, result.ok ? 202 : statusForAuthError(result.error));
}

/**
 * Cancels the matching codex attempt. The body may pin the attempt id so a
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
  const result = await cancelCodexLogin(
    typeof attemptId === "string" && attemptId.length > 0 ? attemptId : undefined,
    currentBackend(),
  );
  return authJson(result, result.ok ? 200 : statusForAuthError(result.error));
}
