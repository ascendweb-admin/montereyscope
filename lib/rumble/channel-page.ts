/**
 * Parser for Rumble channel listing pages. Modern channel pages embed the
 * recent uploads as plain JSON inside `<script type="application/json">`
 * blocks; each item carries full metadata (title, duration, ISO upload
 * date, views, thumbnail) and a `by` object carrying the channel identity
 * (name, URL, avatar image, follower count, verified badge).
 *
 * Pure: HTML text in, validated plain objects out. Every field is probed
 * defensively — malformed blocks are skipped, unusable items are skipped,
 * and structurally empty pages fail with a typed reason. No network, no
 * filesystem. Verified against live pages fetched 2026-09-06.
 */
import type { VideoDraft } from "@/lib/videos/mapper";

import { mapDurationSeconds } from "@/lib/videos/mapper";
import { parseRumbleUrl, rumbleChannelUrlFromSlug, slugFromPathSegment } from "./urls";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RumbleChannelIdentity {
  displayName: string;
  channelUrl: string;
  /** Rumble's own avatar image for the channel (any aspect ratio). */
  avatarUrl: string | null;
  followerCount: number | null;
  verified: boolean;
}

export type RumblePageParseResult =
  | { ok: true; identity: RumbleChannelIdentity | null; videos: VideoDraft[] }
  | { ok: false; reason: "no_data" };

interface RawChannelIdentity {
  url?: unknown;
  thumb?: unknown;
  name?: unknown;
  followers?: unknown;
  verified_badge?: unknown;
}

interface RawVideoItem {
  object_type?: unknown;
  title?: unknown;
  duration?: unknown;
  upload_date?: unknown;
  views?: unknown;
  thumb?: unknown;
  relative_url?: unknown;
  permalink_id?: unknown;
  live?: unknown;
  livestream_status?: unknown;
  live_streamed_on?: unknown;
  by?: unknown;
}

// ---------------------------------------------------------------------------
// Image URL policy
// ---------------------------------------------------------------------------

/** Rumble's image CDNs — the only hosts a stored image URL may point at. */
const RUMBLE_IMAGE_HOST_PATTERN = /(^|\.)(hugh\.cdn\.rumble\.cloud|sp\.rmbl\.ws|i\.rumble\.com)$/;

/** True for an https URL on one of Rumble's image CDNs. */
export function isAllowedRumbleImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    return false;
  }
  try {
    return RUMBLE_IMAGE_HOST_PATTERN.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JSON blob extraction
// ---------------------------------------------------------------------------

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Collects every parsable JSON object embedded in the page that contains an
 * `items` array, in document order. Malformed blocks are skipped silently —
 * Rumble embeds several unrelated blobs (menus, ads config) that must not
 * fail the parse.
 */
function collectItems(html: string): RawVideoItem[] {
  const items: RawVideoItem[] = [];
  const scriptPattern = /<script type="application\/json">([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(scriptPattern)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const candidate = parsed as { items?: unknown };
    if (!Array.isArray(candidate.items)) {
      continue;
    }
    for (const entry of candidate.items) {
      if (typeof entry === "object" && entry !== null) {
        items.push(entry as RawVideoItem);
      }
    }
  }
  return items;
}

/** Reads quoted and unquoted HTML attributes without depending on their order. */
function htmlAttribute(tag: string, name: string): string | null {
  const attributes = /([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1].toLowerCase() === name) {
      return (match[2] ?? match[3] ?? match[4])
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
    }
  }
  return null;
}

function metaContent(html: string, property: string): string | null {
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (htmlAttribute(tag, "property") === property) {
      return htmlAttribute(tag, "content");
    }
  }
  return null;
}

function headerAvatar(html: string): string | null {
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    if (htmlAttribute(tag, "class")?.split(/\s+/).includes("channel-header--img")) {
      const src = htmlAttribute(tag, "src");
      if (isAllowedRumbleImageUrl(src)) return src;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Item mapping
// ---------------------------------------------------------------------------

/** Maps a Rumble item's live-ish flags onto the database-constrained model. */
export function rumbleItemLiveStatus(item: RawVideoItem): VideoDraft["liveStatus"] {
  if (item.live === true) {
    return "is_live";
  }
  const streamedOn = asNonEmptyString(item.live_streamed_on);
  const status = asNonEmptyString(item.livestream_status);
  if (streamedOn !== null || status === "ended" || status === "complete") {
    return "was_live";
  }
  return "not_live";
}

/** Maps one raw item to a VideoDraft, or null when unusable. */
export function mapRumbleItem(item: RawVideoItem): VideoDraft | null {
  if (item === null || typeof item !== "object") {
    return null;
  }
  if (item.object_type !== undefined && item.object_type !== "video") {
    return null;
  }

  const relativeUrl = asNonEmptyString(item.relative_url);
  const slug =
    asNonEmptyString(item.permalink_id) ??
    (relativeUrl !== null ? slugFromPathSegment(relativeUrl) : null);
  if (slug === null) {
    return null;
  }
  const title = asNonEmptyString(item.title);
  if (title === null) {
    return null;
  }

  let url = `https://rumble.com/${slug}`;
  if (relativeUrl !== null) {
    const path = relativeUrl.split("?")[0];
    if (path.startsWith("/") && path.toLowerCase().endsWith(".html")) {
      url = `https://rumble.com${path}`;
    }
  }

  return {
    id: slug,
    title: title.slice(0, 300),
    url,
    thumbnailUrl: isAllowedRumbleImageUrl(item.thumb) ? item.thumb : null,
    publishedAt: normalizeRumbleDate(item.upload_date),
    durationSeconds: mapDurationSeconds(item.duration),
    liveStatus: rumbleItemLiveStatus(item),
    description: null,
  };
}

/**
 * Normalizes a Rumble ISO-8601 date ("2026-08-04T01:32:33+00:00") into the
 * storage format, or null when missing/invalid. Unparseable values become
 * null rather than a bogus 1970 date.
 */
export function normalizeRumbleDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  const parsed = new Date(value);
  const millis = parsed.getTime();
  if (!Number.isFinite(millis) || millis <= 0) {
    return null;
  }
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

function identityFieldsFromBy(by: unknown): Omit<RumbleChannelIdentity, "channelUrl"> | null {
  if (typeof by !== "object" || by === null) {
    return null;
  }
  const candidate = by as RawChannelIdentity;
  const name = asNonEmptyString(candidate.name);
  if (name === null) {
    return null;
  }
  const followers =
    typeof candidate.followers === "number" &&
    Number.isFinite(candidate.followers) &&
    candidate.followers >= 0
      ? Math.round(candidate.followers)
      : null;
  return {
    displayName: name.slice(0, 100),
    avatarUrl: isAllowedRumbleImageUrl(candidate.thumb) ? candidate.thumb : null,
    followerCount: followers,
    verified: candidate.verified_badge === true,
  };
}

function channelUrlFromBy(by: unknown): string | null {
  if (typeof by !== "object" || by === null) {
    return null;
  }
  const direct = asNonEmptyString((by as RawChannelIdentity).url);
  return direct !== null && direct.startsWith("https://") ? direct : null;
}

/**
 * Builds identity from one item's `by` object. When `expectedChannelSlug` is
 * given, only a `by` object referring to that channel is accepted — listing
 * blobs can embed entries pointing at other channels.
 */
function identityFromItem(
  item: RawVideoItem,
  expectedChannelSlug?: string,
): RumbleChannelIdentity | null {
  const fields = identityFieldsFromBy(item.by);
  if (fields === null) {
    return null;
  }
  const channelUrl = channelUrlFromBy(item.by);
  if (expectedChannelSlug !== undefined && channelUrl !== null) {
    try {
      const segments = new URL(channelUrl).pathname.split("/").filter(Boolean);
      const slug = segments.length === 2 ? segments[1] : (segments[0] ?? "");
      if (slug.toLowerCase() !== expectedChannelSlug.toLowerCase()) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return {
    ...fields,
    channelUrl: channelUrl ?? `https://rumble.com/c/${expectedChannelSlug ?? ""}`,
  };
}

/** Last-resort identity from the page's og: meta tags. */
function identityFromMeta(html: string): RumbleChannelIdentity | null {
  const title = metaContent(html, "og:title");
  if (title === null || title.trim().length === 0) {
    return null;
  }
  const image = headerAvatar(html) ?? metaContent(html, "og:image");
  const parsedUrl = parseRumbleUrl(metaContent(html, "og:url") ?? "");
  const channelUrl = parsedUrl.ok && parsedUrl.target.kind === "channel"
    ? rumbleChannelUrlFromSlug(parsedUrl.target.slug, parsedUrl.target.prefix)
    : "";
  return {
    displayName: title.trim().slice(0, 100),
    channelUrl,
    avatarUrl: isAllowedRumbleImageUrl(image) ? image : null,
    followerCount: null,
    verified: false,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parses one fetched channel page into the channel identity and its listed
 * recent videos. `expectedChannelSlug` (the /c/<slug> name) makes identity
 * extraction prefer the `by` object that actually refers to the channel.
 */
export function parseRumbleChannelPage(
  html: string,
  expectedChannelSlug?: string,
): RumblePageParseResult {
  if (html.length === 0) {
    return { ok: false, reason: "no_data" };
  }

  const rawItems = collectItems(html);
  const videos: VideoDraft[] = [];
  const seenIds = new Set<string>();
  let identity: RumbleChannelIdentity | null = null;

  for (const item of rawItems) {
    const draft = mapRumbleItem(item);
    if (draft !== null && !seenIds.has(draft.id)) {
      seenIds.add(draft.id);
      videos.push(draft);
    }
    if (identity === null && draft !== null) {
      const candidate = identityFromItem(item, expectedChannelSlug);
      if (candidate !== null) {
        identity = candidate;
      }
    }
  }

  if (identity === null) {
    identity = identityFromMeta(html);
  }

  if (identity === null && videos.length === 0) {
    return { ok: false, reason: "no_data" };
  }

  return { ok: true, identity, videos };
}
