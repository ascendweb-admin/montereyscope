/**
 * Best-effort avatar lookup for a channel that was saved from a single video.
 * Single-video metadata carries no channel picture, so a host is saved without
 * one and gets it here when the user follows the channel. Server-only.
 *
 * Nothing here throws or reports a failure: a missing avatar is cosmetic and
 * must never fail a follow or an import.
 */
import { channelSlugFromUrl, fetchRumbleChannelIdentity } from "@/lib/rumble/identity";
import { getCreator, setCreatorAvatar, type CreatorRecord } from "./repository";
import { resolveCreatorFromUrl } from "./resolver";
import type { ScopeDatabase } from "@/lib/db/connection";
import { isAllowedImageUrl } from "./avatar";

export interface HostAvatarDeps {
  /** YouTube: resolves the channel page, as the Add creator flow does. */
  resolveYoutube: typeof resolveCreatorFromUrl;
  /** Rumble: reads the channel page's identity. */
  fetchRumbleIdentity: typeof fetchRumbleChannelIdentity;
}

const DEFAULT_DEPS: HostAvatarDeps = {
  resolveYoutube: resolveCreatorFromUrl,
  fetchRumbleIdentity: fetchRumbleChannelIdentity,
};

/** The channel's picture on the platform, or null when it cannot be found. */
export async function lookupHostAvatar(
  host: Pick<CreatorRecord, "platform" | "channelUrl">,
  overrides: Partial<HostAvatarDeps> = {},
): Promise<string | null> {
  const deps: HostAvatarDeps = { ...DEFAULT_DEPS, ...overrides };
  try {
    if (host.platform === "youtube") {
      const resolved = await deps.resolveYoutube(host.channelUrl);
      return resolved.ok && isAllowedImageUrl(resolved.creator.avatarUrl)
        ? resolved.creator.avatarUrl
        : null;
    }
    if (host.platform === "rumble") {
      const slug = channelSlugFromUrl(host.channelUrl) ?? undefined;
      const identity = await deps.fetchRumbleIdentity(host.channelUrl, slug);
      return identity.ok && isAllowedImageUrl(identity.identity.avatarUrl)
        ? identity.identity.avatarUrl
        : null;
    }
  } catch {
    // Cosmetic: a failed lookup leaves the initials avatar in place.
  }
  return null;
}

/**
 * Gives a followed channel its picture when it has none yet. Returns whether an
 * avatar was stored. A channel that already has one is left untouched, so
 * calling this for every host of an import is cheap.
 */
export async function ensureHostAvatar(
  db: ScopeDatabase,
  creatorId: number,
  overrides: Partial<HostAvatarDeps> = {},
): Promise<boolean> {
  const host = getCreator(db, creatorId);
  if (host === null || host.avatarUrl !== null) {
    return false;
  }
  const avatarUrl = await lookupHostAvatar(host, overrides);
  return avatarUrl !== null && setCreatorAvatar(db, host.id, avatarUrl);
}
