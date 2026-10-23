/**
 * Decides what `/creators/[id]` does for a profile id and an optional
 * `?account=` hint. Server-only.
 *
 * An old link may name a person who was linked into someone else; the page
 * then follows the account to its current owner. Only a visible person (one
 * with a followed account) can be a destination or be shown, so the id of a
 * source-only host's profile is a 404 and can never redirect to itself.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { getProfile } from "./profiles";
import { getCreator } from "./repository";

export type CreatorPageTarget =
  | { kind: "show" }
  | { kind: "redirect"; profileId: number; accountId: number }
  | { kind: "notFound" };

export function resolveCreatorPageTarget(
  db: ScopeDatabase,
  profileId: number,
  requestedAccountId: number | null,
): CreatorPageTarget {
  const profile = getProfile(db, profileId);
  const requested = requestedAccountId === null ? null : getCreator(db, requestedAccountId);
  if (profile && (requested === null || profile.accounts.some((a) => a.id === requested.id))) {
    return { kind: "show" };
  }
  // The requested account lives elsewhere. A followed account always belongs
  // to a visible person, and that person must differ from the one asked for.
  if (requested !== null && requested.followed && requested.profileId !== profileId) {
    return { kind: "redirect", profileId: requested.profileId, accountId: requested.id };
  }
  return profile ? { kind: "show" } : { kind: "notFound" };
}
