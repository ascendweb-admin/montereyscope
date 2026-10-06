/**
 * Creator avatar image URL policy — shared by the write path (what may be
 * stored), the UI (how avatars are loaded), and the avatar proxy route.
 * Pure: no database, no network.
 */

/**
 * Platform image CDNs — the only hosts an avatar URL may point at:
 * - YouTube: googleusercontent.com / ggpht.com / ytimg.com
 * - Rumble: hugh.cdn.rumble.cloud (channel avatars + video thumbnails)
 * - X: pbs.twimg.com (profile images; the worker only ever emits https)
 */
const AVATAR_HOST_PATTERN =
  /(^|\.)(googleusercontent\.com|ggpht\.com|ytimg\.com|hugh\.cdn\.rumble\.cloud|pbs\.twimg\.com)$/;

/**
 * True for an https URL on one of YouTube's image CDNs. Anything else
 * (http, other hosts, malformed) is rejected rather than stored or proxied.
 */
export function isAllowedImageUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    return false;
  }
  try {
    return AVATAR_HOST_PATTERN.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Same-origin src for an avatar <img>. For a saved creator the image streams
 * through the local proxy route (`/api/creators/:id/avatar`), so the browser
 * makes no third-party request at all — privacy extensions and tracking
 * protection can otherwise block direct googleusercontent.com loads. Unsaved
 * previews (no id yet) fall back to the direct URL.
 * Include the stored image URL in the cache key: local IDs can refer to a
 * different creator after a database reset or switch, and avatars can change.
 */
export function localAvatarSrc(avatarUrl: string | null, creatorId?: number | null): string | null {
  if (avatarUrl === null) {
    return null;
  }
  return typeof creatorId === "number" && Number.isInteger(creatorId) && creatorId >= 1
    ? `/api/creators/${creatorId}/avatar?v=${encodeURIComponent(avatarUrl)}`
    : avatarUrl;
}
