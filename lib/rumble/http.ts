/**
 * Plain HTTPS fetching for Rumble pages — the one place that talks to
 * rumble.com directly. yt-dlp's HTTP stack is intermittently throttled by
 * Rumble's edge (verified: 429/403 for yt-dlp while identical requests via
 * Node/curl with browser-like headers pass), so the module sends a pinned
 * browser-shaped header set, follows redirects itself so a per-hop
 * Cloudflare cookie survives into the next hop, and retries once after a
 * pause when the edge throttles.
 *
 * Server-only. Response bodies are capped; failures are typed, and raw
 * network details stay here (callers map reasons to user-safe messages).
 */

export type RumbleFetchFailureReason =
  | "throttled"
  | "unavailable"
  | "network"
  | "timeout"
  | "too_large";

export type RumbleFetchResult =
  | { ok: true; body: string; finalUrl: string }
  | { ok: false; reason: RumbleFetchFailureReason };

export interface RumbleFetchOptions {
  timeoutMs?: number;
  maxBodyBytes?: number;
  attempts?: number;
  /** Pause between attempts; tests inject a near-zero value. */
  backoffMs?: number;
  /** Test seam: defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Server-side diagnostics only; never surfaced to the UI. */
  log?: (message: string) => void;
}

export const DEFAULT_RUMBLE_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_RUMBLE_MAX_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RUMBLE_ATTEMPTS = 2;
export const DEFAULT_RUMBLE_BACKOFF_MS = 6_000;

/**
 * Header set verified against rumble.com in testing: with these the page and
 * embed endpoints returned 200 consistently, without them Cloudflare served
 * 403 challenge pages.
 */
export function rumbleRequestHeaders(cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-us,en;q=0.5",
    "Sec-Fetch-Mode": "navigate",
    Referer: "https://rumble.com/",
  };
  if (cookie && cookie.length > 0) {
    headers.Cookie = cookie;
  }
  return headers;
}

const MAX_HOPS = 5;

interface HopAttempt {
  timeoutMs: number;
  maxBodyBytes: number;
  fetchImpl: typeof fetch;
}

/**
 * One attempt: manually follows redirects so cookies set on a challenge hop
 * (e.g. a 307 back to the same URL) are attached to the next hop.
 */
async function attemptFetch(
  url: string,
  options: HopAttempt,
): Promise<
  { ok: true; body: string; finalUrl: string } | { ok: false; reason: RumbleFetchFailureReason }
> {
  let current = url;
  let cookie = "";
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    let response: Response;
    try {
      response = await options.fetchImpl(current, {
        headers: rumbleRequestHeaders(cookie || undefined),
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return { ok: false, reason: "timeout" };
      }
      return { ok: false, reason: "network" };
    }

    cookie = mergeCookies(cookie, typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : []);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { ok: false, reason: "network" };
      }
      current = new URL(location, current).toString();
      continue;
    }

    if (response.status === 200) {
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > options.maxBodyBytes) {
        return { ok: false, reason: "too_large" };
      }
      return { ok: true, body, finalUrl: current };
    }
    if (response.status === 403 || response.status === 429) {
      return { ok: false, reason: "throttled" };
    }
    if (response.status === 404 || response.status === 410) {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: false, reason: "network" };
  }
  return { ok: false, reason: "network" };
}

/** Merges fresh Set-Cookie values into the running cookie string. */
function mergeCookies(existing: string, setCookieValues: string[]): string {
  if (setCookieValues.length === 0) {
    return existing;
  }
  const merged = new Map(
    existing
      .split("; ")
      .filter(Boolean)
      .map((pair) => {
        const eq = pair.indexOf("=");
        return eq > 0 ? [pair.slice(0, eq), pair.slice(eq + 1)] : null;
      })
      .filter((pair): pair is [string, string] => pair !== null),
  );
  for (const entry of setCookieValues) {
    const pair = entry.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) {
      merged.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * Fetches one Rumble page: up to `attempts` attempts with a pause between
 * them whenever the edge throttles (403/429). Everything else fails fast —
 * 404 is definitive, and network or timeout problems rarely resolve within
 * seconds.
 */
export async function fetchRumblePage(
  url: string,
  options: RumbleFetchOptions = {},
): Promise<RumbleFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUMBLE_FETCH_TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_RUMBLE_MAX_BODY_BYTES;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RUMBLE_ATTEMPTS);
  const backoffMs = options.backoffMs ?? DEFAULT_RUMBLE_BACKOFF_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let lastReason: RumbleFetchFailureReason = "network";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await attemptFetch(url, { timeoutMs, maxBodyBytes, fetchImpl });
    if (outcome.ok) {
      return outcome;
    }
    lastReason = outcome.reason;
    options.log?.(`rumble fetch attempt ${attempt}/${attempts} for ${url} failed: ${lastReason}`);
    if (lastReason !== "throttled" || attempt === attempts) {
      break;
    }
    await sleep(backoffMs);
  }
  return { ok: false, reason: lastReason };
}
