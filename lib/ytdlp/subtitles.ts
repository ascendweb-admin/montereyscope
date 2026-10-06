/**
 * Version-sensitive yt-dlp invocations for transcript extraction (stage 4).
 * Server-only. Every flag choice for caption work lives here so behavior
 * stays pinned to the verified yt-dlp CLI (2026.08.19) in one place:
 *
 * - Discovery simulates English caption selection and
 *   prints only the video id and language codes. Full caption maps can exceed
 *   the output limit on videos with many translated tracks. No files are written.
 * - The caption job runs `--skip-download` with exactly one of
 *   `--write-subs` / `--write-auto-subs`, an exact `--sub-langs` code chosen
 *   from discovery, and `--sub-format vtt` — a format YouTube serves natively
 *   for both human and automatic tracks (verified against the installed
 *   binary), so no ffmpeg conversion is involved.
 * - The job writes into a unique OS temporary directory (`%(id)s` template)
 *   and the resulting artifact is discovered by scanning that directory —
 *   never assumed from a filename pattern.
 *
 * Temporary directories are always removed in `finally`, on success,
 * failure, timeout, and cancellation alike.
 */
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCommand } from "./runner";
import type { ExecFileResult } from "./runner";

type YtDlpCommandFailure = Extract<ExecFileResult, { ok: false }>;

// ---------------------------------------------------------------------------
// Track selection (pure)
// ---------------------------------------------------------------------------

export type SubtitleTrackKind = "manual" | "automatic";

export interface SubtitleTrackSelection {
  kind: SubtitleTrackKind;
  /** Exact English track code as reported by yt-dlp ("en", "en-US", "en-orig"). */
  language: string;
}

/** Available caption languages grouped by track kind. Sorted, `live_chat` removed. */
export interface AvailableSubtitles {
  manual: string[];
  automatic: string[];
}

/** English and its regional/original-track variants; excludes other languages. */
export function isEnglishCaptionLanguage(language: string): boolean {
  return /^en(?:-[a-z0-9]{2,8})*$/i.test(language);
}

/** Human-written English first, then original English automatic captions. */
export function selectEnglishSubtitleTrack(
  available: AvailableSubtitles,
): SubtitleTrackSelection | null {
  for (const kind of ["manual", "automatic"] as const) {
    const candidates = available[kind].filter(isEnglishCaptionLanguage).sort((a, b) => {
      const rank = (code: string) => {
        const lower = code.toLowerCase();
        if (lower === "en-orig") return 0;
        if (lower.endsWith("-orig")) return 1;
        if (lower === "en") return 2;
        return 3;
      };
      return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b);
    });
    if (candidates[0]) return { kind, language: candidates[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery job
// ---------------------------------------------------------------------------

/**
 * Builds the argument array for single-video metadata discovery.
 * Pure — exported so tests can pin the exact flags without spawning yt-dlp.
 */
export function buildSubtitleDiscoveryArgs(videoUrl: string): string[] {
  // yt-dlp's `l` conversion iterates dictionary keys, omitting all track URLs
  // and formats. Translated tracks are excluded by the YouTube extractor below.
  const template =
    '{"id":%(id)j,"subtitles":"%(subtitles|)l","automatic_captions":"%(automatic_captions|)l"}';
  return [
    "--print",
    template,
    "--ignore-config",
    "--no-playlist",
    "--simulate",
    "--skip-download",
    "--extractor-args",
    "youtube:skip=translated_subs",
    "--write-subs",
    "--write-auto-subs",
    "--sub-langs",
    "(?i:en(?:-.*)?)",
    "--sub-format",
    "vtt",
    "--no-warnings",
    "--no-progress",
    videoUrl,
  ];
}

interface RawFormatEntry {
  ext?: unknown;
}

function languageKeysOf(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((code) => code.trim())
      .filter((code) => /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i.test(code))
      .sort((a, b) => a.localeCompare(b));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key, formats]) => {
      // live_chat is a replay pseudo-track, not captions.
      if (key === "live_chat") {
        return false;
      }
      return Array.isArray(formats) && (formats as RawFormatEntry[]).length > 0;
    })
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Parses a discovery payload into the available caption languages.
 * Throws TypeError-shaped errors via Result below — kept total by wrapping.
 */
export function parseDiscoveryPayload(
  stdout: string,
): { ok: true; available: AvailableSubtitles; videoId: string } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false };
  }
  const record = parsed as Record<string, unknown>;
  const videoId = typeof record.id === "string" ? record.id : "";
  if (!videoId) {
    return { ok: false };
  }
  return {
    ok: true,
    videoId,
    available: {
      manual: languageKeysOf(record.subtitles),
      automatic: languageKeysOf(record.automatic_captions),
    },
  };
}

export interface YtDlpJobDeps {
  command: string;
  run: typeof runCommand;
}

const DISCOVERY_TIMEOUT_MS = 45_000;
const DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * True when a yt-dlp failure's stderr shows a transient platform throttle
 * (HTTP 403/429). Rumble's edge serves these intermittently under request
 * pressure; YouTube's own rate limits can too. One paced retry heals the
 * common case without masking genuine errors.
 */
export function isThrottledStderr(stderrTail: string): boolean {
  return /http error 403|http error 429|too many requests|forbidden/.test(stderrTail.toLowerCase());
}

/** One retry of a yt-dlp job when the platform throttled the first attempt. */
export async function runJobWithThrottleRetry(
  deps: YtDlpJobDeps & { throttleRetryMs?: number },
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number },
): Promise<ExecFileResult> {
  const first = await deps.run(deps.command, args, options);
  if (first.ok || !isThrottledStderr(first.stderrTail)) {
    return first;
  }
  await new Promise((resolve) => setTimeout(resolve, deps.throttleRetryMs ?? 20_000));
  return deps.run(deps.command, args, options);
}

/**
 * Runs the discovery job through the shared runner and parses the result.
 * Returns the raw failure for upstream classification when yt-dlp itself
 * fails, or a typed parse failure when the payload is not usable JSON.
 */
export async function discoverAvailableSubtitles(
  videoUrl: string,
  overrides: Partial<YtDlpJobDeps & { throttleRetryMs?: number }> = {},
): Promise<
  | { ok: true; available: AvailableSubtitles; videoId: string }
  | { ok: false; reason: "command"; result: Extract<ExecFileResult, { ok: false }> }
  | { ok: false; reason: "unusable_payload" }
> {
  const deps: YtDlpJobDeps & { throttleRetryMs?: number } = {
    command: process.env.SCOPE_YTDLP_PATH ?? process.env.LOCALTUBE_YTDLP_PATH ?? "yt-dlp",
    run: runCommand,
    ...overrides,
  };
  const result = await runJobWithThrottleRetry(deps, buildSubtitleDiscoveryArgs(videoUrl), {
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    maxOutputBytes: DISCOVERY_MAX_OUTPUT_BYTES,
  });
  if (!result.ok) {
    return { ok: false, reason: "command", result };
  }
  const parsed = parseDiscoveryPayload(result.stdout);
  return parsed.ok ? parsed : { ok: false, reason: "unusable_payload" };
}

// ---------------------------------------------------------------------------
// Caption download job
// ---------------------------------------------------------------------------

/**
 * Builds the argument array for the caption-only download of one selected
 * track. Pure — exported so tests can pin the exact flags.
 */
export function buildCaptionDownloadArgs(
  videoUrl: string,
  selection: SubtitleTrackSelection,
  outputDirectory: string,
): string[] {
  if (!isEnglishCaptionLanguage(selection.language)) {
    throw new TypeError("Scope currently supports English captions only.");
  }
  // Exactly one write flag, matching the selection kind decided upstream.
  const writeFlag = selection.kind === "manual" ? "--write-subs" : "--write-auto-subs";
  return [
    "--skip-download",
    "--ignore-config",
    "--no-playlist",
    "--extractor-args",
    "youtube:skip=translated_subs",
    writeFlag,
    "--sub-langs",
    selection.language,
    // WebVTT is served natively by YouTube for both track kinds; strict
    // single-format keeps the artifact predictable for the parser.
    "--sub-format",
    "vtt",
    "--no-warnings",
    "--no-progress",
    "-o",
    path.join(outputDirectory, "%(id)s"),
    videoUrl,
  ];
}

export interface CaptionJobOptions extends Partial<YtDlpJobDeps> {
  timeoutMs?: number;
  maxOutputBytes?: number;
  artifactMaxBytes?: number;
  /** Pause before the single throttle retry; tests inject a small value. */
  throttleRetryMs?: number;
}

export const DEFAULT_CAPTION_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTION_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;

export type CaptionJobFailureReason =
  | "command_failed"
  | "temp_directory"
  | "artifact_not_found"
  | "artifact_ambiguous"
  | "artifact_too_large";

export type CaptionJobResult =
  | { ok: true; vtt: string; artifactName: string }
  | { ok: false; reason: "command_failed"; commandResult: YtDlpCommandFailure }
  | { ok: false; reason: Exclude<CaptionJobFailureReason, "command_failed"> };

const CAPTION_TMP_PREFIX = "localtube-captions-";

/**
 * True for files yt-dlp legitimately produces for a vtt subtitle request.
 * `.part` files only exist mid-download and must never be read.
 */
function isSubtitleArtifact(name: string): boolean {
  return name.endsWith(".vtt") && !name.endsWith(".vtt.part");
}

/**
 * Downloads one selected caption track as WebVTT text.
 *
 * The job runs inside a unique temporary directory created for this call;
 * that directory is always removed before returning — success, yt-dlp
 * failure, timeout, and thrown errors all go through the same finally.
 * The returned text is the file content only; no local paths escape.
 */
export async function downloadCaptionTrack(
  videoUrl: string,
  selection: SubtitleTrackSelection,
  options: CaptionJobOptions = {},
): Promise<CaptionJobResult> {
  const command =
    options.command ?? process.env.SCOPE_YTDLP_PATH ?? process.env.LOCALTUBE_YTDLP_PATH ?? "yt-dlp";
  const run = options.run ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CAPTION_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_CAPTION_MAX_OUTPUT_BYTES;
  const artifactMaxBytes = options.artifactMaxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;

  let jobDir: string | null = null;
  try {
    try {
      jobDir = await mkdtemp(path.join(tmpdir(), CAPTION_TMP_PREFIX));
    } catch {
      return { ok: false, reason: "temp_directory" };
    }

    const result = await runJobWithThrottleRetry(
      { command, run, throttleRetryMs: options.throttleRetryMs },
      buildCaptionDownloadArgs(videoUrl, selection, jobDir),
      { timeoutMs, maxOutputBytes },
    );
    if (!result.ok) {
      return { ok: false, reason: "command_failed", commandResult: result };
    }

    // Never assume the filename: discover what yt-dlp actually wrote inside
    // the unique job directory and validate it is the expected artifact kind.
    let entries: string[];
    try {
      entries = await readdir(/* turbopackIgnore: true */ jobDir);
    } catch {
      return { ok: false, reason: "artifact_not_found" };
    }
    const artifacts = entries.filter(isSubtitleArtifact).sort();
    if (artifacts.length === 0) {
      return { ok: false, reason: "artifact_not_found" };
    }
    if (artifacts.length > 1) {
      return { ok: false, reason: "artifact_ambiguous" };
    }

    const artifactPath = path.join(/* turbopackIgnore: true */ jobDir, artifacts[0]);
    let statResult;
    try {
      statResult = await stat(/* turbopackIgnore: true */ artifactPath);
    } catch {
      return { ok: false, reason: "artifact_not_found" };
    }
    if (!statResult.isFile()) {
      return { ok: false, reason: "artifact_not_found" };
    }
    if (statResult.size > artifactMaxBytes) {
      return { ok: false, reason: "artifact_too_large" };
    }

    let vtt: string;
    try {
      vtt = await readFile(/* turbopackIgnore: true */ artifactPath, "utf8");
    } catch {
      return { ok: false, reason: "artifact_not_found" };
    }
    return { ok: true, vtt, artifactName: artifacts[0] };
  } finally {
    if (jobDir) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
