import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecFileResult } from "@/lib/ytdlp/runner";
import {
  ZOO_CHANNEL_ID,
  ZOO_VIDEO_URL,
  discoveryStdout,
  routedRunner,
  youtubeMetadata,
} from "../helpers/video-import";

// Only the process boundary is faked: the actions, services, resolvers, and
// database are the real ones.
const { state, revalidate } = vi.hoisted(() => ({
  state: {
    db: null as unknown,
    run: null as null | ((file: string, args: readonly string[]) => Promise<ExecFileResult>),
  },
  revalidate: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({ getDb: () => state.db }));
vi.mock("@/lib/ytdlp/runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ytdlp/runner")>()),
  runCommand: (file: string, args: readonly string[]) => {
    if (state.run === null) throw new Error("yt-dlp must not run");
    return state.run(file, args);
  },
}));
vi.mock("@/app/actions/revalidate-library", () => ({ revalidateLibraryViews: revalidate }));

import { followCreatorAction, followVideoChannelAction } from "@/app/actions/creators";
import { importVideosAction } from "@/app/actions/videos";
import { createCategory } from "@/lib/categories/repository";
import { addCreator, getCreator } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { resetPreviewCacheForTests } from "@/lib/videos/import/preview-cache";
import { insertVideoIfMissing } from "@/lib/videos/repository";

const tempDirs: string[] = [];
let db: ScopeDatabase;
let ytdlpCalls: string[][];

const CHANNEL_URL = `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`;
const AVATAR = "https://yt3.googleusercontent.com/example-avatar-3333";

/** What yt-dlp says about the channel page (the avatar lookup). */
const channelPayload = JSON.stringify({
  channel_id: ZOO_CHANNEL_ID,
  channel: "jawed",
  uploader_id: "@jawed",
  thumbnails: [{ url: AVATAR, width: 900, height: 900 }],
});

function useRunner(options: { captions?: "human_english" | "none"; channel?: boolean } = {}) {
  const runner = routedRunner({
    [ZOO_VIDEO_URL]: {
      metadata: youtubeMetadata(),
      discovery: discoveryStdout(options.captions ?? "human_english"),
    },
    ...(options.channel === false ? {} : { [CHANNEL_URL]: { metadata: channelPayload } }),
  });
  state.run = async (file, args) => {
    ytdlpCalls.push([...args]);
    return runner.run(file, args);
  };
}

beforeEach(() => {
  resetPreviewCacheForTests();
  revalidate.mockReset();
  state.run = null;
  ytdlpCalls = [];
  if (db) db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "scope-creator-follow-actions-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
  state.db = db;
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const rows = (table: string) =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

function hiddenHost() {
  const { creator } = addCreator(db, {
    youtubeChannelId: ZOO_CHANNEL_ID,
    handle: "jawed",
    displayName: "jawed",
    channelUrl: CHANNEL_URL,
    avatarUrl: null,
    followed: false,
  });
  insertVideoIfMissing(db, creator.id, {
    id: "hostvideo01",
    title: "Me at the zoo",
    url: "https://www.youtube.com/watch?v=hostvideo01",
    thumbnailUrl: null,
    publishedAt: null,
    durationSeconds: 19,
    liveStatus: "not_live",
    description: null,
  });
  return creator;
}

describe("followCreatorAction", () => {
  it("follows a source-only channel, gives it its picture, and refreshes the library views", async () => {
    useRunner();
    const host = hiddenHost();

    const outcome = await followCreatorAction(host.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.creator).toMatchObject({
      id: host.id,
      profileId: host.profileId,
      avatarUrl: AVATAR,
    });
    expect(getCreator(db, host.id)).toMatchObject({ followed: true, avatarUrl: AVATAR });
    expect(revalidate).toHaveBeenCalledTimes(1);
    // The caller starts the feed refresh; the action fetched only the channel page.
    expect(ytdlpCalls).toHaveLength(1);
    expect(ytdlpCalls[0].at(-1)).toBe(CHANNEL_URL);
  });

  it("still follows when the picture lookup fails", async () => {
    useRunner({ channel: false });
    const host = hiddenHost();
    const outcome = await followCreatorAction(host.id);
    expect(outcome.ok && outcome.creator.avatarUrl).toBeNull();
    expect(getCreator(db, host.id)?.followed).toBe(true);
  });

  it("refuses a creator that is already followed", async () => {
    useRunner();
    const { creator } = addCreator(db, {
      youtubeChannelId: null,
      handle: "luke",
      displayName: "Luke",
      channelUrl: "https://www.youtube.com/@luke",
      avatarUrl: null,
    });
    const outcome = await followCreatorAction(creator.id);
    expect(outcome).toEqual({ ok: false, message: "Luke is already in your library." });
    expect(revalidate).not.toHaveBeenCalled();
    expect(ytdlpCalls).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["a string", "3"],
    ["zero", 0],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["an object", {}],
  ])("rejects an id that is %s", async (_name, id) => {
    const outcome = await followCreatorAction(id);
    expect(outcome).toEqual({ ok: false, message: "That channel is not valid." });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("says so when the channel is gone", async () => {
    const outcome = await followCreatorAction(9999);
    expect(outcome).toEqual({
      ok: false,
      message: "That channel is no longer in your library.",
    });
  });

  it("turns an unexpected failure into a generic message", async () => {
    state.db = {
      prepare: () => {
        throw new Error("database is on fire: /home/me/localtube.db");
      },
    };
    const outcome = await followCreatorAction(1);
    expect(outcome).toEqual({
      ok: false,
      message: "The channel could not be followed. Please try again.",
    });
  });
});

describe("followVideoChannelAction", () => {
  it("follows the video's channel with its picture and categories", async () => {
    useRunner();
    const categoryId = createCategory(db, { name: "Markets", color: "emerald" }).id;

    const outcome = await followVideoChannelAction(ZOO_VIDEO_URL, [categoryId]);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("created");
    expect(outcome.creator).toMatchObject({
      displayName: "jawed",
      avatarUrl: AVATAR,
      categories: [expect.objectContaining({ name: "Markets" })],
    });
    expect(getCreator(db, outcome.creator.id)).toMatchObject({
      followed: true,
      lastRefreshedAt: null,
    });
    expect(rows("videos")).toBe(1);
    expect(rows("profile_videos")).toBe(0);
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("answers a rejected video with its reason and saves nothing", async () => {
    useRunner({ captions: "none" });
    const outcome = await followVideoChannelAction(ZOO_VIDEO_URL, []);
    expect(outcome).toMatchObject({
      ok: false,
      code: "no_english_captions",
      retryable: false,
    });
    expect(rows("creators")).toBe(0);
    expect(rows("videos")).toBe(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ["undefined", undefined],
    ["a number", 42],
    ["a channel link", "https://www.youtube.com/@mkbhd"],
    ["another site", "https://vimeo.com/12345"],
    ["text", "not a link"],
    ["a very long string", `https://youtu.be/${"a".repeat(2000)}`],
  ])("rejects %s before doing any work", async (_name, url) => {
    const outcome = await followVideoChannelAction(url);
    expect(outcome).toMatchObject({ ok: false, code: "invalid_link", retryable: false });
    expect(ytdlpCalls).toEqual([]);
    expect(rows("creators")).toBe(0);
  });

  it("rejects a category list that is not valid", async () => {
    useRunner();
    const outcome = await followVideoChannelAction(ZOO_VIDEO_URL, ["x"]);
    expect(outcome).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(ytdlpCalls).toEqual([]);
  });

  it("turns an unexpected failure into a generic message", async () => {
    state.db = {
      prepare: () => {
        throw new Error("database is on fire: /home/me/localtube.db");
      },
    };
    const outcome = await followVideoChannelAction(ZOO_VIDEO_URL, []);
    // The import engine turns a failed row into its own plain message.
    expect(outcome).toEqual({
      ok: false,
      code: "unexpected_response",
      message: "scope could not save that video. Please try again.",
      retryable: false,
    });
    expect(JSON.stringify(outcome)).not.toContain("on fire");
  });
});

describe("importVideosAction: channel pictures", () => {
  function luke(): number {
    return addCreator(db, {
      youtubeChannelId: null,
      handle: "luke",
      displayName: "Luke",
      channelUrl: "https://www.youtube.com/@luke",
      avatarUrl: null,
    }).creator.profileId;
  }

  it("gives a channel followed by the import its picture", async () => {
    useRunner();
    const outcome = await importVideosAction([ZOO_VIDEO_URL], {
      profileId: luke(),
      followHost: true,
    });
    expect(outcome.ok && outcome.results[0].status).toBe("added");
    const hostId = Number(outcome.ok && outcome.results[0].hostCreatorId);
    expect(getCreator(db, hostId)).toMatchObject({ followed: true, avatarUrl: AVATAR });
  });

  it("looks no picture up for a channel that stays a source-only host", async () => {
    useRunner();
    const outcome = await importVideosAction([ZOO_VIDEO_URL], {
      profileId: luke(),
      followHost: false,
    });
    expect(outcome.ok && outcome.results[0].status).toBe("added");
    const hostId = Number(outcome.ok && outcome.results[0].hostCreatorId);
    expect(getCreator(db, hostId)).toMatchObject({ followed: false, avatarUrl: null });
    expect(ytdlpCalls.some((args) => args.at(-1) === CHANNEL_URL)).toBe(false);
  });

  it("still imports when the picture cannot be found", async () => {
    useRunner({ channel: false });
    const outcome = await importVideosAction([ZOO_VIDEO_URL], {
      profileId: luke(),
      followHost: true,
    });
    expect(outcome.ok && outcome.results[0].status).toBe("added");
    const hostId = Number(outcome.ok && outcome.results[0].hostCreatorId);
    expect(getCreator(db, hostId)).toMatchObject({ followed: true, avatarUrl: null });
  });
});
