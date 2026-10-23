/**
 * Resolves a Rumble channel link into the creator identity preview shown by
 * the add-creator dialog. Server-only.
 *
 * A channel link resolves from one channel-page fetch (name, avatar,
 * follower count). Video links are not channels: they go through the video
 * import engine (`lib/videos/import`), which `resolveCreatorFromAnyUrl` and
 * `followHostWithVideo` use to follow the video's channel.
 *
 * Failures are typed and user-safe; raw stderr and HTML never leave here.
 */
import { isAllowedImageUrl } from "./avatar";
import { parseRumbleUrl, rumbleChannelUrlFromSlug } from "@/lib/rumble/urls";
import { fetchRumbleChannelIdentity } from "@/lib/rumble/identity";
import { NETWORK_UNREACHABLE_MESSAGE } from "@/lib/ytdlp/user-messages";
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
}

export type CreatorPreviewErrorCode =
  | "invalid_url"
  | "unavailable_channel"
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
  fetchIdentity: typeof fetchRumbleChannelIdentity;
}

const DEFAULT_PREVIEW_DEPS: RumblePreviewDeps = {
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

/** Resolves a pasted Rumble channel link into a creator identity preview. */
export async function resolveRumbleCreatorPreview(
  rawInput: string,
  overrides: Partial<RumblePreviewDeps> = {},
): Promise<CreatorPreviewResult> {
  const deps: RumblePreviewDeps = { ...DEFAULT_PREVIEW_DEPS, ...overrides };
  const parsedUrl = parseRumbleUrl(rawInput);
  if (!parsedUrl.ok) {
    return { ok: false, error: { code: "invalid_url", message: parsedUrl.message } };
  }
  const target = parsedUrl.target;
  if (target.kind !== "channel") {
    return {
      ok: false,
      error: {
        code: "invalid_url",
        message: "That is a Rumble video link, not a channel. Paste the channel's link instead.",
      },
    };
  }

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
      channelUrl: identity.channelUrl.startsWith("https://") ? identity.channelUrl : canonical,
      avatarUrl:
        identity.avatarUrl !== null && isAllowedImageUrl(identity.avatarUrl)
          ? identity.avatarUrl
          : null,
      followerCount: identity.followerCount,
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
