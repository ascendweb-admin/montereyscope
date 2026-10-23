/**
 * SQLite-backed creator library storage. Server-only.
 * Rows map the `creators` table created by migration 001.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { isAllowedImageUrl } from "./avatar";

export type CreatorPlatform = "youtube" | "rumble" | "x";

export interface CreatorRecord {
  id: number;
  /** Canonical UC… channel ID; null only if yt-dlp could not provide one. */
  youtubeChannelId: string | null;
  /**
   * Platform-stable account id (currently the X user id, kept as a string
   * because X ids exceed JavaScript's safe integer range). Null for
   * YouTube/Rumble rows.
   */
  platformUserId: string | null;
  handle: string | null;
  displayName: string;
  channelUrl: string;
  avatarUrl: string | null;
  /** Which platform this creator's feed comes from; 'youtube' backfills old rows. */
  platform: CreatorPlatform;
  /** The person this account belongs to (`creator_profiles.id`). */
  profileId: number;
  /**
   * False for a source-only host: a channel saved only because a hand-picked
   * video lives on it. It has no library card and is pruned with its last
   * attributed video (see `lib/videos/attribution.ts`).
   */
  followed: boolean;
  createdAt: string;
  updatedAt: string;
  lastRefreshedAt: string | null;
}

export interface NewCreatorInput {
  youtubeChannelId: string | null;
  /** Optional platform identity; only X creators set this today. */
  platformUserId?: string | null;
  handle: string | null;
  displayName: string;
  channelUrl: string;
  avatarUrl: string | null;
  /** Optional; defaults to "youtube" at insert time (the SQL column default). */
  platform?: CreatorPlatform;
  /**
   * The person to file a new account under. Omitted, the account becomes its
   * own person (the database trigger creates the profile).
   */
  profileId?: number | null;
  /**
   * Defaults to true. `false` saves a source-only host that stays out of the
   * library; it never demotes a channel that is already followed.
   */
  followed?: boolean;
}

export type AddCreatorResult =
  | { status: "created"; creator: CreatorRecord }
  | { status: "already_saved"; creator: CreatorRecord };

interface CreatorRow {
  id: number;
  youtube_channel_id: string | null;
  platform_user_id: string | null;
  handle: string | null;
  display_name: string;
  channel_url: string;
  avatar_url: string | null;
  platform: CreatorPlatform | null;
  profile_id: number | null;
  followed: number;
  created_at: string;
  updated_at: string;
  last_refreshed_at: string | null;
}

function toRecord(row: CreatorRow): CreatorRecord {
  return {
    id: Number(row.id),
    youtubeChannelId: row.youtube_channel_id,
    platformUserId: row.platform_user_id,
    handle: row.handle,
    displayName: row.display_name,
    channelUrl: row.channel_url,
    avatarUrl: row.avatar_url,
    platform: row.platform ?? "youtube",
    profileId: Number(row.profile_id ?? row.id),
    followed: Number(row.followed) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

const CREATOR_SELECT = `SELECT id, youtube_channel_id, platform_user_id, handle, display_name,
                              channel_url, avatar_url, platform, profile_id, followed,
                              created_at, updated_at, last_refreshed_at
                       FROM creators`;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * Finds a previously saved creator that refers to the same account:
 * canonical platform identity first (YouTube channel id or X user id), then
 * exact canonical URL match for rows saved before an identity was known
 * (handle links, Rumble channels).
 */
export function findDuplicateCreator(
  db: ScopeDatabase,
  input: Pick<NewCreatorInput, "youtubeChannelId" | "platformUserId" | "channelUrl">,
): CreatorRecord | null {
  if (input.platformUserId != null && input.platformUserId !== "") {
    const byPlatformId = db
      .prepare<[string], CreatorRow>(`${CREATOR_SELECT} WHERE platform_user_id = ? LIMIT 1`)
      .get(input.platformUserId);
    if (byPlatformId) {
      return toRecord(byPlatformId);
    }
  }
  if (input.youtubeChannelId !== null) {
    const byId = db
      .prepare<[string], CreatorRow>(`${CREATOR_SELECT} WHERE youtube_channel_id = ? LIMIT 1`)
      .get(input.youtubeChannelId);
    if (byId) {
      return toRecord(byId);
    }
  }
  const byUrl = db
    .prepare<[string], CreatorRow>(
      `${CREATOR_SELECT} WHERE youtube_channel_id IS NULL AND platform_user_id IS NULL AND lower(channel_url) = lower(?) LIMIT 1`,
    )
    .get(input.channelUrl);
  return byUrl ? toRecord(byUrl) : null;
}

/**
 * What adding a channel that is already saved means. A source-only host the
 * caller now wants in the library is promoted ("Added", not "already in your
 * library"); every other duplicate is a friendly no-op, so a source-only
 * request never demotes a followed channel.
 */
function resolveDuplicate(
  db: ScopeDatabase,
  duplicate: CreatorRecord,
  input: NewCreatorInput,
): AddCreatorResult {
  if (duplicate.followed || input.followed === false) {
    return { status: "already_saved", creator: duplicate };
  }
  setCreatorFollowed(db, duplicate.id, true);
  if (input.avatarUrl !== null && duplicate.avatarUrl === null) {
    // Hosts are saved without an avatar; keep the one the caller just resolved.
    db.prepare("UPDATE creators SET avatar_url = ? WHERE id = ? AND avatar_url IS NULL").run(
      input.avatarUrl,
      duplicate.id,
    );
  }
  const promoted = getCreator(db, duplicate.id);
  if (!promoted) {
    throw new Error("Followed creator could not be read back");
  }
  return { status: "created", creator: promoted };
}

/**
 * Inserts a new creator, or returns the existing row when this channel is
 * already saved — adding the same creator twice is a friendly no-op.
 */
export function addCreator(db: ScopeDatabase, input: NewCreatorInput): AddCreatorResult {
  const duplicate = findDuplicateCreator(db, input);
  if (duplicate) {
    return resolveDuplicate(db, duplicate, input);
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO creators
           (youtube_channel_id, platform_user_id, handle, display_name, channel_url, avatar_url,
            platform, profile_id, followed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.youtubeChannelId,
        input.platformUserId ?? null,
        input.handle,
        input.displayName,
        input.channelUrl,
        input.avatarUrl,
        input.platform ?? "youtube",
        input.profileId ?? null,
        input.followed === false ? 0 : 1,
      );
    const inserted = getCreator(db, Number(result.lastInsertRowid));
    if (!inserted) {
      throw new Error("Inserted creator could not be read back");
    }
    return { status: "created", creator: inserted };
  } catch (error) {
    // A concurrent insert may have won the race; treat it as a duplicate.
    if (isUniqueConstraintError(error)) {
      const winner = findDuplicateCreator(db, input);
      if (winner) {
        return resolveDuplicate(db, winner, input);
      }
    }
    throw error;
  }
}

/**
 * The creators in the library, alphabetical by display name. Source-only
 * hosts are excluded: this is the funnel for every surface that lists,
 * refreshes or counts creators, so they stay invisible by default.
 */
export function listCreators(db: ScopeDatabase): CreatorRecord[] {
  const rows = db
    .prepare<[], CreatorRow>(
      `${CREATOR_SELECT} WHERE followed = 1 ORDER BY display_name COLLATE NOCASE ASC`,
    )
    .all();
  return rows.map(toRecord);
}

/** Every saved creator including source-only hosts, alphabetical by display name. */
export function listAllCreators(db: ScopeDatabase): CreatorRecord[] {
  const rows = db
    .prepare<[], CreatorRow>(`${CREATOR_SELECT} ORDER BY display_name COLLATE NOCASE ASC`)
    .all();
  return rows.map(toRecord);
}

export function getCreator(db: ScopeDatabase, id: number): CreatorRecord | null {
  const row = db.prepare<[number], CreatorRow>(`${CREATOR_SELECT} WHERE id = ?`).get(id);
  return row ? toRecord(row) : null;
}

/** Sets whether a creator is in the library (true) or a source-only host (false). */
export function setCreatorFollowed(db: ScopeDatabase, id: number, followed: boolean): boolean {
  const result = db
    .prepare("UPDATE creators SET followed = ? WHERE id = ?")
    .run(followed ? 1 : 0, id);
  return Number(result.changes) > 0;
}

/**
 * Stores an avatar for a creator. Only URLs on a platform image CDN are kept
 * (`isAllowedImageUrl`); anything else changes nothing and reports false.
 */
export function setCreatorAvatar(db: ScopeDatabase, id: number, avatarUrl: string): boolean {
  if (!isAllowedImageUrl(avatarUrl)) {
    return false;
  }
  const result = db.prepare("UPDATE creators SET avatar_url = ? WHERE id = ?").run(avatarUrl, id);
  return Number(result.changes) > 0;
}

/**
 * Removes a creator and cascades its cached videos/transcripts
 * (enforced by foreign keys). Returns false when nothing was deleted.
 */
export function removeCreator(db: ScopeDatabase, id: number): boolean {
  const result = db.prepare("DELETE FROM creators WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}
