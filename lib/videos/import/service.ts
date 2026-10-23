/**
 * Import service for "Other videos": turns pasted video links into cached
 * videos attributed to a person. Server-only.
 *
 * Every link is independent: it is resolved (and checked for English
 * captions) over the network, then committed in its own transaction, so one
 * failure never blocks the others and a rejected link writes nothing.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { addCreator, getCreator, setCreatorFollowed } from "@/lib/creators/repository";
import { profilesExist } from "@/lib/creators/profiles";
import { attachVideoToProfile, listVideoProfileIds } from "@/lib/videos/attribution";
import { insertVideoIfMissing, type LiveStatus } from "@/lib/videos/repository";
import type { SubtitleTrackKind } from "@/lib/ytdlp/subtitles";
import { videoImportError, type VideoImportError, type VideoImportErrorCode } from "./errors";
import { MAX_PASTED_VIDEO_LINKS, parseVideoLink, type VideoLink } from "./links";
import { mapWithConcurrency } from "./pool";
import { resolveVideoLinkCached } from "./preview-cache";
import type { ResolveDeps, ResolvedVideo, VideoImportPlatform } from "./resolve";

/** Most links one import handles; matches the paste cap in `extractVideoLinks`. */
export const MAX_IMPORT_URLS = MAX_PASTED_VIDEO_LINKS;

/** Links resolved at once. Each costs two yt-dlp jobs, so this stays small. */
const RESOLVE_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** What the Add videos dialog shows for one resolved link. Client-safe fields only. */
export interface VideoPreview {
  /** Canonical link. */
  url: string;
  videoId: string;
  platform: VideoImportPlatform;
  title: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  publishedAt: string | null;
  liveStatus: LiveStatus;
  hostName: string;
  /** Normalized handle without the "@", or null. */
  hostHandle: string | null;
  hostPlatform: VideoImportPlatform;
  /** Kind of English caption track found: human-written or automatic. */
  captions: SubtitleTrackKind;
  /** The video is already cached (in a feed or another person's Other videos). */
  alreadyInLibrary: boolean;
  /** The video is already in the given person's Other videos. */
  alreadyAttached: boolean;
}

export type PreviewVideoOutcome =
  | { ok: true; preview: VideoPreview }
  | { ok: false; code: VideoImportErrorCode; message: string; retryable: boolean };

function failedOutcome(error: VideoImportError): PreviewVideoOutcome {
  return { ok: false, code: error.code, message: error.message, retryable: error.retryable };
}

function videoIsCached(db: ScopeDatabase, videoId: string): boolean {
  return db.prepare("SELECT 1 FROM videos WHERE id = ?").get(videoId) !== undefined;
}

/**
 * Resolves one link for the preview row. Database state (already cached,
 * already attached) is read fresh every call, even when the resolution itself
 * comes from the cache.
 */
export async function previewVideoLink(
  db: ScopeDatabase,
  rawUrl: string,
  profileId: number | null,
  deps: Partial<ResolveDeps> = {},
): Promise<PreviewVideoOutcome> {
  const parsed = parseVideoLink(rawUrl);
  if (!parsed.ok) {
    return failedOutcome(videoImportError(parsed.code, parsed.message));
  }
  const resolved = await resolveVideoLinkCached(db, parsed.link, deps);
  if (!resolved.ok) {
    return failedOutcome(resolved.error);
  }
  const { video } = resolved;
  return {
    ok: true,
    preview: {
      url: video.url,
      videoId: video.videoId,
      platform: video.platform,
      title: video.draft.title,
      thumbnailUrl: video.draft.thumbnailUrl,
      durationSeconds: video.draft.durationSeconds,
      publishedAt: video.draft.publishedAt,
      liveStatus: video.draft.liveStatus,
      hostName: video.host.displayName,
      hostHandle: video.host.handle,
      hostPlatform: video.host.platform,
      captions: video.captions,
      alreadyInLibrary: videoIsCached(db, video.videoId),
      alreadyAttached:
        profileId !== null && listVideoProfileIds(db, video.videoId).includes(profileId),
    },
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportVideosInput {
  urls: readonly string[];
  /** The visible person the videos feature; null only together with `followHost`. */
  profileId: number | null;
  /** Also save each video's channel as a followed creator instead of a hidden host. */
  followHost: boolean;
}

export type ImportRowStatus = "added" | "attached_existing" | "already_attached" | "rejected";

export interface ImportRowResult {
  /**
   * Canonical link for a parseable input (so duplicates collapse and the
   * client can match rows to its own canonical links); the input text itself
   * when it could not be parsed.
   */
  url: string;
  /**
   * added: the video was new. attached_existing: it was already cached and is
   * now in the person's Other videos. already_attached: nothing to do.
   */
  status: ImportRowStatus;
  videoId?: string;
  title?: string;
  hostName?: string;
  /** The channel row that hosts the video (set on every row that was not rejected). */
  hostCreatorId?: number;
  /** The host was already a followed creator before this import. */
  hostFollowedBefore?: boolean;
  error?: VideoImportError;
}

function rejectedRow(url: string, error: VideoImportError): ImportRowResult {
  return { url, status: "rejected", error };
}

type PlannedRow =
  | { kind: "link"; url: string; link: VideoLink }
  | { kind: "invalid"; url: string; error: VideoImportError };

/** Parses and de-duplicates the input, keeping its order and capping at `MAX_IMPORT_URLS`. */
function planRows(urls: readonly string[]): PlannedRow[] {
  const planned: PlannedRow[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    if (planned.length >= MAX_IMPORT_URLS) {
      break;
    }
    const parsed = parseVideoLink(typeof raw === "string" ? raw : "");
    if (parsed.ok) {
      if (!seen.has(parsed.link.url)) {
        seen.add(parsed.link.url);
        planned.push({ kind: "link", url: parsed.link.url, link: parsed.link });
      }
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!seen.has(text)) {
      seen.add(text);
      planned.push({
        kind: "invalid",
        url: text,
        error: videoImportError(parsed.code, parsed.message),
      });
    }
  }
  return planned;
}

/** Why the whole request cannot run, or null when it can. */
function inputProblem(db: ScopeDatabase, input: ImportVideosInput): VideoImportError | null {
  if (input.profileId === null) {
    // A hidden host must always have an attributed video, so a request with no
    // person is only meaningful when it saves the channel as a followed creator.
    return input.followHost
      ? null
      : videoImportError("invalid_input", "Choose a person to add these videos to.");
  }
  if (
    !Number.isInteger(input.profileId) ||
    input.profileId < 1 ||
    !profilesExist(db, [input.profileId])
  ) {
    return videoImportError("invalid_input", "That person is no longer in your library.");
  }
  return null;
}

/**
 * Writes one resolved video: its host (found or created), the video row, and
 * the attribution, atomically. An already-cached video keeps its creator and
 * its refresh stamp; only a requested follow can change its host.
 */
function commitVideo(
  db: ScopeDatabase,
  video: ResolvedVideo,
  profileId: number | null,
  followHost: boolean,
): ImportRowResult {
  const commit = db.transaction((): ImportRowResult => {
    const existing = db
      .prepare<[string], { creator_id: number }>("SELECT creator_id FROM videos WHERE id = ?")
      .get(video.videoId);

    let inserted = false;
    let hostCreatorId: number;
    let hostFollowedBefore: boolean;
    if (existing) {
      hostCreatorId = Number(existing.creator_id);
      hostFollowedBefore = getCreator(db, hostCreatorId)?.followed === true;
      if (followHost) {
        setCreatorFollowed(db, hostCreatorId, true);
      }
    } else {
      const { status, creator } = addCreator(db, {
        youtubeChannelId: video.host.youtubeChannelId,
        handle: video.host.handle,
        displayName: video.host.displayName,
        channelUrl: video.host.channelUrl,
        avatarUrl: null,
        platform: video.host.platform,
        followed: followHost,
      });
      hostCreatorId = creator.id;
      // A new or just-promoted host reports "created"; only a duplicate that
      // was already followed comes back followed.
      hostFollowedBefore = status === "already_saved" && creator.followed;
      inserted = insertVideoIfMissing(db, creator.id, video.draft);
    }

    const attached =
      profileId === null ? false : attachVideoToProfile(db, profileId, video.videoId);
    const status: ImportRowStatus = inserted
      ? "added"
      : attached
        ? "attached_existing"
        : "already_attached";
    return {
      url: video.url,
      status,
      videoId: video.videoId,
      title: video.draft.title,
      hostName: video.host.displayName,
      hostCreatorId,
      hostFollowedBefore,
    };
  });
  return commit();
}

/**
 * Imports pasted video links onto a person. Rows never throw: each comes back
 * added, attached to an existing video, already attached, or rejected with a
 * typed error, in input order.
 */
export async function importVideos(
  db: ScopeDatabase,
  input: ImportVideosInput,
  deps: Partial<ResolveDeps> = {},
): Promise<{ results: ImportRowResult[] }> {
  const rows = planRows(input.urls);

  const problem = inputProblem(db, input);
  if (problem !== null) {
    return { results: rows.map((row) => rejectedRow(row.url, problem)) };
  }

  const results = await mapWithConcurrency(rows, RESOLVE_CONCURRENCY, async (row) => {
    if (row.kind === "invalid") {
      return rejectedRow(row.url, row.error);
    }
    try {
      const resolved = await resolveVideoLinkCached(db, row.link, deps);
      if (!resolved.ok) {
        return rejectedRow(row.url, resolved.error);
      }
      return commitVideo(db, resolved.video, input.profileId, input.followHost);
    } catch {
      return rejectedRow(
        row.url,
        videoImportError(
          "unexpected_response",
          "scope could not save that video. Please try again.",
        ),
      );
    }
  });
  return { results };
}
