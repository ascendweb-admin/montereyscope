"use server";

/**
 * Server Actions behind "Add videos": preview one pasted link, then import
 * the chosen ones onto a person. Thin: validation here, work in
 * `lib/videos/import`, and every returned value shaped for the client (no raw
 * records, stderr, paths, or the full cached draft).
 */
import { ensureHostAvatar } from "@/lib/creators/host-avatar";
import { profilesExist } from "@/lib/creators/profiles";
import { getDb } from "@/lib/db/connection";
import { removeAttributedVideos } from "@/lib/videos/attribution";
import { MAX_VIDEO_LINK_LENGTH } from "@/lib/videos/import/links";
import { mapWithConcurrency } from "@/lib/videos/import/pool";
import {
  importVideos,
  MAX_IMPORT_URLS,
  previewVideoLink,
  type ImportRowResult,
  type PreviewVideoOutcome,
} from "@/lib/videos/import/service";
import { revalidateLibraryViews } from "./revalidate-library";

/** Channel pictures looked up at once after an import that follows its channels. */
const AVATAR_CONCURRENCY = 3;
/** Most videos one removal takes; a person's Other videos can run long. */
const MAX_REMOVE_VIDEOS = 500;
/** Stored video ids: a YouTube id or a Rumble page slug. */
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,20}$/;

export type PreviewVideoLinkOutcome = PreviewVideoOutcome;

export type ImportVideosOutcome =
  { ok: true; results: ImportRowResult[] } | { ok: false; message: string };

export type RemoveVideosOutcome =
  | { ok: true; removed: number; deletedVideos: number; deletedHosts: number }
  | { ok: false; message: string };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isLink(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_VIDEO_LINK_LENGTH;
}

/**
 * Resolves one link into a preview row, including the English-caption check.
 * `profileId` only tells the row whether the video is already in that
 * person's Other videos.
 */
export async function previewVideoLinkAction(
  url: unknown,
  profileId?: unknown,
): Promise<PreviewVideoLinkOutcome> {
  if (!isLink(url) || url.trim().length === 0) {
    return {
      ok: false,
      code: "invalid_input",
      message: "Paste a video link first.",
      retryable: false,
    };
  }
  if (profileId !== undefined && profileId !== null && !isPositiveInteger(profileId)) {
    return {
      ok: false,
      code: "invalid_input",
      message: "That person choice is not valid.",
      retryable: false,
    };
  }
  try {
    return await previewVideoLink(getDb(), url, profileId ?? null);
  } catch {
    // Never leak unexpected server errors to the UI.
    return {
      ok: false,
      code: "unexpected_response",
      message: "Something went wrong on this machine while looking up the video. Please try again.",
      retryable: false,
    };
  }
}

/**
 * Adds the chosen links to a person's Other videos. The server re-resolves
 * anything it has not just previewed: the client never supplies video data.
 * Each row succeeds or fails on its own.
 */
export async function importVideosAction(
  urls: unknown,
  options: unknown,
): Promise<ImportVideosOutcome> {
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    urls.length > MAX_IMPORT_URLS ||
    !urls.every(isLink)
  ) {
    return {
      ok: false,
      message: `Choose between 1 and ${MAX_IMPORT_URLS} video links to add.`,
    };
  }
  const settings =
    typeof options === "object" && options !== null ? (options as Record<string, unknown>) : null;
  if (
    settings === null ||
    typeof settings.followHost !== "boolean" ||
    (settings.profileId !== null && !isPositiveInteger(settings.profileId))
  ) {
    return { ok: false, message: "Those import options are not valid." };
  }
  const profileId = settings.profileId as number | null;
  const followHost = settings.followHost;
  if (profileId === null && !followHost) {
    return { ok: false, message: "Choose a person to add these videos to." };
  }

  try {
    const db = getDb();
    const { results } = await importVideos(db, { urls, profileId, followHost });
    if (followHost) {
      // Videos give a channel no picture; a channel followed here gets one now.
      const hostIds = new Set(results.flatMap((row) => row.hostCreatorId ?? []));
      await mapWithConcurrency([...hostIds], AVATAR_CONCURRENCY, (id) => ensureHostAvatar(db, id));
    }
    if (results.some((row) => row.status !== "rejected")) {
      revalidateLibraryViews();
    }
    return { ok: true, results };
  } catch {
    return {
      ok: false,
      message: "The videos could not be added to your library. Please try again.",
    };
  }
}

/**
 * Takes videos out of a person's Other videos. A video no other person
 * features and whose channel is only a source-only host is deleted with its
 * transcript, and the channel goes with its last video; a video on a followed
 * channel is never deleted.
 */
export async function removeVideosAction(
  profileId: unknown,
  videoIds: unknown,
): Promise<RemoveVideosOutcome> {
  if (!isPositiveInteger(profileId)) {
    return { ok: false, message: "That person choice is not valid." };
  }
  if (
    !Array.isArray(videoIds) ||
    videoIds.length === 0 ||
    videoIds.length > MAX_REMOVE_VIDEOS ||
    !videoIds.every((id) => typeof id === "string" && VIDEO_ID_PATTERN.test(id))
  ) {
    return { ok: false, message: "Choose the videos to remove." };
  }
  try {
    const db = getDb();
    if (!profilesExist(db, [profileId])) {
      return { ok: false, message: "That person is no longer in your library." };
    }
    const result = removeAttributedVideos(db, profileId, videoIds as string[]);
    if (result.removed > 0) {
      revalidateLibraryViews();
    }
    return { ok: true, ...result };
  } catch {
    return { ok: false, message: "The videos could not be removed. Please try again." };
  }
}
