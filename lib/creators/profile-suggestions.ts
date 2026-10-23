/**
 * "Same person?" suggestions for the creator library. Server-only.
 *
 * People saved before profiles existed — or added one platform at a time —
 * show up as separate creators. Pairs whose names or handles match
 * (see identitiesMatch) are grouped and offered for linking; nothing is ever
 * linked automatically. A pair the user marks as different people is
 * remembered in the settings table and never suggested again.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { identitiesMatch, listProfiles, type CreatorProfileRecord } from "./profiles";

export const DISMISSED_LINK_SUGGESTIONS_KEY = "dismissed_profile_link_suggestions";

/** Upper bound on remembered dismissals; the oldest fall away first. */
const MAX_DISMISSED_PAIRS = 2_000;

export interface ProfileLinkSuggestion {
  /** The person the others would be linked into: most accounts, then oldest. */
  targetId: number;
  /** Every person in the group, the target first. */
  profileIds: number[];
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function getDismissedLinkPairs(db: ScopeDatabase): Set<string> {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?")
    .get(DISMISSED_LINK_SUGGESTIONS_KEY);
  if (!row) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(row.value);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

/** Remembers every pair inside the given group as "not the same person". */
export function dismissLinkSuggestion(db: ScopeDatabase, profileIds: readonly number[]): void {
  const ids = [...new Set(profileIds)].filter((id) => Number.isInteger(id) && id > 0);
  const dismissed = [...getDismissedLinkPairs(db)];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = pairKey(ids[i], ids[j]);
      if (!dismissed.includes(key)) {
        dismissed.push(key);
      }
    }
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(DISMISSED_LINK_SUGGESTIONS_KEY, JSON.stringify(dismissed.slice(-MAX_DISMISSED_PAIRS)));
}

function identityOf(profile: CreatorProfileRecord) {
  return {
    displayName: profile.displayName,
    handles: profile.accounts.flatMap((account) => [account.handle, account.displayName]),
  };
}

/**
 * Groups people who look like the same person. A group grows through
 * matches with any of its members (an X handle can match the YouTube channel
 * while the Rumble name matches the X account) but never holds a pair the
 * user marked as different people. The target is the fullest person — most
 * accounts, then oldest — and groups come back alphabetically by its name.
 */
export function suggestProfileLinks(
  profiles: readonly CreatorProfileRecord[],
  dismissed: ReadonlySet<string> = new Set(),
): ProfileLinkSuggestion[] {
  const ordered = [...profiles].sort(
    (a, b) =>
      b.accounts.length - a.accounts.length ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id - b.id,
  );
  const identities = new Map(ordered.map((profile) => [profile.id, identityOf(profile)]));
  const grouped = new Set<number>();
  const groups: CreatorProfileRecord[][] = [];

  for (const target of ordered) {
    if (grouped.has(target.id)) {
      continue;
    }
    const group = [target];
    let grew = true;
    while (grew) {
      grew = false;
      for (const candidate of ordered) {
        if (grouped.has(candidate.id) || group.includes(candidate)) {
          continue;
        }
        const allowed = group.every((member) => !dismissed.has(pairKey(member.id, candidate.id)));
        const matches = group.some((member) =>
          identitiesMatch(identities.get(member.id)!, identities.get(candidate.id)!),
        );
        if (allowed && matches) {
          group.push(candidate);
          grew = true;
        }
      }
    }
    if (group.length > 1) {
      for (const member of group) {
        grouped.add(member.id);
      }
      groups.push(group);
    }
  }

  return groups
    .sort((a, b) =>
      a[0].displayName.localeCompare(b[0].displayName, undefined, { sensitivity: "base" }),
    )
    .map((group) => ({
      targetId: group[0].id,
      profileIds: group.map((profile) => profile.id),
    }));
}

export function listProfileLinkSuggestions(db: ScopeDatabase): ProfileLinkSuggestion[] {
  return suggestProfileLinks(listProfiles(db), getDismissedLinkPairs(db));
}
