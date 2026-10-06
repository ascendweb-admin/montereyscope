/**
 * Strict parser for the Rumble URL forms scope deliberately supports.
 * Everything else is rejected with plain-language feedback so the user knows
 * exactly why their paste did not work.
 *
 * Supported forms (HTTPS only):
 *   https://www.rumble.com/v7dota4-title-slug.html   (single video page)
 *   https://rumble.com/v7dota4                       (short video form)
 *   https://www.rumble.com/c/Redacted                (channel page)
 *   https://www.rumble.com/user/name                 (legacy channel page)
 *
 * Deliberately NOT supported: non-Rumble hosts, non-HTTPS protocols,
 * credentials in URLs, embeds, search/browse pages, and the /embed/ player.
 *
 * Tracking params appended to share links (?e9s=…&u=…) are ignored.
 */

export type ParsedRumbleTarget =
  | { kind: "video"; slug: string }
  | { kind: "channel"; slug: string; prefix: "c" | "user" };

export type RumbleUrlParseResult =
  { ok: true; target: ParsedRumbleTarget } | { ok: false; message: string };

/** Hosts whose URLs we accept as Rumble addresses. */
const ALLOWED_HOSTS = new Set(["www.rumble.com", "rumble.com"]);

// Rumble video slugs start with "v" followed by 5–7 base36 characters
// (e.g. v7emyxa) and always carry at least one digit — which keeps reserved
// words like "videos" out of the video form.
const VIDEO_SLUG_PATTERN = /^v(?=[0-9a-z]*\d)[0-9a-z]{5,9}$/;
const CHANNEL_SLUG_PATTERN = /^[0-9A-Za-z._-]{2,60}$/;

function reject(message: string): RumbleUrlParseResult {
  return { ok: false, message };
}

/**
 * Parses raw user input into a canonical Rumble target, or a friendly
 * rejection message. Never throws on malformed input.
 */
export function parseRumbleUrl(input: string): RumbleUrlParseResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return reject(
      "Paste a Rumble link first — for example https://rumble.com/c/Redacted or a video link.",
    );
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
    return reject(
      "scope only accepts secure HTTPS Rumble links. Use the https:// version of the address.",
    );
  }
  if (url.protocol !== "https:") {
    return reject(
      `“${url.protocol}” links are not supported. Only HTTPS Rumble links can be used.`,
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return reject("Links with embedded usernames or passwords are not allowed.");
  }

  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return reject(
      `Only rumble.com links can be used — “${url.hostname}” is not a Rumble address.`,
    );
  }

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return reject(
      "That is the Rumble home page. Copy a video or channel address from Rumble instead.",
    );
  }

  const first = segments[0].toLowerCase();

  if (first === "c" || first === "user") {
    if (segments.length !== 2) {
      return reject(
        "Channel links must look like https://rumble.com/c/<name> with nothing after the name.",
      );
    }
    return parseChannelSlug(segments[1], first);
  }

  if (first === "embed" || first === "embedjs") {
    return reject("That is an embedded player link. Paste the video's page address instead.");
  }
  if (first === "search" || first === "browse" || first === "videos") {
    return reject("That is a Rumble listing page. Paste a specific video or channel instead.");
  }

  // Video pages are the only other accepted form: "/v<slug>…" with the
  // descriptive tail either present ("…-title.html") or omitted.
  const videoSlug = slugFromPathSegment(segments[0]);
  if (videoSlug !== null) {
    return { ok: true, target: { kind: "video", slug: videoSlug } };
  }
  if (segments[0].toLowerCase().endsWith(".html")) {
    return reject(
      "That video link looks malformed. Copy the address straight from the video's page.",
    );
  }

  return reject(
    "This address does not look like a Rumble video or channel. Supported forms are rumble.com/v… links and rumble.com/c/<name> channels.",
  );
}

function parseChannelSlug(rawSlug: string, prefix: "c" | "user"): RumbleUrlParseResult {
  const slug = rawSlug;
  if (!CHANNEL_SLUG_PATTERN.test(slug)) {
    return reject(
      "Channel names only contain letters, numbers, dots, underscores, or dashes. Double-check the /c/ part of the link.",
    );
  }
  return { ok: true, target: { kind: "channel", slug, prefix } };
}

/**
 * Extracts the video slug from a path segment such as
 * "/v7emyxa-warning-this-new-flu-shot.html". Returns null when the segment
 * does not carry a plausible "v<…>" video prefix.
 */
export function slugFromPathSegment(segment: string): string | null {
  const normalized = segment.toLowerCase().replace(/^\/+/, "");
  const bare = normalized.replace(/\.html?$/i, "");
  const slug = bare.split(/[?&-]/)[0];
  if (!VIDEO_SLUG_PATTERN.test(slug)) {
    return null;
  }
  return slug;
}

/** Builds the canonical video page URL from a slug. */
export function rumbleVideoUrlFromSlug(slug: string): string {
  return `https://rumble.com/${slug}`;
}

/** Builds the canonical channel page URL from a channel slug. */
export function rumbleChannelUrlFromSlug(slug: string, prefix: "c" | "user" = "c"): string {
  return `https://rumble.com/${prefix}/${slug}`;
}
