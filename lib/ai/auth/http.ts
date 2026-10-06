/**
 * Shared HTTP plumbing for the AI auth routes (provider-auth stage).
 * Server-only.
 *
 * Everything under /api/ai/auth is a mutation of local CLI credentials, so
 * every route: answers with `Cache-Control: no-store`, accepts only bounded
 * JSON bodies, and (in ordinary web mode) rejects cross-origin mutation
 * requests before touching a provider. Desktop builds additionally sit
 * behind the SCOPE_DESKTOP_TOKEN gate in proxy.ts.
 */
import type { AuthErrorInfo } from "../auth-types";

/** Headers every auth response carries. */
export const AUTH_NO_STORE = { "Cache-Control": "no-store" } as const;

/** JSON response with the no-store header always attached. */
export function authJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: AUTH_NO_STORE });
}

export type ReadJsonResult = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * Reads a JSON body with a hard byte cap. Content-Length is checked first so
 * an oversized body can be refused without buffering it; the actual text is
 * measured again because the header can lie or be absent.
 */
export async function readBoundedJson(request: Request, maxBytes = 8_192): Promise<ReadJsonResult> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      response: authJson(
        { error: { code: "body_too_large", message: "The request body is too large." } },
        413,
      ),
    };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: authJson(
        { error: { code: "invalid_body", message: "The request body could not be read." } },
        400,
      ),
    };
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return {
      ok: false,
      response: authJson(
        { error: { code: "body_too_large", message: "The request body is too large." } },
        413,
      ),
    };
  }
  if (text.trim().length === 0) {
    return { ok: true, value: {} };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      response: authJson(
        { error: { code: "invalid_body", message: "The request body is not valid JSON." } },
        400,
      ),
    };
  }
}

/**
 * True when a mutation may proceed. Ordinary web requests from the app's own
 * origin (or non-browser clients without an Origin header) are allowed;
 * any other Origin is a cross-site attempt and is refused.
 *
 * The comparison uses the request's `Host` header, not `request.url`: Next
 * normalizes the URL host to `localhost`, while a browser may legitimately
 * have navigated to `127.0.0.1`, so comparing the two would reject the app's
 * own requests. Origin must match the host the request was actually sent to.
 */
export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") {
    return true;
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  let requestProtocol: string;
  let host: string;
  try {
    const requestUrl = new URL(request.url);
    // HTTP/1.1 always carries Host; fall back to the URL's host for
    // programmatic requests (tests, internal calls).
    host = request.headers.get("host") ?? requestUrl.host;
    requestProtocol = requestUrl.protocol;
  } catch {
    return false;
  }
  if (host === "" || originUrl.host !== host) {
    return false;
  }
  return originUrl.protocol === requestProtocol;
}

/** The shared 403 response for a rejected cross-origin mutation. */
export function crossOriginRejection(): Response {
  return authJson(
    { error: { code: "cross_origin", message: "Cross-origin requests are not allowed." } },
    403,
  );
}

/** Maps an auth error code onto an HTTP status. */
export function statusForAuthError(error: AuthErrorInfo | undefined): number {
  switch (error?.code) {
    case undefined:
      return 200;
    case "invalid_key":
    case "invalid_body":
    case "invalid_code":
    case "code_rejected":
      return 400;
    case "in_progress":
    case "nothing_to_cancel":
    case "nothing_to_submit":
    case "not_ready":
    case "stale_attempt":
    case "provider_busy":
    case "signing_out":
    case "not_installed":
      return 409;
    default:
      return 500;
  }
}
