/**
 * Creator profiles — one person across platforms. Server-only.
 *
 * A `creators` row is one platform account (a YouTube or Rumble channel, an
 * X account) with its own feed and cache; a profile groups the accounts that
 * belong to the same person. Every account belongs to exactly one profile
 * (migration 024 backfills one per account and its triggers keep the
 * invariant), so linking accounts is only ever a regrouping: feeds,
 * transcripts, cursors, and research-list memberships stay on the account.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { listCreators, type CreatorPlatform, type CreatorRecord } from "./repository";

/** Display order for a person's accounts: video platforms first, then X. */
export const PLATFORM_ORDER: Record<CreatorPlatform, number> = { youtube: 0, rumble: 1, x: 2 };

export { PROFILE_NAME_MAX_LENGTH } from "./labels";

export interface CreatorProfileRecord {
  id: number;
  displayName: string;
  /** The representing account's avatar, already resolved (see resolveAvatar). */
  avatarUrl: string | null;
  /** The account the avatar streams through (`/api/creators/:id/avatar`). */
  avatarCreatorId: number | null;
  /** Every linked account, ordered by platform and then by when it was added. */
  accounts: CreatorRecord[];
  createdAt: string;
  updatedAt: string;
}

interface ProfileRow {
  id: number;
  display_name: string;
  avatar_creator_id: number | null;
  created_at: string;
  updated_at: string;
}

const PROFILE_SELECT = `SELECT id, display_name, avatar_creator_id, created_at, updated_at
                        FROM creator_profiles`;

function compareAccounts(a: CreatorRecord, b: CreatorRecord): number {
  return (
    PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform] ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id - b.id
  );
}

/**
 * The avatar that represents a person: the chosen account's when it still
 * belongs to them and has one, otherwise the first account (in display
 * order) that has an avatar at all.
 */
function resolveAvatar(
  chosenCreatorId: number | null,
  accounts: readonly CreatorRecord[],
): { avatarUrl: string | null; avatarCreatorId: number | null } {
  const chosen =
    accounts.find((account) => account.id === chosenCreatorId && account.avatarUrl !== null) ??
    accounts.find((account) => account.avatarUrl !== null);
  return chosen
    ? { avatarUrl: chosen.avatarUrl, avatarCreatorId: chosen.id }
    : { avatarUrl: null, avatarCreatorId: null };
}

function toProfile(row: ProfileRow, accounts: CreatorRecord[]): CreatorProfileRecord {
  const sorted = [...accounts].sort(compareAccounts);
  return {
    id: Number(row.id),
    displayName: row.display_name,
    ...resolveAvatar(row.avatar_creator_id === null ? null : Number(row.avatar_creator_id), sorted),
    accounts: sorted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function groupAccounts(accounts: readonly CreatorRecord[]): Map<number, CreatorRecord[]> {
  const byProfile = new Map<number, CreatorRecord[]>();
  for (const account of accounts) {
    const group = byProfile.get(account.profileId);
    if (group) {
      group.push(account);
    } else {
      byProfile.set(account.profileId, [account]);
    }
  }
  return byProfile;
}

/**
 * Every saved person with their accounts, alphabetical by name. Built from
 * `listCreators`, so a source-only host's profile (the database trigger gives
 * every account one) has no visible account and never appears.
 */
export function listProfiles(db: ScopeDatabase): CreatorProfileRecord[] {
  const byProfile = groupAccounts(listCreators(db));
  return db
    .prepare<[], ProfileRow>(`${PROFILE_SELECT} ORDER BY display_name COLLATE NOCASE ASC, id ASC`)
    .all()
    .map((row) => toProfile(row, byProfile.get(Number(row.id)) ?? []))
    .filter((profile) => profile.accounts.length > 0);
}

/** A visible person; null for an unknown id or a source-only host's profile. */
export function getProfile(db: ScopeDatabase, id: number): CreatorProfileRecord | null {
  const row = db.prepare<[number], ProfileRow>(`${PROFILE_SELECT} WHERE id = ?`).get(id);
  if (!row) {
    return null;
  }
  const accounts = listCreators(db).filter((account) => account.profileId === id);
  return accounts.length > 0 ? toProfile(row, accounts) : null;
}

/** The profile a saved account belongs to, or null for an unknown account. */
export function getProfileIdForCreator(db: ScopeDatabase, creatorId: number): number | null {
  const row = db
    .prepare<[number], { profile_id: number | null }>(
      "SELECT profile_id FROM creators WHERE id = ?",
    )
    .get(creatorId);
  return row?.profile_id == null ? null : Number(row.profile_id);
}

/** Whether every id is a visible person — one with at least one followed account. */
export function profilesExist(db: ScopeDatabase, ids: readonly number[]): boolean {
  if (ids.length === 0) {
    return true;
  }
  const placeholders = ids.map(() => "?").join(", ");
  const row = db
    .prepare<number[], { count: number }>(
      `SELECT COUNT(*) AS count FROM creator_profiles p
       WHERE p.id IN (${placeholders})
         AND EXISTS (SELECT 1 FROM creators c WHERE c.profile_id = p.id AND c.followed = 1)`,
    )
    .get(...ids);
  return Number(row?.count ?? 0) === new Set(ids).size;
}

function touch(db: ScopeDatabase, id: number): void {
  db.prepare(
    "UPDATE creator_profiles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(id);
}

export function renameProfile(db: ScopeDatabase, id: number, displayName: string): boolean {
  const result = db
    .prepare(
      `UPDATE creator_profiles
       SET display_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?`,
    )
    .run(displayName, id);
  return Number(result.changes) > 0;
}

/** Picks which linked account's avatar represents the person. */
export function setProfileAvatar(db: ScopeDatabase, profileId: number, creatorId: number): boolean {
  const result = db
    .prepare(
      `UPDATE creator_profiles
       SET avatar_creator_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND EXISTS (SELECT 1 FROM creators WHERE id = ? AND profile_id = ?)`,
    )
    .run(creatorId, profileId, creatorId, profileId);
  return Number(result.changes) > 0;
}

/**
 * Attributed videos live on the profile row and cascade away with it, so they
 * are copied (keeping their original `added_at`, which decides label
 * ownership) before an emptied profile is deleted.
 */
const COPY_PROFILE_VIDEOS_SQL = `INSERT OR IGNORE INTO profile_videos (profile_id, video_id, added_at)
   SELECT ?, video_id, added_at FROM profile_videos WHERE profile_id = ?`;

/**
 * Folds other people into `targetId`: their accounts move over and their
 * categories and attributed videos join the target's. The emptied profiles
 * are deleted by the migration-024 trigger, so this is one atomic regrouping.
 */
export function mergeProfiles(
  db: ScopeDatabase,
  targetId: number,
  sourceIds: readonly number[],
): void {
  const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
  if (sources.length === 0) {
    return;
  }
  const copyCategories = db.prepare(
    `INSERT OR IGNORE INTO profile_categories (profile_id, category_id)
     SELECT ?, category_id FROM profile_categories WHERE profile_id = ?`,
  );
  const copyVideos = db.prepare(COPY_PROFILE_VIDEOS_SQL);
  const moveAccounts = db.prepare("UPDATE creators SET profile_id = ? WHERE profile_id = ?");
  const merge = db.transaction(() => {
    for (const sourceId of sources) {
      copyCategories.run(targetId, sourceId);
      copyVideos.run(targetId, sourceId);
      moveAccounts.run(targetId, sourceId);
    }
    touch(db, targetId);
  });
  merge();
}

/**
 * Moves one account into an existing profile — the "add to an existing
 * creator" path for an account that was already saved on its own. The
 * account's previous person keeps their categories; if it was their only
 * account they are removed, so their categories and attributed videos carry
 * over first.
 */
export function moveAccountToProfile(
  db: ScopeDatabase,
  creatorId: number,
  targetProfileId: number,
): void {
  const move = db.transaction(() => {
    const sourceId = getProfileIdForCreator(db, creatorId);
    if (sourceId === null || sourceId === targetProfileId) {
      return;
    }
    const remaining = db
      .prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM creators WHERE profile_id = ?",
      )
      .get(sourceId);
    if (Number(remaining?.count ?? 0) <= 1) {
      db.prepare(
        `INSERT OR IGNORE INTO profile_categories (profile_id, category_id)
         SELECT ?, category_id FROM profile_categories WHERE profile_id = ?`,
      ).run(targetProfileId, sourceId);
      db.prepare(COPY_PROFILE_VIDEOS_SQL).run(targetProfileId, sourceId);
    }
    db.prepare("UPDATE creators SET profile_id = ? WHERE id = ?").run(targetProfileId, creatorId);
    touch(db, targetProfileId);
  });
  move();
}

/**
 * Splits one account off into a person of its own, named after the account
 * and keeping a copy of the categories it was filed under. Returns the new
 * profile id, or null when the account was not linked to anyone else.
 */
export function detachAccount(db: ScopeDatabase, creatorId: number): number | null {
  const detach = db.transaction((): number | null => {
    const account = db
      .prepare<[number], { profile_id: number; display_name: string }>(
        "SELECT profile_id, display_name FROM creators WHERE id = ?",
      )
      .get(creatorId);
    if (!account) {
      return null;
    }
    const siblings = db
      .prepare<[number], { count: number }>(
        "SELECT COUNT(*) AS count FROM creators WHERE profile_id = ?",
      )
      .get(account.profile_id);
    if (Number(siblings?.count ?? 0) <= 1) {
      return null;
    }
    const inserted = db
      .prepare("INSERT INTO creator_profiles (display_name, avatar_creator_id) VALUES (?, ?)")
      .run(account.display_name.trim() || "Creator", creatorId);
    const newId = Number(inserted.lastInsertRowid);
    db.prepare(
      `INSERT INTO profile_categories (profile_id, category_id)
       SELECT ?, category_id FROM profile_categories WHERE profile_id = ?`,
    ).run(newId, account.profile_id);
    db.prepare("UPDATE creators SET profile_id = ? WHERE id = ?").run(newId, creatorId);
    touch(db, account.profile_id);
    return newId;
  });
  return detach();
}

/**
 * Deletes every account of a person; their cached content cascades with the
 * accounts and the emptied profile is pruned by trigger. Returns how many
 * accounts were removed. Only followed accounts count, so a source-only
 * host's profile id is "not found" like everywhere else people are read.
 */
export function removeProfileAccounts(db: ScopeDatabase, profileId: number): number {
  const result = db
    .prepare("DELETE FROM creators WHERE profile_id = ? AND followed = 1")
    .run(profileId);
  return Number(result.changes);
}

/** Cached content per account, for a creator page's tab counts. */
export interface AccountContentCounts {
  videos: number;
  livestreams: number;
  posts: number;
}

export function countAccountContent(
  db: ScopeDatabase,
  accountIds: readonly number[],
): Map<number, AccountContentCounts> {
  const counts = new Map<number, AccountContentCounts>(
    accountIds.map((id) => [id, { videos: 0, livestreams: 0, posts: 0 }]),
  );
  if (accountIds.length === 0) {
    return counts;
  }
  const placeholders = accountIds.map(() => "?").join(", ");
  const videoRows = db
    .prepare<number[], { creator_id: number; total: number; live: number }>(
      `SELECT creator_id, COUNT(*) AS total,
              SUM(live_status IN ('is_live', 'was_live', 'upcoming')) AS live
       FROM videos WHERE creator_id IN (${placeholders})
       GROUP BY creator_id`,
    )
    .all(...accountIds);
  for (const row of videoRows) {
    const entry = counts.get(Number(row.creator_id));
    if (entry) {
      entry.livestreams = Number(row.live ?? 0);
      entry.videos = Number(row.total) - entry.livestreams;
    }
  }
  const postRows = db
    .prepare<number[], { creator_id: number; total: number }>(
      `SELECT creator_id, COUNT(*) AS total
       FROM creator_tweets WHERE creator_id IN (${placeholders})
       GROUP BY creator_id`,
    )
    .all(...accountIds);
  for (const row of postRows) {
    const entry = counts.get(Number(row.creator_id));
    if (entry) {
      entry.posts = Number(row.total);
    }
  }
  return counts;
}

export { identitiesMatch, normalizeIdentity, type IdentityCandidate } from "./profile-match";
