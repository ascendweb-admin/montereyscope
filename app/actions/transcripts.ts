"use server";

/**
 * Server Actions backing the stage 4 transcript UI. Thin wrappers that
 * delegate to the transcripts service and return client-safe shapes only —
 * no raw database records, stderr, temporary paths, or stack traces.
 */
import { resolveTranscript, type TranscriptIntent } from "@/lib/transcripts/service";
import { getCachedVideo } from "@/lib/videos/service";
import { getDb } from "@/lib/db/connection";
import { isEnglishCaptionLanguage } from "@/lib/ytdlp/subtitles";

export interface TranscriptSelectionInput {
  language: string;
  kind: "manual" | "automatic";
}

export interface TranscriptActionResultSuccess {
  ok: true;
  transcript: {
    text: string;
    language: string;
    captionSource: "manual" | "automatic";
    fetchedAt: string;
    fromCache: boolean;
  };
}

export interface TranscriptActionResultFailure {
  ok: false;
  errorCode: string;
  message: string;
  availableManualLanguages?: string[];
  availableAutomaticLanguages?: string[];
}

export type TranscriptActionResult = TranscriptActionResultSuccess | TranscriptActionResultFailure;

function parseSelection(raw: unknown): TranscriptSelectionInput | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const { language, kind } = raw as Record<string, unknown>;
  if (
    typeof language !== "string" ||
    !isEnglishCaptionLanguage(language.trim()) ||
    (kind !== "manual" && kind !== "automatic")
  ) {
    return null;
  }
  return { language: language.trim().toLowerCase(), kind };
}

/**
 * Fetches (or re-fetches) the transcript for one cached video.
 * - "get": cache-first, then automatic selection of original English captions.
 * - "refresh": always runs a fresh extraction; overwrites the cache on success.
 * - "select": compatibility with an explicit English track choice.
 */
export async function getTranscriptAction(
  creatorId: number,
  videoId: string,
  intent: TranscriptIntent,
  selection?: unknown,
): Promise<TranscriptActionResult> {
  if (!Number.isInteger(creatorId) || creatorId < 1) {
    return { ok: false, errorCode: "invalid_video", message: "That creator ID is not valid." };
  }
  if (
    typeof videoId !== "string" ||
    !/^[A-Za-z0-9_-]{6,20}$/.test(videoId) ||
    !["get", "refresh", "select"].includes(intent)
  ) {
    return {
      ok: false,
      errorCode: "invalid_video",
      message: "That video reference is not valid.",
    };
  }
  const parsedSelection = intent === "select" ? parseSelection(selection) : undefined;
  if (intent === "select" && !parsedSelection) {
    return {
      ok: false,
      errorCode: "invalid_video",
      message: "The chosen caption track is not valid.",
    };
  }

  try {
    const db = getDb();
    const video = getCachedVideo(db, creatorId, videoId);
    if (!video) {
      return {
        ok: false,
        errorCode: "invalid_video",
        message: "That video is no longer in your cached feed.",
      };
    }

    const outcome = await resolveTranscript(db, video.id, video.url, {
      intent,
      ...(parsedSelection ? { selection: parsedSelection } : {}),
    });

    if (!outcome.ok) {
      return {
        ok: false,
        errorCode: outcome.error.code,
        message: outcome.error.message,
        availableManualLanguages: outcome.error.availableManualLanguages,
        availableAutomaticLanguages: outcome.error.availableAutomaticLanguages,
      };
    }
    return { ok: true, transcript: outcome.transcript };
  } catch {
    // Never leak unexpected server errors to the UI.
    return {
      ok: false,
      errorCode: "unexpected_response",
      message: "scope could not extract this transcript right now. Please try again.",
    };
  }
}
