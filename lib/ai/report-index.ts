/**
 * The reading index behind the Reports page: for every finished report, its
 * section outline and word count (ai_report_index) and its searchable text
 * (ai_report_text, an FTS5 table keyed by report id). Server-only.
 *
 * The index fills lazily. syncReportIndex runs before the page lists or
 * searches reports and reads only documents whose revision fingerprint moved
 * since the last pass — a report that just finished, a brief that was
 * re-saved, a rename — so a steady-state listing does one small query and no
 * file I/O. Deleting a report drops its rows (a cascade and a trigger).
 */
import { readFileSync } from "node:fs";

import type { ScopeDatabase } from "@/lib/db/connection";
import { researchReportHtml } from "@/lib/x/research/experience";

import { summarizeReportDocument } from "./report-document";

/** Bump when extraction changes so every document is read again once. */
const INDEX_VERSION = 1;

/** Body matches returned per search; the rail never shows more. */
const SEARCH_LIMIT = 200;
/** Words around the best body match in a search snippet. */
const SNIPPET_TOKENS = 14;
/** Search terms honoured per query; the rest are ignored. */
const MAX_SEARCH_TERMS = 12;

/** Marks the start and end of a matched term inside a snippet. */
export const SNIPPET_MATCH_START = "\u0002";
export const SNIPPET_MATCH_END = "\u0003";

interface IndexCandidateRow {
  id: number;
  file_path: string | null;
  title: string | null;
  dek: string | null;
  completed_at: string | null;
  has_research_html: number;
  fingerprint: string | null;
}

function fingerprintOf(row: IndexCandidateRow): string {
  return JSON.stringify([
    INDEX_VERSION,
    row.completed_at,
    row.has_research_html ? "stored" : row.file_path,
    row.title,
    row.dek,
  ]);
}

function readDocument(db: ScopeDatabase, row: IndexCandidateRow): string | null {
  try {
    if (row.has_research_html) {
      return researchReportHtml(db, Number(row.id));
    }
    return row.file_path === null ? null : readFileSync(row.file_path, "utf8");
  } catch {
    // Missing or unreadable: the report keeps no outline and is retried on
    // the next pass, which costs one failed read.
    return null;
  }
}

/**
 * Brings the index up to date with every finished report and returns how
 * many documents were (re)read. Safe to call on every request.
 */
export function syncReportIndex(db: ScopeDatabase): number {
  const rows = db
    .prepare<[], IndexCandidateRow>(
      `SELECT r.id, r.file_path, r.title, r.dek, r.completed_at,
              r.research_html IS NOT NULL AS has_research_html, i.fingerprint
       FROM ai_reports r
       LEFT JOIN ai_report_index i ON i.report_id = r.id
       WHERE r.status = 'done'`,
    )
    .all();
  const upsertIndex = db.prepare(
    `INSERT INTO ai_report_index (report_id, fingerprint, word_count, outline_json, indexed_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (report_id) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       word_count = excluded.word_count,
       outline_json = excluded.outline_json,
       indexed_at = excluded.indexed_at`,
  );
  const deleteText = db.prepare("DELETE FROM ai_report_text WHERE rowid = ?");
  const insertText = db.prepare(
    "INSERT INTO ai_report_text (rowid, title, dek, body) VALUES (?, ?, ?, ?)",
  );

  let updated = 0;
  for (const row of rows) {
    const fingerprint = fingerprintOf(row);
    if (row.fingerprint === fingerprint) {
      continue;
    }
    const html = readDocument(db, row);
    if (html === null) {
      continue;
    }
    const summary = summarizeReportDocument(html);
    const id = Number(row.id);
    db.transaction(() => {
      upsertIndex.run(id, fingerprint, summary.wordCount, JSON.stringify(summary.outline));
      deleteText.run(id);
      insertText.run(id, row.title ?? "", row.dek ?? "", summary.text);
    })();
    updated += 1;
  }
  return updated;
}

/**
 * Turns what the user typed into an FTS5 query: every term must appear (as
 * a word or a word prefix), each quoted so FTS operators and punctuation are
 * taken literally. Null when nothing searchable is left.
 */
export function buildReportMatchExpression(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, ""))
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, MAX_SEARCH_TERMS);
  return terms.length > 0 ? terms.map((term) => `"${term}"*`).join(" ") : null;
}

export interface ReportTextMatch {
  id: number;
  /**
   * Words around the best match in the report's body, matched terms wrapped
   * in SNIPPET_MATCH_START/END; null when only the headline or standfirst
   * matched (the rail already shows those).
   */
  snippet: string | null;
}

/** Finished reports whose text matches `query`, best match first. */
export function searchReportText(db: ScopeDatabase, query: string): ReportTextMatch[] {
  const match = buildReportMatchExpression(query);
  if (match === null) {
    return [];
  }
  let rows: Array<{ id: number; snippet: string | null }>;
  try {
    rows = db
      .prepare<[number, string, number], { id: number; snippet: string | null }>(
        `SELECT rowid AS id,
                snippet(ai_report_text, 2, char(2), char(3), '…', ?) AS snippet
         FROM ai_report_text
         WHERE ai_report_text MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(SNIPPET_TOKENS, match, SEARCH_LIMIT);
  } catch {
    // A query FTS cannot parse matches nothing rather than failing the page.
    return [];
  }
  return rows.map((row) => ({
    id: Number(row.id),
    snippet:
      row.snippet !== null && row.snippet.includes(SNIPPET_MATCH_START) ? row.snippet.trim() : null,
  }));
}
