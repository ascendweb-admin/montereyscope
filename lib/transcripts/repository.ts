/**
 * SQLite-backed cache of extracted transcripts. Server-only.
 * Rows map the `transcripts` table created by migration 001 — one row per
 * video, written only after a caption track was fully parsed. Failures
 * never touch existing rows.
 */
import type { ScopeDatabase } from "@/lib/db/connection";

/** Matches the CHECK constraint on the transcripts.source column. */
export type TranscriptSource = "manual" | "automatic";

export interface TranscriptRecord {
  videoId: string;
  language: string;
  source: TranscriptSource;
  plainText: string;
  fetchedAt: string;
}

interface TranscriptRow {
  video_id: string;
  language: string;
  source: TranscriptSource;
  plain_text: string;
  fetched_at: string;
}

function toRecord(row: TranscriptRow): TranscriptRecord {
  return {
    videoId: row.video_id,
    language: row.language,
    source: row.source,
    plainText: row.plain_text,
    fetchedAt: row.fetched_at,
  };
}

/** Reads the cached transcript for one video, or null. */
export function getTranscript(db: ScopeDatabase, videoId: string): TranscriptRecord | null {
  const row = db
    .prepare<[string], TranscriptRow>("SELECT * FROM transcripts WHERE video_id = ?")
    .get(videoId);
  return row ? toRecord(row) : null;
}

/** Total number of cached transcripts across all videos. */
export function countTranscripts(db: ScopeDatabase): number {
  const row = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM transcripts").get();
  return row ? Number(row.n) : 0;
}

/**
 * Deletes every cached transcript at once. Used only by the explicit,
 * confirmed Settings action — never during extraction failures.
 * Returns the number of rows removed.
 */
export function clearAllTranscripts(db: ScopeDatabase): number {
  const result = db.prepare("DELETE FROM transcripts").run();
  return Number(result.changes);
}

export interface SaveTranscriptInput {
  videoId: string;
  language: string;
  source: TranscriptSource;
  plainText: string;
}

/**
 * Stores or replaces the transcript for one video. Callers must only invoke
 * this with a complete, successfully parsed result — nothing here writes
 * partial output or raw subtitle markup.
 */
export function saveTranscript(
  db: ScopeDatabase,
  input: SaveTranscriptInput,
  fetchedAt: string,
): TranscriptRecord {
  db.prepare(
    `INSERT INTO transcripts (video_id, language, source, plain_text, fetched_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (video_id) DO UPDATE SET
       language = excluded.language,
       source = excluded.source,
       plain_text = excluded.plain_text,
       fetched_at = excluded.fetched_at`,
  ).run(input.videoId, input.language, input.source, input.plainText, fetchedAt);
  return {
    videoId: input.videoId,
    language: input.language,
    source: input.source,
    plainText: input.plainText,
    fetchedAt,
  };
}
