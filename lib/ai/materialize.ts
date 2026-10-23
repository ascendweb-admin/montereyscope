/**
 * Transcript materialization for AI analysis jobs (stage 1). Server-only.
 *
 * Writes the cached transcripts for a requested video batch to one plain-text
 * file per video inside a fresh job directory (data/ai-jobs/<jobId>/), plus a
 * manifest.json at the job root recording the scope and what was written.
 * Only locally cached data is used: videos without a cached transcript (and
 * unknown ids) are excluded from the output and recorded in the manifest.
 * manifest.json is written last, so its presence signals a complete job.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TranscriptSource } from "@/lib/transcripts/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { sourceKey, type ContentKind, type SourceRef } from "@/lib/content/model";

import { estimateScopeLoad, type ScopeLoad } from "./scope-selection";

import {
  resolveScope,
  resolveSourceScope,
  type ScopeResolution,
  type ScopedSource,
  type ScopedVideo,
} from "./scope";

/** One materialized transcript file, as recorded in the manifest. */
export interface MaterializedTranscriptFile {
  videoId: string;
  /** Path of the file relative to the job directory. */
  file: string;
  language: string;
  source: TranscriptSource;
  /** True when the file was cut short to fit the byte budget. */
  truncated: boolean;
}

export type ExclusionReason = "unknown_video" | "missing_transcript" | "byte_budget_exhausted";

/** Marker appended to a truncated transcript file, so readers (and the
 * model) can tell the text was cut, not finished. */
export const TRUNCATION_MARKER =
  "[scope: this transcript was truncated to fit the analysis byte budget; text after this point is missing.]";

/** Record of how the byte budget shaped one job. Null when nothing was cut. */
export interface MaterializeTruncation {
  /** The budget that was applied, in bytes. */
  limitBytes: number;
  /** Total bytes actually written across all transcript files. */
  writtenBytes: number;
  /** Videos whose transcript file was written but cut short, in order. */
  truncatedVideoIds: string[];
  /** Videos whose transcript was not written at all — the budget ran out
   * before their file could start, in request order. */
  skippedVideoIds: string[];
}

/** A requested video that has no file in this job, with the reason. */
export interface ExcludedVideo {
  videoId: string;
  reason: ExclusionReason;
}

/** Self-contained record of one materialization job. */
export interface MaterializeManifest {
  jobId: string;
  /** ISO 8601 creation timestamp of the job. */
  createdAt: string;
  scope: ScopeResolution;
  /** One entry per transcript file written, in request order. */
  transcripts: MaterializedTranscriptFile[];
  /** Requested videos excluded from the job, with the reason. */
  excluded: ExcludedVideo[];
  /** How the byte budget shaped the job; null when everything fit. */
  truncation: MaterializeTruncation | null;
}

export interface MaterializeOutcome {
  /** Absolute path of the job directory created for this run. */
  jobDir: string;
  manifest: MaterializeManifest;
}

export interface MaterializeOptions {
  /** Root under which job directories are created. Defaults to <cwd>/data/ai-jobs. */
  jobsRoot?: string;
  /** Defaults to a timestamped, collision-resistant id. */
  jobId?: string;
  /**
   * Total byte budget across all transcript files in the job. Defaults to
   * DEFAULT_MAX_MATERIALIZED_BYTES, overridable with
   * SCOPE_AI_MAX_MATERIALIZED_BYTES.
   */
  maxTotalBytes?: number;
  /** Injectable clock for deterministic manifests and job ids. */
  now?: () => Date;
}

interface TranscriptTextRow {
  video_id: string;
  url: string;
  language: string;
  source: TranscriptSource;
  plain_text: string;
}

/** Chunked IN clauses keep us far below SQLite's host-parameter limit. */
const QUERY_CHUNK_SIZE = 500;

function loadTranscriptTexts(
  db: ScopeDatabase,
  videoIds: readonly string[],
): Map<string, TranscriptTextRow> {
  const texts = new Map<string, TranscriptTextRow>();
  for (let start = 0; start < videoIds.length; start += QUERY_CHUNK_SIZE) {
    const chunk = videoIds.slice(start, start + QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<[...string[]], TranscriptTextRow>(
        `SELECT v.id AS video_id, v.url, t.language, t.source, t.plain_text
         FROM videos v
         JOIN transcripts t ON t.video_id = v.id
         WHERE v.id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const row of rows) {
      texts.set(row.video_id, row);
    }
  }
  return texts;
}

const TRANSCRIPTS_DIR_NAME = "transcripts";
const TWEETS_DIR_NAME = "tweets";

/**
 * Default total byte budget for one job's materialized transcripts. Large
 * selections otherwise inflate every Codex prompt (and its token cost); the
 * budget keeps a job's input bounded while still covering up to the
 * selection cap's worth of typical transcripts.
 */
export const DEFAULT_MAX_MATERIALIZED_BYTES = 4_000_000;

/** Environment override for the byte budget; mirrors SCOPE_AI_JOBS_ROOT. */
export function maxMaterializedBytes(): number {
  const raw =
    process.env.SCOPE_AI_MAX_MATERIALIZED_BYTES ?? process.env.LOCALTUBE_AI_MAX_MATERIALIZED_BYTES;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    console.warn(`[ai/materialize] ignoring non-positive SCOPE_AI_MAX_MATERIALIZED_BYTES: ${raw}`);
  }
  return DEFAULT_MAX_MATERIALIZED_BYTES;
}

function renderTranscriptFile(video: ScopedVideo, transcript: TranscriptTextRow): string {
  const header = [
    `Title: ${video.title}`,
    `Creator: ${video.creator}`,
    ...(video.channel ? [`Channel: ${video.channel}`] : []),
    ...(video.featuring.length > 0 ? [`Featuring: ${video.featuring.join(", ")}`] : []),
    `URL: ${transcript.url}`,
    `Published: ${video.publishedAt ?? "unknown"}`,
    `Language: ${transcript.language}`,
    `Caption source: ${transcript.source}`,
  ].join("\n");
  const body = transcript.plain_text.endsWith("\n")
    ? transcript.plain_text
    : `${transcript.plain_text}\n`;
  return `${header}\n\n${body}`;
}

/** Timestamped, collision-resistant job id, e.g. 20260827T183000Z-1f2e3d4a5b6c. */
function defaultJobId(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(6).toString("hex")}`;
}

/**
 * Materializes the cached transcripts for the requested videos into a fresh
 * job directory and returns its path with the manifest. Repeated ids are
 * collapsed by resolveScope. A job is created even when nothing can be
 * materialized — the manifest records why every requested video is absent.
 *
 * The total bytes written across transcript files is capped (see
 * MaterializeOptions.maxTotalBytes): the first file that crosses the budget
 * is cut short with a truncation marker, and everything after it is skipped
 * and recorded. The manifest's `truncation` field reports what happened.
 */
export function materializeTranscripts(
  db: ScopeDatabase,
  videoIds: readonly string[],
  options: MaterializeOptions = {},
): MaterializeOutcome {
  const now = options.now ?? (() => new Date());
  const jobsRoot = options.jobsRoot ?? path.join(process.cwd(), "data", "ai-jobs");
  const jobId = options.jobId ?? defaultJobId(now());
  const maxTotalBytes = options.maxTotalBytes ?? maxMaterializedBytes();

  const scope = resolveScope(db, videoIds);
  const withTranscript = scope.videos.filter((video) => video.hasTranscript);
  const texts = loadTranscriptTexts(
    db,
    withTranscript.map((video) => video.id),
  );

  const jobDir = path.join(/* turbopackIgnore: true */ jobsRoot, jobId);
  const transcriptsDir = path.join(jobDir, TRANSCRIPTS_DIR_NAME);
  mkdirSync(transcriptsDir, { recursive: true });

  const transcripts: MaterializedTranscriptFile[] = [];
  const truncatedVideoIds: string[] = [];
  const budgetSkippedVideoIds: string[] = [];
  let writtenBytes = 0;
  for (const video of scope.videos) {
    const text = texts.get(video.id);
    if (!video.hasTranscript || !text) {
      continue;
    }
    const rendered = renderTranscriptFile(video, text);
    const remaining = maxTotalBytes - writtenBytes;
    if (remaining <= 0) {
      budgetSkippedVideoIds.push(video.id);
      continue;
    }
    // Byte-accurate cutting: character slices can overshoot the budget on
    // multibyte text, so truncation happens on the utf-8 buffer.
    const full = Buffer.from(rendered, "utf8");
    let file = full;
    let truncated = false;
    if (full.byteLength > remaining) {
      const marker = Buffer.from(`\n\n${TRUNCATION_MARKER}\n`, "utf8");
      const markerBytes = Math.min(marker.byteLength, remaining);
      file = full.subarray(0, Math.max(0, remaining - markerBytes));
      if (file.byteLength === 0) {
        budgetSkippedVideoIds.push(video.id);
        continue;
      }
      file = Buffer.concat([file, marker.subarray(0, markerBytes)]);
      truncated = true;
    }
    const fileName = `${video.id}.txt`;
    writeFileSync(path.join(transcriptsDir, fileName), file);
    writtenBytes += file.byteLength;
    if (truncated) {
      truncatedVideoIds.push(video.id);
    }
    transcripts.push({
      videoId: video.id,
      file: `${TRANSCRIPTS_DIR_NAME}/${fileName}`,
      language: text.language,
      source: text.source,
      truncated,
    });
  }

  const excluded: ExcludedVideo[] = [
    ...scope.unknownVideoIds.map((videoId) => ({ videoId, reason: "unknown_video" as const })),
    ...scope.missingTranscriptVideoIds.map((videoId) => ({
      videoId,
      reason: "missing_transcript" as const,
    })),
    ...budgetSkippedVideoIds.map((videoId) => ({
      videoId,
      reason: "byte_budget_exhausted" as const,
    })),
  ];

  const truncation: MaterializeTruncation | null =
    truncatedVideoIds.length === 0 && budgetSkippedVideoIds.length === 0
      ? null
      : {
          limitBytes: maxTotalBytes,
          writtenBytes,
          truncatedVideoIds,
          skippedVideoIds: budgetSkippedVideoIds,
        };

  const manifest: MaterializeManifest = {
    jobId,
    createdAt: now().toISOString(),
    scope,
    transcripts,
    excluded,
    truncation,
  };
  // Written last: a manifest.json in place means every listed file is on disk.
  writeFileSync(
    path.join(jobDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { jobDir, manifest };
}

/**
 * Small interface so later stages can materialize transcripts without
 * touching the database or filesystem directly, and mock it in their tests.
 */
export interface TranscriptMaterializer {
  materializeTranscripts(videoIds: readonly string[]): MaterializeOutcome;
}

export function createTranscriptMaterializer(
  db: ScopeDatabase,
  options: MaterializeOptions = {},
): TranscriptMaterializer {
  return { materializeTranscripts: (videoIds) => materializeTranscripts(db, videoIds, options) };
}

// ---------------------------------------------------------------------------
// Mixed-source materialization (v2): videos and X posts
// ---------------------------------------------------------------------------

/**
 * Writes one file per ready video — `transcripts/<videoId>.txt`, unchanged so
 * older instructions keep resolving — and bundles X posts per saved account
 * into `tweets/<handle>.txt` (more files for long timelines), newest first,
 * each post headed by the `[tweets/<tweetId>.txt]` id answers cite it by. A
 * file per post made the model open hundreds of files: Claude, which has no
 * shell, read a third fewer posts that way. The versioned manifest records
 * every requested source, its file, readiness, and exclusions. Only locally
 * cached data is used; nothing here contacts X.
 */
export type SourceExclusionReason =
  "unknown_source" | "missing_transcript" | "missing_text" | "byte_budget_exhausted";

export interface MaterializedSourceFile {
  kind: ContentKind;
  id: string;
  title: string;
  creator: string;
  url: string;
  publishedAt: string | null;
  platform: string;
  /** Path relative to the job directory, or null when excluded. Posts share their bundle's path. */
  file: string | null;
  sha256?: string;
  readyForAnalysis: boolean;
  truncated: boolean;
  exclusionReason: SourceExclusionReason | null;
  /** Video only: length in seconds, when known. */
  durationSeconds?: number | null;
  /**
   * Video only, left out when empty: the people the video features without
   * owning its channel, as the transcript's `Featuring:` line lists them. With
   * `creator` (the hosting channel) it lets a saved thread cite the video as
   * "{person} on {channel}" after the live library changes.
   */
  featuring?: string[];
}

/** A long video's summary, added to the job before the run (lib/ai/digests.ts). */
export interface MaterializedDigest {
  videoId: string;
  /** `digests/<videoId>.txt`, relative to the job directory. */
  file: string;
  sha256: string;
}

export interface SourceTruncation {
  limitBytes: number;
  writtenBytes: number;
  /** `${kind}:${id}` keys of files that were cut short, in order. */
  truncatedSourceKeys: string[];
  /** `${kind}:${id}` keys not written at all because the budget ran out. */
  skippedSourceKeys: string[];
}

export interface SourceMaterializationManifest {
  version: 2;
  jobId: string;
  createdAt: string;
  sources: MaterializedSourceFile[];
  excluded: Array<{ kind: ContentKind; id: string; reason: SourceExclusionReason }>;
  truncation: SourceTruncation | null;
  /** Estimated size of what was written, as the selection meter measures it. */
  load?: ScopeLoad;
  /** Summaries of long videos added for selections too big to read in one pass. */
  digests?: MaterializedDigest[];
}

export interface SourceMaterializeOutcome {
  jobDir: string;
  manifest: SourceMaterializationManifest;
}

interface TweetTextRow {
  id: string;
  author_name: string;
  author_handle: string;
  url: string;
  text: string;
  published_at: string | null;
  fetched_at: string;
  content_status: string;
  is_repost: number;
  reposted_by_handle: string | null;
  in_reply_to_handle: string | null;
  quoted_handle: string | null;
  quoted_name: string | null;
  quoted_text: string | null;
  media_json: string | null;
}

function loadTweetTexts(db: ScopeDatabase, tweetIds: readonly string[]): Map<string, TweetTextRow> {
  const texts = new Map<string, TweetTextRow>();
  for (let start = 0; start < tweetIds.length; start += QUERY_CHUNK_SIZE) {
    const chunk = tweetIds.slice(start, start + QUERY_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<[...string[]], TweetTextRow>(
        `SELECT id, author_name, author_handle, url, text, published_at, fetched_at,
                content_status, is_repost, reposted_by_handle, in_reply_to_handle,
                quoted_handle, quoted_name, quoted_text, media_json
         FROM tweets WHERE id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const row of rows) {
      texts.set(row.id, row);
    }
  }
  return texts;
}

/**
 * Largest post bundle file. Codex shows a tool output of ~10k tokens before
 * truncating it and Claude reads up to 25k tokens per file, so ~6k-token
 * bundles always arrive whole in one read.
 */
export const POST_BUNDLE_MAX_BYTES = 24_000;

/** Room kept for a bundle's header lines when checking the byte budget. */
const BUNDLE_HEADER_RESERVE_BYTES = 200;

function postStamp(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "date unknown";
}

function mediaCount(mediaJson: string | null): number {
  if (!mediaJson) return 0;
  try {
    const media: unknown = JSON.parse(mediaJson);
    return Array.isArray(media) ? media.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Renders one cached X post as a block of a bundle: a one-line header with
 * the citation id, author, date, kind, and URL, then the text. Quoted
 * material is context, labelled apart from the author's own words so the
 * model never attributes it to them.
 */
export function renderPostBlock(row: TweetTextRow): string {
  const kind =
    Number(row.is_repost) === 1 && row.reposted_by_handle
      ? `repost by @${row.reposted_by_handle}`
      : row.in_reply_to_handle
        ? `reply to @${row.in_reply_to_handle}`
        : row.quoted_text
          ? "quote"
          : "post";
  const lines = [
    `[tweets/${row.id}.txt] ${row.author_name} (@${row.author_handle}) · ${postStamp(row.published_at)} · ${kind} · ${row.url}`,
    row.text.trim(),
  ];
  if (row.quoted_text) {
    const attribution = row.quoted_handle
      ? `Quoted post by @${row.quoted_handle}${row.quoted_name ? ` (${row.quoted_name})` : ""}:`
      : "Quoted post:";
    lines.push(
      attribution,
      ...row.quoted_text
        .trim()
        .split(/\r?\n/)
        .map((line) => `> ${line}`),
    );
  }
  const media = mediaCount(row.media_json);
  if (media > 0) {
    lines.push(`(${media} media attachment${media === 1 ? "" : "s"}: only the text was analyzed)`);
  }
  return lines.join("\n");
}

function renderPostBundle(
  account: { person: string; channel: string },
  blocks: readonly string[],
  part: number,
  parts: number,
): string {
  const header = [
    "Type: X posts, newest first",
    `Creator: ${account.person}`,
    `Channel: ${account.channel}`,
    `Posts: ${blocks.length}${parts > 1 ? ` (file ${part} of ${parts})` : ""}`,
  ];
  return `${header.join("\n")}\n\n${blocks.join("\n\n")}\n`;
}

/** A bundle's base file name: the saved account's handle, filesystem-safe. */
function bundleBaseName(source: ScopedSource, used: ReadonlySet<string>): string {
  const handle = (source.accountHandle ?? "").replace(/^@/, "").replace(/[^A-Za-z0-9_]/g, "_");
  const base = handle.length > 0 ? handle : `account-${source.creatorId}`;
  return used.has(base) ? `${base}-${source.creatorId}` : base;
}

/** Newest first; undated posts last, in request order. */
function newestFirst(a: TweetTextRow, b: TweetTextRow): number {
  if (a.published_at === b.published_at) return 0;
  if (a.published_at === null) return 1;
  if (b.published_at === null) return -1;
  return a.published_at < b.published_at ? 1 : -1;
}

/**
 * Materializes the cached content for requested source references into a
 * fresh job directory. Videos and posts are written into separate folders,
 * readiness is measured per kind, and the total bytes written across all
 * files is capped by the same budget the video-only path uses — videos
 * first, then posts, whole posts only.
 */
export function materializeSources(
  db: ScopeDatabase,
  refs: readonly SourceRef[],
  options: MaterializeOptions = {},
): SourceMaterializeOutcome {
  const now = options.now ?? (() => new Date());
  const jobsRoot = options.jobsRoot ?? path.join(process.cwd(), "data", "ai-jobs");
  const jobId = options.jobId ?? defaultJobId(now());
  const maxTotalBytes = options.maxTotalBytes ?? maxMaterializedBytes();

  const scope = resolveSourceScope(db, refs);
  const videoIds = scope.sources.filter((source) => source.kind === "video").map((s) => s.id);
  const tweetIds = scope.sources.filter((source) => source.kind === "tweet").map((s) => s.id);
  const transcripts = loadTranscriptTexts(db, videoIds);
  const tweets = loadTweetTexts(db, tweetIds);

  const jobDir = path.join(/* turbopackIgnore: true */ jobsRoot, jobId);
  const transcriptsDir = path.join(jobDir, TRANSCRIPTS_DIR_NAME);
  const tweetsDir = path.join(jobDir, TWEETS_DIR_NAME);
  mkdirSync(transcriptsDir, { recursive: true });
  mkdirSync(tweetsDir, { recursive: true });

  const entries = new Map<string, MaterializedSourceFile>();
  const truncatedSourceKeys: string[] = [];
  const skippedSourceKeys: string[] = [];
  let writtenBytes = 0;

  const exclude = (source: ScopedSource, reason: SourceExclusionReason): void => {
    entries.set(sourceKey(source), { ...toFileEntry(source, null), exclusionReason: reason });
    if (reason === "byte_budget_exhausted") {
      skippedSourceKeys.push(sourceKey(source));
    }
  };

  // Videos: one transcript file each, cut byte-accurately at the budget.
  for (const source of scope.sources) {
    if (source.kind !== "video") continue;
    const transcript = transcripts.get(source.id);
    if (!source.readyForAnalysis || !transcript) {
      exclude(source, "missing_transcript");
      continue;
    }
    const rendered = renderTranscriptFile(
      {
        id: source.id,
        title: source.title,
        creator: source.person,
        channel: source.channel,
        featuring: source.featuring,
        publishedAt: source.publishedAt,
        hasTranscript: true,
        durationSeconds: source.durationSeconds ?? null,
      },
      transcript,
    );
    const remaining = maxTotalBytes - writtenBytes;
    if (remaining <= 0) {
      exclude(source, "byte_budget_exhausted");
      continue;
    }
    const full = Buffer.from(rendered, "utf8");
    let file = full;
    let truncated = false;
    if (full.byteLength > remaining) {
      const marker = Buffer.from(`\n\n${TRUNCATION_MARKER}\n`, "utf8");
      const markerBytes = Math.min(marker.byteLength, remaining);
      file = full.subarray(0, Math.max(0, remaining - markerBytes));
      if (file.byteLength === 0) {
        exclude(source, "byte_budget_exhausted");
        continue;
      }
      file = Buffer.concat([file, marker.subarray(0, markerBytes)]);
      truncated = true;
    }
    const relative = `${TRANSCRIPTS_DIR_NAME}/${source.id}.txt`;
    writeFileSync(path.join(jobDir, relative), file);
    writtenBytes += file.byteLength;
    if (truncated) {
      truncatedSourceKeys.push(sourceKey(source));
    }
    entries.set(sourceKey(source), {
      ...toFileEntry(source, relative),
      sha256: createHash("sha256").update(file).digest("hex"),
      truncated,
      exclusionReason: null,
    });
  }

  // Posts: grouped by the saved account whose timeline holds them, in the
  // order the accounts first appear, newest first within each account.
  const accounts = new Map<number, Array<{ source: ScopedSource; row: TweetTextRow }>>();
  for (const source of scope.sources) {
    if (source.kind !== "tweet") continue;
    const row = tweets.get(source.id);
    if (!source.readyForAnalysis || !row || row.text.trim().length === 0) {
      exclude(source, "missing_text");
      continue;
    }
    const posts = accounts.get(source.creatorId) ?? [];
    posts.push({ source, row });
    accounts.set(source.creatorId, posts);
  }
  const usedNames = new Set<string>();
  for (const posts of accounts.values()) {
    posts.sort((a, b) => newestFirst(a.row, b.row));
    const first = posts[0].source;
    const base = bundleBaseName(first, usedNames);
    usedNames.add(base);

    // Split into files that each fit one read, skipping whole posts once
    // the job's byte budget runs out.
    const chunks: Array<Array<{ source: ScopedSource; block: string }>> = [];
    let chunk: Array<{ source: ScopedSource; block: string }> = [];
    let chunkBytes = BUNDLE_HEADER_RESERVE_BYTES;
    let pendingBytes = 0;
    for (const { source, row } of posts) {
      const block = renderPostBlock(row);
      const blockBytes = Buffer.byteLength(block, "utf8") + 2;
      if (writtenBytes + pendingBytes + chunkBytes + blockBytes > maxTotalBytes) {
        exclude(source, "byte_budget_exhausted");
        continue;
      }
      if (chunk.length > 0 && chunkBytes + blockBytes > POST_BUNDLE_MAX_BYTES) {
        chunks.push(chunk);
        pendingBytes += chunkBytes;
        chunk = [];
        chunkBytes = BUNDLE_HEADER_RESERVE_BYTES;
      }
      chunk.push({ source, block });
      chunkBytes += blockBytes;
    }
    if (chunk.length > 0) chunks.push(chunk);

    chunks.forEach((blocks, index) => {
      const relative = `${TWEETS_DIR_NAME}/${index === 0 ? base : `${base}-${index + 1}`}.txt`;
      const file = Buffer.from(
        renderPostBundle(
          { person: first.person, channel: first.channel },
          blocks.map((entry) => entry.block),
          index + 1,
          chunks.length,
        ),
        "utf8",
      );
      writeFileSync(path.join(jobDir, relative), file);
      writtenBytes += file.byteLength;
      const sha256 = createHash("sha256").update(file).digest("hex");
      for (const { source } of blocks) {
        entries.set(sourceKey(source), {
          ...toFileEntry(source, relative),
          sha256,
          truncated: false,
          exclusionReason: null,
        });
      }
    });
  }

  const files: MaterializedSourceFile[] = scope.sources.map((source) =>
    entries.get(sourceKey(source))!,
  );
  for (const ref of scope.unknown) {
    files.push({
      kind: ref.kind,
      id: ref.id,
      title: ref.id,
      creator: "",
      url: "",
      publishedAt: null,
      platform: "",
      file: null,
      readyForAnalysis: false,
      truncated: false,
      exclusionReason: "unknown_source",
    });
  }
  const excluded = files.flatMap((entry) =>
    entry.exclusionReason === null
      ? []
      : [{ kind: entry.kind, id: entry.id, reason: entry.exclusionReason }],
  );

  const truncation: SourceTruncation | null =
    truncatedSourceKeys.length === 0 && skippedSourceKeys.length === 0
      ? null
      : {
          limitBytes: maxTotalBytes,
          writtenBytes,
          truncatedSourceKeys,
          skippedSourceKeys,
        };

  const manifest: SourceMaterializationManifest = {
    version: 2,
    jobId,
    createdAt: now().toISOString(),
    sources: files,
    excluded,
    truncation,
    load: estimateScopeLoad(files.filter((entry) => entry.file !== null)),
  };
  writeManifest(jobDir, manifest);

  return { jobDir, manifest };
}

/** Writes (or rewrites) a job's manifest.json; its presence marks a complete job. */
export function writeManifest(jobDir: string, manifest: SourceMaterializationManifest): void {
  writeFileSync(
    path.join(jobDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

/** Reads a job's manifest, or null when the directory holds none. */
export function readManifest(jobDir: string): SourceMaterializationManifest | null {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(jobDir, "manifest.json"), "utf8"),
    ) as SourceMaterializationManifest;
    return manifest.version === 2 && Array.isArray(manifest.sources) ? manifest : null;
  } catch {
    return null;
  }
}

function toFileEntry(source: ScopedSource, file: string | null): MaterializedSourceFile {
  return {
    kind: source.kind,
    id: source.id,
    title: source.title,
    creator: source.creator,
    url: source.canonicalUrl,
    publishedAt: source.publishedAt,
    platform: source.platform,
    file,
    readyForAnalysis: source.readyForAnalysis,
    truncated: false,
    exclusionReason: null,
    ...(source.kind === "video" ? { durationSeconds: source.durationSeconds ?? null } : {}),
    ...(source.kind === "video" && source.featuring.length > 0
      ? { featuring: [...source.featuring] }
      : {}),
  };
}

export interface SourceMaterializer {
  materializeSources(refs: readonly SourceRef[]): SourceMaterializeOutcome;
}

export function createSourceMaterializer(
  db: ScopeDatabase,
  options: MaterializeOptions = {},
): SourceMaterializer {
  return { materializeSources: (refs) => materializeSources(db, refs, options) };
}
