/**
 * SQLite-backed creator library storage. Server-only.
 * Rows map the `creators` table created by migration 001.
 */
import type { ScopeDatabase } from "@/lib/db/connection";

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRefreshedAt: row.last_refreshed_at,
  };
}

const CREATOR_SELECT = `SELECT id, youtube_channel_id, platform_user_id, handle, display_name,
                              channel_url, avatar_url, platform, created_at, updated_at,
                              last_refreshed_at
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
 * Inserts a new creator, or returns the existing row when this channel is
 * already saved — adding the same creator twice is a friendly no-op.
 */
export function addCreator(db: ScopeDatabase, input: NewCreatorInput): AddCreatorResult {
  const duplicate = findDuplicateCreator(db, input);
  if (duplicate) {
    return { status: "already_saved", creator: duplicate };
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO creators
           (youtube_channel_id, platform_user_id, handle, display_name, channel_url, avatar_url, platform)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.youtubeChannelId,
        input.platformUserId ?? null,
        input.handle,
        input.displayName,
        input.channelUrl,
        input.avatarUrl,
        input.platform ?? "youtube",
      );
    const inserted = getCreator(db, Number(result.lastInsertRowid));
    if (!inserted) {
      throw new Error("Inserted creator could not be read back");
    }
    return { status: "created", creator: inserted };
  } catch (error) {
    // A concurrent insert may have won the race; treat it as "already saved".
    if (isUniqueConstraintError(error)) {
      const winner = findDuplicateCreator(db, input);
      if (winner) {
        return { status: "already_saved", creator: winner };
      }
    }
    throw error;
  }
}

/** All saved creators, alphabetical by display name. */
export function listCreators(db: ScopeDatabase): CreatorRecord[] {
  const rows = db
    .prepare<[], CreatorRow>(`${CREATOR_SELECT} ORDER BY display_name COLLATE NOCASE ASC`)
    .all();
  return rows.map(toRecord);
}

export function getCreator(db: ScopeDatabase, id: number): CreatorRecord | null {
  const row = db.prepare<[number], CreatorRow>(`${CREATOR_SELECT} WHERE id = ?`).get(id);
  return row ? toRecord(row) : null;
}

/**
 * Removes a creator and cascades its cached videos/transcripts
 * (enforced by foreign keys). Returns false when nothing was deleted.
 */
export function removeCreator(db: ScopeDatabase, id: number): boolean {
  const result = db.prepare("DELETE FROM creators WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}
