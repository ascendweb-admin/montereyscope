/**
 * Video link parsing for "Other videos". Pure and client-safe: no server-only
 * imports and no `node:` modules, so a dialog can parse a paste as the user
 * types. Only HTTPS links to a single YouTube or Rumble video are accepted;
 * everything else is rejected with a plain-language reason.
 *
 * Accepted YouTube forms (on youtube.com, www., m., and youtu.be):
 *   watch?v=<id>, youtu.be/<id>, shorts/<id>, live/<id>, embed/<id>, v/<id>
 * Playlist, tracking, and timestamp parameters are dropped: the canonical
 * link is always https://www.youtube.com/watch?v=<id>.
 */
import { parseRumbleUrl, rumbleVideoUrlFromSlug } from "@/lib/rumble/urls";

export type VideoLink =
  | { platform: "youtube"; id: string; url: string }
  | { platform: "rumble"; slug: string; url: string };

export type VideoLinkErrorCode = "invalid_link" | "unsupported_site";

export type VideoLinkParseResult =
  { ok: true; link: VideoLink } | { ok: false; code: VideoLinkErrorCode; message: string };

export interface RejectedVideoLink {
  raw: string;
  code: VideoLinkErrorCode;
  message: string;
}

export interface ExtractedVideoLinks {
  links: VideoLink[];
  rejected: RejectedVideoLink[];
  /** True when valid links beyond `max` were left out. */
  truncated: boolean;
}

export const MAX_PASTED_VIDEO_LINKS = 30;
/** Longest address a server action accepts for one video link. */
export const MAX_VIDEO_LINK_LENGTH = 2000;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const SHORT_HOST = "youtu.be";
const RUMBLE_HOSTS = new Set(["rumble.com", "www.rumble.com"]);
const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const SUPPORTED_SITES_MESSAGE = "scope can import YouTube and Rumble video links for now.";
const CHANNEL_LINK_MESSAGE = "That is a channel link; add it with Add creator.";

function reject(code: VideoLinkErrorCode, message: string): VideoLinkParseResult {
  return { ok: false, code, message };
}

function youtubeLink(id: string): VideoLinkParseResult {
  return {
    ok: true,
    link: { platform: "youtube", id, url: `https://www.youtube.com/watch?v=${id}` },
  };
}

/** The stored video id: the 11-character YouTube id, or the Rumble page slug. */
export function videoLinkId(link: VideoLink): string {
  return link.platform === "youtube" ? link.id : link.slug;
}

/**
 * Parses one pasted address into a canonical single-video link, or a typed
 * rejection. Never throws on malformed input.
 */
export function parseVideoLink(raw: string): VideoLinkParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return reject("invalid_link", "Paste a video link first.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return reject(
      "invalid_link",
      "That does not look like a complete link. Paste the full address, starting with https://",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return reject("invalid_link", "Only https:// video links can be imported.");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return reject("invalid_link", "Links with embedded usernames or passwords are not allowed.");
  }

  const host = url.hostname;
  const isYoutube = YOUTUBE_HOSTS.has(host) || host === SHORT_HOST;
  const isRumble = RUMBLE_HOSTS.has(host);
  if (!isYoutube && !isRumble) {
    return reject("unsupported_site", SUPPORTED_SITES_MESSAGE);
  }
  if (url.protocol === "http:") {
    return reject(
      "invalid_link",
      "scope only accepts secure HTTPS links. Use the https:// version of the address.",
    );
  }

  return isRumble ? parseRumbleVideoLink(trimmed) : parseYoutubeVideoLink(url);
}

function parseRumbleVideoLink(trimmed: string): VideoLinkParseResult {
  const parsed = parseRumbleUrl(trimmed);
  if (!parsed.ok) {
    return reject("invalid_link", parsed.message);
  }
  if (parsed.target.kind !== "video") {
    return reject("invalid_link", CHANNEL_LINK_MESSAGE);
  }
  const { slug } = parsed.target;
  return { ok: true, link: { platform: "rumble", slug, url: rumbleVideoUrlFromSlug(slug) } };
}

function parseYoutubeVideoLink(url: URL): VideoLinkParseResult {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);

  if (url.hostname === SHORT_HOST) {
    if (segments.length === 0) {
      return reject("invalid_link", "That is not a video link. Paste a link to a single video.");
    }
    return segments.length === 1 ? videoIdOrReject(segments[0]) : notAVideo();
  }

  if (segments.length === 0) {
    return reject(
      "invalid_link",
      "That is the YouTube home page. Paste a link to a single video instead.",
    );
  }

  const first = segments[0];
  if (first === "watch") {
    // `list=`, `t=`, `si=`, and tracking parameters are ignored.
    return segments.length === 1 ? videoIdOrReject(url.searchParams.get("v")) : notAVideo();
  }
  if (first === "shorts" || first === "live" || first === "embed" || first === "v") {
    return segments.length === 2 ? videoIdOrReject(segments[1]) : notAVideo();
  }
  if (first === "playlist") {
    return reject("invalid_link", "That is a playlist link. Paste a link to a single video.");
  }
  if (first.startsWith("@") || first === "channel" || first === "c" || first === "user") {
    return reject("invalid_link", CHANNEL_LINK_MESSAGE);
  }
  return notAVideo();
}

function notAVideo(): VideoLinkParseResult {
  return reject(
    "invalid_link",
    "That YouTube address is not a single video. Copy the link from the video's page.",
  );
}

function videoIdOrReject(candidate: string | null): VideoLinkParseResult {
  if (candidate === null || !YOUTUBE_ID_PATTERN.test(candidate)) {
    return reject(
      "invalid_link",
      "That video link looks incomplete. Copy the address straight from the video's page.",
    );
  }
  return youtubeLink(candidate);
}

/** True only for a link `parseVideoLink` accepts: a YouTube or Rumble single video. */
export function looksLikeVideoLink(input: string): boolean {
  return parseVideoLink(input).ok;
}

// Links end at whitespace, commas, or quote/angle characters; trailing prose
// punctuation ("see https://youtu.be/x.", "(https://youtu.be/x)") is trimmed.
const URL_IN_TEXT = /https?:\/\/[^\s,<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[).\]};:!?]+$/;

/**
 * Finds every link in a pasted blob (one per line, separated by spaces or
 * commas, or surrounded by prose), de-duplicates by canonical link, and caps
 * the valid links at `max`. Rejected links keep their original text so the UI
 * can show why; they are capped at `max` as well and never mark the paste as
 * truncated.
 */
export function extractVideoLinks(
  text: string,
  { max = MAX_PASTED_VIDEO_LINKS }: { max?: number } = {},
): ExtractedVideoLinks {
  const links: VideoLink[] = [];
  const rejected: RejectedVideoLink[] = [];
  const seenLinks = new Set<string>();
  const seenRejected = new Set<string>();
  let truncated = false;

  for (const match of text.matchAll(URL_IN_TEXT)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    const parsed = parseVideoLink(raw);
    if (parsed.ok) {
      if (seenLinks.has(parsed.link.url)) {
        continue;
      }
      seenLinks.add(parsed.link.url);
      if (links.length >= max) {
        truncated = true;
        continue;
      }
      links.push(parsed.link);
    } else if (!seenRejected.has(raw) && rejected.length < max) {
      seenRejected.add(raw);
      rejected.push({ raw, code: parsed.code, message: parsed.message });
    }
  }

  return { links, rejected, truncated };
}
