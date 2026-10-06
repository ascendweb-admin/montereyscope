/**
 * Version-sensitive yt-dlp invocation for creator channel feed tabs.
 * Server-only. All flag choices for feed extraction live here so behavior
 * stays pinned to the researched yt-dlp CLI (2026.08.19) in one place:
 *
 * - `--flat-playlist` keeps extraction cheap: entries arrive as URL-type
 *   stubs (title, duration, timestamp, live_status, thumbnails) and no
 *   video/audio is ever downloaded or resolved per-entry.
 * - `--playlist-items 1:N` bounds the refresh to the configured recent-item
 *   limit instead of walking the whole tab.
 * - `--extractor-args "youtubetab:approximate_date"` is required on this
 *   yt-dlp version for flat entries to carry a `timestamp` at all; without
 *   it every entry's timestamp is null. Dates are approximations derived
 *   from YouTube's relative time text ("1 week ago").
 * - Tab URLs are the canonical channel URL plus `/videos` or `/streams`.
 *
 * Never add download-enabling flags here.
 */
import { runCommand, type ExecFileResult } from "./runner";

export type ChannelFeedTab = "videos" | "streams";

/** Per-tab yt-dlp timeout floor; two tabs refresh sequentially per creator. */
export const DEFAULT_FEED_TIMEOUT_MS = 60_000;
// ~300 flat entries stay well under a megabyte; the cap guards pathological
// output.
export const DEFAULT_FEED_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Hard bounds for the recent-items-per-tab window passed to --playlist-items. */
export const FEED_LIMIT_MIN = 5;
export const FEED_LIMIT_MAX = 300;

export interface ChannelFeedDeps {
  command: string;
  run: typeof runCommand;
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Builds the argument array for a bounded flat-tab extraction.
 * Pure — exported so tests can pin the exact flags without spawning yt-dlp.
 */
export function buildChannelFeedArgs(
  channelUrl: string,
  tab: ChannelFeedTab,
  limit: number,
): string[] {
  const boundedLimit = clampFeedLimit(limit);
  return [
    "--flat-playlist",
    "--dump-single-json",
    "--playlist-items",
    `1:${boundedLimit}`,
    // Flat entries omit timestamps entirely unless this extractor arg is set
    // (verified against yt-dlp 2026.08.19).
    "--extractor-args",
    "youtubetab:approximate_date",
    "--no-warnings",
    "--no-progress",
    `${channelUrl.replace(/\/+$/, "")}/${tab}`,
  ];
}

export function clampFeedLimit(value: number): number {
  if (!Number.isFinite(value)) {
    value = FEED_LIMIT_MIN;
  }
  return Math.min(FEED_LIMIT_MAX, Math.max(FEED_LIMIT_MIN, Math.round(value)));
}

/**
 * Per-tab yt-dlp timeout, scaled to the window: a flat tab paginates in
 * ~30-entry continuation requests, so deep windows legitimately take several
 * times longer than the default one. +30 s per full 100 items beyond the
 * first (60 s up to 100, 90 s to 200, 120 s to 300).
 */
export function feedTimeoutMsFor(limit: number): number {
  const extraSteps = Math.max(0, Math.ceil(clampFeedLimit(limit) / 100) - 1);
  return DEFAULT_FEED_TIMEOUT_MS + extraSteps * 30_000;
}

/**
 * Runs yt-dlp for one channel tab through the shared runner (concurrency
 * gate, hard timeout, output cap). Returns the raw discriminated result;
 * parsing/classification happens upstream.
 */
export async function fetchChannelFeedTab(
  channelUrl: string,
  tab: ChannelFeedTab,
  limit: number,
  overrides: Partial<ChannelFeedDeps> = {},
): Promise<ExecFileResult> {
  const deps: ChannelFeedDeps = {
    command: process.env.SCOPE_YTDLP_PATH ?? process.env.LOCALTUBE_YTDLP_PATH ?? "yt-dlp",
    run: runCommand,
    timeoutMs: feedTimeoutMsFor(limit),
    maxOutputBytes: DEFAULT_FEED_MAX_OUTPUT_BYTES,
    ...overrides,
  };
  return deps.run(deps.command, buildChannelFeedArgs(channelUrl, tab, limit), {
    timeoutMs: deps.timeoutMs,
    maxOutputBytes: deps.maxOutputBytes,
  });
}

/**
 * True when yt-dlp reports that this channel simply has no such tab
 * (e.g. "This channel does not have a streams tab"). That is an expected,
 * legitimate empty result — not a failure.
 */
export function isEmptyTabStderr(stderrTail: string, tab: ChannelFeedTab): boolean {
  const normalized = stderrTail.toLowerCase();
  if (tab === "streams") {
    return /does not have a streams tab/.test(normalized);
  }
  return /does not have a videos tab/.test(normalized);
}
