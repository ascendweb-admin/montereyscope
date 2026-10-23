/**
 * Videos attributed to a person ("Other videos"). Server-only.
 *
 * `profile_videos` links a video to the person it features, whichever channel
 * hosts it. A host saved only to satisfy `videos.creator_id` is source-only
 * (`creators.followed = 0`); the invariant is that every video of such a host
 * is attributed to at least one person, and a source-only host left with no
 * attributed video is deleted.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { FeedVideoPlatform, VideoRecord } from "./repository";

/** Matches the chunking in lib/transcripts/prepare.ts; far below SQLite's variable limit. */
const IN_CHUNK_SIZE = 500;

/** Attaches a video to a person. True when newly added, false when it already was. */
export function attachVideoToProfile(
  db: ScopeDatabase,
  profileId: number,
  videoId: string,
): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO profile_videos (profile_id, video_id) VALUES (?, ?)")
    .run(profileId, videoId);
  return Number(result.changes) > 0;
}

/** Removes one attribution. True when there was one to remove. */
export function detachVideoFromProfile(
  db: ScopeDatabase,
  profileId: number,
  videoId: string,
): boolean {
  const result = db
    .prepare("DELETE FROM profile_videos WHERE profile_id = ? AND video_id = ?")
    .run(profileId, videoId);
  return Number(result.changes) > 0;
}

/** The people a video is attributed to, first-added first; the first owns the label. */
export function listVideoProfileIds(db: ScopeDatabase, videoId: string): number[] {
  return db
    .prepare<[string], { profile_id: number }>(
      `SELECT profile_id FROM profile_videos
       WHERE video_id = ? ORDER BY added_at ASC, profile_id ASC`,
    )
    .all(videoId)
    .map((row) => Number(row.profile_id));
}

export interface FeaturedProfile {
  profileId: number;
  displayName: string;
}

interface FeaturedRow {
  video_id: string;
  profile_id: number;
  display_name: string;
}

function collectFeatured(rows: readonly FeaturedRow[], featured: Map<string, FeaturedProfile[]>) {
  for (const row of rows) {
    const entry = { profileId: Number(row.profile_id), displayName: row.display_name };
    const list = featured.get(row.video_id);
    if (list) {
      list.push(entry);
    } else {
      featured.set(row.video_id, [entry]);
    }
  }
}

/**
 * Video id → the people it features, in label order. Videos with no
 * attribution are absent from the map.
 */
export function listFeaturedProfiles(
  db: ScopeDatabase,
  videoIds: readonly string[],
): Map<string, FeaturedProfile[]> {
  const featured = new Map<string, FeaturedProfile[]>();
  const unique = [...new Set(videoIds)];
  for (let start = 0; start < unique.length; start += IN_CHUNK_SIZE) {
    const chunk = unique.slice(start, start + IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    collectFeatured(
      db
        .prepare<string[], FeaturedRow>(
          `SELECT pv.video_id, pv.profile_id, p.display_name
           FROM profile_videos pv
           JOIN creator_profiles p ON p.id = pv.profile_id
           WHERE pv.video_id IN (${placeholders})
           ORDER BY pv.added_at ASC, pv.profile_id ASC`,
        )
        .all(...chunk),
      featured,
    );
  }
  return featured;
}

/** {@link listFeaturedProfiles} for every attributed video, in one read (the library-wide surfaces). */
export function listAllFeaturedProfiles(db: ScopeDatabase): Map<string, FeaturedProfile[]> {
  const featured = new Map<string, FeaturedProfile[]>();
  collectFeatured(
    db
      .prepare<[], FeaturedRow>(
        `SELECT pv.video_id, pv.profile_id, p.display_name
         FROM profile_videos pv
         JOIN creator_profiles p ON p.id = pv.profile_id
         ORDER BY pv.added_at ASC, pv.profile_id ASC`,
      )
      .all(),
    featured,
  );
  return featured;
}

/**
 * The person a video is labelled with on the feed, the picker, and citations:
 * the first attached person, skipping the owner of the hosting channel (a
 * video on someone's own channel is simply theirs, not an appearance). Null
 * when the video is nobody's appearance.
 */
export function labelProfileOf(
  featured: readonly FeaturedProfile[] | undefined,
  hostProfileId: number | null,
): FeaturedProfile | null {
  return featured?.find((profile) => profile.profileId !== hostProfileId) ?? null;
}

/** An attributed video with the channel that hosts it. */
export interface ProfileVideo extends VideoRecord {
  hostName: string;
  hostPlatform: FeedVideoPlatform;
}

interface ProfileVideoRow {
  id: string;
  creator_id: number;
  title: string;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  live_status: VideoRecord["liveStatus"];
  description: string | null;
  fetched_at: string;
  host_name: string;
  host_platform: CreatorPlatform | null;
}

/**
 * A person's attributed videos, newest published first (undated first,
 * matching the other cached reads), with the host's creator id, name and
 * platform.
 */
export function listProfileVideos(db: ScopeDatabase, profileId: number): ProfileVideo[] {
  return db
    .prepare<[number], ProfileVideoRow>(
      `SELECT v.*, c.display_name AS host_name, c.platform AS host_platform
       FROM profile_videos pv
       JOIN videos v ON v.id = pv.video_id
       JOIN creators c ON c.id = v.creator_id
       WHERE pv.profile_id = ?
       ORDER BY (v.published_at IS NULL) DESC, v.published_at DESC, v.id ASC`,
    )
    .all(profileId)
    .map((row) => ({
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
      hostName: row.host_name,
      hostPlatform: row.host_platform === "rumble" ? "rumble" : "youtube",
    }));
}

export function countProfileVideos(db: ScopeDatabase, profileId: number): number {
  const row = db
    .prepare<[number], { n: number }>(
      "SELECT COUNT(*) AS n FROM profile_videos WHERE profile_id = ?",
    )
    .get(profileId);
  return row ? Number(row.n) : 0;
}

/**
 * Deletes source-only hosts that no longer have an attributed video; their
 * videos cascade and the profile trigger removes their profile. Returns the
 * number of hosts deleted.
 */
export function pruneSourceOnlyHosts(db: ScopeDatabase): number {
  const result = db
    .prepare(
      `DELETE FROM creators
       WHERE followed = 0
         AND NOT EXISTS (
           SELECT 1 FROM videos v
           JOIN profile_videos pv ON pv.video_id = v.id
           WHERE v.creator_id = creators.id
         )`,
    )
    .run();
  return Number(result.changes);
}

/**
 * Takes a video out of a person's "Other videos". When that was its last
 * attribution and its host is source-only, the video is deleted (transcript
 * and digest cascade) and the host goes with it if nothing else keeps it. A
 * video of a followed host is never deleted here.
 */
export function removeAttributedVideo(
  db: ScopeDatabase,
  profileId: number,
  videoId: string,
): { removedVideo: boolean; removedHost: boolean } {
  const remove = db.transaction(() => {
    detachVideoFromProfile(db, profileId, videoId);
    const host = db
      .prepare<[string], { id: number; followed: number }>(
        `SELECT c.id, c.followed FROM videos v JOIN creators c ON c.id = v.creator_id WHERE v.id = ?`,
      )
      .get(videoId);
    let removedVideo = false;
    if (host && Number(host.followed) === 0 && listVideoProfileIds(db, videoId).length === 0) {
      removedVideo = Number(db.prepare("DELETE FROM videos WHERE id = ?").run(videoId).changes) > 0;
    }
    pruneSourceOnlyHosts(db);
    const hostStays =
      host !== undefined &&
      db.prepare("SELECT 1 FROM creators WHERE id = ?").get(host.id) !== undefined;
    return { removedVideo, removedHost: host !== undefined && !hostStays };
  });
  return remove();
}

export interface RemoveAttributedVideosResult {
  /** Videos taken out of the person's Other videos. */
  removed: number;
  /** Of those, videos deleted because nothing else used them. */
  deletedVideos: number;
  /** Source-only channels deleted along with their last video. */
  deletedHosts: number;
}

/**
 * Takes several videos out of a person's Other videos in one transaction (see
 * {@link removeAttributedVideo}). Ids that are not attributed to this person
 * are skipped, so a stale selection can never delete anything else.
 */
export function removeAttributedVideos(
  db: ScopeDatabase,
  profileId: number,
  videoIds: readonly string[],
): RemoveAttributedVideosResult {
  const remove = db.transaction((): RemoveAttributedVideosResult => {
    const result = { removed: 0, deletedVideos: 0, deletedHosts: 0 };
    for (const videoId of new Set(videoIds)) {
      if (!listVideoProfileIds(db, videoId).includes(profileId)) {
        continue;
      }
      const outcome = removeAttributedVideo(db, profileId, videoId);
      result.removed += 1;
      result.deletedVideos += outcome.removedVideo ? 1 : 0;
      result.deletedHosts += outcome.removedHost ? 1 : 0;
    }
    return result;
  });
  return remove();
}
