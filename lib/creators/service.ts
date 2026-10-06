/**
 * Creator library application service: glues URL parsing, yt-dlp
 * resolution, and storage into operations shared by Server Actions and
 * Route Handlers. Server-only.
 */
import {
  addCreator,
  getCreator,
  removeCreator,
  type CreatorRecord,
  type CreatorPlatform,
  type NewCreatorInput,
} from "./repository";
import { resolveCreatorFromUrl, type ResolvedCreator } from "./resolver";
import { resolveRumbleCreatorPreview } from "./rumble-resolver";
import { importRumbleVideo } from "@/lib/rumble/video-import";
import { parseRumbleUrl } from "@/lib/rumble/urls";
import { parseXTarget } from "@/lib/x/urls";
import { resolveXCreator, saveXCreator, type XResolvedCreator } from "@/lib/x/service";
import { deleteOrphanTweets } from "@/lib/x/repository";
import { isAllowedImageUrl } from "./avatar";
import {
  addCreatorCategories,
  categoriesExist,
  listCategoriesForCreator,
  type CreatorCategory,
} from "@/lib/categories";
import { normalizeIds } from "@/lib/categories/service";
import type { ScopeDatabase } from "@/lib/db/connection";

export interface CreatorSummary {
  id: number;
  displayName: string;
  handle: string | null;
  channelUrl: string;
  avatarUrl: string | null;
  youtubeChannelId: string | null;
  /** Platform-stable account id (X user id); null for YouTube/Rumble. */
  platformUserId: string | null;
  platform: CreatorPlatform;
  categories: CreatorCategory[];
}

/** The one failure shape every caller surfaces to the UI. */
export interface CreatorServiceError {
  code: string;
  message: string;
}

const RESOLUTION_CODE_TO_STATUS: Record<string, number> = {
  invalid_url: 400,
  ytdlp_missing: 503,
  unavailable_channel: 422,
  unavailable_video: 422,
  throttled: 429,
  network: 502,
  timeout: 504,
  local_tool: 500,
  unexpected_response: 502,
  // X provider failures.
  not_connected: 503,
  unsupported_runtime: 503,
  session_expired: 401,
  verification_required: 403,
  rate_limited: 429,
  not_found: 404,
  protected_account: 422,
  cancelled: 499,
  invalid_response: 502,
};

export function httpStatusForServiceError(error: CreatorServiceError): number {
  return RESOLUTION_CODE_TO_STATUS[error.code] ?? 500;
}

function toSummary(record: CreatorRecord, categories: CreatorCategory[] = []): CreatorSummary {
  return {
    id: record.id,
    displayName: record.displayName,
    handle: record.handle,
    channelUrl: record.channelUrl,
    avatarUrl: record.avatarUrl,
    youtubeChannelId: record.youtubeChannelId,
    platformUserId: record.platformUserId,
    platform: record.platform,
    categories,
  };
}

export function toCreatorSummary(record: CreatorRecord): CreatorSummary {
  return toSummary(record);
}

/**
 * Full add pipeline for a pasted URL: parse → resolve identity → persist.
 * Duplicate creators resolve to the already-saved row. `platform` carries
 * the user's explicit platform choice, letting a bare `@handle` resolve as X
 * without changing the existing YouTube default.
 */
export async function addCreatorFromUrl(
  db: ScopeDatabase,
  rawInput: string,
  platform?: CreatorPlatform,
): Promise<
  | { ok: true; status: "created" | "already_saved"; creator: CreatorSummary }
  | { ok: false; error: CreatorServiceError }
> {
  // X links (and bare handles once X was chosen) resolve through the
  // connected X session.
  if (platform === "x" || parseXTarget(rawInput).ok) {
    const preview = await resolveXCreator(rawInput);
    if (!preview.ok) {
      return { ok: false, error: preview.error };
    }
    const saved = await saveXCreator(db, {
      payload: preview.creator,
      importTweetId: preview.creator.tweetId,
    });
    if (!saved.ok) {
      return { ok: false, error: saved.error };
    }
    return {
      ok: true,
      status: saved.status,
      creator: toSummary(saved.creator, listCategoriesForCreator(db, saved.creator.id)),
    };
  }

  // Rumble links go through the Rumble paths: a video link imports the
  // video and auto-provisions its creator; a channel link saves identity.
  if (parseRumbleUrl(rawInput).ok) {
    const preview = await resolveRumbleCreatorPreview(rawInput);
    if (!preview.ok) {
      return { ok: false, error: preview.error };
    }
    if (preview.creator.videoUrl !== null) {
      const imported = await importRumbleVideo(db, preview.creator.videoUrl);
      if (!imported.ok) {
        return { ok: false, error: imported.error };
      }
      const record = getCreator(db, imported.creatorId);
      if (!record) {
        return {
          ok: false,
          error: { code: "unexpected_response", message: "The creator could not be saved." },
        };
      }
      return {
        ok: true,
        status: imported.status,
        creator: toSummary(record, listCategoriesForCreator(db, record.id)),
      };
    }
    const outcome = addCreator(db, {
      youtubeChannelId: null,
      handle: preview.creator.handle,
      displayName: preview.creator.displayName,
      channelUrl: preview.creator.channelUrl,
      avatarUrl: preview.creator.avatarUrl,
      platform: "rumble",
    });
    return {
      ok: true,
      status: outcome.status,
      creator: toSummary(outcome.creator, listCategoriesForCreator(db, outcome.creator.id)),
    };
  }

  const resolution = await resolveCreatorFromUrl(rawInput);
  if (!resolution.ok) {
    return { ok: false, error: resolution.error };
  }
  const outcome = addCreator(db, toNewCreatorInput(resolution.creator));
  return {
    ok: true,
    status: outcome.status,
    creator: toSummary(outcome.creator, listCategoriesForCreator(db, outcome.creator.id)),
  };
}

function toNewCreatorInput(resolved: ResolvedCreator): NewCreatorInput {
  return {
    youtubeChannelId: resolved.youtubeChannelId,
    handle: resolved.handle,
    displayName: resolved.displayName,
    channelUrl: resolved.channelUrl,
    avatarUrl: resolved.avatarUrl,
    platform: resolved.platform,
  };
}

/**
 * Unified preview used by the add-creator UI: dispatches on the pasted
 * link's platform — or the explicit platform choice for bare handles. Every
 * platform returns the same preview shape.
 */
export interface CreatorPreviewModel {
  platform: CreatorPlatform;
  youtubeChannelId: string | null;
  /** Platform-stable account id (X user id); null for YouTube/Rumble. */
  platformUserId: string | null;
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
  /** X status links only: the post the import will cache. */
  tweetId: string | null;
  tweetText: string | null;
  tweetUrl: string | null;
  tweetPublishedAt: string | null;
}

function toXPreview(creator: XResolvedCreator): CreatorPreviewModel {
  return {
    platform: "x",
    youtubeChannelId: null,
    platformUserId: creator.platformUserId,
    handle: creator.handle,
    displayName: creator.displayName,
    channelUrl: creator.channelUrl,
    avatarUrl: creator.avatarUrl,
    followerCount: null,
    videoTitle: null,
    videoId: null,
    videoUrl: null,
    tweetId: creator.tweetId,
    tweetText: creator.tweetText,
    tweetUrl: creator.tweetUrl,
    tweetPublishedAt: creator.tweetPublishedAt,
  };
}

function mismatchedPlatform(message: string): { ok: false; error: CreatorServiceError } {
  return { ok: false, error: { code: "invalid_url", message } };
}

export async function resolveCreatorFromAnyUrl(
  rawInput: string,
  platform?: CreatorPlatform,
): Promise<
  { ok: true; creator: CreatorPreviewModel } | { ok: false; error: CreatorServiceError }
> {
  const xTarget = parseXTarget(rawInput, { allowBareHandle: platform === "x" });

  if (platform === "x" || (platform === undefined && xTarget.ok)) {
    if (!xTarget.ok) {
      return mismatchedPlatform(xTarget.message);
    }
    const preview = await resolveXCreator(rawInput);
    if (!preview.ok) {
      return { ok: false, error: preview.error };
    }
    return { ok: true, creator: toXPreview(preview.creator) };
  }

  // An explicit non-X platform must not silently absorb an X link.
  if (platform !== undefined && xTarget.ok) {
    return mismatchedPlatform("That is an X link. Choose the X platform above to add it.");
  }

  const isRumble = parseRumbleUrl(rawInput).ok;
  if (platform === "rumble" && !isRumble) {
    return mismatchedPlatform(
      "That does not look like a Rumble channel or video link. Choose the right platform above.",
    );
  }
  if (platform === "youtube" && isRumble) {
    return mismatchedPlatform("That is a Rumble link. Choose the Rumble platform above to add it.");
  }

  if (isRumble) {
    const preview = await resolveRumbleCreatorPreview(rawInput);
    if (!preview.ok) {
      return { ok: false, error: preview.error };
    }
    const { creator } = preview;
    return {
      ok: true,
      creator: {
        platform: creator.platform,
        youtubeChannelId: creator.youtubeChannelId,
        platformUserId: null,
        handle: creator.handle,
        displayName: creator.displayName,
        channelUrl: creator.channelUrl,
        avatarUrl: creator.avatarUrl,
        followerCount: creator.followerCount,
        videoTitle: creator.videoTitle,
        videoId: creator.videoId,
        videoUrl: creator.videoUrl,
        tweetId: null,
        tweetText: null,
        tweetUrl: null,
        tweetPublishedAt: null,
      },
    };
  }
  const outcome = await resolveCreatorFromUrl(rawInput);
  if (!outcome.ok) {
    return outcome;
  }
  const resolved = outcome.creator;
  return {
    ok: true,
    creator: {
      ...resolved,
      platform: resolved.platform,
      platformUserId: null,
      followerCount: null,
      videoTitle: null,
      videoId: null,
      videoUrl: null,
      tweetId: null,
      tweetText: null,
      tweetUrl: null,
      tweetPublishedAt: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Server-side re-validation of client-provided resolved creators. Values that
// arrive over the wire are untrusted; anything malformed is rejected rather
// than stored, and avatar URLs pointing at unexpected hosts are dropped.
// ---------------------------------------------------------------------------

const CHANNEL_ID_PATTERN = /^UC[0-9A-Za-z_-]{22}$/;
const HANDLE_PATTERN = /^[0-9a-z._-]{3,30}$/;

function isValidCanonicalChannelUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !/(^|\.)youtube\.com$/.test(url.hostname)) {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      (segments.length === 2 && segments[0] === "channel") ||
      (segments.length === 1 && segments[0].startsWith("@"))
    );
  } catch {
    return false;
  }
}

function sanitizeAvatarUrl(value: unknown): string | null {
  return isAllowedImageUrl(value) ? value : null;
}

/**
 * Validates a resolved-creator payload coming back from the confirmation UI
 * before persisting it. Returns a friendly error instead of throwing.
 */
export function validateResolvedCreatorPayload(
  payload: unknown,
): { ok: true; input: NewCreatorInput } | { ok: false; error: CreatorServiceError } {
  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message: "The resolved creator could not be saved. Try adding the link again.",
      },
    };
  }
  const candidate = payload as Record<string, unknown>;
  const displayName =
    typeof candidate.displayName === "string" ? candidate.displayName.trim().slice(0, 100) : "";
  const channelUrl = candidate.channelUrl;

  if (displayName.length === 0 || !isValidCanonicalChannelUrl(channelUrl)) {
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message:
          "That creator was not resolved correctly. Please start again from the channel link.",
      },
    };
  }

  const channelIdRaw = candidate.youtubeChannelId;
  const youtubeChannelId =
    typeof channelIdRaw === "string" && CHANNEL_ID_PATTERN.test(channelIdRaw) ? channelIdRaw : null;
  const handleRaw = candidate.handle;
  const handle = typeof handleRaw === "string" && HANDLE_PATTERN.test(handleRaw) ? handleRaw : null;

  return {
    ok: true,
    input: {
      youtubeChannelId,
      handle,
      displayName,
      channelUrl,
      avatarUrl: sanitizeAvatarUrl(candidate.avatarUrl),
      platform: "youtube",
    },
  };
}

export function saveResolvedCreator(
  db: ScopeDatabase,
  payload: unknown,
  categoryIdsValue: unknown = [],
):
  | { ok: true; status: "created" | "already_saved"; creator: CreatorSummary }
  | { ok: false; error: CreatorServiceError } {
  const validated = validateResolvedCreatorPayload(payload);
  if (!validated.ok) {
    return validated;
  }
  const categoryIds = normalizeIds(categoryIdsValue, 100);
  if (categoryIds === null) {
    return {
      ok: false,
      error: { code: "invalid_payload", message: "That category selection is not valid." },
    };
  }
  if (!categoriesExist(db, categoryIds)) {
    return {
      ok: false,
      error: { code: "invalid_payload", message: "One of those categories no longer exists." },
    };
  }

  // Duplicate adds keep existing memberships and add the newly checked ones.
  // A transaction makes creator creation + initial categorization one write.
  const save = db.transaction(() => {
    const result = addCreator(db, validated.input);
    addCreatorCategories(db, result.creator.id, categoryIds);
    return result;
  });
  const outcome = save();
  return {
    ok: true,
    status: outcome.status,
    creator: toSummary(outcome.creator, listCategoriesForCreator(db, outcome.creator.id)),
  };
}

// ---------------------------------------------------------------------------
// Rumble saves. The video-import variant is async (yt-dlp + a channel-page
// fetch happen at save time); the channel-identity variant mirrors
// saveResolvedCreator's validation pattern.
// ---------------------------------------------------------------------------

const RUMBLE_CHANNEL_URL_PATTERN = /^https:\/\/(?:www\.)?rumble\.com\/(?:c|user)\/[0-9A-Za-z._-]{2,60}$/;

function isValidRumbleChannelUrl(value: unknown): value is string {
  return typeof value === "string" && RUMBLE_CHANNEL_URL_PATTERN.test(value);
}

/**
 * Validates a rumble-resolved creator payload (channel-identity variant —
 * no video import). The YouTube canonical-URL rules do not apply here.
 */
export function validateRumbleCreatorPayload(
  payload: unknown,
): { ok: true; input: NewCreatorInput } | { ok: false; error: CreatorServiceError } {
  if (typeof payload !== "object" || payload === null) {
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message: "The resolved creator could not be saved. Try adding the link again.",
      },
    };
  }
  const candidate = payload as Record<string, unknown>;
  const displayName =
    typeof candidate.displayName === "string" ? candidate.displayName.trim().slice(0, 100) : "";
  if (displayName.length === 0 || !isValidRumbleChannelUrl(candidate.channelUrl)) {
    return {
      ok: false,
      error: {
        code: "invalid_payload",
        message: "That creator was not resolved correctly. Please start again from the link.",
      },
    };
  }
  const handleRaw = candidate.handle;
  const handle =
    typeof handleRaw === "string" && HANDLE_PATTERN.test(handleRaw) ? handleRaw : null;

  return {
    ok: true,
    input: {
      youtubeChannelId: null,
      handle,
      displayName,
      channelUrl: candidate.channelUrl,
      avatarUrl: sanitizeAvatarUrl(candidate.avatarUrl),
      platform: "rumble",
    },
  };
}

/**
 * Persists a confirmed Rumble preview. When the payload carries a video URL
 * (a video-link import) the whole import re-runs server side — the client
 * only supplies the link reference, never the video data — and the freshly
 * provisioned creator keeps the newly checked categories.
 */
export async function saveRumbleCreatorPayload(
  db: ScopeDatabase,
  payload: unknown,
  categoryIdsValue: unknown = [],
): Promise<
  | { ok: true; status: "created" | "already_saved"; creator: CreatorSummary }
  | { ok: false; error: CreatorServiceError }
> {
  const categoryIds = normalizeIds(categoryIdsValue, 100);
  if (categoryIds === null) {
    return {
      ok: false,
      error: { code: "invalid_payload", message: "That category selection is not valid." },
    };
  }
  if (!categoriesExist(db, categoryIds)) {
    return {
      ok: false,
      error: { code: "invalid_payload", message: "One of those categories no longer exists." },
    };
  }

  const candidate = typeof payload === "object" && payload !== null ? payload : {};
  const videoUrlRaw = (candidate as Record<string, unknown>).videoUrl;
  const videoUrl = typeof videoUrlRaw === "string" && videoUrlRaw.length > 0 ? videoUrlRaw : null;

  if (videoUrl !== null && parseRumbleUrl(videoUrl).ok) {
    const imported = await importRumbleVideo(db, videoUrl);
    if (!imported.ok) {
      return { ok: false, error: imported.error };
    }
    addCreatorCategories(db, imported.creatorId, categoryIds);
    const record = getCreator(db, imported.creatorId);
    if (!record) {
      return {
        ok: false,
        error: { code: "unexpected_response", message: "The creator could not be saved." },
      };
    }
    return {
      ok: true,
      status: imported.status,
      creator: toSummary(record, listCategoriesForCreator(db, record.id)),
    };
  }

  const validated = validateRumbleCreatorPayload(payload);
  if (!validated.ok) {
    return validated;
  }

  // Duplicate adds keep existing memberships and add the newly checked ones.
  const save = db.transaction(() => {
    const result = addCreator(db, validated.input);
    addCreatorCategories(db, result.creator.id, categoryIds);
    return result;
  });
  const outcome = save();
  return {
    ok: true,
    status: outcome.status,
    creator: toSummary(outcome.creator, listCategoriesForCreator(db, outcome.creator.id)),
  };
}

// ---------------------------------------------------------------------------
// X saves. The creator identity is re-validated server side; a status-link
// import re-fetches the post through the provider so the client never
// supplies tweet bodies.
// ---------------------------------------------------------------------------

export async function saveXCreatorPayload(
  db: ScopeDatabase,
  payload: unknown,
  categoryIdsValue: unknown = [],
): Promise<
  | { ok: true; status: "created" | "already_saved"; creator: CreatorSummary; importedTweet: boolean }
  | { ok: false; error: CreatorServiceError }
> {
  const categoryIds = normalizeIds(categoryIdsValue, 100);
  if (categoryIds === null) {
    return {
      ok: false,
      error: { code: "invalid_payload", message: "That category selection is not valid." },
    };
  }
  if (!categoriesExist(db, categoryIds)) {
    return {
      ok: false,
      error: { code: "invalid_payload", message: "One of those categories no longer exists." },
    };
  }

  const importTweetId =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).tweetId
      : null;
  const saved = await saveXCreator(db, {
    payload,
    importTweetId: typeof importTweetId === "string" ? importTweetId : null,
  });
  if (!saved.ok) {
    return saved;
  }
  addCreatorCategories(db, saved.creator.id, categoryIds);
  return {
    ok: true,
    status: saved.status,
    importedTweet: saved.importedTweet,
    creator: toSummary(saved.creator, listCategoriesForCreator(db, saved.creator.id)),
  };
}

export function removeCreatorById(
  db: ScopeDatabase,
  id: number,
): { ok: true; removed: boolean } | { ok: false; error: CreatorServiceError } {
  if (!Number.isInteger(id) || id < 1) {
    return { ok: false, error: { code: "invalid_id", message: "That creator ID is not valid." } };
  }
  const removed = removeCreator(db, id);
  if (removed) {
    // Creator timelines cascade; posts no other timeline references are
    // reclaimed so removal does not leave orphaned text behind.
    deleteOrphanTweets(db);
  }
  return { ok: true, removed };
}

export function getCreatorById(db: ScopeDatabase, id: number): CreatorRecord | null {
  if (!Number.isInteger(id) || id < 1) {
    return null;
  }
  return getCreator(db, id);
}
