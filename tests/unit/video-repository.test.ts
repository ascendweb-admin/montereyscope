import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import { saveTranscript } from "@/lib/transcripts/repository";
import {
  countCachedVideos,
  getVideoForCreator,
  listAllVideosWithCreator,
  listCachedVideos,
  listFeedVideos,
  mergeCreatorFeed,
} from "@/lib/videos/repository";
import type { VideoDraft } from "@/lib/videos/mapper";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function createTempDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-videos-"));
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

beforeEach(() => {
  if (db) {
    db.close();
  }
  db = createTempDb();
  runMigrations(db, ALL_MIGRATIONS);
});

const CREATOR = {
  youtubeChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
  handle: "samplecreator",
  displayName: "Sample Creator",
  channelUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
  avatarUrl: null,
};

function draft(overrides: Partial<VideoDraft> & { id: string }): VideoDraft {
  return {
    title: `Video ${overrides.id}`,
    url: `https://www.youtube.com/watch?v=${overrides.id}`,
    thumbnailUrl: null,
    publishedAt: null,
    durationSeconds: 120,
    liveStatus: "unknown",
    description: null,
    ...overrides,
  };
}

const ORDINARY: readonly VideoDraft[] = [
  draft({ id: "Ordinary01A", publishedAt: "2026-08-20T12:00:00.000Z" }),
  draft({ id: "Ordinary02B", publishedAt: "2026-08-18T09:00:00.000Z" }),
];

const LIVESTREAMS: readonly VideoDraft[] = [
  draft({ id: "LiveNow00001", liveStatus: "is_live", durationSeconds: null }),
  draft({ id: "Upcoming0011", liveStatus: "upcoming" }),
  draft({ id: "WasLive0001", liveStatus: "was_live", publishedAt: "2026-08-15T00:00:00.000Z" }),
];

describe("mergeCreatorFeed (refresh transaction)", () => {
  it("inserts the parsed feed and stamps last_refreshed_at atomically", () => {
    const { creator } = addCreator(db, CREATOR);
    expect(creator.lastRefreshedAt).toBeNull();

    const outcome = mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: [...ORDINARY, ...LIVESTREAMS],
      refreshedAt: "2026-08-24T10:00:00.000Z",
    });

    expect(outcome.fetchedCount).toBe(5);
    expect(outcome.livestreamCount).toBe(3);

    const refreshed = db
      .prepare<[number], { last_refreshed_at: string | null }>(
        "SELECT last_refreshed_at FROM creators WHERE id = ?",
      )
      .get(creator.id);
    expect(refreshed?.last_refreshed_at).toBe("2026-08-24T10:00:00.000Z");
  });

  it("keeps the previous feed and refresh stamp untouched when the merge fails", () => {
    const { creator } = addCreator(db, CREATOR);
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: ORDINARY,
      refreshedAt: "2026-08-23T08:00:00.000Z",
    });

    // A batch violating the live_status CHECK constraint aborts the
    // transaction mid-write — everything must roll back.
    expect(() => {
      mergeCreatorFeed(db, {
        creatorId: creator.id,
        videos: [
          draft({ id: "NewVideo001", liveStatus: "is_live" }),
          draft({ id: "NewVideo002" }),
          draft({ id: "BadStatus01", liveStatus: "definitely_live" as never }),
        ],
        refreshedAt: "2026-08-24T11:00:00.000Z",
      });
    }).toThrow(/CHECK/);

    // Old cached rows survive; the failed refresh never stamped anything.
    expect(countCachedVideos(db, creator.id)).toBe(2);
    expect(listCachedVideos(db, creator.id, "videos").map((v) => v.id)).toEqual([
      "Ordinary01A",
      "Ordinary02B",
    ]);
    const stamp = db
      .prepare<[number], { last_refreshed_at: string | null }>(
        "SELECT last_refreshed_at FROM creators WHERE id = ?",
      )
      .get(creator.id);
    expect(stamp?.last_refreshed_at).toBe("2026-08-23T08:00:00.000Z");
  });

  it("keeps videos — and their transcripts — that scroll past the fetched window", () => {
    const { creator } = addCreator(db, CREATOR);
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: [draft({ id: "OldVideo001", publishedAt: "2026-07-01T00:00:00.000Z" })],
      refreshedAt: "2026-08-01T00:00:00.000Z",
    });
    saveTranscript(
      db,
      { videoId: "OldVideo001", language: "en", source: "manual", plainText: "kept" },
      "2026-08-01T01:00:00.000Z",
    );

    // A later refresh with a narrow window no longer includes the old video.
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: [draft({ id: "NewVideo001", publishedAt: "2026-08-20T12:00:00.000Z" })],
      refreshedAt: "2026-08-24T00:00:00.000Z",
    });

    expect(listCachedVideos(db, creator.id, "videos").map((v) => v.id)).toEqual([
      "NewVideo001",
      "OldVideo001",
    ]);
    expect(getVideoForCreator(db, creator.id, "OldVideo001")).not.toBeNull();
    const transcripts = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM transcripts")
      .get();
    expect(Number(transcripts?.n)).toBe(1);
  });

  it("upserts known ids in place: metadata updates and tab moves, first date wins", () => {
    const { creator } = addCreator(db, CREATOR);
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: [
        draft({ id: "StreamToVod1", liveStatus: "upcoming", publishedAt: null }),
        draft({ id: "Ordinary01A", publishedAt: "2026-08-20T12:00:00.000Z" }),
      ],
      refreshedAt: "2026-08-23T00:00:00.000Z",
    });

    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: [
        // The scheduled stream ended: was_live moves it to the livestreams
        // tab and fills in the date the earlier fetch could not know.
        draft({
          id: "StreamToVod1",
          liveStatus: "was_live",
          publishedAt: "2026-08-22T18:00:00.000Z",
        }),
        // A drifted approximate date must not clobber the stored one.
        draft({ id: "Ordinary01A", publishedAt: "2026-08-25T00:00:00.000Z" }),
      ],
      refreshedAt: "2026-08-24T00:00:00.000Z",
    });

    const videos = listCachedVideos(db, creator.id, "videos");
    expect(videos.map((v) => v.id)).toEqual(["Ordinary01A"]);
    expect(videos[0].publishedAt).toBe("2026-08-20T12:00:00.000Z");

    const livestreams = listCachedVideos(db, creator.id, "livestreams");
    expect(livestreams.map((v) => v.id)).toEqual(["StreamToVod1"]);
    expect(livestreams[0].publishedAt).toBe("2026-08-22T18:00:00.000Z");
  });

  it("enforces the live_status CHECK constraint on untrusted input", () => {
    const { creator } = addCreator(db, CREATOR);
    expect(() => {
      mergeCreatorFeed(db, {
        creatorId: creator.id,
        videos: [draft({ id: "BadStatus01", liveStatus: "definitely_live" as never })],
        refreshedAt: "2026-08-24T00:00:00.000Z",
      });
    }).toThrow(/CHECK/);
    // Rollback left the cache empty rather than half-written.
    expect(countCachedVideos(db, creator.id)).toBe(0);
  });

  it("cascades cached videos when a creator is removed", () => {
    const { creator } = addCreator(db, CREATOR);
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: ORDINARY,
      refreshedAt: "2026-08-24T00:00:00.000Z",
    });
    db.prepare("DELETE FROM creators WHERE id = ?").run(creator.id);
    expect(countCachedVideos(db, 9999)).toBe(0);
    expect(countCachedVideos(db, creator.id)).toBe(0);
  });
});

describe("listCachedVideos tab split", () => {
  let creatorId: number;

  beforeEach(() => {
    const { creator } = addCreator(db, CREATOR);
    creatorId = creator.id;
    mergeCreatorFeed(db, {
      creatorId,
      videos: [...ORDINARY, ...LIVESTREAMS],
      refreshedAt: "2026-08-24T00:00:00.000Z",
    });
  });

  it("routes ordinary uploads to videos and streams to livestreams", () => {
    const videoIds = listCachedVideos(db, creatorId, "videos").map((v) => v.id);
    expect(videoIds).toEqual(["Ordinary01A", "Ordinary02B"]);

    const livestreamIds = listCachedVideos(db, creatorId, "livestreams").map((v) => v.id);
    // Undated (upcoming/live) items first, then dated past streams.
    expect(livestreamIds.filter((id) => id !== "WasLive0001")).toHaveLength(2);
    expect(livestreamIds.at(-1)).toBe("WasLive0001");
    expect(videoIds.some((id) => LIVESTREAMS.some((l) => l.id === id))).toBe(false);
  });

  it("orders dated entries newest-first inside a tab", () => {
    expect(listCachedVideos(db, creatorId, "videos").map((v) => v.id)).toEqual([
      "Ordinary01A",
      "Ordinary02B",
    ]);
  });

  it("returns empty arrays for creators without cached data", () => {
    const other = addCreator(db, {
      ...CREATOR,
      youtubeChannelId: null,
      handle: "other",
      displayName: "Other",
      channelUrl: "https://www.youtube.com/@other",
    });
    if (other.status !== "created") throw new Error("fixture setup failed");
    expect(listCachedVideos(db, other.creator.id, "videos")).toEqual([]);
    expect(listCachedVideos(db, other.creator.id, "livestreams")).toEqual([]);
  });
});

describe("getVideoForCreator", () => {
  it("reads one cached video scoped to its creator", () => {
    const { creator } = addCreator(db, CREATOR);
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: ORDINARY,
      refreshedAt: "2026-08-24T00:00:00.000Z",
    });

    const record = getVideoForCreator(db, creator.id, "Ordinary01A");
    expect(record?.creatorId).toBe(creator.id);
    expect(record?.fetchedAt).toBeTruthy();

    // Another creator must not see it.
    const other = addCreator(db, {
      ...CREATOR,
      youtubeChannelId: null,
      handle: "someone",
      displayName: "Someone",
      channelUrl: "https://www.youtube.com/@someone",
    });
    if (other.status !== "created") throw new Error("fixture setup failed");
    expect(getVideoForCreator(db, other.creator.id, "Ordinary01A")).toBeNull();
  });
});

describe("listFeedVideos (unified feed reads)", () => {
  it("lists every cached video across creators, newest first, with joined feed fields", () => {
    const first = addCreator(db, CREATOR);
    if (first.status !== "created") throw new Error("fixture setup failed");
    const second = addCreator(db, {
      ...CREATOR,
      youtubeChannelId: null,
      handle: "someone",
      displayName: "Someone Else",
      channelUrl: "https://www.youtube.com/@someone",
      platform: "rumble",
    });
    if (second.status !== "created") throw new Error("fixture setup failed");

    mergeCreatorFeed(db, {
      creatorId: first.creator.id,
      videos: [ORDINARY[1], LIVESTREAMS[2]],
      refreshedAt: "2026-08-24T10:00:00.000Z",
    });
    mergeCreatorFeed(db, {
      creatorId: second.creator.id,
      videos: [draft({ id: "OtherVideo1", publishedAt: "2026-08-25T00:00:00.000Z" })],
      refreshedAt: "2026-08-24T10:00:00.000Z",
    });
    saveTranscript(
      db,
      { videoId: "Ordinary02B", language: "en", source: "manual", plainText: "cached" },
      "2026-08-24T11:00:00.000Z",
    );

    const rows = listFeedVideos(db);
    expect(rows.map((row) => [row.id, row.creatorName])).toEqual([
      ["OtherVideo1", "Someone Else"],
      ["Ordinary02B", "Sample Creator"],
      ["WasLive0001", "Sample Creator"],
    ]);
    expect(rows[0].creatorPlatform).toBe("rumble");
    expect(rows[0].creatorAvatarUrl).toBeNull();
    expect(rows[0].hasTranscript).toBe(false);
    expect(rows[1].hasTranscript).toBe(true);
    expect(rows[2].hasTranscript).toBe(false);
  });

  it("sorts undated items ahead of dated ones", () => {
    const { creator } = addCreator(db, CREATOR);
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      videos: [
        draft({ id: "DatedVideo1", publishedAt: "2026-08-20T12:00:00.000Z" }),
        draft({ id: "UpcomingFeed", liveStatus: "upcoming" }),
      ],
      refreshedAt: "2026-08-24T10:00:00.000Z",
    });
    expect(listFeedVideos(db).map((row) => row.id)).toEqual(["UpcomingFeed", "DatedVideo1"]);
  });

  it("returns an empty list with no cached videos", () => {
    expect(listFeedVideos(db)).toEqual([]);
  });
});

describe("listAllVideosWithCreator (AI Research reads)", () => {
  it("lists every cached video across creators, newest first, with creator names", () => {
    const first = addCreator(db, CREATOR);
    if (first.status !== "created") throw new Error("fixture setup failed");
    const second = addCreator(db, {
      ...CREATOR,
      youtubeChannelId: null,
      handle: "someone",
      displayName: "Someone Else",
      channelUrl: "https://www.youtube.com/@someone",
    });
    if (second.status !== "created") throw new Error("fixture setup failed");

    mergeCreatorFeed(db, {
      creatorId: first.creator.id,
      videos: ORDINARY,
      refreshedAt: "2026-08-24T10:00:00.000Z",
    });
    mergeCreatorFeed(db, {
      creatorId: second.creator.id,
      videos: [draft({ id: "OtherVideo1", publishedAt: "2026-08-25T00:00:00.000Z" })],
      refreshedAt: "2026-08-24T10:00:00.000Z",
    });

    const rows = listAllVideosWithCreator(db);
    // Newest first across creators; undated items sort ahead of dated ones.
    expect(rows.map((row) => [row.id, row.creatorName])).toEqual([
      ["OtherVideo1", "Someone Else"],
      ["Ordinary01A", "Sample Creator"],
      ["Ordinary02B", "Sample Creator"],
    ]);
    // Everything the scope-selection UI needs comes joined on the row.
    expect(rows[0].creatorId).toBe(second.creator.id);
    expect(rows[0].title).toBe("Video OtherVideo1");
  });

  it("returns an empty list with no cached videos", () => {
    expect(listAllVideosWithCreator(db)).toEqual([]);
  });
});
