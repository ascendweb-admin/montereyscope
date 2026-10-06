import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import { clearAllCachedFeeds, countAllVideos } from "@/lib/videos/repository";
import {
  clearAllTranscripts,
  countTranscripts,
  saveTranscript,
} from "@/lib/transcripts/repository";
import {
  clearCachedFeedMetadata,
  clearTranscriptCache,
  getCacheCounts,
} from "@/lib/maintenance/service";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function createTempDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-maintenance-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  return database;
}

afterAll(() => {
  if (db?.open) db.close();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CREATORS = [
  {
    youtubeChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
    handle: "samplecreator",
    displayName: "Sample Creator",
    channelUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
    avatarUrl: null,
  },
  {
    youtubeChannelId: "UCBJycsmduvYEL83R_U4JriQ",
    handle: "secondcreator",
    displayName: "Second Creator",
    channelUrl: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ",
    avatarUrl: null,
  },
];

function insertVideo(creatorId: number, id: string): void {
  db.prepare(`INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)`).run(
    id,
    creatorId,
    `Video ${id}`,
    `https://www.youtube.com/watch?v=${id}`,
  );
}

beforeEach(() => {
  if (db) {
    db.close();
  }
  db = createTempDb();
  runMigrations(db, ALL_MIGRATIONS);

  for (const creator of CREATORS) {
    const result = addCreator(db, creator);
    // Stamp a refresh time so we can assert it is reset by feed clearing.
    db.prepare("UPDATE creators SET last_refreshed_at = ? WHERE id = ?").run(
      "2026-08-20T10:00:00.000Z",
      result.creator.id,
    );
  }

  const rows = db.prepare("SELECT id FROM creators ORDER BY id").all() as { id: number }[];
  insertVideo(rows[0].id, "Video00001");
  insertVideo(rows[0].id, "Video00002");
  insertVideo(rows[1].id, "Stream00001");

  saveTranscript(
    db,
    { videoId: "Video00001", language: "en", source: "manual", plainText: "One." },
    "2026-08-21T10:00:00.000Z",
  );
  saveTranscript(
    db,
    { videoId: "Video00002", language: "en", source: "automatic", plainText: "Two." },
    "2026-08-22T10:00:00.000Z",
  );
});

describe("cache counts (shown in confirmations before deletion)", () => {
  it("reports transcript and video totals across all creators", () => {
    expect(getCacheCounts(db)).toEqual({
      cachedTranscripts: 2,
      cachedTweets: 0,
      cachedVideos: 3,
    });
  });

  it("reads zero on an untouched database", () => {
    clearAllTranscripts(db);
    clearAllCachedFeeds(db);
    expect(getCacheCounts(db)).toEqual({ cachedTranscripts: 0, cachedVideos: 0, cachedTweets: 0 });
  });
});

describe("clearTranscriptCache — deletes exactly the transcript scope", () => {
  it("removes every transcript and nothing else", () => {
    const outcome = clearTranscriptCache(db);
    expect(outcome).toEqual({ ok: true, deletedCount: 2 });

    expect(countTranscripts(db)).toBe(0);
    // Feeds and creators are untouched.
    expect(countAllVideos(db)).toBe(3);
    const creators = db.prepare("SELECT COUNT(*) AS n FROM creators").get() as { n: number };
    expect(creators.n).toBe(CREATORS.length);
  });

  it("is safe to run twice and reports zero the second time", () => {
    clearTranscriptCache(db);
    expect(clearTranscriptCache(db)).toEqual({ ok: true, deletedCount: 0 });
  });

  it("lets extraction re-cache afterwards", () => {
    clearTranscriptCache(db);
    saveTranscript(
      db,
      { videoId: "Video00001", language: "en", source: "manual", plainText: "Fresh." },
      "2026-08-24T10:00:00.000Z",
    );
    expect(getCacheCounts(db).cachedTranscripts).toBe(1);
  });
});

describe("clearCachedFeedMetadata — clears feeds while retaining saved creators", () => {
  it("deletes videos (with cascading transcripts), resets refresh stamps, keeps creators", () => {
    const outcome = clearCachedFeedMetadata(db);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.deletedCount).toBe(3);

    expect(countAllVideos(db)).toBe(0);
    // Transcripts cascade with their videos via foreign keys.
    expect(countTranscripts(db)).toBe(0);

    const creators = db
      .prepare("SELECT display_name, last_refreshed_at FROM creators ORDER BY display_name")
      .all() as { display_name: string; last_refreshed_at: string | null }[];
    expect(creators.map((row) => row.display_name)).toEqual(["Sample Creator", "Second Creator"]);
    for (const row of creators) {
      expect(row.last_refreshed_at).toBeNull();
    }
  });

  it("allows a fresh cache cycle after clearing", () => {
    clearCachedFeedMetadata(db);
    const rows = db.prepare("SELECT id FROM creators ORDER BY id LIMIT 1").all() as {
      id: number;
    }[];
    insertVideo(rows[0].id, "Refill0001");
    expect(getCacheCounts(db)).toEqual({ cachedTranscripts: 0, cachedVideos: 1, cachedTweets: 0 });
  });
});
