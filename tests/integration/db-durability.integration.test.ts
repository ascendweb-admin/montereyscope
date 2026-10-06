/**
 * Database durability integration tests through the REAL connection module
 * (lib/db/connection.ts) — the same code path the server uses.
 *
 * Simulates an application restart by closing the process-wide connection
 * and reopening the same SQLite file: saved creators, cached feeds,
 * transcripts, settings, refresh stamps, and migration state must all
 * survive. Uses only temporary files; never touches data/localtube.db.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDb, type ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { addCreator } from "@/lib/creators/repository";
import { saveTranscript, countTranscripts } from "@/lib/transcripts/repository";
import { mergeCreatorFeed } from "@/lib/videos/repository";
import { setRecentItemsPerTab, getRecentItemsPerTab } from "@/lib/settings/settings";
import { parseChannelFeedPayload } from "@/lib/videos/mapper";
import { readFileSync } from "node:fs";

const VIDEOS_TAB_JSON = readFileSync(
  path.join(__dirname, "..", "fixtures", "channel-videos-tab.fixture.json"),
  "utf8",
);

let workDir: string;
let dbFile: string;

function reopen(): ScopeDatabase {
  // Emulates a fresh process: drop the cached handle, then let getDb()
  // re-open, re-run idempotent migrations, and hand back the same data.
  closeDatabase();
  return getDb();
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "localtube-durability-"));
  dbFile = path.join(workDir, "localtube.db");
  process.env.LOCALTUBE_DB_PATH = dbFile;
});

afterEach(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(workDir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.LOCALTUBE_DB_PATH;
});

describe("database durability across restarts", () => {
  it("persists creators, feeds, transcripts, settings, and stamps after reopen", () => {
    const db = getDb();

    const added = addCreator(db, {
      youtubeChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
      handle: "samplecreator",
      displayName: "Sample Creator",
      channelUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
      avatarUrl: null,
    });
    expect(added.status).toBe("created");

    const parsed = parseChannelFeedPayload(VIDEOS_TAB_JSON);
    if (!parsed.ok) {
      throw new Error("fixture must parse");
    }
    const refreshedAt = "2026-08-24T12:00:00.000Z";
    mergeCreatorFeed(db, {
      creatorId: added.creator.id,
      videos: parsed.videos,
      refreshedAt,
    });
    saveTranscript(
      db,
      {
        videoId: "aBcD1234EfG",
        language: "en",
        source: "manual",
        plainText: "Persisted transcript text.",
      },
      refreshedAt,
    );
    setRecentItemsPerTab(db, 42);

    // --- restart ---
    const reopened = reopen();
    expect(getDb()).toBe(reopened); // single process-wide handle restored

    const creator = reopened
      .prepare<[string], { id: number; display_name: string }>(
        "SELECT id, display_name FROM creators WHERE youtube_channel_id = ?",
      )
      .get("UCX6OQ3DkcsbYNE6H8uQQuVA");
    expect(creator?.display_name).toBe("Sample Creator");

    const stamp = reopened
      .prepare<[number], { last_refreshed_at: string | null }>(
        "SELECT last_refreshed_at FROM creators WHERE id = ?",
      )
      .get(added.creator.id);
    expect(stamp?.last_refreshed_at).toBe(refreshedAt);

    const videoCount = reopened
      .prepare<[number], { n: number }>("SELECT COUNT(*) AS n FROM videos WHERE creator_id = ?")
      .get(added.creator.id);
    expect(Number(videoCount?.n)).toBe(parsed.videos.length);
    expect(countTranscripts(reopened)).toBe(1);
    expect(getRecentItemsPerTab(reopened)).toBe(42);

    // Migrations did not duplicate their bookkeeping rows.
    const applied = reopened
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM schema_migrations")
      .get();
    expect(Number(applied?.n)).toBe(ALL_MIGRATIONS.length);
  });

  it("cascades removal of a creator's videos AND transcripts after reopen", () => {
    const db = getDb();
    const added = addCreator(db, {
      youtubeChannelId: null,
      handle: "temporary",
      displayName: "Temporary Creator",
      channelUrl: "https://www.youtube.com/@temporary",
      avatarUrl: null,
    });
    const parsed = parseChannelFeedPayload(VIDEOS_TAB_JSON);
    if (!parsed.ok) {
      throw new Error("fixture must parse");
    }
    mergeCreatorFeed(db, {
      creatorId: added.creator.id,
      videos: parsed.videos,
      refreshedAt: "2026-08-24T09:00:00.000Z",
    });
    saveTranscript(
      db,
      { videoId: "aBcD1234EfG", language: "en", source: "manual", plainText: "bye" },
      "2026-08-24T09:05:00.000Z",
    );

    // Remove via the repository (the confirmed-removal path), then restart.
    db.prepare("DELETE FROM creators WHERE id = ?").run(added.creator.id);
    const reopened = reopen();

    expect(countTranscripts(reopened)).toBe(0);
    const orphanVideos = reopened
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM videos")
      .get();
    expect(Number(orphanVideos?.n)).toBe(0);
    const fkTargets = reopened
      .prepare<[], { fk_table: string; on_delete: string }>(
        "SELECT \"table\" AS fk_table, on_delete FROM pragma_foreign_key_list('videos')",
      )
      .all();
    expect(fkTargets).toEqual([{ fk_table: "creators", on_delete: "CASCADE" }]);
  });

  it("rolls a failed refresh merge back so the previous feed survives a restart", () => {
    const db = getDb();
    const added = addCreator(db, {
      youtubeChannelId: null,
      handle: "stable",
      displayName: "Stable Creator",
      channelUrl: "https://www.youtube.com/@stable",
      avatarUrl: null,
    });
    const parsed = parseChannelFeedPayload(VIDEOS_TAB_JSON);
    if (!parsed.ok) {
      throw new Error("fixture must parse");
    }
    const firstStamp = "2026-08-24T08:00:00.000Z";
    mergeCreatorFeed(db, {
      creatorId: added.creator.id,
      videos: parsed.videos,
      refreshedAt: firstStamp,
    });

    // A malformed merge (an entry violating the live_status CHECK constraint
    // after earlier valid rows) must abort the whole transaction.
    expect(() =>
      mergeCreatorFeed(db, {
        creatorId: added.creator.id,
        videos: [
          ...parsed.videos,
          { ...parsed.videos[0], id: "BadStatus00", liveStatus: "definitely_live" as never },
        ],
        refreshedAt: "2026-08-24T10:00:00.000Z",
      }),
    ).toThrow(/CHECK/);

    const reopened = reopen();
    const state = reopened
      .prepare<[{ id: number }], { n: number; stamp: string | null }>(
        "SELECT COUNT(*) AS n, (SELECT last_refreshed_at FROM creators WHERE id = :id) AS stamp FROM videos WHERE creator_id = :id",
      )
      .get({ id: added.creator.id });
    expect(Number(state?.n)).toBe(parsed.videos.length);
    expect(state?.stamp).toBe(firstStamp);
  });
});
