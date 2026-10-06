"use server";

/**
 * Server Actions backing the creator library UI. Thin: they delegate to the
 * creator service and keep every returned value shaped for the client —
 * no raw database records, stderr, paths, or stack traces.
 */
import { revalidatePath } from "next/cache";

import {
  removeCreatorById,
  saveResolvedCreator,
  saveRumbleCreatorPayload,
  saveXCreatorPayload,
  resolveCreatorFromAnyUrl,
  type CreatorPreviewModel,
  type CreatorSummary,
} from "@/lib/creators/service";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { getDb } from "@/lib/db/connection";

export interface ResolveOutcome {
  ok: boolean;
  /** Resolved identity preview for confirmation (no database id yet). */
  creator?: CreatorPreviewModel;
  errorCode?: string;
  message?: string;
}

export interface SaveOutcome {
  ok: boolean;
  status?: "created" | "already_saved";
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
 * Step 1 of adding: resolve a pasted channel or video link into a preview.
 * `platform` carries the user's explicit platform choice; it only matters
 * for bare X handles, which must never silently change the YouTube default.
 */
export async function resolveCreatorAction(
  rawUrl: string,
  platform?: CreatorPlatform,
): Promise<ResolveOutcome> {
  if (typeof rawUrl !== "string") {
    return { ok: false, errorCode: "invalid_url", message: "Paste a channel or video link first." };
  }
  try {
    const outcome = await resolveCreatorFromAnyUrl(rawUrl, platform);
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
): Promise<SaveOutcome> {
  try {
    const db = getDb();
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
    revalidatePath("/");
    revalidatePath("/x-research");
    revalidatePath(`/channels/${outcome.creator.id}`);
    const importedTweet =
      platform === "x" && "importedTweet" in outcome
        ? Boolean((outcome as { importedTweet?: unknown }).importedTweet)
        : undefined;
    return {
      ok: true,
      status: outcome.status,
      creator: outcome.creator,
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

/** Removes a creator; its future cached videos/transcripts cascade with it. */
export async function removeCreatorAction(id: number): Promise<RemoveOutcome> {
  try {
    const db = getDb();
    const outcome = removeCreatorById(db, id);
    if (!outcome.ok) {
      return { ok: false, message: outcome.error.message };
    }
    if (!outcome.removed) {
      return { ok: false, message: "That creator was already removed from your library." };
    }
    revalidatePath("/");
    revalidatePath("/x-research");
    revalidatePath(`/channels/${id}`);
    return { ok: true };
  } catch {
    return { ok: false, message: "The creator could not be removed. Please try again." };
  }
}
