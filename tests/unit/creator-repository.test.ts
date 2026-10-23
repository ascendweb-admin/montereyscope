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
  listAllCreators,
  listCreators,
  removeCreator,
  setCreatorAvatar,
  setCreatorFollowed,
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

describe("source-only hosts (followed = 0)", () => {
  const HOST = {
    youtubeChannelId: "UCAAAAAAAAAAAAAAAAAAAAAA",
    handle: "hostchannel",
    displayName: "Host Channel",
    channelUrl: "https://www.youtube.com/channel/UCAAAAAAAAAAAAAAAAAAAAAA",
    avatarUrl: null,
  };

  it("follows new creators by default and stores source-only hosts as not followed", () => {
    expect(addCreator(db, MKBHD).creator.followed).toBe(true);
    const host = addCreator(db, { ...HOST, followed: false });
    expect(host.status).toBe("created");
    expect(host.creator.followed).toBe(false);
    expect(getCreator(db, host.creator.id)?.followed).toBe(false);
  });

  it("lists only followed creators, and every creator through listAllCreators", () => {
    addCreator(db, MKBHD);
    addCreator(db, { ...HOST, followed: false });

    expect(listCreators(db).map((creator) => creator.displayName)).toEqual(["Marques Brownlee"]);
    expect(listAllCreators(db).map((creator) => creator.displayName)).toEqual([
      "Host Channel",
      "Marques Brownlee",
    ]);
  });

  it("still de-duplicates against a hidden host", () => {
    const host = addCreator(db, { ...HOST, followed: false }).creator;
    expect(findDuplicateCreator(db, HOST)?.id).toBe(host.id);
    expect(addCreator(db, { ...HOST, followed: false })).toMatchObject({
      status: "already_saved",
      creator: { id: host.id, followed: false },
    });
    expect(listAllCreators(db)).toHaveLength(1);
  });

  it("promotes a hidden host when the channel is added normally, and reports it as created", () => {
    const host = addCreator(db, { ...HOST, followed: false }).creator;

    const added = addCreator(db, { ...HOST, avatarUrl: "https://yt3.googleusercontent.com/host" });

    expect(added.status).toBe("created");
    expect(added.creator).toMatchObject({
      id: host.id,
      followed: true,
      avatarUrl: "https://yt3.googleusercontent.com/host",
    });
    expect(listCreators(db).map((creator) => creator.id)).toEqual([host.id]);
    // Adding it a third time is the usual friendly no-op.
    expect(addCreator(db, HOST).status).toBe("already_saved");
  });

  it("promotes without overwriting an avatar the host already has", () => {
    const host = addCreator(db, {
      ...HOST,
      avatarUrl: "https://yt3.googleusercontent.com/kept",
      followed: false,
    }).creator;
    addCreator(db, { ...HOST, avatarUrl: "https://yt3.googleusercontent.com/new" });
    expect(getCreator(db, host.id)?.avatarUrl).toBe("https://yt3.googleusercontent.com/kept");
  });

  it("leaves a followed channel followed when a source-only add finds it", () => {
    const saved = addCreator(db, HOST).creator;
    expect(addCreator(db, { ...HOST, followed: false })).toMatchObject({
      status: "already_saved",
      creator: { id: saved.id, followed: true },
    });
    expect(getCreator(db, saved.id)?.followed).toBe(true);
  });

  it("flips followed with setCreatorFollowed", () => {
    const { creator } = addCreator(db, { ...HOST, followed: false });
    expect(setCreatorFollowed(db, creator.id, true)).toBe(true);
    expect(getCreator(db, creator.id)?.followed).toBe(true);
    expect(setCreatorFollowed(db, creator.id, false)).toBe(true);
    expect(getCreator(db, creator.id)?.followed).toBe(false);
    expect(setCreatorFollowed(db, 9999, true)).toBe(false);
  });

  it("stores an avatar only from a platform image CDN", () => {
    const { creator } = addCreator(db, { ...HOST, followed: false });
    expect(setCreatorAvatar(db, creator.id, "https://yt3.googleusercontent.com/avatar")).toBe(true);
    expect(getCreator(db, creator.id)?.avatarUrl).toBe("https://yt3.googleusercontent.com/avatar");

    // Anything else changes nothing: other hosts, plain http, and missing rows.
    expect(setCreatorAvatar(db, creator.id, "https://evil.example/avatar.png")).toBe(false);
    expect(setCreatorAvatar(db, creator.id, "http://yt3.googleusercontent.com/avatar")).toBe(false);
    expect(setCreatorAvatar(db, 9999, "https://yt3.googleusercontent.com/avatar")).toBe(false);
    expect(getCreator(db, creator.id)?.avatarUrl).toBe("https://yt3.googleusercontent.com/avatar");
  });

  it("keeps existing creators followed when the column is added by migration 032", () => {
    db.close();
    const dir = mkdtempSync(path.join(tmpdir(), "localtube-creators-old-"));
    tempDirs.push(dir);
    db = new Database(path.join(dir, "test.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(
      db,
      ALL_MIGRATIONS.filter((migration) => migration.id < "032"),
    );
    db.prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)").run(
      "Older channel",
      "https://www.youtube.com/@older",
    );

    runMigrations(db, ALL_MIGRATIONS);

    expect(listCreators(db).map((creator) => [creator.displayName, creator.followed])).toEqual([
      ["Older channel", true],
    ]);
    expect(() =>
      db.prepare("UPDATE creators SET followed = 2 WHERE display_name = 'Older channel'").run(),
    ).toThrow(/CHECK/);
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
