/**
 * Strict parser for the YouTube channel URL forms scope deliberately
 * supports. Everything else is rejected with plain-language feedback so the
 * user knows exactly why their paste did not work.
 *
 * Supported forms (HTTPS only):
 *   https://www.youtube.com/@handle
 *   https://youtube.com/@handle
 *   https://m.youtube.com/@handle
 *   https://www.youtube.com/channel/UC…
 *
 * Deliberately NOT supported: non-YouTube hosts, non-HTTPS protocols,
 * credentials in URLs, video/shorts/live links, playlists, and legacy
 * /user/ or /c/ custom URLs.
 */

export type ParsedCreatorTarget =
  { kind: "channel_id"; channelId: string } | { kind: "handle"; handle: string };

export type CreatorUrlParseResult =
  { ok: true; target: ParsedCreatorTarget } | { ok: false; message: string };

/** Hosts whose URLs we accept as YouTube channel addresses. */
const ALLOWED_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);

const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;
// YouTube handles: 3-30 characters, letters, digits, dots, underscores, dashes.
const HANDLE_PATTERN = /^[0-9A-Za-z._-]{3,30}$/;

function reject(message: string): CreatorUrlParseResult {
  return { ok: false, message };
}

/**
 * Parses raw user input into a canonical creator target, or a friendly
 * rejection message. Never throws on malformed input.
 */
export function parseCreatorChannelUrl(input: string): CreatorUrlParseResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return reject(
      "Paste a YouTube channel link first — for example https://www.youtube.com/@YouTube",
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
      "scope only accepts secure HTTPS YouTube links. Use the https:// version of the address.",
    );
  }
  if (url.protocol !== "https:") {
    return reject(
      `“${url.protocol}” links are not supported. Only HTTPS YouTube channel links can be added.`,
    );
  }

  if (url.username.length > 0 || url.password.length > 0) {
    return reject("Links with embedded usernames or passwords are not allowed.");
  }

  if (!ALLOWED_HOSTS.has(url.hostname)) {
    if (url.hostname === "youtu.be") {
      return reject("That is a video link (youtu.be). Paste the creator's channel page instead.");
    }
    return reject(
      `Only youtube.com channels can be added — “${url.hostname}” is not a YouTube address.`,
    );
  }

  // Share links often append tracking params like ?si=… — harmless, ignored.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return reject(
      "That is the YouTube home page. Open the creator's channel page and copy that address instead.",
    );
  }

  const first = segments[0];

  if (first.startsWith("@")) {
    if (segments.length > 1) {
      return reject(
        "This looks like a specific tab of a channel (videos, shorts, …). Paste just the main channel address.",
      );
    }
    return parseHandle(first);
  }

  if (first === "channel") {
    if (segments.length !== 2) {
      return reject(
        "Channel ID links must look like https://www.youtube.com/channel/UCAbC123… with nothing after the ID.",
      );
    }
    return parseChannelId(segments[1]);
  }

  if (first === "watch") {
    return reject("That is a single video link. Paste the creator's channel page instead.");
  }
  if (first === "shorts" || first === "live" || first === "embed" || first === "v") {
    return reject("That is a single video link. Paste the creator's channel page instead.");
  }
  if (first === "playlist") {
    return reject("Playlists cannot be saved here. Paste the creator's channel page instead.");
  }
  if (first === "user" || first === "c" || first === "profile") {
    return reject(
      "Legacy custom URLs (/user/, /c/) are not supported yet. Open the channel and use its @handle address instead.",
    );
  }
  if (
    first.startsWith("results") ||
    first === "feed" ||
    first === "explore" ||
    first === "account"
  ) {
    return reject("That is a YouTube page, not a creator's channel.");
  }

  return reject(
    "This address does not look like a channel. Supported forms are youtube.com/@handle and youtube.com/channel/<channel ID>.",
  );
}

function parseHandle(segment: string): CreatorUrlParseResult {
  const handle = segment.slice(1).toLowerCase();

  if (!HANDLE_PATTERN.test(handle)) {
    return reject(
      "Handles are 3–30 letters, numbers, dots, underscores, or dashes. Double-check the @name part of the link.",
    );
  }
  return { ok: true, target: { kind: "handle", handle } };
}

function parseChannelId(rawId: string): CreatorUrlParseResult {
  const channelId = rawId;

  if (!CHANNEL_ID_PATTERN.test(channelId)) {
    return reject(
      "Channel IDs start with “UC” followed by 24 letters, numbers, dashes, or underscores. That one does not look valid.",
    );
  }
  return { ok: true, target: { kind: "channel_id", channelId } };
}
