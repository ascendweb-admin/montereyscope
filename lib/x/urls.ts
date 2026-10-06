/**
 * Strict parser for the X (Twitter) links Scope supports. Everything else is
 * rejected with plain-language feedback. Pure: no network, no database.
 *
 * Supported forms:
 *   https://x.com/<handle>
 *   https://twitter.com/<handle>
 *   https://www.x.com/<handle>          (www and mobile hosts)
 *   https://x.com/<handle>/status/<id>  (single-tweet import)
 *   @handle                             (only when X is explicitly selected)
 *
 * Deliberately NOT supported: non-X hosts, look-alike domains, non-HTTPS
 * protocols, credentials in URLs, search/home/settings pages, and any path
 * that is not a profile or a status link.
 */

export type ParsedXTarget =
  | { kind: "profile"; handle: string }
  | { kind: "status"; handle: string; tweetId: string };

export type XUrlParseResult = { ok: true; target: ParsedXTarget } | { ok: false; message: string };

/** Exact hosts accepted as X addresses. Look-alike domains are rejected. */
const ALLOWED_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "mobile.x.com",
]);

/** X handles: 1–15 characters, letters, digits, underscores. */
const HANDLE_PATTERN = /^[0-9A-Za-z_]{1,15}$/;

/** Status ids are decimal strings; they exceed the safe integer range. */
const TWEET_ID_PATTERN = /^\d{1,20}$/;

/**
 * Reserved top-level paths that are pages, not profiles. A handle can never
 * be one of these, so rejecting them avoids saving `x.com/home` as a creator.
 */
const RESERVED_PATHS = new Set([
  "home",
  "explore",
  "notifications",
  "messages",
  "search",
  "settings",
  "compose",
  "login",
  "logout",
  "signup",
  "i",
  "intent",
  "share",
  "hashtag",
  "tos",
  "privacy",
  "about",
  "account",
  "following",
  "followers",
  "bookmarks",
  "lists",
  "jobs",
  "help",
]);

export function isXHost(hostname: string): boolean {
  return ALLOWED_HOSTS.has(hostname.toLowerCase());
}

/** True when the raw text looks like a bare `@handle` (no scheme, no path). */
export function looksLikeBareHandle(input: string): boolean {
  const trimmed = input.trim();
  return /^@[0-9A-Za-z_]{1,15}$/.test(trimmed);
}

/** Canonical profile URL for a handle. */
export function xProfileUrl(handle: string): string {
  return `https://x.com/${handle}`;
}

/** Canonical status URL for a tweet. */
export function xStatusUrl(handle: string, tweetId: string): string {
  return `https://x.com/${handle}/status/${tweetId}`;
}

function reject(message: string): XUrlParseResult {
  return { ok: false, message };
}

function parseHandle(segment: string): ParsedXTarget | string {
  const handle = segment.startsWith("@") ? segment.slice(1) : segment;
  if (!HANDLE_PATTERN.test(handle)) {
    return "X usernames are 1–15 letters, numbers, or underscores. Double-check the @name in the link.";
  }
  return { kind: "profile", handle };
}

/**
 * Parses raw user input into an X profile or status target, or a friendly
 * rejection. A bare `@handle` is accepted only when `allowBareHandle` is set
 * — the add-creator dialog sets it when the user explicitly picked X, so the
 * default YouTube flow keeps rejecting bare handles.
 */
export function parseXTarget(
  input: string,
  options: { allowBareHandle?: boolean } = {},
): XUrlParseResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return reject(
      "Paste an X profile or post link — for example https://x.com/OpenAI — or an @handle.",
    );
  }

  // Bare @handle: only meaningful when X is the chosen platform, because
  // `@name` alone is ambiguous with every other platform's handle.
  if (trimmed.startsWith("@") && !trimmed.includes("/")) {
    if (!options.allowBareHandle) {
      return reject("Choose X as the platform to add an @handle directly.");
    }
    const parsed = parseHandle(trimmed);
    return typeof parsed === "string" ? reject(parsed) : { ok: true, target: parsed };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject(
      "That does not look like a complete URL. Paste the full address, starting with https://",
    );
  }

  if (url.protocol === "http:") {
    return reject("scope only accepts secure HTTPS X links. Use the https:// version.");
  }
  if (url.protocol !== "https:") {
    return reject(`“${url.protocol}” links are not supported. Only HTTPS X links can be added.`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return reject("Links with embedded usernames or passwords are not allowed.");
  }
  if (!isXHost(url.hostname)) {
    if (/(^|\.)(x|twitter)\.com$/.test(url.hostname)) {
      return reject(`Only x.com and twitter.com links are accepted — “${url.hostname}” is not.`);
    }
    return reject(`Only x.com and twitter.com links can be added — “${url.hostname}” is not X.`);
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return reject("That is the X home page. Open the creator's profile and copy that address.");
  }

  const first = segments[0];
  // The first path segment is a handle unless it is a reserved page.
  if (RESERVED_PATHS.has(first.toLowerCase())) {
    return reject(`That is an X page (/${first.toLowerCase()}), not a creator's profile.`);
  }

  const profile = parseHandle(first);
  if (typeof profile === "string") {
    return reject(profile);
  }

  if (segments.length === 1) {
    return { ok: true, target: profile };
  }

  if (segments.length === 3 && segments[1] === "status") {
    if (!TWEET_ID_PATTERN.test(segments[2])) {
      return reject("That post link does not contain a valid status ID.");
    }
    if (profile.kind !== "profile") {
      return reject("That post link does not look valid.");
    }
    return {
      ok: true,
      target: { kind: "status", handle: profile.handle, tweetId: segments[2] },
    };
  }

  if (segments[1] === "status" || segments[1] === "photo" || segments[1] === "video") {
    return reject("That is a specific post link. Paste the full post address.");
  }
  return reject(
    "This address is not an X profile. Supported forms are x.com/@handle and x.com/@handle/status/<id>.",
  );
}

/** Extracts a tweet id from any accepted status URL, or null. */
export function tweetIdFromStatusUrl(input: string): string | null {
  const parsed = parseXTarget(input);
  return parsed.ok && parsed.target.kind === "status" ? parsed.target.tweetId : null;
}
