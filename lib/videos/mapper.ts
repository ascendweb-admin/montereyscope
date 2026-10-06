/**
 * Runtime-validated normalization of yt-dlp flat-playlist JSON into the
 * scope video model. yt-dlp output is untrusted input: every field is
 * probed defensively, missing values become nulls (never crashes), and
 * structurally broken payloads are rejected as typed errors.
 *
 * Flat entries verified against yt-dlp 2026.08.19:
 *   { id, url, title, duration, timestamp, live_status, thumbnails[],
 *     view_count, availability, ... } — all optional/nullable in practice.
 */
import type { LiveStatus } from "./repository";

/** A normalized video ready to be persisted for a creator's cached feed. */
export interface VideoDraft {
  id: string;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  /** ISO 8601 timestamp, or null when unknown (flat metadata is approximate). */
  publishedAt: string | null;
  durationSeconds: number | null;
  liveStatus: LiveStatus;
  description: string | null;
}

export type FeedParseErrorCode = "unexpected_response";

export interface FeedParseError {
  code: FeedParseErrorCode;
  /** Plain-language, UI-safe message. Never contains raw payload text. */
  message: string;
}

export interface FeedParseSuccess {
  ok: true;
  videos: VideoDraft[];
  /** Entries skipped because they were malformed or unusable. */
  skippedEntries: number;
  /** Duplicate video IDs collapsed during parsing/merging. */
  duplicatesCollapsed: number;
}

export type FeedParseResult = FeedParseSuccess | { ok: false; error: FeedParseError };

interface YtDlpPlaylistJson {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly channel?: unknown;
  readonly channel_id?: unknown;
  readonly entries?: unknown;
}

interface YtDlpEntryJson {
  readonly id?: unknown;
  readonly url?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly duration?: unknown;
  readonly timestamp?: unknown;
  readonly live_status?: unknown;
  readonly thumbnails?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Maps a yt-dlp live_status onto the database-constrained model.
 * Unknown/null values and `post_live` (a stream that just ended) normalize
 * safely; unexpected strings never violate the CHECK constraint.
 */
export function mapLiveStatus(value: unknown): LiveStatus {
  switch (value) {
    case "not_live":
      return "not_live";
    case "is_live":
      return "is_live";
    case "was_live":
    case "post_live":
      return "was_live";
    case "is_upcoming":
      return "upcoming";
    default:
      return "unknown";
  }
}

/**
 * Picks the best video thumbnail: HTTPS only, YouTube image hosts only,
 * largest area wins. Returns null rather than an unsafe URL.
 */
export function pickThumbnailUrl(thumbnails: unknown): string | null {
  if (!Array.isArray(thumbnails)) {
    return null;
  }
  let bestUrl: string | null = null;
  let bestArea = -1;
  for (const item of thumbnails) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const url = asNonEmptyString(record.url);
    if (url === null || !url.startsWith("https://")) {
      continue;
    }
    try {
      const parsed = new URL(url);
      if (!/(^|\.)(ytimg\.com|googleusercontent\.com)$/.test(parsed.hostname)) {
        continue;
      }
    } catch {
      continue;
    }
    const width = typeof record.width === "number" ? record.width : 0;
    const height = typeof record.height === "number" ? record.height : 0;
    const area = width * height;
    if (area > bestArea) {
      bestArea = area;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/**
 * Normalizes a unix-seconds timestamp into ISO 8601, or null when missing,
 * non-numeric, or implausible (negative / zero).
 */
export function mapPublishedAt(timestamp: unknown): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }
  if (timestamp <= 0) {
    return null;
  }
  return new Date(timestamp * 1000).toISOString();
}

/** Normalizes a duration in seconds; negative or non-finite values → null. */
export function mapDurationSeconds(duration: unknown): number | null {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
    return null;
  }
  return Math.round(duration);
}

/**
 * Normalizes one flat entry. Returns null when the entry is unusable
 * (no ID or no title); callers skip such entries instead of failing the
 * whole feed — partial metadata is expected from flat extraction.
 */
export function mapFeedEntry(entry: unknown): VideoDraft | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const candidate = entry as YtDlpEntryJson;

  // Flat entries put the canonical watch URL in `url`; reconstruct it from
  // the ID when absent so stored links are always well-formed.
  const id = asNonEmptyString(candidate.id);
  if (id === null || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    return null;
  }
  const title = asNonEmptyString(candidate.title);
  if (title === null) {
    return null;
  }

  const directUrl = asNonEmptyString(candidate.url);
  const url =
    directUrl !== null && directUrl.startsWith("https://")
      ? directUrl
      : `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

  const description = asNonEmptyString(candidate.description);

  return {
    id,
    title: title.slice(0, 300),
    url,
    thumbnailUrl: pickThumbnailUrl(candidate.thumbnails),
    publishedAt: mapPublishedAt(candidate.timestamp),
    durationSeconds: mapDurationSeconds(candidate.duration),
    liveStatus: mapLiveStatus(candidate.live_status),
    description: description !== null ? description.slice(0, 5000) : null,
  };
}

const WATCH_URL_ID_PATTERN = /[?&]v=([A-Za-z0-9_-]{6,20})/;

/** Extracts the video ID from a stored watch URL, for detail lookups. */
export function videoIdFromWatchUrl(url: string): string | null {
  const match = WATCH_URL_ID_PATTERN.exec(url);
  return match?.[1] ?? null;
}

function failParse(message: string): FeedParseResult {
  return { ok: false, error: { code: "unexpected_response", message } };
}

/**
 * Parses and validates the stdout of one channel-tab extraction.
 * The top-level payload must be a JSON object with an `entries` array
 * (possibly empty). Individual malformed entries are skipped and counted;
 * duplicate IDs collapse deterministically — the entry with richer
 * live-status information wins, since past livestreams appear on both the
 * Videos and Streams tabs but only identify themselves as `was_live` there.
 */
export function parseChannelFeedPayload(stdout: string): FeedParseResult {
  let payload: YtDlpPlaylistJson;
  try {
    payload = JSON.parse(stdout) as YtDlpPlaylistJson;
  } catch {
    return failParse("yt-dlp returned data scope could not read. Please refresh and try again.");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return failParse("yt-dlp returned data scope could not read. Please refresh and try again.");
  }
  if (!Array.isArray(payload.entries)) {
    return failParse(
      "yt-dlp did not report any feed entries for this tab. Please refresh and try again.",
    );
  }

  const byId = new Map<string, VideoDraft>();
  let skippedEntries = 0;

  for (const entry of payload.entries) {
    const draft = mapFeedEntry(entry);
    if (draft === null) {
      skippedEntries += 1;
      continue;
    }
    const existing = byId.get(draft.id);
    if (existing) {
      // Prefer whichever copy knows more about its live status; keep the
      // first-seen copy otherwise so merging is deterministic.
      if (liveStatusRank(draft.liveStatus) > liveStatusRank(existing.liveStatus)) {
        byId.set(draft.id, draft);
      }
      continue;
    }
    byId.set(draft.id, draft);
  }

  const videos = [...byId.values()];
  return {
    ok: true,
    videos,
    skippedEntries,
    duplicatesCollapsed: payload.entries.length - skippedEntries - videos.length,
  };
}

function liveStatusRank(status: LiveStatus): number {
  switch (status) {
    case "is_live":
      return 4;
    case "upcoming":
      return 3;
    case "was_live":
      return 2;
    case "not_live":
      return 1;
    default:
      return 0;
  }
}

/**
 * Merges two already-parsed tab feeds (Videos + Streams) into one draft
 * list, collapsing videos that appear on both tabs. The copy with richer
 * live-status information wins; otherwise the first-seen copy is kept.
 */
export function mergeFeedResults(
  primary: VideoDraft[],
  secondary: VideoDraft[],
): { videos: VideoDraft[]; duplicatesCollapsed: number } {
  const byId = new Map<string, VideoDraft>();
  for (const draft of [...primary, ...secondary]) {
    const existing = byId.get(draft.id);
    if (!existing) {
      byId.set(draft.id, draft);
      continue;
    }
    if (liveStatusRank(draft.liveStatus) > liveStatusRank(existing.liveStatus)) {
      byId.set(draft.id, draft);
    }
  }
  const merged = [...byId.values()];
  return {
    videos: merged,
    duplicatesCollapsed: primary.length + secondary.length - merged.length,
  };
}
