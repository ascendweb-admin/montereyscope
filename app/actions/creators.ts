"use server";

/**
 * Server Actions backing the creator library UI. Thin: they delegate to the
 * creator service and keep every returned value shaped for the client —
 * no raw database records, stderr, paths, or stack traces.
 */
import { revalidatePath } from "next/cache";

import {
  followCreator,
  followHostWithVideo,
  removeCreatorById,
  saveResolvedCreator,
  saveRumbleCreatorPayload,
  saveXCreatorPayload,
  resolveCreatorFromAnyUrl,
  type CreatorPreviewModel,
  type CreatorSummary,
} from "@/lib/creators/service";
import {
  detachAccountFromInput,
  fileAccountUnderProfile,
  linkProfilesFromInput,
  listProfileSummaries,
  removeProfileById,
  renameProfileFromInput,
  setProfileAvatarFromInput,
  targetProfileExists,
  type CreatorProfileSummary,
} from "@/lib/creators/profile-service";
import { dismissLinkSuggestion } from "@/lib/creators/profile-suggestions";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";
import { MAX_VIDEO_LINK_LENGTH, parseVideoLink } from "@/lib/videos/import/links";
import { revalidateLibraryViews } from "./revalidate-library";

export interface ResolveOutcome {
  ok: boolean;
  /** Resolved identity preview for confirmation (no database id yet). */
  creator?: CreatorPreviewModel;
  errorCode?: string;
  message?: string;
}

export interface SaveOutcome {
  ok: boolean;
  /**
   * "linked" means the account was already saved on its own and has now been
   * filed under the chosen creator.
   */
  status?: "created" | "already_saved" | "linked";
  creator?: CreatorSummary;
  /** X status-link imports only: whether the previewed post was cached. */
  importedTweet?: boolean;
  message?: string;
}

export interface RemoveOutcome {
  ok: boolean;
  message?: string;
}

/**
 * Step 1 of adding: resolve a pasted channel link (or an X post link) into a
 * preview. A single YouTube or Rumble video link is not a creator: the Add
 * dialog sends those to `previewVideoLinkAction` instead, and only API-style
 * callers reach this with one (a Rumble video link previews the channel that
 * saving would follow). `platform` carries the user's explicit platform
 * choice; it only matters for bare X handles, which must never silently
 * change the YouTube default.
 */
export async function resolveCreatorAction(
  rawUrl: string,
  platform?: CreatorPlatform,
): Promise<ResolveOutcome> {
  if (typeof rawUrl !== "string") {
    return { ok: false, errorCode: "invalid_url", message: "Paste a creator link first." };
  }
  try {
    const outcome = await resolveCreatorFromAnyUrl(getDb(), rawUrl, platform);
    if (!outcome.ok) {
      return { ok: false, errorCode: outcome.error.code, message: outcome.error.message };
    }
    return { ok: true, creator: outcome.creator };
  } catch {
    // Never leak unexpected server errors to the UI.
    return {
      ok: false,
      errorCode: "unexpected_error",
      message: "Something went wrong on this machine while resolving the link. Please try again.",
    };
  }
}

/**
 * Step 2 of adding: persist the confirmed creator. The payload is
 * re-validated server side; duplicates are reported as already_saved.
 * Rumble payloads go through the Rumble save path (a video-link import
 * re-runs server side so the client never supplies video data).
 */
export async function saveCreatorAction(
  payload: unknown,
  categoryIds: unknown = [],
  /** Files the account under this existing creator instead of a new one. */
  profileId: unknown = null,
): Promise<SaveOutcome> {
  try {
    const db = getDb();
    const targetProfileId =
      Number.isInteger(profileId) && Number(profileId) >= 1 ? Number(profileId) : null;
    if (profileId !== null && targetProfileId === null) {
      return { ok: false, message: "That creator choice is not valid." };
    }
    if (targetProfileId !== null && !targetProfileExists(db, targetProfileId)) {
      return {
        ok: false,
        message: "That creator is no longer in your library. Choose another one or save it as new.",
      };
    }
    const platform =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>).platform
        : null;
    const outcome =
      platform === "rumble"
        ? await saveRumbleCreatorPayload(db, payload, categoryIds)
        : platform === "x"
          ? await saveXCreatorPayload(db, payload, categoryIds)
          : saveResolvedCreator(db, payload, categoryIds);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    let status: SaveOutcome["status"] = outcome.status;
    let creator = outcome.creator;
    if (targetProfileId !== null && creator.profileId !== targetProfileId) {
      fileAccountUnderProfile(db, creator.id, targetProfileId);
      if (outcome.status === "already_saved") {
        status = "linked";
      }
      creator = { ...creator, profileId: targetProfileId };
    }
    revalidateLibraryViews();
    const importedTweet =
      platform === "x" && "importedTweet" in outcome
        ? Boolean((outcome as { importedTweet?: unknown }).importedTweet)
        : undefined;
    return {
      ok: true,
      status,
      creator,
      importedTweet,
    };
  } catch {
    return {
      ok: false,
      message: "The creator could not be saved to your library. Please try again.",
    };
  }
}

/**
 * Convenience path used by the API-first flows (e.g. scripts): resolve and
 * immediately save in one step.
 */
export async function addCreatorAction(rawUrl: string): Promise<SaveOutcome> {
  const resolved = await resolveCreatorAction(rawUrl);
  if (!resolved.ok || !resolved.creator) {
    return { ok: false, message: resolved.message };
  }
  return saveCreatorAction(resolved.creator);
}

/**
 * Removes one platform account; its cached videos, posts, and transcripts
 * cascade with it. The person it belonged to stays while other accounts
 * remain linked.
 */
export async function removeCreatorAction(id: number): Promise<RemoveOutcome> {
  try {
    const db = getDb();
    const outcome = removeCreatorById(db, id);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    if (!outcome.removed) {
      return { ok: false, message: "That account was already removed from your library." };
    }
    revalidateLibraryViews();
    return { ok: true };
  } catch {
    return { ok: false, message: "The account could not be removed. Please try again." };
  }
}

export type FollowCreatorOutcome =
  { ok: true; creator: CreatorSummary } | { ok: false; message: string };

/**
 * Follows a channel that is only a source (it hosts a hand-picked video): it
 * joins the library with its picture. The caller starts the channel's first
 * feed refresh, so the page can show it as a background task.
 */
export async function followCreatorAction(creatorId: unknown): Promise<FollowCreatorOutcome> {
  if (typeof creatorId !== "number" || !Number.isInteger(creatorId) || creatorId < 1) {
    return { ok: false, message: "That channel is not valid." };
  }
  try {
    const outcome = await followCreator(getDb(), creatorId);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateLibraryViews();
    return { ok: true, creator: outcome.creator };
  } catch {
    return { ok: false, message: "The channel could not be followed. Please try again." };
  }
}

export type FollowVideoChannelOutcome =
  | { ok: true; status: "created" | "already_saved"; creator: CreatorSummary }
  | { ok: false; code: string; message: string; retryable: boolean };

/**
 * "Follow {host} as a creator" from a pasted video link: the video's channel
 * joins the library with the chosen categories and that one video is cached
 * under it. The server re-resolves the link, so a rejected video (no English
 * captions, live, unavailable) comes back as an error and saves nothing.
 */
export async function followVideoChannelAction(
  url: unknown,
  categoryIds: unknown = [],
): Promise<FollowVideoChannelOutcome> {
  if (typeof url !== "string" || url.length > MAX_VIDEO_LINK_LENGTH || !parseVideoLink(url).ok) {
    return {
      ok: false,
      code: "invalid_link",
      message: "Paste a link to a single YouTube or Rumble video.",
      retryable: false,
    };
  }
  try {
    const outcome = await followHostWithVideo(getDb(), url, categoryIds);
    if (!outcome.ok) {
      return {
        ok: false,
        code: outcome.error.code,
        message: outcome.error.message,
        retryable: outcome.error.retryable ?? false,
      };
    }
    revalidateLibraryViews();
    return { ok: true, status: outcome.status, creator: outcome.creator };
  } catch {
    return {
      ok: false,
      code: "unexpected_response",
      message: "The channel could not be added to your library. Please try again.",
      retryable: false,
    };
  }
}

export interface ProfileActionOutcome {
  ok: boolean;
  message?: string;
}

/** Removes a person together with every linked account and its cache. */
export async function removeProfileAction(
  profileId: unknown,
): Promise<ProfileActionOutcome & { removedAccounts?: number }> {
  try {
    const outcome = removeProfileById(getDb(), profileId);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateLibraryViews();
    return { ok: true, removedAccounts: outcome.removedAccounts };
  } catch {
    return { ok: false, message: "The creator could not be removed. Please try again." };
  }
}

/** Renames a person; their accounts keep the names their platforms use. */
export async function renameProfileAction(
  profileId: unknown,
  name: unknown,
): Promise<ProfileActionOutcome & { displayName?: string }> {
  try {
    const outcome = renameProfileFromInput(getDb(), profileId, name);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateLibraryViews();
    return { ok: true, displayName: outcome.displayName };
  } catch {
    return { ok: false, message: "The name could not be saved. Please try again." };
  }
}

/** Chooses which linked account's avatar represents the person. */
export async function setProfileAvatarAction(
  profileId: unknown,
  creatorId: unknown,
): Promise<ProfileActionOutcome> {
  try {
    const outcome = setProfileAvatarFromInput(getDb(), profileId, creatorId);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateLibraryViews();
    return { ok: true };
  } catch {
    return { ok: false, message: "The profile picture could not be changed. Please try again." };
  }
}

/** Links other creators' accounts into one person (categories are combined). */
export async function linkProfilesAction(
  targetProfileId: unknown,
  sourceProfileIds: unknown,
): Promise<ProfileActionOutcome & { linkedCount?: number }> {
  try {
    const outcome = linkProfilesFromInput(getDb(), targetProfileId, sourceProfileIds);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateLibraryViews();
    return { ok: true, linkedCount: outcome.linkedCount };
  } catch {
    return { ok: false, message: "Those creators could not be linked. Please try again." };
  }
}

/** Splits one account off into a creator of its own. */
export async function detachAccountAction(
  creatorId: unknown,
): Promise<ProfileActionOutcome & { profileId?: number }> {
  try {
    const outcome = detachAccountFromInput(getDb(), creatorId);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    revalidateLibraryViews();
    return { ok: true, profileId: outcome.profileId };
  } catch {
    return { ok: false, message: "The account could not be unlinked. Please try again." };
  }
}

/** Everyone in the library, for the add flow's "add to an existing creator" picker. */
export async function listProfilesAction(): Promise<CreatorProfileSummary[]> {
  try {
    return listProfileSummaries(getDb());
  } catch {
    return [];
  }
}

/** Marks a suggested group as different people so it is never suggested again. */
export async function dismissLinkSuggestionAction(
  profileIds: unknown,
): Promise<ProfileActionOutcome> {
  if (
    !Array.isArray(profileIds) ||
    profileIds.length < 2 ||
    profileIds.length > 50 ||
    !profileIds.every((id) => Number.isInteger(id) && id > 0)
  ) {
    return { ok: false, message: "That suggestion is no longer valid." };
  }
  try {
    dismissLinkSuggestion(getDb(), profileIds as number[]);
    revalidatePath("/");
    return { ok: true };
  } catch {
    return { ok: false, message: "The suggestion could not be dismissed. Please try again." };
  }
}
