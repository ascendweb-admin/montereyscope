/**
 * Background transcript preparation for AI analysis. Server-only.
 *
 * Transcripts are an implementation detail of analysis, never a step the
 * user performs: chats, reports, and the selection prefetch call
 * ensureTranscripts with the videos they are about to analyze, and every
 * video without a cached transcript is fetched here. Extractions share one
 * process-wide limiter so a large selection (or a chat and a report at once)
 * never fans out into dozens of yt-dlp processes and trips platform rate
 * limits; duplicate requests for the same video still collapse inside
 * resolveTranscript. Results are always cached, so a video is fetched once.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { resolveTranscript, type TranscriptErrorCode, type TranscriptOutcome } from "./service";

/** At most this many caption extractions run at once across the process. */
export const MAX_CONCURRENT_EXTRACTIONS = 3;

export interface PrepareProgress {
  /** Videos that finished (fetched or failed) so far. */
  done: number;
  /** Videos that needed a fetch when preparation started. */
  total: number;
}

export interface PreparedVideoFailure {
  videoId: string;
  code: TranscriptErrorCode;
  /** Plain-language, UI-safe message from the transcript service. */
  message: string;
}

export interface PrepareOutcome {
  /** Videos whose transcript was fetched and cached by this call. */
  fetched: string[];
  /** Videos that could not be given a transcript, in request order. */
  failed: PreparedVideoFailure[];
}

export interface PrepareOptions {
  onProgress?: (progress: PrepareProgress) => void;
  /** Stops waiting (and starting new fetches) once aborted. */
  signal?: AbortSignal;
}

type TranscriptResolver = (
  db: ScopeDatabase,
  videoId: string,
  videoUrl: string,
) => Promise<TranscriptOutcome>;

const defaultResolver: TranscriptResolver = (db, videoId, videoUrl) =>
  resolveTranscript(db, videoId, videoUrl, { intent: "get", cacheEnabled: true });

let resolverOverride: TranscriptResolver | null = null;

/** Test seam: replace the yt-dlp-backed resolver (null restores it). */
export function setTranscriptResolverForTests(resolver: TranscriptResolver | null): void {
  resolverOverride = resolver;
}

// ---------------------------------------------------------------------------
// Process-wide limiter
// ---------------------------------------------------------------------------

let running = 0;
const waiters: Array<() => void> = [];

async function withExtractionSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_EXTRACTIONS) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

interface MissingRow {
  id: string;
  url: string;
}

/** Chunked IN clauses keep us far below SQLite's host-parameter limit. */
const QUERY_CHUNK_SIZE = 500;

/** Known videos among `videoIds` that have no cached transcript, in request order. */
export function videosMissingTranscripts(
  db: ScopeDatabase,
  videoIds: readonly string[],
): MissingRow[] {
  const requested = [...new Set(videoIds)];
  const found = new Map<string, MissingRow>();
  for (let start = 0; start < requested.length; start += QUERY_CHUNK_SIZE) {
    const chunk = requested.slice(start, start + QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<[...string[]], MissingRow>(
        `SELECT v.id, v.url
         FROM videos v
         LEFT JOIN transcripts t ON t.video_id = v.id
         WHERE v.id IN (${placeholders}) AND t.video_id IS NULL`,
      )
      .all(...chunk);
    for (const row of rows) {
      found.set(row.id, row);
    }
  }
  return requested.flatMap((id) => {
    const row = found.get(id);
    return row ? [row] : [];
  });
}

function abortedError(): Error {
  const error = new Error("Transcript preparation was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Makes sure every known video in `videoIds` has a cached transcript,
 * fetching the missing ones in the background limiter. Never throws for a
 * single video's failure — failures are returned for the caller to disclose.
 * Rejects with an AbortError only when `signal` aborts.
 */
export async function ensureTranscripts(
  db: ScopeDatabase,
  videoIds: readonly string[],
  options: PrepareOptions = {},
): Promise<PrepareOutcome> {
  const missing = videosMissingTranscripts(db, videoIds);
  if (missing.length === 0) {
    return { fetched: [], failed: [] };
  }
  const resolver = resolverOverride ?? defaultResolver;
  const total = missing.length;
  let done = 0;
  options.onProgress?.({ done, total });

  const results = new Map<string, PreparedVideoFailure | null>();
  const work = Promise.all(
    missing.map((video) =>
      withExtractionSlot(async () => {
        if (options.signal?.aborted) {
          return;
        }
        let failure: PreparedVideoFailure | null = null;
        try {
          const outcome = await resolver(db, video.id, video.url);
          if (!outcome.ok) {
            failure = {
              videoId: video.id,
              code: outcome.error.code,
              message: outcome.error.message,
            };
          }
        } catch (error) {
          console.error("[transcripts/prepare] extraction failed unexpectedly:", error);
          failure = {
            videoId: video.id,
            code: "unexpected_response",
            message: "scope could not read captions for this video right now.",
          };
        }
        results.set(video.id, failure);
        done += 1;
        options.onProgress?.({ done, total });
      }),
    ),
  );

  if (options.signal) {
    const signal = options.signal;
    if (signal.aborted) {
      throw abortedError();
    }
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(abortedError()), { once: true });
      }),
    ]);
  } else {
    await work;
  }

  const fetched: string[] = [];
  const failed: PreparedVideoFailure[] = [];
  for (const video of missing) {
    const failure = results.get(video.id);
    if (failure) {
      failed.push(failure);
    } else if (failure === null) {
      fetched.push(video.id);
    }
  }
  return { fetched, failed };
}

/**
 * Starts preparing transcripts without waiting — used when a user picks
 * sources, so captions download while they type their question. A chat
 * that starts meanwhile joins the same in-flight extractions.
 */
export function prefetchTranscripts(db: ScopeDatabase, videoIds: readonly string[]): number {
  const missing = videosMissingTranscripts(db, videoIds);
  if (missing.length > 0) {
    void ensureTranscripts(
      db,
      missing.map((video) => video.id),
    ).catch((error: unknown) => {
      console.error("[transcripts/prepare] prefetch failed:", error);
    });
  }
  return missing.length;
}

/** Short, user-facing reason a video was left out of an analysis. */
export function failureReason(failure: PreparedVideoFailure): string {
  switch (failure.code) {
    case "no_captions":
    case "language_choice":
      return "no English captions";
    case "unavailable_video":
      return "private, removed, or restricted";
    case "throttled":
      return "the platform is rate-limiting requests";
    case "timeout":
      return "took too long";
    case "network":
      return "network trouble";
    case "ytdlp_missing":
      return "yt-dlp is missing";
    default:
      return "captions couldn't be read";
  }
}

/**
 * One-line disclosure naming the videos an analysis had to leave out,
 * e.g. `Left out 2 videos scope couldn't read captions for: “A” (no English
 * captions), “B” (took too long).` Empty string when nothing failed.
 */
export function describePreparationFailures(
  failures: readonly PreparedVideoFailure[],
  titleFor: (videoId: string) => string,
): string {
  if (failures.length === 0) {
    return "";
  }
  const items = failures
    .map((failure) => `“${titleFor(failure.videoId)}” (${failureReason(failure)})`)
    .join(", ");
  const count = failures.length;
  return `Left out ${count} ${count === 1 ? "video" : "videos"} scope couldn't read captions for: ${items}.`;
}
