/**
 * Typed outcomes for importing one video link. Rejections are final for that
 * link (retrying will not change the answer); retryable failures are
 * transient and worth another attempt. Messages are plain language and never
 * contain stderr or paths. No server-only imports: only types from the
 * command runner are referenced.
 */
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { NETWORK_UNREACHABLE_MESSAGE, YTDLP_MISSING_MESSAGE } from "@/lib/ytdlp/user-messages";
import type { VideoLinkErrorCode } from "./links";

export type VideoImportRejectionCode =
  | VideoLinkErrorCode
  | "unavailable_video"
  | "live_or_upcoming"
  | "no_english_captions"
  | "no_channel"
  | "unexpected_response"
  | "invalid_input";

export type VideoImportRetryableCode = "throttled" | "network" | "timeout" | "ytdlp_missing";

export type VideoImportErrorCode = VideoImportRejectionCode | VideoImportRetryableCode;

export interface VideoImportError {
  code: VideoImportErrorCode;
  /** Plain-language, UI-safe message. */
  message: string;
  /** True for transient failures a retry may fix. */
  retryable: boolean;
}

const RETRYABLE_CODES: ReadonlySet<VideoImportErrorCode> = new Set<VideoImportErrorCode>([
  "throttled",
  "network",
  "timeout",
  "ytdlp_missing",
]);

export const NO_ENGLISH_CAPTIONS_MESSAGE =
  "No original English captions are available for this video. scope currently supports English only.";

export const LIVE_OR_UPCOMING_MESSAGE =
  "Live and scheduled videos have no captions yet. Import it after it ends.";

export const NO_CHANNEL_MESSAGE = "That video did not resolve to a channel scope can save.";

export function videoImportError(code: VideoImportErrorCode, message: string): VideoImportError {
  return { code, message, retryable: RETRYABLE_CODES.has(code) };
}

/**
 * Maps a failed yt-dlp job to a typed, user-safe error. stderr is inspected
 * only for classification; its text never surfaces. `platformLabel` is the
 * site's name in user-facing wording ("YouTube", "Rumble").
 */
export function classifyVideoJobFailure(
  result: Extract<ExecFileResult, { ok: false }>,
  platformLabel: string,
): VideoImportError {
  switch (result.kind) {
    case "missing_executable":
      return videoImportError("ytdlp_missing", YTDLP_MISSING_MESSAGE);
    case "spawn_failed":
      return videoImportError("ytdlp_missing", "scope could not start yt-dlp on this machine.");
    case "timeout":
      return videoImportError(
        "timeout",
        "Looking up that video took too long and was stopped. Please try again.",
      );
    case "output_limit":
      return videoImportError(
        "unexpected_response",
        "The video data was too large to read safely.",
      );
    default:
      break;
  }

  const stderrTail = result.stderrTail.toLowerCase();
  // Transient edge throttling is distinct from an unreachable network: the
  // message tells the user to retry in a minute.
  if (/http error 403|http error 429|too many requests|forbidden/.test(stderrTail)) {
    return videoImportError(
      "throttled",
      `${platformLabel} is throttling requests right now. Wait a minute and try again.`,
    );
  }
  // yt-dlp refuses scheduled streams and premieres outright instead of
  // reporting `is_upcoming`.
  if (/live event will begin|premieres in|premiere will begin|will begin in/.test(stderrTail)) {
    return videoImportError("live_or_upcoming", LIVE_OR_UPCOMING_MESSAGE);
  }
  if (
    /video unavailable|video is unavailable|private video|has been removed|not found|404|terminated|no longer available|members[- ]only|join this channel|sign in to confirm|age.?restrict/.test(
      stderrTail,
    )
  ) {
    return videoImportError(
      "unavailable_video",
      `${platformLabel} would not serve that video (it may be private, removed, or restricted).`,
    );
  }
  if (
    /getaddrinfo|temporary failure|name or service not known|network|connection|unable to download|resolve|refused|reset by peer/.test(
      stderrTail,
    )
  ) {
    return videoImportError("network", NETWORK_UNREACHABLE_MESSAGE);
  }
  return videoImportError(
    "unexpected_response",
    "scope could not look up that video right now. Please try again later.",
  );
}
