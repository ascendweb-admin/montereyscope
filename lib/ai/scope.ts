/**
 * Scope resolution for AI analysis jobs (stage 1). Server-only.
 *
 * Validates requested video ids against the cached feed: every known id comes
 * back with per-video metadata (joined with its creator's display name), and
 * unknown ids or videos without a cached transcript are reported separately.
 * Pure reads — nothing here mutates the database or the filesystem.
 *
 * `resolveSourceScope` is the mixed-source successor: it validates typed
 * source references (video + tweet), so chats and reports can be grounded in
 * any mix of cached transcripts and X posts.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import type { CreatorPlatform } from "@/lib/creators/repository";
import {
  sourceKey,
  type ContentKind,
  type SourceRef,
} from "@/lib/content/model";

/** One requested video that exists in the cached feed. */
export interface ScopedVideo {
  id: string;
  title: string;
  /** Creator display name, joined from the creators table. */
  creator: string;
  /** ISO 8601 publication timestamp, or null when unknown. */
  publishedAt: string | null;
  hasTranscript: boolean;
  /** Duration in seconds, or null when unknown. */
  durationSeconds: number | null;
}

/** Outcome of validating a batch of requested video ids. */
export interface ScopeResolution {
  /** Known videos, in the order they were requested. */
  videos: ScopedVideo[];
  /** Requested ids with no row in the videos table, in request order. */
  unknownVideoIds: string[];
  /** Known videos without a cached transcript, in request order. */
  missingTranscriptVideoIds: string[];
}

interface ScopeRow {
  id: string;
  title: string;
  creator: string;
  published_at: string | null;
  duration_seconds: number | null;
  has_transcript: number;
}

function toScopedVideo(row: ScopeRow): ScopedVideo {
  return {
    id: row.id,
    title: row.title,
    creator: row.creator,
    publishedAt: row.published_at,
    hasTranscript: Number(row.has_transcript) === 1,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
  };
}

/** Chunked IN clauses keep us far below SQLite's host-parameter limit. */
const QUERY_CHUNK_SIZE = 500;

/**
 * Validates each requested id against the videos table. Repeated ids are
 * collapsed to their first occurrence; all result lists preserve request
 * order. Unknown ids and transcripts of unrequested videos are never listed.
 */
export function resolveScope(db: ScopeDatabase, videoIds: readonly string[]): ScopeResolution {
  const requestedIds = [...new Set(videoIds)];

  const known = new Map<string, ScopeRow>();
  for (let start = 0; start < requestedIds.length; start += QUERY_CHUNK_SIZE) {
    const chunk = requestedIds.slice(start, start + QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<[...string[]], ScopeRow>(
        `SELECT v.id, v.title, c.display_name AS creator,
                v.published_at, v.duration_seconds,
                (t.video_id IS NOT NULL) AS has_transcript
         FROM videos v
         JOIN creators c ON c.id = v.creator_id
         LEFT JOIN transcripts t ON t.video_id = v.id
         WHERE v.id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const row of rows) {
      known.set(row.id, row);
    }
  }

  const videos: ScopedVideo[] = [];
  const unknownVideoIds: string[] = [];
  const missingTranscriptVideoIds: string[] = [];
  for (const id of requestedIds) {
    const row = known.get(id);
    if (!row) {
      unknownVideoIds.push(id);
      continue;
    }
    videos.push(toScopedVideo(row));
    if (Number(row.has_transcript) !== 1) {
      missingTranscriptVideoIds.push(id);
    }
  }

  return { videos, unknownVideoIds, missingTranscriptVideoIds };
}

/**
 * Small interface so later stages can resolve scope without touching the
 * database directly, and mock it in their tests.
 */
export interface TranscriptScopeReader {
  resolveScope(videoIds: readonly string[]): ScopeResolution;
}

export function createTranscriptScopeReader(db: ScopeDatabase): TranscriptScopeReader {
  return { resolveScope: (videoIds) => resolveScope(db, videoIds) };
}

// ---------------------------------------------------------------------------
// Mixed-source scope (video + tweet)
// ---------------------------------------------------------------------------

/** One requested source that exists in the local cache. */
export interface ScopedSource {
  kind: ContentKind;
  id: string;
  /** Display label: the video title or the post text's first line. */
  title: string;
  /** Creator display name (for tweets: the post's author). */
  creator: string;
  creatorId: number;
  platform: CreatorPlatform;
  canonicalUrl: string;
  publishedAt: string | null;
  /** Video: a cached transcript exists. Tweet: complete cached text. */
  readyForAnalysis: boolean;
  /** Video only. */
  durationSeconds?: number | null;
  /** Tweet only: author handle without the @. */
  authorHandle?: string;
  /** Tweet only: whether the payload is truncated/unavailable. */
  contentStatus?: "summary" | "complete" | "unavailable";
}

export interface SourceScopeResolution {
  /** Known sources, in the order they were requested. */
  sources: ScopedSource[];
  /** Requested references with no cached row. */
  unknown: SourceRef[];
  /** Known sources that are not ready for analysis (no transcript/text). */
  notReady: SourceRef[];
}

const VIDEO_SCOPE_SELECT = `
  SELECT v.id, v.title, v.url, v.published_at, v.duration_seconds,
         c.id AS creator_id, c.display_name AS creator, c.platform AS platform,
         (t.video_id IS NOT NULL) AS has_content
  FROM videos v
  JOIN creators c ON c.id = v.creator_id
  LEFT JOIN transcripts t ON t.video_id = v.id
  WHERE v.id IN (%PLACEHOLDERS%)
`;

const TWEET_SCOPE_SELECT = `
  SELECT tw.id, tw.text, tw.url, tw.published_at, tw.author_handle, tw.author_name,
         tw.content_status, tw.in_reply_to_handle,
         MIN(ct.creator_id) AS creator_id,
         MIN(c.display_name) AS creator,
         MIN(c.platform) AS platform
  FROM tweets tw
  JOIN creator_tweets ct ON ct.tweet_id = tw.id
  JOIN creators c ON c.id = ct.creator_id
  WHERE tw.id IN (%PLACEHOLDERS%)
  GROUP BY tw.id
`;

interface VideoScopeRow {
  id: string;
  title: string;
  url: string;
  published_at: string | null;
  duration_seconds: number | null;
  creator_id: number;
  creator: string;
  platform: CreatorPlatform | null;
  has_content: number;
}

interface TweetScopeRow {
  id: string;
  text: string;
  url: string;
  published_at: string | null;
  author_handle: string;
  author_name: string;
  content_status: "summary" | "complete" | "unavailable";
  in_reply_to_handle: string | null;
  creator_id: number;
  creator: string;
  platform: CreatorPlatform | null;
}

/** First non-empty line of a post, trimmed to a display-friendly length. */
function tweetTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  const label = line ?? "X post";
  return label.length > 120 ? `${label.slice(0, 117)}…` : label;
}

/**
 * Validates each requested reference against the local cache. Repeated
 * references collapse to their first occurrence; result lists preserve
 * request order. Unknown and not-ready sources are reported separately so
 * callers can explain exactly what is missing.
 */
export function resolveSourceScope(
  db: ScopeDatabase,
  refs: readonly SourceRef[],
): SourceScopeResolution {
  const requested: SourceRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = sourceKey(ref);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    requested.push(ref);
  }

  const videoIds = requested.filter((ref) => ref.kind === "video").map((ref) => ref.id);
  const tweetIds = requested.filter((ref) => ref.kind === "tweet").map((ref) => ref.id);

  const videos = new Map<string, ScopedSource>();
  for (let start = 0; start < videoIds.length; start += QUERY_CHUNK_SIZE) {
    const chunk = videoIds.slice(start, start + QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<[...string[]], VideoScopeRow>(
        VIDEO_SCOPE_SELECT.replace("%PLACEHOLDERS%", placeholders),
      )
      .all(...chunk);
    for (const row of rows) {
      videos.set(row.id, {
        kind: "video",
        id: row.id,
        title: row.title,
        creator: row.creator,
        creatorId: Number(row.creator_id),
        platform: row.platform ?? "youtube",
        canonicalUrl: row.url,
        publishedAt: row.published_at,
        readyForAnalysis: Number(row.has_content) === 1,
        durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      });
    }
  }

  const tweets = new Map<string, ScopedSource>();
  for (let start = 0; start < tweetIds.length; start += QUERY_CHUNK_SIZE) {
    const chunk = tweetIds.slice(start, start + QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<[...string[]], TweetScopeRow>(
        TWEET_SCOPE_SELECT.replace("%PLACEHOLDERS%", placeholders),
      )
      .all(...chunk);
    for (const row of rows) {
      tweets.set(row.id, {
        kind: "tweet",
        id: row.id,
        title: tweetTitle(row.text),
        creator: row.author_name,
        creatorId: Number(row.creator_id),
        platform: "x",
        canonicalUrl: row.url,
        publishedAt: row.published_at,
        readyForAnalysis: row.content_status === "complete" && row.text.trim().length > 0,
        authorHandle: row.author_handle,
        contentStatus: row.content_status,
      });
    }
  }

  const sources: ScopedSource[] = [];
  const unknown: SourceRef[] = [];
  const notReady: SourceRef[] = [];
  for (const ref of requested) {
    const found = ref.kind === "video" ? videos.get(ref.id) : tweets.get(ref.id);
    if (!found) {
      unknown.push(ref);
      continue;
    }
    sources.push(found);
    if (!found.readyForAnalysis) {
      notReady.push(ref);
    }
  }

  return { sources, unknown, notReady };
}

/** Small interface so later stages can resolve without a database handle. */
export interface SourceScopeReader {
  resolveSourceScope(refs: readonly SourceRef[]): SourceScopeResolution;
}

export function createSourceScopeReader(db: ScopeDatabase): SourceScopeReader {
  return { resolveSourceScope: (refs) => resolveSourceScope(db, refs) };
}
