/**
 * Resolves a Rumble link (channel page or single video) into the creator
 * identity preview shown by the add-creator dialog. Server-only.
 *
 * - Channel links resolve from one channel-page fetch (name, avatar,
 *   follower count).
 * - Video links resolve from yt-dlp's cheap metadata roundtrip (channel
 *   name + canonical channel URL) plus one channel-page fetch for the
 *   avatar; the video being imported is surfaced in the preview and the
 *   actual import (and its DB writes) happens at save time, server-side.
 *
 * Failures are typed and user-safe; raw stderr and HTML never leave here.
 */
import { isAllowedImageUrl } from "./avatar";
import { parseRumbleUrl, rumbleChannelUrlFromSlug, rumbleVideoUrlFromSlug } from "@/lib/rumble/urls";
import {
  fetchRumbleChannelIdentity,
  channelSlugFromUrl,
} from "@/lib/rumble/identity";
import {
  classifyDiscoveryFailure,
  parseRumbleVideoPayload,
  runRumbleDiscovery,
  type RumbleImportError,
} from "@/lib/rumble/video-import";
import { runCommand } from "@/lib/ytdlp/runner";
import { YT_DLP_COMMAND } from "@/lib/ytdlp/version";
import { NETWORK_UNREACHABLE_MESSAGE, YTDLP_MISSING_MESSAGE } from "@/lib/ytdlp/user-messages";
import type { CreatorPlatform } from "./repository";

export interface ResolvedCreatorPreview {
  platform: CreatorPlatform;
  youtubeChannelId: string | null;
  handle: string | null;
  displayName: string;
  channelUrl: string;
  avatarUrl: string | null;
  /** Rumble only: follower count when the listing page exposed it. */
  followerCount: number | null;
  /** Rumble video links only: the video the import will cache. */
  videoTitle: string | null;
  videoId: string | null;
  videoUrl: string | null;
}

export type CreatorPreviewErrorCode =
  | "invalid_url"
  | "ytdlp_missing"
  | "unavailable_channel"
  | "unavailable_video"
  | "throttled"
  | "network"
  | "timeout"
  | "unexpected_response";

export interface CreatorPreviewError {
  code: CreatorPreviewErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr or paths. */
  message: string;
}

export type CreatorPreviewResult =
  { ok: true; creator: ResolvedCreatorPreview } | { ok: false; error: CreatorPreviewError };

export interface RumblePreviewDeps {
  command: string;
  run: typeof runCommand;
  fetchIdentity: typeof fetchRumbleChannelIdentity;
}

const DEFAULT_PREVIEW_DEPS: RumblePreviewDeps = {
  command: YT_DLP_COMMAND,
  run: runCommand,
  fetchIdentity: fetchRumbleChannelIdentity,
};

function identityError(failure: { reason: string; detail?: string }): CreatorPreviewError {
  switch (failure.reason) {
    case "throttled":
      return {
        code: "throttled",
        message: "Rumble is throttling requests right now. Wait a minute and try again.",
      };
    case "unavailable":
      return {
        code: "unavailable_channel",
        message:
          "Rumble does not offer that channel (it may have been removed, renamed, or made private).",
      };
    case "timeout":
      return {
        code: "timeout",
        message: "Looking up that channel took too long and was stopped. Please try again.",
      };
    case "unusable_page":
      return {
        code: "unexpected_response",
        message: "scope could not read that channel right now. Please try again later.",
      };
    default:
      return { code: "network", message: NETWORK_UNREACHABLE_MESSAGE };
  }
}

function importErrorToPreviewError(error: RumbleImportError): CreatorPreviewError {
  if (error.code === "local_tool") {
    return {
      code: "unexpected_response",
      message: "The video data was too large to read safely, so the import was stopped.",
    };
  }
  return { code: error.code, message: error.message };
}

/**
 * Resolves any pasted Rumble link into a creator identity preview. Video
 * links additionally resolve the video itself so the dialog can show what
 * the import will cache; channel links resolve identity only.
 */
export async function resolveRumbleCreatorPreview(
  rawInput: string,
  overrides: Partial<RumblePreviewDeps> = {},
): Promise<{ ok: true; creator: ResolvedCreatorPreview } | { ok: false; error: CreatorPreviewError }> {
  const deps: RumblePreviewDeps = { ...DEFAULT_PREVIEW_DEPS, ...overrides };
  const parsedUrl = parseRumbleUrl(rawInput);
  if (!parsedUrl.ok) {
    return { ok: false, error: { code: "invalid_url", message: parsedUrl.message } };
  }
  const target = parsedUrl.target;

  if (target.kind === "channel") {
    const canonical = rumbleChannelUrlFromSlug(target.slug, target.prefix);
    const identityResult = await deps.fetchIdentity(canonical, target.slug);
    if (!identityResult.ok) {
      return { ok: false, error: identityError(identityResult.failure) };
    }
    const { identity } = identityResult;
    return {
      ok: true,
      creator: {
        platform: "rumble",
        youtubeChannelId: null,
        handle: normalizeHandle(target.slug),
        displayName: identity.displayName,
        channelUrl: identity.channelUrl.startsWith("https://")
          ? identity.channelUrl
          : canonical,
        avatarUrl:
          identity.avatarUrl !== null && isAllowedImageUrl(identity.avatarUrl)
            ? identity.avatarUrl
            : null,
        followerCount: identity.followerCount,
        videoTitle: null,
        videoId: null,
        videoUrl: null,
      },
    };
  }

  // Video link: resolve the video via yt-dlp, then the channel identity.
  const videoUrl = rumbleVideoUrlFromSlug(target.slug);
  const discovery = await runRumbleDiscovery(
    { command: deps.command, run: deps.run },
    videoUrl,
  );
  if (!discovery.ok) {
    const classified = classifyDiscoveryFailure(discovery);
    if (classified.code === "local_tool") {
      return {
        ok: false,
        error: {
          code: "unexpected_response",
          message: "The video data was too large to read safely, so the import was stopped.",
        },
      };
    }
    return { ok: false, error: importErrorToPreviewError(classified) };
  }
  const parsedVideo = parseRumbleVideoPayload(discovery.stdout, target.slug);
  if (!parsedVideo.ok) {
    return { ok: false, error: importErrorToPreviewError(parsedVideo.error) };
  }
  const video = parsedVideo.video;

  const channelSlug = channelSlugFromUrl(video.channelUrl);
  const identityResult = await deps.fetchIdentity(video.channelUrl, channelSlug ?? undefined);
  let avatarUrl: string | null = null;
  let followerCount: number | null = null;
  if (identityResult.ok) {
    if (identityResult.identity.avatarUrl !== null && isAllowedImageUrl(identityResult.identity.avatarUrl)) {
      avatarUrl = identityResult.identity.avatarUrl;
    }
    followerCount = identityResult.identity.followerCount;
  }
  // A throttled avatar fetch must not fail the preview: identity is known.

  return {
    ok: true,
    creator: {
      platform: "rumble",
      youtubeChannelId: null,
      handle: normalizeHandle(channelSlug),
      displayName: video.channelName,
      channelUrl: video.channelUrl,
      avatarUrl,
      followerCount,
      videoTitle: video.title,
      videoId: video.id,
      videoUrl: video.url,
    },
  };
}

function normalizeHandle(slug: string | null): string | null {
  if (slug === null) {
    return null;
  }
  const handle = slug.toLowerCase();
  return /^[0-9a-z._-]{3,30}$/.test(handle) ? handle : null;
}

/** Missing-executable mapping shared with the import path. */
export function ytdlpMissingError(): CreatorPreviewError {
  return { code: "ytdlp_missing", message: YTDLP_MISSING_MESSAGE };
}
