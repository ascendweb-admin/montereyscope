import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { discoveryStdout, failure, routedRunner, youtubeMetadata } from "../helpers/video-import";

// Only the process boundary is faked: the actions, service, resolver, and
// database are the real ones.
const { state, revalidate } = vi.hoisted(() => ({
  state: {
    db: null as unknown,
    run: null as null | ((file: string, args: readonly string[]) => Promise<ExecFileResult>),
    getDbCalls: 0,
  },
  revalidate: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: () => {
    state.getDbCalls += 1;
    return state.db;
  },
}));
vi.mock("@/lib/ytdlp/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ytdlp/runner")>()),
  runCommand: (file: string, args: readonly string[]) => {
    if (state.run === null) throw new Error("yt-dlp must not run");
    return state.run(file, args);
  },
}));
vi.mock("@/app/actions/revalidate-library", () => ({ revalidateLibraryViews: revalidate }));

import { addCreator } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { resetPreviewCacheForTests } from "@/lib/videos/import/preview-cache";
import { attachVideoToProfile } from "@/lib/videos/attribution";
import {
  importVideosAction,
  previewVideoLinkAction,
  removeVideosAction,
} from "@/app/actions/videos";

const tempDirs: string[] = [];
let db: ScopeDatabase;
let profileId: number;
let ytdlpCalls: number;

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const URL_B = "https://www.youtube.com/watch?v=bbbbbbbbbbb";

function metadataFor(id: string): string {
  return youtubeMetadata((payload) => {
    payload.id = id;
    payload.title = `Episode ${id}`;
  });
}

function useRunner(routes: Parameters<typeof routedRunner>[0]) {
  const runner = routedRunner(routes);
  state.run = async (file, args) => {
    ytdlpCalls += 1;
    return runner.run(file, args);
  };
}

beforeEach(() => {
  resetPreviewCacheForTests();
  revalidate.mockReset();
  state.run = null;
  state.getDbCalls = 0;
  ytdlpCalls = 0;
  if (db) db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "scope-video-actions-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
  state.db = db;
  profileId = addCreator(db, {
    youtubeChannelId: null,
    handle: "luke",
    displayName: "Luke",
    channelUrl: "https://www.youtube.com/@luke",
    avatarUrl: null,
  }).creator.profileId;
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const rows = (table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("previewVideoLinkAction: input validation", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { url: URL_A }],
    ["an empty string", ""],
    ["whitespace", "   "],
    ["a very long string", `https://youtu.be/${"a".repeat(2000)}`],
  ])("rejects %s before doing any work", async (_name, url) => {
    const outcome = await previewVideoLinkAction(url);
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input", retryable: false });
    expect(ytdlpCalls).toBe(0);
    expect(state.getDbCalls).toBe(0);
  });

  it.each([
    ["a string", "1"],
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["an object", {}],
  ])("rejects a person id that is %s", async (_name, badProfileId) => {
    const outcome = await previewVideoLinkAction(URL_A, badProfileId);
    expect(outcome).toMatchObject({ ok: false, code: "invalid_input" });
    expect(ytdlpCalls).toBe(0);
  });

  it("answers an unsupported link without running yt-dlp", async () => {
    const outcome = await previewVideoLinkAction("https://vimeo.com/123456789", profileId);
    expect(outcome).toMatchObject({ ok: false, code: "unsupported_site" });
    expect(ytdlpCalls).toBe(0);
  });
});

describe("previewVideoLinkAction: outcomes", () => {
  it("returns exactly the client-safe preview fields", async () => {
    useRunner({
      [URL_A]: {
        metadata: metadataFor("aaaaaaaaaaa"),
        discovery: discoveryStdout("human_english"),
      },
    });
    const outcome = await previewVideoLinkAction(URL_A, profileId);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(Object.keys(outcome.preview).sort()).toEqual(
      [
        "alreadyAttached",
        "alreadyInLibrary",
        "captions",
        "durationSeconds",
        "hostHandle",
        "hostName",
        "hostPlatform",
        "liveStatus",
        "platform",
        "publishedAt",
        "thumbnailUrl",
        "title",
        "url",
        "videoId",
      ].sort(),
    );
    expect(outcome.preview).toMatchObject({
      url: URL_A,
      videoId: "aaaaaaaaaaa",
      title: "Episode aaaaaaaaaaa",
      captions: "manual",
      hostName: "jawed",
      alreadyInLibrary: false,
      alreadyAttached: false,
    });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("subtitles");
    expect(serialized).not.toContain("timedtext");
    expect(serialized).not.toContain("youtubeChannelId");
    // Nothing is written by a preview.
    expect(rows("videos")).toBe(0);
    expect(rows("creators")).toBe(1);
  });

  it("accepts a preview without a person", async () => {
    useRunner({
      [URL_A]: {
        metadata: metadataFor("aaaaaaaaaaa"),
        discovery: discoveryStdout("human_english"),
      },
    });
    expect((await previewVideoLinkAction(URL_A)).ok).toBe(true);
    expect((await previewVideoLinkAction(URL_A, null)).ok).toBe(true);
  });

  it("passes a typed rejection through without stderr or paths", async () => {
    useRunner({
      [URL_A]: {
        metadata: failure("nonzero_exit", "ERROR: /home/me/.config/yt-dlp: Video unavailable"),
        discovery: discoveryStdout("human_english"),
      },
    });
    const outcome = await previewVideoLinkAction(URL_A, profileId);
    expect(outcome).toEqual({
      ok: false,
      code: "unavailable_video",
      message: "YouTube would not serve that video (it may be private, removed, or restricted).",
      retryable: false,
    });
  });

  it("turns an unexpected failure into a generic message", async () => {
    state.run = async () => {
      throw new Error("secret internal detail at /home/me/db.sqlite");
    };
    const outcome = await previewVideoLinkAction(URL_A, profileId);
    expect(outcome).toMatchObject({ ok: false, code: "unexpected_response", retryable: false });
    expect(JSON.stringify(outcome)).not.toContain("secret");
    expect(JSON.stringify(outcome)).not.toContain("/home/");
  });
});

describe("importVideosAction: input validation", () => {
  const valid = { profileId: 1, followHost: false };

  it.each([
    ["undefined", undefined],
    ["a string", URL_A],
    ["an object", { 0: URL_A }],
    ["an empty array", []],
    [
      "31 links",
      Array.from({ length: 31 }, (_, i) => `https://youtu.be/video${String(i).padStart(6, "0")}`),
    ],
    ["a non-string entry", [URL_A, 5]],
    ["a null entry", [URL_A, null]],
    ["an over-long entry", [`https://youtu.be/${"a".repeat(2000)}`]],
  ])("rejects links given as %s", async (_name, urls) => {
    const outcome = await importVideosAction(urls, valid);
    expect(outcome).toMatchObject({ ok: false });
    expect(ytdlpCalls).toBe(0);
    expect(state.getDbCalls).toBe(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["an array", []],
    ["a string", "options"],
    ["no followHost", { profileId: 1 }],
    ["a string followHost", { profileId: 1, followHost: "true" }],
    ["a numeric followHost", { profileId: 1, followHost: 1 }],
    ["no profileId", { followHost: false }],
    ["a string profileId", { profileId: "1", followHost: false }],
    ["a zero profileId", { profileId: 0, followHost: false }],
    ["a fractional profileId", { profileId: 1.5, followHost: false }],
    ["a negative profileId", { profileId: -2, followHost: false }],
    ["no person and no follow", { profileId: null, followHost: false }],
  ])("rejects options given as %s", async (_name, options) => {
    const outcome = await importVideosAction([URL_A], options);
    expect(outcome).toMatchObject({ ok: false });
    expect(ytdlpCalls).toBe(0);
    expect(state.getDbCalls).toBe(0);
    expect(rows("videos")).toBe(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("accepts exactly 30 links", async () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://vimeo.com/${i + 1}`);
    const outcome = await importVideosAction(urls, { profileId, followHost: false });
    expect(outcome.ok && outcome.results).toHaveLength(30);
  });
});

describe("importVideosAction: outcomes", () => {
  it("imports, returns per-row results, and refreshes the library views", async () => {
    useRunner({
      [URL_A]: {
        metadata: metadataFor("aaaaaaaaaaa"),
        discovery: discoveryStdout("human_english"),
      },
      [URL_B]: { metadata: metadataFor("bbbbbbbbbbb"), discovery: discoveryStdout("none") },
    });
    const outcome = await importVideosAction([URL_A, URL_B, "https://vimeo.com/1"], {
      profileId,
      followHost: false,
    });

    expect(outcome).toEqual({
      ok: true,
      results: [
        {
          url: URL_A,
          status: "added",
          videoId: "aaaaaaaaaaa",
          title: "Episode aaaaaaaaaaa",
          hostName: "jawed",
          hostCreatorId: expect.any(Number),
          hostFollowedBefore: false,
        },
        {
          url: URL_B,
          status: "rejected",
          error: {
            code: "no_english_captions",
            message:
              "No original English captions are available for this video. scope currently supports English only.",
            retryable: false,
          },
        },
        {
          url: "https://vimeo.com/1",
          status: "rejected",
          error: {
            code: "unsupported_site",
            message: "scope can import YouTube and Rumble video links for now.",
            retryable: false,
          },
        },
      ],
    });
    expect(rows("videos")).toBe(1);
    expect(rows("profile_videos")).toBe(1);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("does not refresh anything when every row was rejected", async () => {
    const outcome = await importVideosAction(["https://vimeo.com/1"], {
      profileId,
      followHost: false,
    });
    expect(outcome.ok && outcome.results[0].status).toBe("rejected");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("accepts followHost with no person", async () => {
    useRunner({
      [URL_A]: {
        metadata: metadataFor("aaaaaaaaaaa"),
        discovery: discoveryStdout("human_english"),
      },
    });
    const outcome = await importVideosAction([URL_A], { profileId: null, followHost: true });
    expect(outcome.ok && outcome.results[0].status).toBe("added");
    expect(rows("profile_videos")).toBe(0);
  });

  it("turns an unexpected failure into a generic message", async () => {
    state.db = {
      prepare: () => {
        throw new Error("database is on fire: /home/me/localtube.db");
      },
    };
    const outcome = await importVideosAction([URL_A], { profileId, followHost: false });
    expect(outcome).toEqual({
      ok: false,
      message: "The videos could not be added to your library. Please try again.",
    });
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe("removeVideosAction", () => {
  function hostedVideo(id: string, handle: string, followed = false): string {
    const hostId = addCreator(db, {
      youtubeChannelId: null,
      handle,
      displayName: `Host ${handle}`,
      channelUrl: `https://www.youtube.com/@${handle}`,
      avatarUrl: null,
      followed,
    }).creator.id;
    db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
      id,
      hostId,
      `Video ${id}`,
      `https://www.youtube.com/watch?v=${id}`,
    );
    attachVideoToProfile(db, profileId, id);
    return id;
  }

  it.each([
    ["a missing person", undefined, ["aaaaaaaaaaa"]],
    ["a zero person", 0, ["aaaaaaaaaaa"]],
    ["a fractional person", 1.5, ["aaaaaaaaaaa"]],
    ["no ids", 1, []],
    ["a non-array", 1, "aaaaaaaaaaa"],
    ["a non-string id", 1, [42]],
    ["a malformed id", 1, ["../etc/passwd"]],
    ["too many ids", 1, Array.from({ length: 501 }, () => "aaaaaaaaaaa")],
  ])("rejects %s before touching the database", async (_name, person, ids) => {
    const outcome = await removeVideosAction(person, ids);
    expect(outcome.ok).toBe(false);
    expect(state.getDbCalls).toBe(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses a person who is not in the library", async () => {
    const outcome = await removeVideosAction(9999, ["aaaaaaaaaaa"]);
    expect(outcome).toEqual({ ok: false, message: "That person is no longer in your library." });
  });

  it("removes the videos, their hidden hosts, and revalidates", async () => {
    const first = hostedVideo("aaaaaaaaaaa", "one");
    const second = hostedVideo("bbbbbbbbbbb", "two");

    const outcome = await removeVideosAction(profileId, [first, second]);

    expect(outcome).toEqual({ ok: true, removed: 2, deletedVideos: 2, deletedHosts: 2 });
    expect(rows("videos")).toBe(0);
    expect(rows("profile_videos")).toBe(0);
    // Only the person's own channel remains.
    expect(rows("creators")).toBe(1);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("keeps a followed host and its video, and ignores videos not attributed to the person", async () => {
    const kept = hostedVideo("aaaaaaaaaaa", "followed", true);
    const hostId = addCreator(db, {
      youtubeChannelId: null,
      handle: "stranger",
      displayName: "Stranger",
      channelUrl: "https://www.youtube.com/@stranger",
      avatarUrl: null,
      followed: false,
    }).creator.id;
    db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
      "ccccccccccc",
      hostId,
      "Not theirs",
      "https://www.youtube.com/watch?v=ccccccccccc",
    );
    // Another person's appearance: removing it for this person must not touch it.
    const otherPerson = addCreator(db, {
      youtubeChannelId: null,
      handle: "dana",
      displayName: "Dana",
      channelUrl: "https://www.youtube.com/@dana",
      avatarUrl: null,
    }).creator.profileId;
    attachVideoToProfile(db, otherPerson, "ccccccccccc");

    const outcome = await removeVideosAction(profileId, [kept, "ccccccccccc"]);

    expect(outcome).toEqual({ ok: true, removed: 1, deletedVideos: 0, deletedHosts: 0 });
    expect(rows("videos")).toBe(2);
    expect(rows("profile_videos")).toBe(1);
  });

  it("does not revalidate when nothing was removed", async () => {
    const outcome = await removeVideosAction(profileId, ["zzzzzzzzzzz"]);
    expect(outcome).toEqual({ ok: true, removed: 0, deletedVideos: 0, deletedHosts: 0 });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("turns an unexpected failure into a generic message", async () => {
    state.db = {
      prepare: () => {
        throw new Error("database is on fire: /home/me/localtube.db");
      },
    };
    const outcome = await removeVideosAction(profileId, ["aaaaaaaaaaa"]);
    expect(outcome).toEqual({
      ok: false,
      message: "The videos could not be removed. Please try again.",
    });
  });
});
