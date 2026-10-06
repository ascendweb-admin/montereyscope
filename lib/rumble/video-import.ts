/**
 * Rumble single-video import: resolves a pasted rumble.com video link into
 * a cached video row and — when the link's channel is not saved yet —
 * auto-provisions the creator from the video's own metadata plus one
 * channel-page fetch for the avatar. Server-only.
 *
 * - Video metadata comes from yt-dlp (`--dump-single-json --skip-download`),
 *   the same cheap discovery roundtrip the transcript pipeline uses, so no
 *   media is ever downloaded.
 * - The video id is the slug Rumble itself uses in page URLs
 *   ("v7emyxa…"), parsed from yt-dlp's webpage_url, so pasted links and
 *   channel-listing items key to the same row.
 * - Avatar lookup is best-effort: when Rumble throttles the channel-page
 *   fetch the creator is still saved (avatarless) rather than failing the
 *   whole import.
 */
import { runCommand } from "@/lib/ytdlp/runner";
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { YT_DLP_COMMAND } from "@/lib/ytdlp/version";
import {
  NETWORK_UNREACHABLE_MESSAGE,
  YTDLP_MISSING_MESSAGE,
} from "@/lib/ytdlp/user-messages";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  mapDurationSeconds,
  mapLiveStatus,
  mapPublishedAt,
  type VideoDraft,
} from "@/lib/videos/mapper";
import { mergeCreatorFeed } from "@/lib/videos/repository";
import { addCreator, findDuplicateCreator, type NewCreatorInput } from "@/lib/creators/repository";
import { isAllowedImageUrl } from "@/lib/creators/avatar";
import { parseRumbleUrl, slugFromPathSegment } from "./urls";
import { fetchRumbleChannelIdentity, channelSlugFromUrl } from "./identity";
import { isAllowedRumbleImageUrl } from "./channel-page";
import type { RumbleFetchOptions } from "./http";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type RumbleImportErrorCode =
  | "invalid_url"
  | "ytdlp_missing"
  | "unavailable_video"
  | "throttled"
  | "network"
  | "timeout"
  | "local_tool"
  | "unexpected_response";

export interface RumbleImportError {
  code: RumbleImportErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr or paths. */
  message: string;
}

export const RUMBLE_IMPORT_ERROR_STATUS: Record<RumbleImportErrorCode, number> = {
  invalid_url: 400,
  ytdlp_missing: 503,
  unavailable_video: 422,
  throttled: 429,
  network: 502,
  timeout: 504,
  local_tool: 500,
  unexpected_response: 502,
};

function fail(code: RumbleImportErrorCode, message: string): RumbleImportError {
  return { code, message };
}

// ---------------------------------------------------------------------------
// yt-dlp discovery job
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
    return { ok: false, error: fail("unexpected_response", "Rumble returned data scope could not read. Please try again.") };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: fail("unexpected_response", "Rumble returned data scope could not read. Please try again.") };
  }
  const record = parsed as Record<string, unknown>;

  const webpageUrl = typeof record.webpage_url === "string" ? record.webpage_url : null;
  const slug =
    (webpageUrl !== null ? slugFromWebpageUrl(webpageUrl) : null) ?? fallbackSlug;
  if (slug === null) {
    return { ok: false, error: fail("unexpected_response", "Rumble returned data scope could not read. Please try again.") };
  }

  const title = typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : null;
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
      url: webpageUrl !== null && webpageUrl.startsWith("https://")
        ? webpageUrl
        : `https://rumble.com/${slug}`,
      channelName: channelName.slice(0, 100),
      channelUrl,
      draft: {
        id: slug,
        title: title.slice(0, 300),
        url: webpageUrl !== null && webpageUrl.startsWith("https://")
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
export function pickRumbleThumbnail(
  thumbnails: readonly unknown[],
): string | null {
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

// ---------------------------------------------------------------------------
// Failure classification for the yt-dlp job
// ---------------------------------------------------------------------------

/**
 * Runs the discovery job once, retrying a single time after a pause when
 * Rumble's edge throttles yt-dlp (transient 403/429 — verified behavior in
 * the research pass). The pause and the second run both stay inside this
 * module so callers stay simple.
 */
export async function runRumbleDiscovery(
  deps: Pick<RumbleImportDeps, "command" | "run"> & { throttleRetryMs?: number },
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

/** Maps a raw runner failure to a typed, user-safe import error. */
export function classifyDiscoveryFailure(
  result: Extract<ExecFileResult, { ok: false }>,
): RumbleImportError {
  switch (result.kind) {
    case "missing_executable":
      return fail("ytdlp_missing", YTDLP_MISSING_MESSAGE);
    case "timeout":
      return fail("timeout", "Looking up that video took too long and was stopped. Please try again.");
    case "output_limit":
      return fail("local_tool", "The video data was too large to read safely.");
    default:
      break;
  }
  const stderrTail = result.stderrTail.toLowerCase();
  // Transient edge throttling is distinct from a genuinely unreachable
  // network: the user-facing message tells them to retry in a minute.
  if (/http error 403|http error 429|too many requests|forbidden/.test(stderrTail)) {
    return fail("throttled", "Rumble is throttling requests right now. Wait a minute and try again.");
  }
  if (
    /video unavailable|private video|has been removed|not found|404|terminated|is unavailable|no longer available/.test(
      stderrTail,
    )
  ) {
    return fail(
      "unavailable_video",
      "Rumble would not serve that video (it may be private, removed, or restricted).",
    );
  }
  if (
    /getaddrinfo|temporary failure|name or service not known|network|connection|unable to download|resolve|refused|reset by peer/.test(
      stderrTail,
    )
  ) {
    return fail("network", NETWORK_UNREACHABLE_MESSAGE);
  }
  return fail("unexpected_response", "scope could not look up that video right now. Please try again later.");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RumbleImportDeps {
  command: string;
  run: typeof runCommand;
  now: () => Date;
  fetchChannelIdentity: typeof fetchRumbleChannelIdentity;
  fetchOptions?: RumbleFetchOptions;
}

const defaultImportDeps: RumbleImportDeps = {
  command: YT_DLP_COMMAND,
  run: runCommand,
  now: () => new Date(),
  fetchChannelIdentity: fetchRumbleChannelIdentity,
};

export interface RumbleImportOutcomeSuccess {
  ok: true;
  /** Existing creator when the channel was already saved ("already_saved"). */
  status: "created" | "already_saved";
  creator: NewCreatorInput;
  creatorId: number;
  videoId: string;
  videoTitle: string;
}

export type RumbleImportOutcome =
  | RumbleImportOutcomeSuccess
  | { ok: false; error: RumbleImportError };

/**
 * Imports one Rumble video link: parse → yt-dlp discovery → creator
 * find-or-create (avatar best-effort) → single-draft feed merge. Returns
 * the ids the UI needs to navigate to the video detail page.
 */
export async function importRumbleVideo(
  db: ScopeDatabase,
  rawUrl: string,
  overrides: Partial<RumbleImportDeps> = {},
): Promise<RumbleImportOutcome> {
  const deps: RumbleImportDeps = { ...defaultImportDeps, ...overrides };

  const parsedUrl = parseRumbleUrl(rawUrl);
  if (!parsedUrl.ok || parsedUrl.target.kind !== "video") {
    return {
      ok: false,
      error: fail("invalid_url", parsedUrl.ok ? "Paste a Rumble video link (rumble.com/v…) to import a video." : parsedUrl.message),
    };
  }
  const slug = parsedUrl.target.slug;

  const discovery = await runRumbleDiscovery(deps, `https://rumble.com/${slug}`);
  if (!discovery.ok) {
    return { ok: false, error: classifyDiscoveryFailure(discovery) };
  }
  const parsedVideo = parseRumbleVideoPayload(discovery.stdout, slug);
  if (!parsedVideo.ok) {
    return parsedVideo;
  }
  const video = parsedVideo.video;

  // Best-effort avatar lookup; throttling here must not fail the import.
  const channelSlug = channelSlugFromUrl(video.channelUrl);
  let avatarUrl: string | null = null;
  if (channelSlug !== null) {
    const identityResult = await deps.fetchChannelIdentity(video.channelUrl, channelSlug, {
      ...(deps.fetchOptions ?? {}),
    });
    if (identityResult.ok && identityResult.identity.avatarUrl !== null) {
      avatarUrl = identityResult.identity.avatarUrl;
    }
  }

  const creatorInput: NewCreatorInput = {
    youtubeChannelId: null,
    handle: normalizeHandle(channelSlug),
    displayName: video.channelName,
    channelUrl: video.channelUrl,
    avatarUrl: avatarUrl !== null && isAllowedImageUrl(avatarUrl) ? avatarUrl : null,
    platform: "rumble",
  };

  const duplicate = findDuplicateCreator(db, {
    youtubeChannelId: null,
    channelUrl: creatorInput.channelUrl,
  });
  let creatorId: number;
  if (duplicate) {
    creatorId = duplicate.id;
  } else {
    const created = addCreator(db, creatorInput);
    creatorId = created.creator.id;
  }

  // Single-draft merge through the shared upsert: one transaction, and the
  // refresh stamp reflects the data just fetched.
  mergeCreatorFeed(db, {
    creatorId,
    videos: [video.draft],
    refreshedAt: deps.now().toISOString(),
  });

  return {
    ok: true,
    status: duplicate ? "already_saved" : "created",
    creator: creatorInput,
    creatorId,
    videoId: video.draft.id,
    videoTitle: video.title,
  };
}

function normalizeHandle(slug: string | null): string | null {
  if (slug === null) {
    return null;
  }
  const handle = slug.toLowerCase();
  return /^[0-9a-z._-]{3,30}$/.test(handle) ? handle : null;
}
