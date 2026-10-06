/**
 * HTTP mapping for the typed X errors, shared by the tweet route handlers.
 * Server-only; no credentials or provider details cross this module.
 */
import type { XErrorCode } from "./model";
import { isSameOriginMutation, crossOriginRejection } from "@/lib/ai/auth/http";

/** Reject before reading or doing work; cap streamed bodies even without Content-Length. */
export async function readXMutation(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const fail = (status: number, code: string) => ({
    ok: false as const,
    response: Response.json(
      { error: { code } },
      { status, headers: { "Cache-Control": "no-store" } },
    ),
  });
  if (!isSameOriginMutation(request) || request.headers.get("sec-fetch-site") === "cross-site") {
    return { ok: false, response: crossOriginRejection() };
  }
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  ) {
    return fail(415, "json_required");
  }
  const host = request.headers.get("host") ?? new URL(request.url).host;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return fail(403, "invalid_host");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return fail(403, "invalid_host");
  const maxBytes = 8_192;
  if (Number(request.headers.get("content-length")) > maxBytes) return fail(413, "body_too_large");
  const reader = request.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          return fail(413, "body_too_large");
        }
        chunks.push(value);
      }
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(400, "invalid_body");
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return fail(400, "invalid_body");
  } finally {
    reader?.releaseLock();
  }
}

export const X_ERROR_CODE_TO_STATUS: Record<XErrorCode, number> = {
  not_connected: 503,
  unsupported_runtime: 503,
  session_expired: 401,
  verification_required: 403,
  rate_limited: 429,
  not_found: 404,
  protected_account: 422,
  network: 502,
  timeout: 504,
  cancelled: 499,
  invalid_response: 502,
};

export function xErrorStatus(code: string): number {
  return (X_ERROR_CODE_TO_STATUS as Record<string, number>)[code] ?? 500;
}
