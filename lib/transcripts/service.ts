/**
 * Transcript application service (stage 4): discovers an available caption
 * track, downloads it as WebVTT with yt-dlp, converts it to plain text,
 * and caches complete successful results. Server-only.
 *
 * Extraction runs in the background when an analysis needs a transcript
 * (see prepare.ts) and is guarded so concurrent requests for the same video
 * collapse into one run. Successful results are always cached. A failed extraction never touches the
 * cached transcript or the cached feed: rows are written only after a
 * track has been fully parsed. Raw subtitle markup and local temporary
 * paths never leave this module; transcript bodies are never logged.
 */
import {
  discoverAvailableSubtitles,
  downloadCaptionTrack,
  selectEnglishSubtitleTrack,
  isEnglishCaptionLanguage,
  isThrottledStderr,
  type SubtitleTrackKind,
  type SubtitleTrackSelection,
} from "@/lib/ytdlp/subtitles";
import { runCommand } from "@/lib/ytdlp/runner";
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { NETWORK_UNREACHABLE_MESSAGE, YTDLP_MISSING_MESSAGE } from "@/lib/ytdlp/user-messages";
import { vttToPlainText, VttParseError } from "./vtt-to-text";
import { getTranscript, saveTranscript, type TranscriptRecord } from "./repository";
import type { ScopeDatabase } from "@/lib/db/connection";

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export type TranscriptErrorCode =
  | "invalid_video"
  | "ytdlp_missing"
  | "unavailable_video"
  | "no_captions"
  | "language_choice"
  | "timeout"
  | "network"
  | "throttled"
  | "parse"
  | "local_tool"
  | "unexpected_response";

export interface TranscriptServiceError {
  code: TranscriptErrorCode;
  /** Plain-language, UI-safe message. Never contains stderr or paths. */
  message: string;
  /** Present only for language_choice: languages the user can pick from. */
  availableManualLanguages?: string[];
  availableAutomaticLanguages?: string[];
}

export const TRANSCRIPT_ERROR_CODE_TO_STATUS: Record<TranscriptErrorCode, number> = {
  invalid_video: 404,
  ytdlp_missing: 503,
  unavailable_video: 422,
  no_captions: 422,
  language_choice: 422,
  timeout: 504,
  network: 502,
  throttled: 429,
  parse: 502,
  local_tool: 500,
  unexpected_response: 502,
};

function fail(code: TranscriptErrorCode, message: string): TranscriptServiceError {
  return { code, message };
}

/**
 * Maps a raw runner/yt-dlp failure to a typed, user-safe error.
 * stderr is inspected only for classification — its text never surfaces.
 */
export function classifyCommandFailure(
  result: Extract<ExecFileResult, { ok: false }>,
): TranscriptServiceError {
  switch (result.kind) {
    case "missing_executable":
      return fail("ytdlp_missing", YTDLP_MISSING_MESSAGE);
    case "timeout":
      return fail("timeout", "Fetching captions took too long and was stopped. Please try again.");
    case "output_limit":
      return fail(
        "local_tool",
        "yt-dlp returned too much command output, so caption extraction was stopped.",
      );
    case "spawn_failed":
      return fail("local_tool", "scope could not start yt-dlp on this machine.");
    default:
      break;
  }

  const stderrTail = result.stderrTail.toLowerCase();
  // Platform rate-limiting (Rumble's edge in particular) is distinct from a
  // broken network: the message asks the user to retry in a minute, and the
  // extraction job has already retried once internally.
  if (isThrottledStderr(stderrTail)) {
    return fail(
      "throttled",
      "The platform is rate-limiting requests right now. Wait a minute and try again.",
    );
  }
  if (
    /video unavailable|video is unavailable|private video|has been removed|terminated|members[- ]only|join this channel|sign in to confirm|age.?restrict|premiere|is not live/.test(
      stderrTail,
    )
  ) {
    return fail(
      "unavailable_video",
      "The platform would not serve captions for this video (it may be private, removed, or restricted).",
    );
  }
  if (
    /getaddrinfo|temporary failure|name or service not known|network|connection|unable to download|resolve|refused|reset by peer/.test(
      stderrTail,
    )
  ) {
    return fail("network", NETWORK_UNREACHABLE_MESSAGE);
  }
  return fail(
    "unexpected_response",
    "scope could not extract captions right now. Please try again later.",
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** "refresh" ignores any cached copy; "select" uses an explicit user choice. */
export type TranscriptIntent = "get" | "refresh" | "select";

export interface TranscriptView {
  text: string;
  language: string;
  captionSource: SubtitleTrackKind;
  fetchedAt: string;
  /** True when served from the local cache without running yt-dlp. */
  fromCache: boolean;
}

export type TranscriptOutcome =
  { ok: true; transcript: TranscriptView } | { ok: false; error: TranscriptServiceError };

interface ResolveDeps {
  command: string;
  run: typeof runCommand;
  now: () => Date;
  cacheEnabled?: boolean;
  selection?: SubtitleTrackSelection;
  intent?: TranscriptIntent;
}

const defaultResolveDeps: ResolveDeps = {
  command: process.env.SCOPE_YTDLP_PATH ?? process.env.LOCALTUBE_YTDLP_PATH ?? "yt-dlp",
  run: runCommand,
  now: () => new Date(),
};

/**
 * In-process guard mirroring the feed service: at most one extraction per
 * video id at a time; duplicate calls await the same outcome.
 */
const inFlightExtractions = new Map<string, Promise<TranscriptOutcome>>();

/** Test seam: forget any in-flight extraction state. */
export function resetInFlightExtractions(): void {
  inFlightExtractions.clear();
}

function recordToView(record: TranscriptRecord): TranscriptView {
  return {
    text: record.plainText,
    language: record.language,
    captionSource: record.source,
    fetchedAt: record.fetchedAt,
    fromCache: true,
  };
}

/**
 * Resolves the transcript for one cached video:
 * cached success → discovery + selection → caption job → parse → cache write.
 * Only fully parsed text is ever stored or returned.
 */
export async function resolveTranscript(
  db: ScopeDatabase,
  videoId: string,
  videoUrl: string,
  overrides: Partial<ResolveDeps> = {},
): Promise<TranscriptOutcome> {
  const existing = inFlightExtractions.get(videoId);
  if (existing) {
    return existing;
  }
  const task = performResolve(db, videoId, videoUrl, overrides);
  inFlightExtractions.set(videoId, task);
  try {
    return await task;
  } finally {
    if (inFlightExtractions.get(videoId) === task) {
      inFlightExtractions.delete(videoId);
    }
  }
}

async function performResolve(
  db: ScopeDatabase,
  videoId: string,
  videoUrl: string,
  overrides: Partial<ResolveDeps>,
): Promise<TranscriptOutcome> {
  const deps: ResolveDeps = { ...defaultResolveDeps, ...overrides };
  const intent = deps.intent ?? "get";
  const jobDeps = { command: deps.command, run: deps.run };
  const cacheEnabled = deps.cacheEnabled ?? true;

  // 1) Cached successful result (unless refreshing or caching is disabled).
  if (cacheEnabled && intent === "get" && !deps.selection) {
    const cached = getTranscript(db, videoId);
    if (cached && isEnglishCaptionLanguage(cached.language)) {
      return { ok: true, transcript: recordToView(cached) };
    }
  }

  // 2) Decide which track to fetch.
  let selection = deps.selection ?? null;
  if (selection && !isEnglishCaptionLanguage(selection.language)) {
    return {
      ok: false,
      error: fail("no_captions", "Scope currently supports English captions only."),
    };
  }
  if (!selection) {
    const discovery = await discoverAvailableSubtitles(videoUrl, jobDeps);
    if (!discovery.ok) {
      if (discovery.reason === "command") {
        return { ok: false, error: classifyCommandFailure(discovery.result) };
      }
      return {
        ok: false,
        error: fail(
          "unexpected_response",
          "scope could not read the caption information for this video.",
        ),
      };
    }

    selection = selectEnglishSubtitleTrack(discovery.available);
    if (!selection) {
      return {
        ok: false,
        error: fail(
          "no_captions",
          "No original English captions are available for this video. Scope currently supports English only.",
        ),
      };
    }
  }

  // 3) Download just that track into a self-cleaning temporary directory.
  const job = await downloadCaptionTrack(videoUrl, selection, jobDeps);
  if (!job.ok) {
    switch (job.reason) {
      case "command_failed":
        return { ok: false, error: classifyCommandFailure(job.commandResult) };
      case "artifact_not_found":
        return {
          ok: false,
          error: fail(
            "unexpected_response",
            "The platform did not return the English caption track. Please try again.",
          ),
        };
      case "artifact_too_large":
        return {
          ok: false,
          error: fail("local_tool", "The caption file was too large to read safely."),
        };
      case "temp_directory":
        return {
          ok: false,
          error: fail("local_tool", "scope could not create a temporary working folder."),
        };
      default:
        return {
          ok: false,
          error: fail(
            "local_tool",
            "The caption download was ambiguous, so nothing was saved. Please try again.",
          ),
        };
    }
  }

  // 4) Convert to plain text. Parse failures are terminal for this attempt —
  // nothing partial is stored.
  let text: string;
  try {
    text = vttToPlainText(job.vtt);
  } catch (error) {
    if (error instanceof VttParseError) {
      const detail =
        error.code === "empty"
          ? "The caption track contained no readable text."
          : error.code === "not_webvtt"
            ? "The caption track was not in the expected WebVTT format."
            : "The caption file was malformed and could not be converted.";
      return { ok: false, error: fail("parse", `${detail} Nothing was saved.`) };
    }
    throw error;
  }
  if (text.trim().length === 0) {
    return {
      ok: false,
      error: fail("parse", "The caption track contained no readable text. Nothing was saved."),
    };
  }

  const fetchedAt = deps.now().toISOString();

  // 5) Cache only complete successes.
  if (cacheEnabled) {
    saveTranscript(
      db,
      {
        videoId,
        language: selection.language,
        source: selection.kind,
        plainText: text,
      },
      fetchedAt,
    );
  }

  return {
    ok: true,
    transcript: {
      text,
      language: selection.language,
      captionSource: selection.kind,
      fetchedAt,
      fromCache: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Cached reads
// ---------------------------------------------------------------------------

/** Reads the locally cached transcript for UI rendering, or null. */
export function getCachedTranscript(db: ScopeDatabase, videoId: string): TranscriptRecord | null {
  const record = getTranscript(db, videoId);
  return record && isEnglishCaptionLanguage(record.language) ? record : null;
}
