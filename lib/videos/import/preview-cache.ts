/**
 * Process-local cache of resolved links, so committing an import does not
 * repeat the two yt-dlp lookups the preview just made. Server-only data: the
 * client never sends video fields back (the pattern `saveRumbleCreatorPayload`
 * documents), so a cache miss simply resolves again.
 *
 * Only successful results are stored. Entries expire after ten minutes and the
 * oldest is dropped past 200 entries.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import type { VideoLink } from "./links";
import {
  resolveVideoLink,
  type ResolveDeps,
  type ResolveResult,
  type ResolvedVideo,
} from "./resolve";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  video: ResolvedVideo;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: forget every cached preview. */
export function resetPreviewCacheForTests(): void {
  cache.clear();
}

export function getCachedPreview(url: string): ResolvedVideo | null {
  const entry = cache.get(url);
  if (entry === undefined) {
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    cache.delete(url);
    return null;
  }
  return entry.video;
}

export function cachePreview(video: ResolvedVideo): void {
  // Re-insert so a refreshed entry counts as the newest when evicting.
  cache.delete(video.url);
  cache.set(video.url, { video, expiresAt: Date.now() + TTL_MS });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
}

/** Serves a fresh cached resolution when there is one; otherwise resolves and remembers a success. */
export async function resolveVideoLinkCached(
  db: ScopeDatabase,
  link: VideoLink,
  overrides: Partial<ResolveDeps> = {},
): Promise<ResolveResult> {
  const cached = getCachedPreview(link.url);
  if (cached !== null) {
    return { ok: true, video: cached };
  }
  const result = await resolveVideoLink(db, link, overrides);
  if (result.ok) {
    cachePreview(result.video);
  }
  return result;
}
