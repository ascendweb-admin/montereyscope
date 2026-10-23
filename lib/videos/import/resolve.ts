/**
 * Resolves a parsed video link into something previewable and importable,
 * and decides whether scope can actually use it. Server-only.
 *
 * Two yt-dlp jobs run in parallel, neither downloading media:
 * - metadata (YouTube: `--print` of just the fields below; Rumble:
 *   `--dump-single-json`): the video's fields plus the channel that hosts it;
 * - captions: `discoverAvailableSubtitles` + `selectEnglishSubtitleTrack`,
 *   the exact functions the transcript pipeline uses. This is the English
 *   caption gate, so its verdict matches what chat will find later.
 *
 * A video that is already cached skips the work it no longer needs.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { channelSlugFromUrl } from "@/lib/rumble/identity";
import { parseRumbleVideoPayload, runRumbleDiscovery } from "@/lib/rumble/video-import";
import { runCommand } from "@/lib/ytdlp/runner";
import {
  discoverAvailableSubtitles,
  isEnglishCaptionLanguage,
  runJobWithThrottleRetry,
  selectEnglishSubtitleTrack,
  type SubtitleTrackKind,
  type SubtitleTrackSelection,
} from "@/lib/ytdlp/subtitles";
import { YT_DLP_COMMAND } from "@/lib/ytdlp/version";
import {
  mapDurationSeconds,
  mapLiveStatus,
  mapPublishedAt,
  pickThumbnailUrl,
  type VideoDraft,
} from "@/lib/videos/mapper";
import type { LiveStatus } from "@/lib/videos/repository";
import {
  classifyVideoJobFailure,
  LIVE_OR_UPCOMING_MESSAGE,
  NO_CHANNEL_MESSAGE,
  NO_ENGLISH_CAPTIONS_MESSAGE,
  videoImportError,
  type VideoImportError,
} from "./errors";
import { videoLinkId, type VideoLink } from "./links";

export type VideoImportPlatform = "youtube" | "rumble";

/** The channel that hosts a video, in the shape `addCreator` takes. */
export interface ResolvedHost {
  platform: VideoImportPlatform;
  youtubeChannelId: string | null;
  handle: string | null;
  displayName: string;
  channelUrl: string;
}

export interface ResolvedVideo {
  platform: VideoImportPlatform;
  videoId: string;
  /** Canonical link. */
  url: string;
  draft: VideoDraft;
  host: ResolvedHost;
  /** Kind of the English track the transcript pipeline would use. */
  captions: SubtitleTrackKind;
  /** Set when the video is already cached; `hasTranscript` says whether chat can read it. */
  inLibrary: { creatorId: number; hasTranscript: boolean } | null;
}

export type ResolveResult =
  { ok: true; video: ResolvedVideo } | { ok: false; error: VideoImportError };

export interface ResolveDeps {
  command: string;
  run: typeof runCommand;
  discover: typeof discoverAvailableSubtitles;
  /** Pause before the single throttle retry; tests inject a small value. */
  throttleRetryMs?: number;
}

const METADATA_TIMEOUT_MS = 45_000;
const METADATA_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const PLATFORM_LABEL: Record<VideoImportPlatform, string> = {
  youtube: "YouTube",
  rumble: "Rumble",
};

const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;
const HANDLE_PATTERN = /^[0-9a-z._-]{3,30}$/;

/**
 * The only fields the YouTube parser reads. A full `--dump-single-json` carries
 * every auto-translated caption track and runs past 10 MB on popular videos,
 * so yt-dlp is asked for this subset instead (`%(.{...})j` keeps the same JSON
 * shape, minus the rest).
 */
const YOUTUBE_METADATA_FIELDS = [
  "id",
  "title",
  "channel_id",
  "channel",
  "uploader",
  "uploader_id",
  "thumbnails",
  "thumbnail",
  "description",
  "timestamp",
  "release_timestamp",
  "upload_date",
  "duration",
  "live_status",
];

/** Metadata-only flags: no media, no playlist expansion, no user config. */
export function buildVideoMetadataArgs(videoUrl: string): string[] {
  return [
    "--print",
    `%(.{${YOUTUBE_METADATA_FIELDS.join(",")}})j`,
    "--skip-download",
    "--no-playlist",
    "--ignore-config",
    "--no-warnings",
    "--no-progress",
    videoUrl,
  ];
}

function defaultDeps(): ResolveDeps {
  return { command: YT_DLP_COMMAND, run: runCommand, discover: discoverAvailableSubtitles };
}

// ---------------------------------------------------------------------------
// Payload parsing (pure)
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** "@name" or a bare channel slug, lowercased; null when it is not a usable handle. */
function normalizeHandle(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const handle = raw.replace(/^@/, "").toLowerCase();
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

/** yt-dlp's `upload_date` ("20050424") as a UTC midnight timestamp. */
function publishedAtFromUploadDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Parses yt-dlp's single-video JSON for a YouTube link into the cached video
 * draft plus the channel that hosts it. Output is untrusted: every field is
 * probed, and a video with no usable channel identity is rejected because
 * `videos.creator_id` needs a host row.
 */
export function parseYoutubeVideoPayload(
  stdout: string,
  link: Extract<VideoLink, { platform: "youtube" }>,
): { ok: true; draft: VideoDraft; host: ResolvedHost } | { ok: false; error: VideoImportError } {
  const unreadable = videoImportError(
    "unexpected_response",
    "YouTube returned data scope could not read. Please try again.",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: unreadable };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: unreadable };
  }
  const record = parsed as Record<string, unknown>;

  const title = nonEmptyString(record.title);
  if (title === null) {
    return {
      ok: false,
      error: videoImportError("unexpected_response", "That link did not resolve to a real video."),
    };
  }

  const channelId = nonEmptyString(record.channel_id);
  const displayName = nonEmptyString(record.channel) ?? nonEmptyString(record.uploader);
  if (channelId === null || !CHANNEL_ID_PATTERN.test(channelId) || displayName === null) {
    return { ok: false, error: videoImportError("no_channel", NO_CHANNEL_MESSAGE) };
  }

  const uploaderId = nonEmptyString(record.uploader_id);
  const handle = uploaderId?.startsWith("@") ? normalizeHandle(uploaderId) : null;

  const thumbnailUrl =
    pickThumbnailUrl(record.thumbnails) ?? pickThumbnailUrl([{ url: record.thumbnail }]);
  const description = nonEmptyString(record.description);

  return {
    ok: true,
    draft: {
      id: link.id,
      title: title.slice(0, 300),
      url: link.url,
      thumbnailUrl,
      publishedAt:
        mapPublishedAt(record.timestamp ?? record.release_timestamp) ??
        publishedAtFromUploadDate(record.upload_date),
      durationSeconds: mapDurationSeconds(record.duration),
      liveStatus: mapLiveStatus(record.live_status),
      description: description === null ? null : description.slice(0, 5000),
    },
    host: {
      platform: "youtube",
      youtubeChannelId: channelId,
      handle,
      displayName: displayName.slice(0, 100),
      channelUrl: `https://www.youtube.com/channel/${channelId}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

type MetadataOutcome =
  { ok: true; draft: VideoDraft; host: ResolvedHost } | { ok: false; error: VideoImportError };

async function fetchMetadata(link: VideoLink, deps: ResolveDeps): Promise<MetadataOutcome> {
  const jobDeps = { command: deps.command, run: deps.run, throttleRetryMs: deps.throttleRetryMs };

  if (link.platform === "rumble") {
    const result = await runRumbleDiscovery(jobDeps, link.url);
    if (!result.ok) {
      return { ok: false, error: classifyVideoJobFailure(result, PLATFORM_LABEL.rumble) };
    }
    const parsed = parseRumbleVideoPayload(result.stdout, link.slug);
    if (!parsed.ok) {
      return {
        ok: false,
        error: videoImportError("unexpected_response", parsed.error.message),
      };
    }
    const { video } = parsed;
    return {
      ok: true,
      draft: video.draft,
      host: {
        platform: "rumble",
        youtubeChannelId: null,
        handle: normalizeHandle(channelSlugFromUrl(video.channelUrl)),
        displayName: video.channelName,
        channelUrl: video.channelUrl,
      },
    };
  }

  const result = await runJobWithThrottleRetry(jobDeps, buildVideoMetadataArgs(link.url), {
    timeoutMs: METADATA_TIMEOUT_MS,
    maxOutputBytes: METADATA_MAX_OUTPUT_BYTES,
  });
  if (!result.ok) {
    return { ok: false, error: classifyVideoJobFailure(result, PLATFORM_LABEL.youtube) };
  }
  return parseYoutubeVideoPayload(result.stdout, link);
}

type CaptionOutcome =
  { ok: true; selection: SubtitleTrackSelection | null } | { ok: false; error: VideoImportError };

/** The English caption gate: same discovery and selection the transcript pipeline runs. */
async function checkCaptions(link: VideoLink, deps: ResolveDeps): Promise<CaptionOutcome> {
  const discovery = await deps.discover(link.url, {
    command: deps.command,
    run: deps.run,
    throttleRetryMs: deps.throttleRetryMs,
  });
  if (!discovery.ok) {
    if (discovery.reason === "command") {
      return {
        ok: false,
        error: classifyVideoJobFailure(discovery.result, PLATFORM_LABEL[link.platform]),
      };
    }
    return {
      ok: false,
      error: videoImportError(
        "unexpected_response",
        "scope could not read the caption information for this video.",
      ),
    };
  }
  return { ok: true, selection: selectEnglishSubtitleTrack(discovery.available) };
}

// ---------------------------------------------------------------------------
// Already-cached shortcut
// ---------------------------------------------------------------------------

interface KnownVideoRow {
  id: string;
  title: string;
  url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  live_status: LiveStatus;
  description: string | null;
  creator_id: number;
  platform: string | null;
  youtube_channel_id: string | null;
  handle: string | null;
  display_name: string;
  channel_url: string;
  transcript_source: SubtitleTrackKind | null;
  transcript_language: string | null;
}

function findKnownVideo(db: ScopeDatabase, videoId: string): KnownVideoRow | undefined {
  return db
    .prepare<[string], KnownVideoRow>(
      `SELECT v.id, v.title, v.url, v.thumbnail_url, v.published_at, v.duration_seconds,
              v.live_status, v.description,
              c.id AS creator_id, c.platform, c.youtube_channel_id, c.handle, c.display_name,
              c.channel_url,
              t.source AS transcript_source, t.language AS transcript_language
       FROM videos v
       JOIN creators c ON c.id = v.creator_id
       LEFT JOIN transcripts t ON t.video_id = v.id
       WHERE v.id = ?`,
    )
    .get(videoId);
}

function knownVideoToResolved(
  row: KnownVideoRow,
  link: VideoLink,
  captions: SubtitleTrackKind,
  hasTranscript: boolean,
): ResolvedVideo {
  return {
    platform: link.platform,
    videoId: row.id,
    url: link.url,
    draft: {
      id: row.id,
      title: row.title,
      url: row.url,
      thumbnailUrl: row.thumbnail_url,
      publishedAt: row.published_at,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      liveStatus: row.live_status,
      description: row.description,
    },
    host: {
      platform: row.platform === "rumble" ? "rumble" : "youtube",
      youtubeChannelId: row.youtube_channel_id,
      handle: row.handle,
      displayName: row.display_name,
      channelUrl: row.channel_url,
    },
    captions,
    inLibrary: { creatorId: Number(row.creator_id), hasTranscript },
  };
}

function isLiveOrUpcoming(status: LiveStatus): boolean {
  return status === "is_live" || status === "upcoming";
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Resolves one link. Verdict order: a failed metadata lookup wins, then a live
 * or scheduled video (no captions exist yet), then a failed caption lookup,
 * then the absence of an English track.
 */
export async function resolveVideoLink(
  db: ScopeDatabase,
  link: VideoLink,
  overrides: Partial<ResolveDeps> = {},
): Promise<ResolveResult> {
  const deps: ResolveDeps = { ...defaultDeps(), ...overrides };

  const known = findKnownVideo(db, videoLinkId(link));
  if (known) {
    const cachedLanguage = known.transcript_language;
    if (
      known.transcript_source !== null &&
      cachedLanguage !== null &&
      isEnglishCaptionLanguage(cachedLanguage)
    ) {
      return {
        ok: true,
        video: knownVideoToResolved(known, link, known.transcript_source, true),
      };
    }
    const gate = await checkCaptions(link, deps);
    if (!gate.ok) {
      return gate;
    }
    if (gate.selection === null) {
      return {
        ok: false,
        error: isLiveOrUpcoming(known.live_status)
          ? videoImportError("live_or_upcoming", LIVE_OR_UPCOMING_MESSAGE)
          : videoImportError("no_english_captions", NO_ENGLISH_CAPTIONS_MESSAGE),
      };
    }
    return {
      ok: true,
      video: knownVideoToResolved(known, link, gate.selection.kind, false),
    };
  }

  const [metadata, gate] = await Promise.all([
    fetchMetadata(link, deps),
    checkCaptions(link, deps),
  ]);
  if (!metadata.ok) {
    return metadata;
  }
  if (isLiveOrUpcoming(metadata.draft.liveStatus)) {
    return { ok: false, error: videoImportError("live_or_upcoming", LIVE_OR_UPCOMING_MESSAGE) };
  }
  if (!gate.ok) {
    return gate;
  }
  if (gate.selection === null) {
    return {
      ok: false,
      error: videoImportError("no_english_captions", NO_ENGLISH_CAPTIONS_MESSAGE),
    };
  }
  return {
    ok: true,
    video: {
      platform: link.platform,
      videoId: metadata.draft.id,
      url: link.url,
      draft: metadata.draft,
      host: metadata.host,
      captions: gate.selection.kind,
      inLibrary: null,
    },
  };
}
