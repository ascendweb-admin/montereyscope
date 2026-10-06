import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import {
  addCreator,
  findDuplicateCreator,
  getCreator,
  listCreators,
  removeCreator,
} from "@/lib/creators/repository";
import { saveResolvedCreator } from "@/lib/creators/service";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function createTempDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-creators-"));
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

const MKBHD = {
  youtubeChannelId: "UCBJycsmduvYEL83R_U4JriQ",
  handle: "mkbhd",
  displayName: "Marques Brownlee",
  channelUrl: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ",
  avatarUrl: "https://yt3.googleusercontent.com/example-avatar",
};

describe("addCreator", () => {
  it("creates a creator and reads it back with all fields", () => {
    const outcome = addCreator(db, MKBHD);
    expect(outcome.status).toBe("created");

    const record = getCreator(db, outcome.creator.id);
    expect(record).toMatchObject({
      id: outcome.creator.id,
      youtubeChannelId: MKBHD.youtubeChannelId,
      handle: "mkbhd",
      displayName: "Marques Brownlee",
      channelUrl: MKBHD.channelUrl,
      avatarUrl: MKBHD.avatarUrl,
    });
    expect(record?.createdAt).toBeTruthy();
    expect(record?.lastRefreshedAt).toBeNull();
  });

  it("makes adding the same canonical channel twice a friendly no-op", () => {
    const first = addCreator(db, MKBHD);
    const second = addCreator(db, { ...MKBHD, displayName: "Renamed Later" });

    expect(first.status).toBe("created");
    expect(second.status).toBe("already_saved");
    expect(second.creator.id).toBe(first.creator.id);
    // Original row untouched by the duplicate attempt.
    expect(getCreator(db, first.creator.id)?.displayName).toBe("Marques Brownlee");
    expect(listCreators(db)).toHaveLength(1);
  });

  it("treats a handle URL as the same creator when the channel ID matches", () => {
    const first = addCreator(db, MKBHD);
    const viaHandle = addCreator(db, {
      ...MKBHD,
      channelUrl: "https://www.youtube.com/@mkbhd",
    });
    expect(viaHandle.status).toBe("already_saved");
    expect(viaHandle.creator.id).toBe(first.creator.id);
  });

  it("falls back to exact canonical URL matching when no channel ID is known", () => {
    const noId = {
      youtubeChannelId: null,
      handle: "someone",
      displayName: "Someone",
      channelUrl: "https://www.youtube.com/@someone",
      avatarUrl: null,
    };
    const first = addCreator(db, noId);
    const duplicate = addCreator(db, { ...noId, displayName: "Someone Else Spelling" });

    expect(duplicate.status).toBe("already_saved");
    expect(duplicate.creator.id).toBe(first.creator.id);

    // A different URL is a genuinely new creator.
    const other = addCreator(db, { ...noId, channelUrl: "https://www.youtube.com/@other" });
    expect(other.status).toBe("created");
    expect(listCreators(db)).toHaveLength(2);
  });

  it("keeps distinct creators distinct", () => {
    addCreator(db, MKBHD);
    addCreator(db, {
      youtubeChannelId: "UCBR8-60-B28hp2BmDPdntcQ",
      handle: "youtube",
      displayName: "YouTube",
      channelUrl: "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      avatarUrl: null,
    });
    expect(listCreators(db)).toHaveLength(2);
  });
});

describe("listCreators and getCreator", () => {
  it("orders creators alphabetically regardless of insertion order", () => {
    addCreator(db, MKBHD);
    addCreator(db, {
      youtubeChannelId: "UCBR8-60-B28hp2BmDPdntcQ",
      handle: "youtube",
      displayName: "aLowercase channel",
      channelUrl: "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      avatarUrl: null,
    });

    const names = listCreators(db).map((creator) => creator.displayName);
    expect(names).toEqual(["aLowercase channel", "Marques Brownlee"]);
  });

  it("returns null for unknown IDs", () => {
    expect(getCreator(db, 9999)).toBeNull();
  });

  it("finds duplicates directly through findDuplicateCreator", () => {
    addCreator(db, MKBHD);
    expect(
      findDuplicateCreator(db, { youtubeChannelId: MKBHD.youtubeChannelId, channelUrl: "x" }),
    ).not.toBeNull();

    // URL-only matching applies to creators saved without a canonical ID;
    // rows that have one are matched by their ID instead.
    addCreator(db, {
      youtubeChannelId: null,
      handle: "someone",
      displayName: "Someone",
      channelUrl: "https://www.youtube.com/@someone",
      avatarUrl: null,
    });
    expect(
      findDuplicateCreator(db, {
        youtubeChannelId: null,
        channelUrl: "HTTPS://WWW.YOUTUBE.COM/@SOMEONE",
      }),
    ).not.toBeNull();
    expect(
      findDuplicateCreator(db, { youtubeChannelId: MKBHD.youtubeChannelId, channelUrl: "" }),
    ).not.toBeNull();
    expect(
      findDuplicateCreator(db, { youtubeChannelId: null, channelUrl: "https://none" }),
    ).toBeNull();
  });
});

describe("removeCreator", () => {
  function insertCreatorWithCachedData(): number {
    const { creator } = addCreator(db, MKBHD);
    db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
      "dQw4w9WgXcQ",
      creator.id,
      "A cached video",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    db.prepare(
      "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
    ).run("dQw4w9WgXcQ", "en", "manual", "cached transcript text");
    return creator.id;
  }

  it("removes the creator and cascades cached videos/transcripts", () => {
    const creatorId = insertCreatorWithCachedData();

    expect(removeCreator(db, creatorId)).toBe(true);

    expect(getCreator(db, creatorId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM videos").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcripts").get()).toEqual({ n: 0 });
  });

  it("reports false when the creator does not exist", () => {
    expect(removeCreator(db, 12345)).toBe(false);
  });
});

describe("saveResolvedCreator (service-level validation)", () => {
  beforeEach(() => {
    runMigrations(db, ALL_MIGRATIONS);
  });

  it("accepts a well-formed resolved payload", () => {
    const outcome = saveResolvedCreator(db, MKBHD);
    expect(outcome.ok).toBe(true);
  });

  it("rejects payloads with non-canonical channel URLs", () => {
    const outcome = saveResolvedCreator(db, {
      ...MKBHD,
      channelUrl: "https://evil.example/@mkbhd",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("invalid_payload");
    }
  });

  it("drops avatar URLs pointing at unexpected hosts instead of storing them", () => {
    const outcome = saveResolvedCreator(db, {
      ...MKBHD,
      avatarUrl: "https://tracker.example/avatar.png",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.creator.avatarUrl).toBeNull();
    }
  });
});
