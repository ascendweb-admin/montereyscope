import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addCreator,
  getCreator,
  listAllCreators,
  listCreators,
  type CreatorRecord,
} from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { saveTranscript } from "@/lib/transcripts/repository";
import { attachVideoToProfile, listVideoProfileIds } from "@/lib/videos/attribution";
import { mapWithConcurrency } from "@/lib/videos/import/pool";
import {
  cachePreview,
  getCachedPreview,
  resetPreviewCacheForTests,
} from "@/lib/videos/import/preview-cache";
import type { ResolvedVideo } from "@/lib/videos/import/resolve";
import {
  importVideos,
  MAX_IMPORT_URLS,
  previewVideoLink,
  type ImportVideosInput,
} from "@/lib/videos/import/service";
import { insertVideoIfMissing, mergeCreatorFeed } from "@/lib/videos/repository";
import {
  RUMBLE_VIDEO_URL,
  ZOO_CHANNEL_ID,
  discoveryStdout,
  failure,
  fakeRunner,
  type FakeReply,
  isMetadataJob,
  rumbleMetadata,
  routedRunner,
  youtubeMetadata,
} from "../helpers/video-import";

const tempDirs: string[] = [];
let db: ScopeDatabase;

beforeEach(() => {
  resetPreviewCacheForTests();
  if (db) db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "scope-video-import-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHANNEL_A = ZOO_CHANNEL_ID;
const CHANNEL_B = "UC9999999999999999999999";

function count(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function storedVideo(id: string) {
  return db.prepare("SELECT * FROM videos WHERE id = ?").get(id) as
    { id: string; creator_id: number; title: string; fetched_at: string } | undefined;
}

/** A person the user follows: one followed channel and its profile. */
function person(name: string, handle: string): { creator: CreatorRecord; profileId: number } {
  const { creator } = addCreator(db, {
    youtubeChannelId: null,
    handle,
    displayName: name,
    channelUrl: `https://www.youtube.com/@${handle}`,
    avatarUrl: null,
  });
  return { creator, profileId: creator.profileId };
}

interface FakeVideo {
  id: string;
  url: string;
  metadata: FakeReply;
  discovery: FakeReply;
}

/** A resolvable YouTube video on `channelId`, with human English captions. */
function fakeVideo(
  id: string,
  { channelId = CHANNEL_A, channelName = "Host Channel" } = {},
): FakeVideo {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    metadata: youtubeMetadata((payload) => {
      payload.id = id;
      payload.title = `Episode ${id}`;
      payload.channel_id = channelId;
      payload.channel = channelName;
      payload.uploader_id = "@hostchannel";
    }),
    discovery: discoveryStdout("human_english"),
  };
}

function routes(...videos: FakeVideo[]) {
  return routedRunner(
    Object.fromEntries(
      videos.map((video) => [video.url, { metadata: video.metadata, discovery: video.discovery }]),
    ),
  );
}

function deps(run: ReturnType<typeof routedRunner>["run"] | ReturnType<typeof fakeRunner>["run"]) {
  return { command: "yt-dlp", run, throttleRetryMs: 0 };
}

async function run(
  input: Partial<ImportVideosInput> & { urls: string[] },
  runner: { run: ReturnType<typeof fakeRunner>["run"] },
) {
  const { results } = await importVideos(
    db,
    { profileId: null, followHost: false, ...input },
    deps(runner.run),
  );
  return results;
}

const A = fakeVideo("aaaaaaaaaaa");
const B = fakeVideo("bbbbbbbbbbb");
const C = fakeVideo("ccccccccccc");

// ---------------------------------------------------------------------------
// importVideos
// ---------------------------------------------------------------------------

describe("importVideos: new videos", () => {
  it("adds the video under a hidden host and attributes it to the person", async () => {
    const { profileId } = person("Luke", "luke");
    const results = await run({ urls: [A.url], profileId }, routes(A));

    expect(results).toEqual([
      {
        url: A.url,
        status: "added",
        videoId: A.id,
        title: `Episode ${A.id}`,
        hostName: "Host Channel",
        hostCreatorId: expect.any(Number),
        hostFollowedBefore: false,
      },
    ]);
    const video = storedVideo(A.id);
    expect(video).toBeDefined();
    expect(results[0].hostCreatorId).toBe(Number(video?.creator_id));
    const host = getCreator(db, Number(video?.creator_id));
    expect(host).toMatchObject({
      platform: "youtube",
      youtubeChannelId: CHANNEL_A,
      handle: "hostchannel",
      displayName: "Host Channel",
      avatarUrl: null,
      followed: false,
      lastRefreshedAt: null,
    });
    expect(listVideoProfileIds(db, A.id)).toEqual([profileId]);
    // Hidden from every library surface.
    expect(listCreators(db).map((creator) => creator.displayName)).toEqual(["Luke"]);
    expect(listAllCreators(db)).toHaveLength(2);
  });

  it("shares one hidden host between videos on the same channel", async () => {
    const { profileId } = person("Luke", "luke");
    const results = await run({ urls: [A.url, B.url], profileId }, routes(A, B));

    expect(results.map((row) => row.status)).toEqual(["added", "added"]);
    expect(count("creators")).toBe(2);
    expect(storedVideo(A.id)?.creator_id).toBe(storedVideo(B.id)?.creator_id);
  });

  it("imports a Rumble video with its channel as the host", async () => {
    const { profileId } = person("Luke", "luke");
    const runner = routedRunner({
      [RUMBLE_VIDEO_URL]: {
        metadata: rumbleMetadata(),
        discovery: discoveryStdout("human_english"),
      },
    });
    const results = await run(
      { urls: ["https://rumble.com/v7emyxa-some-title.html"], profileId },
      runner,
    );

    expect(results[0]).toMatchObject({
      status: "added",
      videoId: "v7emyxa",
      url: RUMBLE_VIDEO_URL,
    });
    const host = getCreator(db, Number(storedVideo("v7emyxa")?.creator_id));
    expect(host).toMatchObject({
      platform: "rumble",
      youtubeChannelId: null,
      handle: "redacted",
      displayName: "Redacted News",
      channelUrl: "https://rumble.com/c/Redacted",
      followed: false,
    });
  });

  it("returns canonical links as row urls and collapses duplicates", async () => {
    const { profileId } = person("Luke", "luke");
    const results = await run(
      {
        urls: [
          `https://youtu.be/${A.id}?si=x`,
          A.url,
          `https://www.youtube.com/watch?v=${A.id}&t=9`,
        ],
        profileId,
      },
      routes(A),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ url: A.url, status: "added" });
  });

  it("keeps rows in input order", async () => {
    const { profileId } = person("Luke", "luke");
    const slow = routes(A, B, C);
    const results = await run({ urls: [C.url, A.url, B.url], profileId }, slow);
    expect(results.map((row) => row.videoId)).toEqual([C.id, A.id, B.id]);
  });
});

describe("importVideos: hosts", () => {
  it("reuses a followed host untouched, without hiding or duplicating it", async () => {
    const { profileId } = person("Luke", "luke");
    const { creator: host } = addCreator(db, {
      youtubeChannelId: CHANNEL_A,
      handle: "hostchannel",
      displayName: "Host Channel (library name)",
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_A}`,
      avatarUrl: "https://yt3.ggpht.com/avatar",
    });
    const before = count("creators");

    const results = await run({ urls: [A.url], profileId }, routes(A));

    expect(results[0].status).toBe("added");
    expect(count("creators")).toBe(before);
    expect(storedVideo(A.id)?.creator_id).toBe(host.id);
    expect(getCreator(db, host.id)).toMatchObject({
      followed: true,
      displayName: "Host Channel (library name)",
      avatarUrl: "https://yt3.ggpht.com/avatar",
      lastRefreshedAt: null,
    });
  });

  it("does not hide a followed host when followHost is false", async () => {
    const { profileId } = person("Luke", "luke");
    const { creator: host } = addCreator(db, {
      youtubeChannelId: CHANNEL_A,
      handle: "hostchannel",
      displayName: "Host Channel",
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_A}`,
      avatarUrl: null,
    });
    await run({ urls: [A.url], profileId, followHost: false }, routes(A));
    expect(getCreator(db, host.id)?.followed).toBe(true);
  });

  it("with followHost, saves a new host as a followed creator", async () => {
    const { profileId } = person("Luke", "luke");
    await run({ urls: [A.url], profileId, followHost: true }, routes(A));

    const host = getCreator(db, Number(storedVideo(A.id)?.creator_id));
    expect(host).toMatchObject({ followed: true, displayName: "Host Channel" });
    expect(
      listCreators(db)
        .map((creator) => creator.displayName)
        .sort(),
    ).toEqual(["Host Channel", "Luke"]);
  });

  it("with followHost, flips an existing hidden host", async () => {
    const { profileId } = person("Luke", "luke");
    await run({ urls: [A.url], profileId }, routes(A));
    const hostId = Number(storedVideo(A.id)?.creator_id);
    expect(getCreator(db, hostId)?.followed).toBe(false);

    const results = await run({ urls: [B.url], profileId, followHost: true }, routes(B));

    expect(results[0].status).toBe("added");
    expect(count("creators")).toBe(2);
    expect(storedVideo(B.id)?.creator_id).toBe(hostId);
    expect(getCreator(db, hostId)?.followed).toBe(true);
  });

  it("with followHost, flips the stored host of a video that is already cached", async () => {
    const { profileId } = person("Luke", "luke");
    const other = person("Maya", "maya");
    await run({ urls: [A.url], profileId }, routes(A));
    const hostId = Number(storedVideo(A.id)?.creator_id);
    resetPreviewCacheForTests();

    const results = await run(
      { urls: [A.url], profileId: other.profileId, followHost: true },
      routes(A),
    );

    expect(results[0].status).toBe("attached_existing");
    expect(getCreator(db, hostId)?.followed).toBe(true);
    expect(count("creators")).toBe(3);
  });

  it("reports whether the host was already followed before the import", async () => {
    const { profileId } = person("Luke", "luke");
    // New host: not followed before, whether or not it is followed now.
    const first = await run({ urls: [A.url], profileId, followHost: true }, routes(A));
    expect(first[0].hostFollowedBefore).toBe(false);
    // The same channel again, now followed.
    const second = await run({ urls: [B.url], profileId, followHost: false }, routes(B));
    expect(second[0]).toMatchObject({
      hostCreatorId: first[0].hostCreatorId,
      hostFollowedBefore: true,
    });
  });

  it("reports a hidden host that is only now being promoted as not followed before", async () => {
    const { profileId } = person("Luke", "luke");
    const first = await run({ urls: [A.url], profileId }, routes(A));
    const promoted = await run({ urls: [B.url], profileId, followHost: true }, routes(B));
    expect(promoted[0]).toMatchObject({
      hostCreatorId: first[0].hostCreatorId,
      hostFollowedBefore: false,
    });
  });

  it("with no person, saves a followed host and attributes nothing", async () => {
    const results = await run({ urls: [A.url], profileId: null, followHost: true }, routes(A));

    expect(results[0].status).toBe("added");
    expect(getCreator(db, Number(storedVideo(A.id)?.creator_id))?.followed).toBe(true);
    expect(count("profile_videos")).toBe(0);
  });
});

describe("importVideos: videos that already exist", () => {
  /** A followed host whose feed already cached a video, refreshed at a known time. */
  function feedVideo(id = A.id) {
    const { creator } = addCreator(db, {
      youtubeChannelId: CHANNEL_B,
      handle: "feedhost",
      displayName: "Feed Host",
      channelUrl: `https://www.youtube.com/channel/${CHANNEL_B}`,
      avatarUrl: null,
    });
    mergeCreatorFeed(db, {
      creatorId: creator.id,
      refreshedAt: "2026-10-01T08:00:00.000Z",
      videos: [
        {
          id,
          title: "From the feed",
          url: `https://www.youtube.com/watch?v=${id}`,
          thumbnailUrl: null,
          publishedAt: "2026-09-30T00:00:00.000Z",
          durationSeconds: 100,
          liveStatus: "not_live",
          description: null,
        },
      ],
    });
    return creator;
  }

  it("attaches without reassigning the creator or stamping a refresh", async () => {
    const { profileId } = person("Luke", "luke");
    const host = feedVideo();
    saveTranscript(
      db,
      { videoId: A.id, language: "en", source: "manual", plainText: "words" },
      "2026-10-02T00:00:00.000Z",
    );
    const fetchedAt = storedVideo(A.id)?.fetched_at;
    const creatorsBefore = count("creators");

    const runner = routes();
    const results = await run({ urls: [A.url], profileId }, runner);

    expect(results).toEqual([
      {
        url: A.url,
        status: "attached_existing",
        videoId: A.id,
        title: "From the feed",
        hostName: "Feed Host",
        hostCreatorId: host.id,
        hostFollowedBefore: true,
      },
    ]);
    expect(runner.calls).toEqual([]);
    expect(storedVideo(A.id)).toMatchObject({
      creator_id: host.id,
      title: "From the feed",
      fetched_at: fetchedAt,
    });
    expect(getCreator(db, host.id)?.lastRefreshedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(count("creators")).toBe(creatorsBefore);
    expect(listVideoProfileIds(db, A.id)).toEqual([profileId]);
  });

  it("checks captions for an existing video that has no transcript yet", async () => {
    const { profileId } = person("Luke", "luke");
    feedVideo();
    const runner = routes(A);
    const results = await run({ urls: [A.url], profileId }, runner);

    expect(results[0].status).toBe("attached_existing");
    expect(runner.runnerFor(A.url).metadataCalls()).toEqual([]);
    expect(runner.runnerFor(A.url).discoveryCalls()).toHaveLength(1);
  });

  it("never leaves a hidden host behind when the video turned out to be cached elsewhere", async () => {
    const { profileId } = person("Luke", "luke");
    // The preview resolved the video onto channel A before it was cached...
    const runner = routes(A);
    await previewVideoLink(db, A.url, profileId, deps(runner.run));
    // ...then a feed refresh cached the same video under another channel.
    const host = feedVideo();

    const results = await run({ urls: [A.url], profileId }, runner);

    expect(results[0].status).toBe("attached_existing");
    expect(storedVideo(A.id)?.creator_id).toBe(host.id);
    expect(
      listAllCreators(db)
        .map((creator) => creator.displayName)
        .sort(),
    ).toEqual(["Feed Host", "Luke"]);
  });

  it("rejects an existing video that has no English captions", async () => {
    const { profileId } = person("Luke", "luke");
    feedVideo();
    const results = await run(
      { urls: [A.url], profileId },
      routes({ ...A, discovery: discoveryStdout("none") }),
    );
    expect(results[0]).toMatchObject({
      status: "rejected",
      error: { code: "no_english_captions" },
    });
    expect(count("profile_videos")).toBe(0);
  });

  it("is idempotent: importing again changes nothing", async () => {
    const { profileId } = person("Luke", "luke");
    const first = await run({ urls: [A.url], profileId }, routes(A));
    const snapshot = {
      creators: count("creators"),
      videos: count("videos"),
      attributions: count("profile_videos"),
    };

    const second = await run({ urls: [A.url], profileId }, routes(A));
    resetPreviewCacheForTests();
    const third = await run({ urls: [A.url], profileId }, routes(A));

    expect(first[0].status).toBe("added");
    expect(second[0]).toMatchObject({ status: "already_attached", videoId: A.id });
    expect(third[0].status).toBe("already_attached");
    expect({
      creators: count("creators"),
      videos: count("videos"),
      attributions: count("profile_videos"),
    }).toEqual(snapshot);
  });

  it("attaches the same video to a second person", async () => {
    const luke = person("Luke", "luke");
    const maya = person("Maya", "maya");
    await run({ urls: [A.url], profileId: luke.profileId }, routes(A));
    const results = await run({ urls: [A.url], profileId: maya.profileId }, routes(A));

    expect(results[0].status).toBe("attached_existing");
    expect(listVideoProfileIds(db, A.id)).toEqual([luke.profileId, maya.profileId]);
    expect(count("videos")).toBe(1);
  });

  it("does nothing for a cached video the person already has", async () => {
    const { profileId } = person("Luke", "luke");
    const host = feedVideo();
    insertVideoIfMissing(db, host.id, {
      id: B.id,
      title: "Other",
      url: B.url,
      thumbnailUrl: null,
      publishedAt: null,
      durationSeconds: null,
      liveStatus: "not_live",
      description: null,
    });
    attachVideoToProfile(db, profileId, B.id);

    const results = await run({ urls: [B.url], profileId }, routes(B));
    expect(results[0].status).toBe("already_attached");
  });
});

describe("importVideos: input rules", () => {
  it("rejects every row when there is no person and the host is not followed", async () => {
    const runner = routes(A, B);
    const results = await run({ urls: [A.url, B.url, "not a link"], profileId: null }, runner);

    expect(results).toHaveLength(3);
    for (const row of results) {
      expect(row).toMatchObject({ status: "rejected", error: { code: "invalid_input" } });
    }
    expect(runner.calls).toEqual([]);
    expect(count("videos")).toBe(0);
    expect(count("creators")).toBe(0);
  });

  it.each([
    ["an unknown id", 9999],
    ["zero", 0],
    ["a negative id", -3],
    ["a fractional id", 1.5],
  ])("rejects every row for %s", async (_name, profileId) => {
    person("Luke", "luke");
    const runner = routes(A);
    const results = await run({ urls: [A.url], profileId }, runner);

    expect(results).toEqual([
      {
        url: A.url,
        status: "rejected",
        error: {
          code: "invalid_input",
          message: "That person is no longer in your library.",
          retryable: false,
        },
      },
    ]);
    expect(runner.calls).toEqual([]);
    expect(count("videos")).toBe(0);
  });

  it("does not accept a hidden host's profile as a person", async () => {
    const { profileId } = person("Luke", "luke");
    await run({ urls: [A.url], profileId }, routes(A));
    const hidden = listAllCreators(db).find((creator) => !creator.followed);

    const results = await run({ urls: [B.url], profileId: hidden?.profileId ?? 0 }, routes(B));
    expect(results[0]).toMatchObject({ status: "rejected", error: { code: "invalid_input" } });
    expect(storedVideo(B.id)).toBeUndefined();
  });

  it("returns nothing for no links", async () => {
    const { profileId } = person("Luke", "luke");
    expect(await run({ urls: [], profileId }, routes())).toEqual([]);
  });

  it("lists links that cannot be parsed as rejected rows with their text", async () => {
    const { profileId } = person("Luke", "luke");
    const results = await run(
      {
        urls: [
          "https://vimeo.com/123456789",
          "https://www.youtube.com/@pbdpodcast",
          "  nonsense  ",
          A.url,
        ],
        profileId,
      },
      routes(A),
    );

    expect(results.map((row) => [row.url, row.status, row.error?.code])).toEqual([
      ["https://vimeo.com/123456789", "rejected", "unsupported_site"],
      ["https://www.youtube.com/@pbdpodcast", "rejected", "invalid_link"],
      ["nonsense", "rejected", "invalid_link"],
      [A.url, "added", undefined],
    ]);
  });

  it("handles at most 30 links", async () => {
    const { profileId } = person("Luke", "luke");
    const videos = Array.from({ length: 33 }, (_, index) =>
      fakeVideo(`video${String(index).padStart(6, "0")}`),
    );
    const results = await run(
      { urls: videos.map((video) => video.url), profileId },
      routes(...videos),
    );

    expect(MAX_IMPORT_URLS).toBe(30);
    expect(results).toHaveLength(30);
    expect(results.map((row) => row.videoId)).toEqual(videos.slice(0, 30).map((video) => video.id));
  });
});

describe("importVideos: partial success", () => {
  it("imports what it can, reports the rest, and writes nothing for rejected rows", async () => {
    const { profileId } = person("Luke", "luke");
    const noCaptions = { ...B, discovery: discoveryStdout("none") };
    const gone = { ...C, metadata: failure("nonzero_exit", "ERROR: Video unavailable") };
    const throttled = fakeVideo("ddddddddddd");

    const runner = routedRunner({
      [A.url]: { metadata: A.metadata, discovery: A.discovery },
      [noCaptions.url]: { metadata: noCaptions.metadata, discovery: noCaptions.discovery },
      [gone.url]: { metadata: gone.metadata, discovery: gone.discovery },
      [throttled.url]: {
        metadata: failure("nonzero_exit", "HTTP Error 429: Too Many Requests"),
        discovery: throttled.discovery,
      },
    });
    const results = await run(
      { urls: [A.url, noCaptions.url, gone.url, throttled.url], profileId },
      runner,
    );

    expect(results.map((row) => [row.videoId ?? row.url, row.status, row.error?.code])).toEqual([
      [A.id, "added", undefined],
      [noCaptions.url, "rejected", "no_english_captions"],
      [gone.url, "rejected", "unavailable_video"],
      [throttled.url, "rejected", "throttled"],
    ]);
    expect(results[3].error?.retryable).toBe(true);
    expect(results[1].error?.retryable).toBe(false);

    expect(count("videos")).toBe(1);
    expect(count("profile_videos")).toBe(1);
    // Only the good video's host exists besides the person.
    expect(count("creators")).toBe(2);
  });

  it("does not let a thrown failure block the other rows", async () => {
    const { profileId } = person("Luke", "luke");
    const boom = vi.fn(async (_file: string, args: readonly string[]) => {
      if (args.at(-1) === B.url) {
        throw new Error("spawn exploded");
      }
      return routes(A).run(_file, args);
    });
    const { results } = await importVideos(
      db,
      { urls: [B.url, A.url], profileId, followHost: false },
      deps(boom),
    );

    expect(results[0]).toMatchObject({
      url: B.url,
      status: "rejected",
      error: { code: "unexpected_response", retryable: false },
    });
    expect(results[0].error?.message).not.toContain("exploded");
    expect(results[1].status).toBe("added");
  });

  it("resolves at most three links at a time", async () => {
    const { profileId } = person("Luke", "luke");
    const videos = Array.from({ length: 8 }, (_, index) =>
      fakeVideo(`video${String(index).padStart(6, "0")}`),
    );
    const inner = routes(...videos);
    let inFlight = 0;
    let peak = 0;
    const tracked = async (file: string, args: readonly string[]) => {
      if (isMetadataJob(args)) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      }
      return inner.run(file, args);
    };
    const { results } = await importVideos(
      db,
      { urls: videos.map((video) => video.url), profileId, followHost: false },
      deps(tracked),
    );

    expect(results.every((row) => row.status === "added")).toBe(true);
    expect(peak).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Preview cache
// ---------------------------------------------------------------------------

describe("preview cache", () => {
  it("lets an import reuse what a preview just resolved", async () => {
    const { profileId } = person("Luke", "luke");
    const runner = routes(A);

    const preview = await previewVideoLink(db, A.url, profileId, deps(runner.run));
    expect(preview.ok).toBe(true);
    const lookups = runner.calls.length;
    expect(lookups).toBe(2);

    const results = await run({ urls: [A.url], profileId }, runner);
    expect(results[0].status).toBe("added");
    expect(runner.calls).toHaveLength(lookups);
  });

  it("resolves again on a miss", async () => {
    const { profileId } = person("Luke", "luke");
    const runner = routes(A);
    await previewVideoLink(db, A.url, profileId, deps(runner.run));
    resetPreviewCacheForTests();
    await run({ urls: [A.url], profileId }, runner);
    expect(runner.calls).toHaveLength(4);
  });

  it("forgets entries after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
    const { profileId } = person("Luke", "luke");
    const runner = routes(A);
    await previewVideoLink(db, A.url, profileId, deps(runner.run));
    expect(getCachedPreview(A.url)).not.toBeNull();

    vi.setSystemTime(new Date("2026-10-23T10:09:59Z"));
    expect(getCachedPreview(A.url)).not.toBeNull();
    vi.setSystemTime(new Date("2026-10-23T10:10:01Z"));
    expect(getCachedPreview(A.url)).toBeNull();

    await run({ urls: [A.url], profileId }, runner);
    expect(runner.calls).toHaveLength(4);
  });

  it("keeps at most 200 entries and drops the oldest", () => {
    const resolved = (index: number): ResolvedVideo => {
      const video = fakeVideo(`video${String(index).padStart(6, "0")}`);
      return {
        platform: "youtube",
        videoId: video.id,
        url: video.url,
        draft: {
          id: video.id,
          title: "t",
          url: video.url,
          thumbnailUrl: null,
          publishedAt: null,
          durationSeconds: null,
          liveStatus: "not_live",
          description: null,
        },
        host: {
          platform: "youtube",
          youtubeChannelId: CHANNEL_A,
          handle: null,
          displayName: "h",
          channelUrl: "https://www.youtube.com/channel/" + CHANNEL_A,
        },
        captions: "manual",
        inLibrary: null,
      };
    };
    for (let index = 0; index < 201; index += 1) {
      cachePreview(resolved(index));
    }
    expect(getCachedPreview(resolved(0).url)).toBeNull();
    expect(getCachedPreview(resolved(1).url)).not.toBeNull();
    expect(getCachedPreview(resolved(200).url)).not.toBeNull();
  });

  it("never caches a failed resolution", async () => {
    const { profileId } = person("Luke", "luke");
    const runner = routes({ ...A, metadata: failure("nonzero_exit", "HTTP Error 429") });
    const first = await previewVideoLink(db, A.url, profileId, deps(runner.run));
    expect(first.ok).toBe(false);
    expect(getCachedPreview(A.url)).toBeNull();

    const callsAfterFirst = runner.calls.length;
    await previewVideoLink(db, A.url, profileId, deps(runner.run));
    expect(runner.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// previewVideoLink
// ---------------------------------------------------------------------------

describe("previewVideoLink", () => {
  it("returns only client-safe fields", async () => {
    const { profileId } = person("Luke", "luke");
    const outcome = await previewVideoLink(db, A.url, profileId, deps(routes(A).run));

    expect(outcome).toEqual({
      ok: true,
      preview: {
        url: A.url,
        videoId: A.id,
        platform: "youtube",
        title: `Episode ${A.id}`,
        thumbnailUrl: expect.stringMatching(/^https:\/\/i\.ytimg\.com\//),
        durationSeconds: 19,
        publishedAt: "2005-04-24T03:31:52.000Z",
        liveStatus: "not_live",
        hostName: "Host Channel",
        hostHandle: "hostchannel",
        hostPlatform: "youtube",
        captions: "manual",
        alreadyInLibrary: false,
        alreadyAttached: false,
      },
    });
  });

  it("reads the library state fresh even when the resolution is cached", async () => {
    const { profileId } = person("Luke", "luke");
    const runner = routes(A);
    const first = await previewVideoLink(db, A.url, profileId, deps(runner.run));
    expect(first.ok && first.preview).toMatchObject({
      alreadyInLibrary: false,
      alreadyAttached: false,
    });

    await run({ urls: [A.url], profileId }, runner);
    const other = person("Maya", "maya");

    const attached = await previewVideoLink(db, A.url, profileId, deps(runner.run));
    expect(attached.ok && attached.preview).toMatchObject({
      alreadyInLibrary: true,
      alreadyAttached: true,
    });
    const elsewhere = await previewVideoLink(db, A.url, other.profileId, deps(runner.run));
    expect(elsewhere.ok && elsewhere.preview).toMatchObject({
      alreadyInLibrary: true,
      alreadyAttached: false,
    });
    const noPerson = await previewVideoLink(db, A.url, null, deps(runner.run));
    expect(noPerson.ok && noPerson.preview.alreadyAttached).toBe(false);
  });

  it("returns a typed failure for unparseable and rejected links", async () => {
    const bad = await previewVideoLink(db, "https://vimeo.com/1", null, deps(routes().run));
    expect(bad).toEqual({
      ok: false,
      code: "unsupported_site",
      message: "scope can import YouTube and Rumble video links for now.",
      retryable: false,
    });

    const rejected = await previewVideoLink(
      db,
      B.url,
      null,
      deps(routes({ ...B, discovery: discoveryStdout("translated_only") }).run),
    );
    expect(rejected).toMatchObject({ ok: false, code: "no_english_captions", retryable: false });
  });

  it("marks transient failures retryable", async () => {
    const outcome = await previewVideoLink(
      db,
      A.url,
      null,
      deps(routes({ ...A, metadata: failure("timeout") }).run),
    );
    expect(outcome).toMatchObject({ ok: false, code: "timeout", retryable: true });
  });
});

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------

describe("mapWithConcurrency", () => {
  it("preserves input order whatever order the work finishes in", async () => {
    const delays = [30, 5, 20, 1, 10];
    const results = await mapWithConcurrency(delays, 2, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `${index}:${delay}`;
    });
    expect(results).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10"]);
  });

  it("never runs more than `limit` at once", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, index) => index),
      3,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      },
    );
    expect(peak).toBe(3);
  });

  it("handles empty input and a limit larger than the list", async () => {
    expect(await mapWithConcurrency([], 3, async (item: number) => item)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], 10, async (item) => item * 2)).toEqual([2, 4]);
  });
});
