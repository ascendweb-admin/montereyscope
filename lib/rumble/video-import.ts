/**
 * Rumble video metadata for the video import engine (`lib/videos/import`):
 * the yt-dlp discovery job with its throttle retry, and the parsers that turn
 * its JSON into a cached-video draft plus the channel that hosts it.
 * Server-only.
 *
 * - Video metadata comes from yt-dlp (`--dump-single-json --skip-download`),
 *   the same cheap discovery roundtrip the transcript pipeline uses, so no
 *   media is ever downloaded.
 * - The video id is the slug Rumble itself uses in page URLs
 *   ("v7emyxa…"), parsed from yt-dlp's webpage_url, so pasted links and
 *   channel-listing items key to the same row.
 */
import type { ExecFileResult, runCommand } from "@/lib/ytdlp/runner";
import {
  mapDurationSeconds,
  mapLiveStatus,
  mapPublishedAt,
  type VideoDraft,
} from "@/lib/videos/mapper";
import { slugFromPathSegment } from "./urls";
import { isAllowedRumbleImageUrl } from "./channel-page";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** The payload parser's one failure: yt-dlp answered, but not with a usable video. */
export type RumbleImportErrorCode = "unexpected_response";

export interface RumbleImportError {
  code: RumbleImportErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr or paths. */
  message: string;
}

function fail(code: RumbleImportErrorCode, message: string): RumbleImportError {
  return { code, message };
}

// ---------------------------------------------------------------------------
// yt-dlp discovery job and payload parsing
// ---------------------------------------------------------------------------

/** Same cheap flags as transcript discovery: metadata only, no media. */
export function buildRumbleVideoDiscoveryArgs(videoUrl: string): string[] {
  return ["--dump-single-json", "--skip-download", "--no-warnings", "--no-progress", videoUrl];
}

const DISCOVERY_TIMEOUT_MS = 45_000;
const DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RumbleResolvedVideo {
  /** Canonical page-slug id, e.g. "v7emyxa". */
  id: string;
  title: string;
  url: string;
  channelName: string;
  channelUrl: string;
  /** Avatar-ready draft ready for the videos cache. */
  draft: VideoDraft;
}

/** Extracts the video slug from a canonical webpage_url. */
function slugFromWebpageUrl(webpageUrl: string): string | null {
  try {
    const segments = new URL(webpageUrl).pathname.split("/").filter(Boolean);
    const segment = segments[0];
    return segment !== undefined ? slugFromPathSegment(segment) : null;
  } catch {
    return null;
  }
}

/**
 * Parses yt-dlp's single-video JSON into the import model. The slug comes
 * from webpage_url (canonical page form); the yt-dlp `id` field is the
 * embed/media id and is deliberately not used as the storage key.
 */
export function parseRumbleVideoPayload(
  stdout: string,
  fallbackSlug: string,
): { ok: true; video: RumbleResolvedVideo } | { ok: false; error: RumbleImportError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      error: fail(
        "unexpected_response",
        "Rumble returned data scope could not read. Please try again.",
      ),
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return {
      ok: false,
      error: fail(
        "unexpected_response",
        "Rumble returned data scope could not read. Please try again.",
      ),
    };
  }
  const record = parsed as Record<string, unknown>;

  const webpageUrl = typeof record.webpage_url === "string" ? record.webpage_url : null;
  const slug = (webpageUrl !== null ? slugFromWebpageUrl(webpageUrl) : null) ?? fallbackSlug;
  if (slug === null) {
    return {
      ok: false,
      error: fail(
        "unexpected_response",
        "Rumble returned data scope could not read. Please try again.",
      ),
    };
  }

  const title =
    typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : null;
  if (title === null) {
    return {
      ok: false,
      error: fail("unexpected_response", "That video page did not resolve to a real video."),
    };
  }

  const channelName =
    (typeof record.channel === "string" && record.channel.trim()) ||
    (typeof record.uploader === "string" && record.uploader.trim()) ||
    null;
  const channelUrl =
    typeof record.channel_url === "string" && record.channel_url.startsWith("https://")
      ? record.channel_url
      : null;
  if (channelName === null || channelUrl === null) {
    return {
      ok: false,
      error: fail("unexpected_response", "That video did not resolve to a channel scope can save."),
    };
  }

  const thumbnails = Array.isArray(record.thumbnails) ? record.thumbnails : [];
  const thumbnailUrl = pickRumbleThumbnail(thumbnails);

  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim().slice(0, 5000)
      : null;

  return {
    ok: true,
    video: {
      id: slug,
      title: title.slice(0, 300),
      url:
        webpageUrl !== null && webpageUrl.startsWith("https://")
          ? webpageUrl
          : `https://rumble.com/${slug}`,
      channelName: channelName.slice(0, 100),
      channelUrl,
      draft: {
        id: slug,
        title: title.slice(0, 300),
        url:
          webpageUrl !== null && webpageUrl.startsWith("https://")
            ? webpageUrl
            : `https://rumble.com/${slug}`,
        thumbnailUrl,
        publishedAt: mapPublishedAt(record.timestamp),
        durationSeconds: mapDurationSeconds(record.duration),
        liveStatus: mapLiveStatus(record.live_status),
        description,
      },
    },
  };
}

/** Largest-area thumbnail on a Rumble image CDN; null when none qualify. */
export function pickRumbleThumbnail(thumbnails: readonly unknown[]): string | null {
  let bestUrl: string | null = null;
  let bestArea = -1;
  for (const item of thumbnails) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : null;
    if (url === null || !isAllowedRumbleImageUrl(url)) {
      continue;
    }
    const width = typeof record.width === "number" ? record.width : 0;
    const height = typeof record.height === "number" ? record.height : 0;
    const area = width * height;
    if (area > bestArea) {
      bestArea = area;
      bestUrl = url;
    }
  }
  return bestUrl;
}

/**
 * Runs the discovery job once, retrying a single time after a pause when
 * Rumble's edge throttles yt-dlp (transient 403/429 — verified behavior in
 * the research pass). The pause and the second run both stay inside this
 * module so callers stay simple.
 */
export async function runRumbleDiscovery(
  deps: { command: string; run: typeof runCommand; throttleRetryMs?: number },
  videoUrl: string,
): Promise<ExecFileResult> {
  const args = buildRumbleVideoDiscoveryArgs(videoUrl);
  const options = { timeoutMs: DISCOVERY_TIMEOUT_MS, maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES };
  const first = await deps.run(deps.command, args, options);
  if (first.ok) {
    return first;
  }
  const throttled = /http error 403|http error 429|too many requests|forbidden/.test(
    first.stderrTail.toLowerCase(),
  );
  if (!throttled) {
    return first;
  }
  await sleepMs(deps.throttleRetryMs ?? DEFAULT_THROTTLE_RETRY_MS);
  return deps.run(deps.command, args, options);
}

const DEFAULT_THROTTLE_RETRY_MS = 20_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
