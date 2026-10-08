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
  clearTweetCache,
  getCacheCounts,
  getCacheSizes,
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

describe("cache sizes", () => {
  it("measures UTF-8 transcript data separately from video metadata", () => {
    const before = getCacheSizes(db);
    expect(before.cachedTranscriptBytes).toBeGreaterThan(0);
    expect(before.cachedVideoBytes).toBeGreaterThan(0);
    expect(before.cachedTweetBytes).toBe(0);

    const text = "Caption café 🎬\u0000".repeat(1_000);
    saveTranscript(
      db,
      { videoId: "Video00001", language: "en", source: "manual", plainText: text },
      "2026-08-21T10:00:00.000Z",
    );
    const after = getCacheSizes(db);
    expect(after.cachedTranscriptBytes - before.cachedTranscriptBytes).toBeGreaterThanOrEqual(
      Buffer.byteLength(text) - Buffer.byteLength("One."),
    );
    expect(after.cachedVideoBytes).toBe(before.cachedVideoBytes);
    expect(after.cachedTweetBytes).toBe(0);
  });

  it("includes X timeline and feed state without duplicating shared post bodies", () => {
    const text = "A cached post.".repeat(1_000);
    db.prepare(
      `INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text)
       VALUES ('post1', 'author1', 'author', 'Author', 'https://x.com/author/status/1', ?)`,
    ).run(text);
    const creatorIds = db.prepare("SELECT id FROM creators ORDER BY id").all() as { id: number }[];
    const postBytes = getCacheSizes(db).cachedTweetBytes;
    expect(postBytes).toBeGreaterThan(Buffer.byteLength(text));

    for (const creator of creatorIds) {
      db.prepare("INSERT INTO creator_tweets (creator_id, tweet_id) VALUES (?, 'post1')").run(
        creator.id,
      );
      db.prepare("INSERT INTO x_feed_state (creator_id, config_key) VALUES (?, 'test')").run(
        creator.id,
      );
    }
    const linkedBytes = getCacheSizes(db).cachedTweetBytes;
    expect(linkedBytes).toBeGreaterThan(postBytes);
    expect(linkedBytes - postBytes).toBeLessThan(Buffer.byteLength(text));
    clearTweetCache(db);
    expect(getCacheSizes(db).cachedTweetBytes).toBe(0);
  });

  it("reports zero for cleared caches even while database pages and creators remain", () => {
    const videoBytes = getCacheSizes(db).cachedVideoBytes;
    clearTranscriptCache(db);
    expect(getCacheSizes(db)).toEqual({
      cachedTranscriptBytes: 0,
      cachedVideoBytes: videoBytes,
      cachedTweetBytes: 0,
    });

    clearCachedFeedMetadata(db);
    expect(getCacheSizes(db)).toEqual({
      cachedTranscriptBytes: 0,
      cachedVideoBytes: 0,
      cachedTweetBytes: 0,
    });
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
