/**
 * Who a report is about: the people (creator profiles) behind its sources,
 * the categories those people are filed under, and the platforms the
 * sources came from — what the Reports page names on each row and filters
 * by. Server-only; reads the creator library, never the network.
 */
import type { CategoryColor } from "@/lib/categories/model";
import type { ScopeDatabase } from "@/lib/db/connection";
import { PLATFORM_ORDER } from "@/lib/creators/profiles";
import type { CreatorPlatform } from "@/lib/creators/repository";

/** One person a report draws on, across all of their platform accounts. */
export interface ReportCreator {
  /** The creator profile id. */
  id: number;
  name: string;
  /** The account whose avatar represents the person (avatar proxy route). */
  avatarCreatorId: number | null;
  avatarUrl: string | null;
  /** How many of the report's sources are theirs. */
  sourceCount: number;
}

export interface ReportCategory {
  id: number;
  name: string;
  color: CategoryColor;
}

export interface ReportPeople {
  /** Most-cited first. */
  creators: ReportCreator[];
  /** Every category of every creator, by name. */
  categories: ReportCategory[];
  /** The platforms the sources came from, in library order. */
  platforms: CreatorPlatform[];
}

interface AccountRow {
  id: number;
  platform: CreatorPlatform;
  profile_id: number;
  followed: number;
  display_name: string;
  avatar_creator_id: number | null;
}

interface ProfileRow {
  id: number;
  display_name: string;
  avatar_creator_id: number | null;
}

interface AvatarRow {
  id: number;
  profile_id: number;
  platform: CreatorPlatform;
  avatar_url: string;
  created_at: string;
}

interface CategoryRow {
  profile_id: number;
  id: number;
  name: string;
  color: CategoryColor;
}

const EMPTY: ReportPeople = { creators: [], categories: [], platforms: [] };

/**
 * Describes the people behind a report from its sources' platform accounts,
 * given as account id → number of sources from that account, plus (for
 * appearances on other people's channels) profile id → number of sources that
 * feature them. Accounts no longer in the library drop out. A source-only
 * host (`followed = 0`) is not a person of the library: its sources count
 * only toward the report's platforms, and the people they feature come from
 * `profileCounts`.
 */
export function describeReportPeople(
  db: ScopeDatabase,
  accountCounts: ReadonlyMap<number, number>,
  profileCounts: ReadonlyMap<number, number> = new Map(),
): ReportPeople {
  if (accountCounts.size === 0 && profileCounts.size === 0) {
    return EMPTY;
  }
  const accounts =
    accountCounts.size === 0
      ? []
      : db
          .prepare<[string], AccountRow>(
            `SELECT c.id, c.platform, c.profile_id, c.followed, p.display_name, p.avatar_creator_id
             FROM creators c
             JOIN creator_profiles p ON p.id = c.profile_id
             WHERE c.id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify([...accountCounts.keys()]));
  const featured =
    profileCounts.size === 0
      ? []
      : db
          .prepare<[string], ProfileRow>(
            `SELECT id, display_name, avatar_creator_id
             FROM creator_profiles
             WHERE id IN (SELECT value FROM json_each(?))`,
          )
          .all(JSON.stringify([...profileCounts.keys()]));
  if (accounts.length === 0 && featured.length === 0) {
    return EMPTY;
  }

  const byProfile = new Map<number, ReportCreator>();
  const chosenAvatars = new Map<number, number | null>();
  const platforms = new Set<CreatorPlatform>();
  const addPerson = (
    profileId: number,
    name: string,
    avatarCreatorId: number | null,
    count: number,
  ): void => {
    const existing = byProfile.get(profileId);
    if (existing) {
      existing.sourceCount += count;
      return;
    }
    byProfile.set(profileId, {
      id: profileId,
      name,
      avatarCreatorId: null,
      avatarUrl: null,
      sourceCount: count,
    });
    chosenAvatars.set(profileId, avatarCreatorId === null ? null : Number(avatarCreatorId));
  };
  for (const account of accounts) {
    platforms.add(account.platform);
    if (Number(account.followed) !== 1) {
      continue;
    }
    addPerson(
      Number(account.profile_id),
      account.display_name,
      account.avatar_creator_id,
      accountCounts.get(Number(account.id)) ?? 0,
    );
  }
  for (const person of featured) {
    addPerson(
      Number(person.id),
      person.display_name,
      person.avatar_creator_id,
      profileCounts.get(Number(person.id)) ?? 0,
    );
  }
  const profileIds = JSON.stringify([...byProfile.keys()]);

  // The profile's chosen avatar, else the first account with one — the same
  // rule the creator library uses.
  const avatars = db
    .prepare<[string], AvatarRow>(
      `SELECT id, profile_id, platform, avatar_url, created_at
       FROM creators
       WHERE profile_id IN (SELECT value FROM json_each(?)) AND avatar_url IS NOT NULL`,
    )
    .all(profileIds)
    .sort(
      (a, b) =>
        PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform] ||
        a.created_at.localeCompare(b.created_at) ||
        a.id - b.id,
    );
  for (const creator of byProfile.values()) {
    const own = avatars.filter((row) => Number(row.profile_id) === creator.id);
    const chosen = own.find((row) => Number(row.id) === chosenAvatars.get(creator.id)) ?? own[0];
    if (chosen) {
      creator.avatarCreatorId = Number(chosen.id);
      creator.avatarUrl = chosen.avatar_url;
    }
  }

  const categories = new Map<number, ReportCategory>();
  for (const row of db
    .prepare<[string], CategoryRow>(
      `SELECT pc.profile_id, c.id, c.name, c.color
       FROM profile_categories pc
       JOIN categories c ON c.id = pc.category_id
       WHERE pc.profile_id IN (SELECT value FROM json_each(?))`,
    )
    .all(profileIds)) {
    categories.set(Number(row.id), { id: Number(row.id), name: row.name, color: row.color });
  }

  return {
    creators: [...byProfile.values()].sort(
      (a, b) => b.sourceCount - a.sourceCount || a.name.localeCompare(b.name),
    ),
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    platforms: [...platforms].sort((a, b) => PLATFORM_ORDER[a] - PLATFORM_ORDER[b]),
  };
}

/**
 * Counts a resolved source list by the people it features on someone else's
 * channel (profile id → sources). Sources without `featuredProfileIds` add
 * nothing.
 */
export function countFeaturedProfiles(
  sources: ReadonlyArray<{ featuredProfileIds?: readonly number[] }>,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const source of sources) {
    for (const profileId of new Set(source.featuredProfileIds ?? [])) {
      counts.set(profileId, (counts.get(profileId) ?? 0) + 1);
    }
  }
  return counts;
}

/** Counts a resolved source list by the platform account each came from. */
export function countSourceAccounts(
  sources: ReadonlyArray<{ creatorId: number }>,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (const source of sources) {
    counts.set(source.creatorId, (counts.get(source.creatorId) ?? 0) + 1);
  }
  return counts;
}
