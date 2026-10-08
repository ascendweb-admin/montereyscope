/**
 * Creator search: the shared result shape every platform search produces,
 * plus the pure helpers the add-creator dialog uses to decide between
 * "search by name" and "look up a pasted link". No network, no database —
 * safe to import from client components.
 */
import type { CreatorPlatform } from "@/lib/creators/repository";

/** One channel or account returned by a platform search. */
export interface CreatorSearchResult {
  platform: CreatorPlatform;
  /**
   * Stable per-platform identity: the YouTube channel ID, the X user ID, or
   * the Rumble `c/<slug>` / `user/<slug>` path (lowercased).
   */
  id: string;
  displayName: string;
  /** Lowercase YouTube/Rumble handle, or the X screen name as X spells it. */
  handle: string | null;
  /** Canonical channel/profile URL; the value the save path re-validates. */
  channelUrl: string;
  avatarUrl: string | null;
  /** YouTube subscribers or Rumble/X followers, when the platform exposed it. */
  followerCount: number | null;
  verified: boolean;
  /** X only: protected accounts cannot be collected, so they cannot be added. */
  protectedAccount: boolean;
  description: string | null;
  /** YouTube only: the canonical UC… channel ID. */
  youtubeChannelId: string | null;
  /** X only: the stable account ID. */
  platformUserId: string | null;
  /** The saved library row for this creator, when it is already saved. */
  savedCreatorId: number | null;
}

export type CreatorSearchErrorCode =
  | "invalid_query"
  | "ytdlp_missing"
  | "desktop_required"
  | "throttled"
  | "network"
  | "timeout"
  | "unexpected_response"
  // X provider failures pass through unchanged so the UI can offer reconnects.
  | "not_connected"
  | "unsupported_runtime"
  | "session_expired"
  | "verification_required"
  | "rate_limited"
  | "cancelled"
  | "invalid_response";

export interface CreatorSearchError {
  code: CreatorSearchErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr, HTML, or paths. */
  message: string;
  retryAfterSeconds?: number | null;
}

export type CreatorSearchOutcome =
  { ok: true; results: CreatorSearchResult[] } | { ok: false; error: CreatorSearchError };

export const CREATOR_SEARCH_MAX_QUERY_LENGTH = 100;

/**
 * Normalizes a search query: trims, collapses internal whitespace, and drops
 * control characters. Returns null when nothing searchable is left or the
 * query is too long to be a name.
 */
export function normalizeSearchQuery(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0 || normalized.length > CREATOR_SEARCH_MAX_QUERY_LENGTH) {
    return null;
  }
  return normalized;
}

const LINK_HOST_PATTERN =
  /^(?:www\.|m\.|mobile\.)?(?:youtube\.com|youtu\.be|rumble\.com|x\.com|twitter\.com)(?:[/?#]|$)/i;

/**
 * What the add dialog should do with the text in its one input:
 * - `link`: resolve it directly (a URL, a bare host path, or an `@handle`
 *   on YouTube/X), exactly like the paste flow always did.
 * - `search`: look the text up by name on the selected platform.
 * - `empty`: nothing to do yet.
 */
export function classifyCreatorInput(
  input: string,
  platform: CreatorPlatform,
): "link" | "search" | "empty" {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (/^https?:\/\//i.test(trimmed) || LINK_HOST_PATTERN.test(trimmed)) {
    return "link";
  }
  if (platform === "x" && /^@[0-9A-Za-z_]{1,15}$/.test(trimmed)) {
    return "link";
  }
  if (platform === "youtube" && /^@[0-9A-Za-z._-]{3,30}$/.test(trimmed)) {
    return "link";
  }
  if (platform === "youtube" && /^UC[0-9A-Za-z_-]{22}$/.test(trimmed)) {
    return "link";
  }
  return "search";
}

/**
 * Expands the shorthand forms `classifyCreatorInput` accepts as links into
 * the full URLs the resolvers expect: bare hosts gain `https://`, and a
 * YouTube `@handle` or channel ID becomes its channel URL. X keeps `@handle`
 * as is because its resolver accepts it directly.
 */
export function expandCreatorLink(input: string, platform: CreatorPlatform): string {
  const trimmed = input.trim();
  if (platform === "youtube" && trimmed.startsWith("@")) {
    return `https://www.youtube.com/${trimmed}`;
  }
  if (platform === "youtube" && /^UC[0-9A-Za-z_-]{22}$/.test(trimmed)) {
    return `https://www.youtube.com/channel/${trimmed}`;
  }
  if (LINK_HOST_PATTERN.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/** "109M", "1.2K", "532" — compact, locale-aware counts for result rows. */
export function formatFollowerCount(count: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    count,
  );
}

/** The noun each platform uses for its audience. */
export function audienceNoun(platform: CreatorPlatform, count: number): string {
  if (platform === "youtube") {
    return count === 1 ? "subscriber" : "subscribers";
  }
  return count === 1 ? "follower" : "followers";
}
