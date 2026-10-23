/**
 * Creator profile application service: validated operations shared by the
 * Server Actions, plus the client-safe view models every surface reads a
 * person through. Server-only.
 */
import {
  detachAccount,
  getProfile,
  getProfileIdForCreator,
  listProfiles,
  mergeProfiles,
  moveAccountToProfile,
  profilesExist,
  PROFILE_NAME_MAX_LENGTH,
  removeProfileAccounts,
  renameProfile,
  setProfileAvatar,
  type CreatorProfileRecord,
} from "./profiles";
import type { CreatorPlatform, CreatorRecord } from "./repository";
import { listCategoriesForProfile, listProfileCategoryAssignments } from "@/lib/categories";
import type { CreatorCategory } from "@/lib/categories";
import { deleteOrphanTweets } from "@/lib/x/repository";
import { pruneSourceOnlyHosts } from "@/lib/videos/attribution";
import type { ScopeDatabase } from "@/lib/db/connection";

/** One platform account as the UI needs it. */
export interface CreatorAccountSummary {
  id: number;
  platform: CreatorPlatform;
  displayName: string;
  handle: string | null;
  channelUrl: string;
  avatarUrl: string | null;
  lastRefreshedAt: string | null;
}

/** A person with every linked account and their categories. */
export interface CreatorProfileSummary {
  id: number;
  displayName: string;
  avatarUrl: string | null;
  avatarCreatorId: number | null;
  accounts: CreatorAccountSummary[];
  categories: CreatorCategory[];
}

export interface ProfileServiceError {
  code: "invalid_input" | "not_found" | "not_linked";
  message: string;
}

type ProfileResult<T = Record<never, never>> =
  ({ ok: true } & T) | { ok: false; error: ProfileServiceError };

export function toAccountSummary(
  record: CreatorRecord,
  xRefreshedAt?: ReadonlyMap<number, string | null>,
): CreatorAccountSummary {
  return {
    id: record.id,
    platform: record.platform,
    displayName: record.displayName,
    handle: record.handle,
    channelUrl: record.channelUrl,
    avatarUrl: record.avatarUrl,
    // X timelines record their refreshes in x_feed_state, not on the account row.
    lastRefreshedAt:
      record.platform === "x"
        ? (xRefreshedAt?.get(record.id) ?? record.lastRefreshedAt)
        : record.lastRefreshedAt,
  };
}

/**
 * X account id → the latest time anything brought its posts up to date —
 * kept apart from the account row: a timeline refresh records it in
 * x_feed_state, the X Dashboard's sync in the account's head checkpoints.
 */
export function listXRefreshTimes(db: ScopeDatabase): Map<number, string | null> {
  const rows = db
    .prepare<[], { creator_id: number; last_refreshed_at: string | null }>(
      "SELECT creator_id, last_refreshed_at FROM x_feed_state",
    )
    .all();
  const times = new Map(rows.map((row) => [Number(row.creator_id), row.last_refreshed_at]));
  const heads = db
    .prepare<[], { creator_id: number; synced_at: string | null }>(
      // Across every connection the account was read through, not just the newest one.
      `SELECT creator_id, MAX(json_extract(state_json, '$.lastSuccessfulRefresh')) AS synced_at
       FROM x_retrieval_checkpoints
       WHERE lane = 'head'
       GROUP BY creator_id`,
    )
    .all();
  for (const head of heads) {
    const id = Number(head.creator_id);
    const refreshed = times.get(id) ?? null;
    if (head.synced_at && (refreshed === null || head.synced_at > refreshed)) {
      times.set(id, head.synced_at);
    }
  }
  return times;
}

function toProfileSummary(
  record: CreatorProfileRecord,
  categories: CreatorCategory[],
  xRefreshedAt: ReadonlyMap<number, string | null>,
): CreatorProfileSummary {
  return {
    id: record.id,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
    avatarCreatorId: record.avatarCreatorId,
    accounts: record.accounts.map((account) => toAccountSummary(account, xRefreshedAt)),
    categories,
  };
}

/** Every person in the library, alphabetical, with accounts and categories. */
export function listProfileSummaries(db: ScopeDatabase): CreatorProfileSummary[] {
  const categories = listProfileCategoryAssignments(db);
  const xRefreshedAt = listXRefreshTimes(db);
  return listProfiles(db).map((profile) =>
    toProfileSummary(profile, categories.get(profile.id) ?? [], xRefreshedAt),
  );
}

export function getProfileSummary(db: ScopeDatabase, id: number): CreatorProfileSummary | null {
  if (!Number.isInteger(id) || id < 1) {
    return null;
  }
  const profile = getProfile(db, id);
  return profile
    ? toProfileSummary(profile, listCategoriesForProfile(db, id), listXRefreshTimes(db))
    : null;
}

/**
 * Account id → the person it belongs to, for surfaces that list content per
 * account (feed rows, research and chat sources) but label it per person.
 */
export interface AccountProfileRef {
  profileId: number;
  profileName: string;
  /** The person's representing avatar and the account it streams through. */
  avatarUrl: string | null;
  avatarCreatorId: number | null;
  platform: CreatorPlatform;
  handle: string | null;
  /** How many accounts the person has, so single-platform people stay terse. */
  accountCount: number;
}

export function listAccountProfileRefs(db: ScopeDatabase): Map<number, AccountProfileRef> {
  const refs = new Map<number, AccountProfileRef>();
  for (const profile of listProfiles(db)) {
    for (const account of profile.accounts) {
      refs.set(account.id, {
        profileId: profile.id,
        profileName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        avatarCreatorId: profile.avatarCreatorId,
        platform: account.platform,
        handle: account.handle,
        accountCount: profile.accounts.length,
      });
    }
  }
  return refs;
}

function isId(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1;
}

const NOT_FOUND: ProfileServiceError = {
  code: "not_found",
  message: "That creator is no longer in your library.",
};

export function renameProfileFromInput(
  db: ScopeDatabase,
  profileId: unknown,
  nameValue: unknown,
): ProfileResult<{ displayName: string }> {
  const name = typeof nameValue === "string" ? nameValue.trim().replace(/\s+/g, " ") : "";
  if (
    !isId(profileId) ||
    name.length < 1 ||
    name.length > PROFILE_NAME_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `Use a name between 1 and ${PROFILE_NAME_MAX_LENGTH} characters.`,
      },
    };
  }
  return renameProfile(db, profileId, name)
    ? { ok: true, displayName: name }
    : { ok: false, error: NOT_FOUND };
}

export function setProfileAvatarFromInput(
  db: ScopeDatabase,
  profileId: unknown,
  creatorId: unknown,
): ProfileResult {
  if (!isId(profileId) || !isId(creatorId)) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "That avatar choice is invalid." },
    };
  }
  return setProfileAvatar(db, profileId, creatorId)
    ? { ok: true }
    : {
        ok: false,
        error: { code: "not_found", message: "That account is no longer linked to this creator." },
      };
}

/** Links other people's accounts into `targetId`, merging them into one person. */
export function linkProfilesFromInput(
  db: ScopeDatabase,
  targetId: unknown,
  sourceIdsValue: unknown,
): ProfileResult<{ linkedCount: number }> {
  const sourceIds = Array.isArray(sourceIdsValue)
    ? [...new Set(sourceIdsValue)].filter((id) => id !== targetId)
    : null;
  if (
    !isId(targetId) ||
    sourceIds === null ||
    sourceIds.length === 0 ||
    sourceIds.length > 100 ||
    !sourceIds.every(isId)
  ) {
    return {
      ok: false,
      error: { code: "invalid_input", message: "Choose at least one creator to link." },
    };
  }
  if (!profilesExist(db, [targetId, ...sourceIds])) {
    return {
      ok: false,
      error: { code: "not_found", message: "One of those creators is no longer in your library." },
    };
  }
  mergeProfiles(db, targetId, sourceIds);
  return { ok: true, linkedCount: sourceIds.length };
}

/** Splits one account off into its own person. */
export function detachAccountFromInput(
  db: ScopeDatabase,
  creatorId: unknown,
): ProfileResult<{ profileId: number; previousProfileId: number }> {
  if (!isId(creatorId)) {
    return { ok: false, error: { code: "invalid_input", message: "That account is invalid." } };
  }
  const previousProfileId = getProfileIdForCreator(db, creatorId);
  if (previousProfileId === null) {
    return {
      ok: false,
      error: { code: "not_found", message: "That account is no longer in your library." },
    };
  }
  const profileId = detachAccount(db, creatorId);
  if (profileId === null) {
    return {
      ok: false,
      error: { code: "not_linked", message: "That account is already a creator of its own." },
    };
  }
  return { ok: true, profileId, previousProfileId };
}

/** Removes a person and every linked account, with their cached content. */
export function removeProfileById(
  db: ScopeDatabase,
  profileId: unknown,
): ProfileResult<{ removedAccounts: number }> {
  if (!isId(profileId)) {
    return { ok: false, error: { code: "invalid_input", message: "That creator ID is invalid." } };
  }
  const removedAccounts = removeProfileAccounts(db, profileId);
  if (removedAccounts === 0) {
    return {
      ok: false,
      error: { code: "not_found", message: "That creator was already removed." },
    };
  }
  // Timelines cascade with the accounts; posts no other timeline references
  // are reclaimed so removal leaves no orphaned text behind. The person's
  // attributions cascade too, so hosts that only held their videos go as well.
  deleteOrphanTweets(db);
  pruneSourceOnlyHosts(db);
  return { ok: true, removedAccounts };
}

/**
 * Files a just-saved account under an existing person. A newly created
 * account starts as a person of its own (the database default) and is moved
 * over; an account that was already saved elsewhere moves the same way.
 */
export function fileAccountUnderProfile(
  db: ScopeDatabase,
  creatorId: number,
  targetProfileId: number,
): void {
  moveAccountToProfile(db, creatorId, targetProfileId);
}

export function targetProfileExists(db: ScopeDatabase, profileId: number): boolean {
  return profilesExist(db, [profileId]);
}
