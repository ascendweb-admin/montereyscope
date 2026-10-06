/**
 * SQLite-backed cache of creator feed videos. Server-only.
 * Rows map the `videos` table created by migration 001.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import type { VideoDraft } from "./mapper";

export type LiveStatus = "not_live" | "is_live" | "was_live" | "upcoming" | "unknown";

/** The cached-feed tabs the UI shows. Distinct from yt-dlp tab names. */
export type FeedTab = "videos" | "livestreams";

export interface VideoRecord {
  id: string;
  creatorId: number;
  title: string;
  url: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  liveStatus: LiveStatus;
  description: string | null;
  fetchedAt: string;
}

interface VideoRow {
  id: string;
  creator_id: number;
  title: string;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  live_status: LiveStatus;
  description: string | null;
  fetched_at: string;
}

function toRecord(row: VideoRow): VideoRecord {
  return {
    id: row.id,
    creatorId: Number(row.creator_id),
    title: row.title,
    url: row.url,
    thumbnailUrl: row.thumbnail_url,
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
    liveStatus: row.live_status,
    description: row.description,
    fetchedAt: row.fetched_at,
  };
}

/**
 * Tab membership is decided purely by stored live status, so every cached
 * video appears in exactly one tab:
 * - videos: ordinary uploads (plus anything whose status stayed unknown)
 * - livestreams: active, scheduled, and past livestreams
 */
const TAB_LIVE_STATUSES: Record<FeedTab, readonly LiveStatus[]> = {
  videos: ["not_live", "unknown"],
  livestreams: ["is_live", "was_live", "upcoming"],
};

/**
 * All cached videos for a creator in one tab, newest first. Undated items
 * (e.g. upcoming streams) sort ahead of dated ones within the tab.
 */
export function listCachedVideos(
  db: ScopeDatabase,
  creatorId: number,
  tab: FeedTab,
): VideoRecord[] {
  const statuses = TAB_LIVE_STATUSES[tab];
  const placeholders = statuses.map(() => "?").join(", ");
  const rows = db
    .prepare<[number, ...string[]], VideoRow>(
      `SELECT * FROM videos
       WHERE creator_id = ? AND live_status IN (${placeholders})
       ORDER BY (published_at IS NULL) DESC, published_at DESC`,
    )
    .all(creatorId, ...statuses);
  return rows.map(toRecord);
}

/** Total number of cached videos across both tabs for a creator. */
export function countCachedVideos(db: ScopeDatabase, creatorId: number): number {
  const row = db
    .prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM videos WHERE creator_id = ?")
    .get(creatorId);
  return row ? Number(row.n) : 0;
}

/** Total number of cached videos across all creators. */
export function countAllVideos(db: ScopeDatabase): number {
  const row = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM videos").get();
  return row ? Number(row.n) : 0;
}

/**
 * Deletes every cached video entry (transcripts cascade via foreign key)
 * and clears every creator's last-refreshed stamp, in one transaction.
 * Used only by the explicit, confirmed Settings action — never during
 * refresh failures. Returns the number of video rows removed.
 */
export function clearAllCachedFeeds(db: ScopeDatabase): number {
  const wipe = db.transaction((): number => {
    const result = db.prepare("DELETE FROM videos").run();
    db.prepare("UPDATE creators SET last_refreshed_at = NULL").run();
    return Number(result.changes);
  });
  return wipe();
}

export function getVideoForCreator(
  db: ScopeDatabase,
  creatorId: number,
  videoId: string,
): VideoRecord | null {
  const row = db
    .prepare<[number, string], VideoRow>(
      "SELECT * FROM videos WHERE creator_id = ? AND id = ? LIMIT 1",
    )
    .get(creatorId, videoId);
  return row ? toRecord(row) : null;
}

export interface VideoWithCreator extends VideoRecord {
  /** Creator display name, joined from the creators table. */
  creatorName: string;
}

interface VideoWithCreatorRow extends VideoRow {
  creator_name: string;
}

function toWithCreatorRecord(row: VideoWithCreatorRow): VideoWithCreator {
  return { ...toRecord(row), creatorName: row.creator_name };
}

/**
 * Every cached video across all creators, newest first (undated items sort
 * ahead, matching the per-tab ordering). Feeds the AI Research page; pair
 * with resolveScope for per-video transcript availability.
 */
export function listAllVideosWithCreator(db: ScopeDatabase): VideoWithCreator[] {
  const rows = db
    .prepare<[], VideoWithCreatorRow>(
      `SELECT v.*, c.display_name AS creator_name
       FROM videos v
       JOIN creators c ON c.id = v.creator_id
       ORDER BY (v.published_at IS NULL) DESC, v.published_at DESC`,
    )
    .all();
  return rows.map(toWithCreatorRecord);
}

export type FeedVideoPlatform = "youtube" | "rumble";

export interface FeedVideoRecord extends VideoWithCreator {
  /** Creator avatar URL for the feed's byline, joined from the creators table. */
  creatorAvatarUrl: string | null;
  /** Creator platform, so feed rows can label the source and its links. */
  creatorPlatform: FeedVideoPlatform;
  /** Whether a cached transcript exists — drives the row's transcript action. */
  hasTranscript: boolean;
}

interface FeedVideoRow extends VideoWithCreatorRow {
  creator_avatar_url: string | null;
  creator_platform: FeedVideoPlatform | null;
  has_transcript: number;
}

function toFeedRecord(row: FeedVideoRow): FeedVideoRecord {
  return {
    ...toWithCreatorRecord(row),
    creatorAvatarUrl: row.creator_avatar_url,
    creatorPlatform: row.creator_platform ?? "youtube",
    hasTranscript: Number(row.has_transcript) === 1,
  };
}

/**
 * The unified feed: every cached video across all saved creators, newest
 * first (undated items sort ahead, matching every other cached read), with
 * the creator and cached-transcript fields the feed rows render. Pair with
 * the transcripts actions for per-row extraction.
 */
export function listFeedVideos(db: ScopeDatabase): FeedVideoRecord[] {
  const rows = db
    .prepare<[], FeedVideoRow>(
      `SELECT v.*, c.display_name AS creator_name, c.avatar_url AS creator_avatar_url,
              c.platform AS creator_platform,
              (t.video_id IS NOT NULL) AS has_transcript
       FROM videos v
       JOIN creators c ON c.id = v.creator_id
       LEFT JOIN transcripts t ON t.video_id = v.id
       ORDER BY (v.published_at IS NULL) DESC, v.published_at DESC`,
    )
    .all();
  return rows.map(toFeedRecord);
}

export interface MergeFeedInput {
  creatorId: number;
  /** Fully parsed feed drafts to merge into the cache (both tabs merged). */
  videos: readonly VideoDraft[];
  /** ISO timestamp written to creators.last_refreshed_at on success only. */
  refreshedAt: string;
}

export interface MergeFeedOutcome {
  /** Number of fetched drafts in this merge, before upsert dedupe. */
  fetchedCount: number;
  livestreamCount: number;
}

/**
 * Atomically merges a freshly parsed feed into a creator's cache and stamps
 * the refresh time — in ONE transaction so a failure anywhere leaves the
 * previous cache (and last_refreshed_at) untouched.
 *
 * Upsert-on-id, never delete: known rows are updated in place and rows that
 * scrolled past the fetched recent-items window stay put — along with their
 * cached transcripts, which would otherwise cascade away on every refresh
 * (see docs/proposals/background-ingestion.md §1). Trimming the cache is the
 * explicit, confirmed Settings action, never a side effect of refreshing.
 *
 * Callers MUST pass fully parsed drafts; nothing here writes before parsing
 * has succeeded upstream.
 */
export function mergeCreatorFeed(db: ScopeDatabase, input: MergeFeedInput): MergeFeedOutcome {
  const upsert = db.prepare(
    `INSERT INTO videos
       (id, creator_id, title, url, thumbnail_url, published_at, duration_seconds, live_status, description, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (id) DO UPDATE SET
       creator_id = excluded.creator_id,
       title = excluded.title,
       url = excluded.url,
       thumbnail_url = excluded.thumbnail_url,
       -- Flat entries carry approximate dates, so the first stored estimate
       -- wins; a newer guess may only fill a date in when the row has none
       -- (e.g. an upcoming stream that gained a schedule time).
       published_at = COALESCE(videos.published_at, excluded.published_at),
       duration_seconds = excluded.duration_seconds,
       live_status = excluded.live_status,
       description = excluded.description,
       fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const stampRefresh = db.prepare("UPDATE creators SET last_refreshed_at = ? WHERE id = ?");

  const merge = db.transaction((drafts: readonly VideoDraft[]): MergeFeedOutcome => {
    for (const draft of drafts) {
      upsert.run(
        draft.id,
        input.creatorId,
        draft.title,
        draft.url,
        draft.thumbnailUrl,
        draft.publishedAt,
        draft.durationSeconds,
        draft.liveStatus,
        draft.description,
      );
    }
    stampRefresh.run(input.refreshedAt, input.creatorId);

    const livestreamCount = drafts.filter((draft) =>
      TAB_LIVE_STATUSES.livestreams.includes(draft.liveStatus),
    ).length;
    return { fetchedCount: drafts.length, livestreamCount };
  });

  return merge(input.videos);
}
