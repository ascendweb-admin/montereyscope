/**
 * Clean-database migration verification (stage 6 gate).
 *
 * Opens a brand-new SQLite file through the REAL connection module and
 * asserts the full schema was created. Run with a temp LOCALTUBE_DB_PATH:
 *
 *   LOCALTUBE_DB_PATH=/tmp/... npx vitest run tests/unit/clean-db-migration.check.ts
 *
 * Kept out of the normal suite because it duplicates migrations coverage;
 * it exists as an explicit, human-runnable release-gate check.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDb } from "@/lib/db/connection";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-clean-migration-"));
  dirs.push(dir);
  process.env.LOCALTUBE_DB_PATH = path.join(dir, "fresh.db");
});

afterAll(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("clean-database migration gate", () => {
  it("creates the complete schema on first access", () => {
    const db = getDb();
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    // sqlite_sequence exists because creators and ai_threads use AUTOINCREMENT.
    expect(tables).toEqual([
      "ai_messages",
      "ai_model_catalog",
      "ai_reports",
      "ai_threads",
      "categories",
      "creator_categories",
      "creator_tweets",
      "creators",
      "schema_migrations",
      "settings",
      "sqlite_sequence",
      "transcripts",
      "tweets",
      "videos",
      "x_analysis_batches",
      "x_analysis_jobs",
      "x_analysis_post_results",
      "x_analysis_segments",
      "x_dashboard_seen",
      "x_feed_state",
      "x_insight_messages",
      "x_insight_posts",
      "x_insights",
      "x_research_list_members",
      "x_research_lists",
      "x_research_scope_memberships",
      "x_research_scope_posts",
      "x_research_scopes",
      "x_research_turns",
      "x_retrieval_checkpoints",
      "x_retrieval_job_tasks",
      "x_retrieval_jobs",
      "x_retrieval_tasks",
      "x_tweet_text",
      "x_tweet_text_config",
      "x_tweet_text_data",
      "x_tweet_text_docsize",
      "x_tweet_text_idx",
    ]);

    const applied = db.prepare<[], { id: string }>("SELECT id FROM schema_migrations").all();
    expect(applied.map((row) => row.id)).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "010",
      "011",
      "012",
      "013",
      "014",
      "015",
      "016",
      "017",
      "018",
      "019",
      "020",
      "021",
      "022",
    ]);

    // WAL + foreign keys are enabled per connection by getDb().
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.exec("INSERT INTO x_tweet_text(x_tweet_text, rank) VALUES ('integrity-check', 1)");
  });
});
