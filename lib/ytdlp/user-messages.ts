/**
 * Canonical user-facing sentences for failures shared by every yt-dlp-backed
 * operation (creator resolution, feed refresh, transcript extraction).
 * Importing these keeps wording identical across surfaces — the UI never
 * paraphrases tool errors. Messages are UI-safe: no stderr, no paths.
 */

export const YTDLP_MISSING_MESSAGE =
  "yt-dlp was not found on this machine. Install it or point SCOPE_YTDLP_PATH at the executable.";

export const NETWORK_UNREACHABLE_MESSAGE =
  "Could not reach the video platform. Check your internet connection and try again.";
