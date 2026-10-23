import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { listCategoriesForCreator } from "@/lib/categories";
import { createCategory } from "@/lib/categories/repository";
import { ensureHostAvatar, lookupHostAvatar } from "@/lib/creators/host-avatar";
import {
  addCreator,
  getCreator,
  listAllCreators,
  listCreators,
  type CreatorRecord,
} from "@/lib/creators/repository";
import {
  addCreatorFromUrl,
  followCreator,
  followHostWithVideo,
  httpStatusForServiceError,
  resolveCreatorFromAnyUrl,
  saveRumbleCreatorPayload,
} from "@/lib/creators/service";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { attachVideoToProfile } from "@/lib/videos/attribution";
import { resetPreviewCacheForTests } from "@/lib/videos/import/preview-cache";
import { importVideos } from "@/lib/videos/import/service";
import { insertVideoIfMissing } from "@/lib/videos/repository";
import {
  RUMBLE_VIDEO_URL,
  ZOO_CHANNEL_ID,
  ZOO_VIDEO_URL,
  discoveryStdout,
  failure,
  rumbleMetadata,
  routedRunner,
  youtubeMetadata,
} from "../helpers/video-import";

const tempDirs: string[] = [];
let db: ScopeDatabase;

beforeEach(() => {
  resetPreviewCacheForTests();
  if (db) db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "scope-creator-follow-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const AVATAR = "https://yt3.googleusercontent.com/example-avatar";
const RUMBLE_AVATAR = "https://hugh.cdn.rumble.cloud/video/avatar.png";

function count(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

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

/** A source-only host with one attributed video, as an import leaves it. */
function hiddenHost(platform: "youtube" | "rumble" = "youtube") {
  const { creator } = addCreator(db, {
    youtubeChannelId: platform === "youtube" ? ZOO_CHANNEL_ID : null,
    handle: "hostchannel",
    displayName: "Host Channel",
    channelUrl:
      platform === "youtube"
        ? `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`
        : "https://rumble.com/c/Redacted",
    avatarUrl: null,
    platform,
    followed: false,
  });
  insertVideoIfMissing(db, creator.id, {
    id: "hostvideo01",
    title: "A guest appearance",
    url: "https://www.youtube.com/watch?v=hostvideo01",
    thumbnailUrl: null,
    publishedAt: "2026-09-01T00:00:00.000Z",
    durationSeconds: 600,
    liveStatus: "not_live",
    description: null,
  });
  const luke = person("Luke", "luke");
  attachVideoToProfile(db, luke.profileId, "hostvideo01");
  return { host: creator, luke };
}

/** Stand-ins for the two channel-picture lookups. */
function avatarDeps(url: string | null = AVATAR) {
  return {
    resolveYoutube: vi
      .fn()
      .mockResolvedValue(
        url === null
          ? { ok: false, error: { code: "network", message: "offline" } }
          : { ok: true, creator: { avatarUrl: url } },
      ),
    fetchRumbleIdentity: vi
      .fn()
      .mockResolvedValue(
        url === null
          ? { ok: false, failure: { reason: "throttled" } }
          : { ok: true, identity: { avatarUrl: url } },
      ),
  };
}

/** The yt-dlp boundary for one YouTube video: metadata plus the caption check. */
function youtubeVideoRunner(discovery: "human_english" | "none" = "human_english") {
  return routedRunner({
    [ZOO_VIDEO_URL]: {
      metadata: youtubeMetadata(),
      discovery: discoveryStdout(discovery),
    },
  });
}

function rumbleVideoRunner(discovery: "human_english" | "none" = "human_english") {
  return routedRunner({
    [RUMBLE_VIDEO_URL]: { metadata: rumbleMetadata(), discovery: discoveryStdout(discovery) },
  });
}

function resolveDeps(runner: { run: ReturnType<typeof routedRunner>["run"] }) {
  return { command: "yt-dlp", run: runner.run, throttleRetryMs: 0 };
}

// ---------------------------------------------------------------------------
// Channel pictures
// ---------------------------------------------------------------------------

describe("lookupHostAvatar", () => {
  it("reads a YouTube channel's picture from its channel page", async () => {
    const deps = avatarDeps();
    const url = await lookupHostAvatar(
      { platform: "youtube", channelUrl: `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}` },
      deps,
    );
    expect(url).toBe(AVATAR);
    expect(deps.resolveYoutube).toHaveBeenCalledWith(
      `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`,
    );
  });

  it("reads a Rumble channel's picture from its identity", async () => {
    const deps = avatarDeps(RUMBLE_AVATAR);
    const url = await lookupHostAvatar(
      { platform: "rumble", channelUrl: "https://rumble.com/c/Redacted" },
      deps,
    );
    expect(url).toBe(RUMBLE_AVATAR);
    expect(deps.fetchRumbleIdentity).toHaveBeenCalledWith(
      "https://rumble.com/c/Redacted",
      "Redacted",
    );
  });

  it("answers null for a failed lookup, a thrown error, or a picture off the allowed hosts", async () => {
    const channelUrl = `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`;
    expect(
      await lookupHostAvatar({ platform: "youtube", channelUrl }, avatarDeps(null)),
    ).toBeNull();
    expect(
      await lookupHostAvatar(
        { platform: "youtube", channelUrl },
        { resolveYoutube: vi.fn().mockRejectedValue(new Error("boom")) },
      ),
    ).toBeNull();
    expect(
      await lookupHostAvatar(
        { platform: "youtube", channelUrl },
        avatarDeps("https://evil.example/avatar.png"),
      ),
    ).toBeNull();
    // X channels are never source-only, so there is nothing to look up.
    expect(
      await lookupHostAvatar({ platform: "x", channelUrl: "https://x.com/jane" }, avatarDeps()),
    ).toBeNull();
  });
});

describe("ensureHostAvatar", () => {
  it("stores a found picture, and skips a channel that already has one", async () => {
    const { host } = hiddenHost();
    const deps = avatarDeps();
    expect(await ensureHostAvatar(db, host.id, deps)).toBe(true);
    expect(getCreator(db, host.id)?.avatarUrl).toBe(AVATAR);

    expect(await ensureHostAvatar(db, host.id, deps)).toBe(false);
    expect(deps.resolveYoutube).toHaveBeenCalledTimes(1);
  });

  it("leaves a channel without a picture when nothing is found or the channel is gone", async () => {
    const { host } = hiddenHost();
    expect(await ensureHostAvatar(db, host.id, avatarDeps(null))).toBe(false);
    expect(getCreator(db, host.id)?.avatarUrl).toBeNull();
    expect(await ensureHostAvatar(db, 9999, avatarDeps())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// followCreator
// ---------------------------------------------------------------------------

describe("followCreator", () => {
  it("turns a source-only host into a followed creator with its picture", async () => {
    const { host } = hiddenHost();
    expect(listCreators(db).map((creator) => creator.displayName)).toEqual(["Luke"]);

    const outcome = await followCreator(db, host.id, avatarDeps());

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.creator).toMatchObject({
      id: host.id,
      displayName: "Host Channel",
      avatarUrl: AVATAR,
      profileId: host.profileId,
    });
    expect(getCreator(db, host.id)).toMatchObject({ followed: true, avatarUrl: AVATAR });
    expect(
      listCreators(db)
        .map((creator) => creator.displayName)
        .sort(),
    ).toEqual(["Host Channel", "Luke"]);
    // Nothing else changed: still one row per channel, and the video is kept.
    expect(listAllCreators(db)).toHaveLength(2);
    expect(count("videos")).toBe(1);
    expect(count("profile_videos")).toBe(1);
    // No feed was fetched, so the channel is not claimed as refreshed.
    expect(getCreator(db, host.id)?.lastRefreshedAt).toBeNull();
  });

  it("still follows when the picture cannot be found", async () => {
    const { host } = hiddenHost();
    const outcome = await followCreator(db, host.id, avatarDeps(null));
    expect(outcome.ok).toBe(true);
    expect(getCreator(db, host.id)).toMatchObject({ followed: true, avatarUrl: null });
  });

  it("still follows when the picture lookup throws", async () => {
    const { host } = hiddenHost();
    const outcome = await followCreator(db, host.id, {
      resolveYoutube: vi.fn().mockRejectedValue(new Error("boom")),
    });
    expect(outcome.ok).toBe(true);
    expect(getCreator(db, host.id)?.followed).toBe(true);
  });

  it("looks a Rumble channel's picture up on Rumble", async () => {
    const { host } = hiddenHost("rumble");
    const deps = avatarDeps(RUMBLE_AVATAR);
    const outcome = await followCreator(db, host.id, deps);
    expect(outcome.ok && outcome.creator.avatarUrl).toBe(RUMBLE_AVATAR);
    expect(deps.resolveYoutube).not.toHaveBeenCalled();
  });

  it("keeps a picture the channel already has", async () => {
    const { host } = hiddenHost();
    db.prepare("UPDATE creators SET avatar_url = ? WHERE id = ?").run(AVATAR, host.id);
    const deps = avatarDeps("https://yt3.googleusercontent.com/other");
    await followCreator(db, host.id, deps);
    expect(getCreator(db, host.id)?.avatarUrl).toBe(AVATAR);
    expect(deps.resolveYoutube).not.toHaveBeenCalled();
  });

  it("refuses a creator that is already followed", async () => {
    const luke = person("Luke", "luke");
    const deps = avatarDeps();
    const outcome = await followCreator(db, luke.creator.id, deps);
    expect(outcome).toEqual({
      ok: false,
      error: { code: "already_followed", message: "Luke is already in your library." },
    });
    expect(deps.resolveYoutube).not.toHaveBeenCalled();
  });

  it("refuses a second follow of the same channel", async () => {
    const { host } = hiddenHost();
    expect((await followCreator(db, host.id, avatarDeps())).ok).toBe(true);
    const again = await followCreator(db, host.id, avatarDeps());
    expect(!again.ok && again.error.code).toBe("already_followed");
  });

  it.each([[0], [-3], [1.5], [Number.NaN]])("rejects the id %s", async (id) => {
    const outcome = await followCreator(db, id);
    expect(!outcome.ok && outcome.error.code).toBe("invalid_id");
  });

  it("reports a channel that no longer exists", async () => {
    const outcome = await followCreator(db, 9999);
    expect(!outcome.ok && outcome.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// followHostWithVideo: "Follow {host} as a creator" from a video link
// ---------------------------------------------------------------------------

describe("followHostWithVideo", () => {
  it("follows a new channel, caches the video, and attributes it to nobody", async () => {
    const runner = youtubeVideoRunner();
    const marketsId = createCategory(db, { name: "Markets", color: "emerald" }).id;

    const outcome = await followHostWithVideo(db, ZOO_VIDEO_URL, [marketsId], {
      resolve: resolveDeps(runner),
      avatar: avatarDeps(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("created");
    expect(outcome.creator).toMatchObject({ avatarUrl: AVATAR });
    const host = getCreator(db, outcome.creator.id);
    expect(host).toMatchObject({
      followed: true,
      platform: "youtube",
      youtubeChannelId: ZOO_CHANNEL_ID,
      avatarUrl: AVATAR,
      // The channel was not refreshed, only one video was cached.
      lastRefreshedAt: null,
    });
    expect(listCategoriesForCreator(db, outcome.creator.id).map((c) => c.name)).toEqual([
      "Markets",
    ]);
    expect(db.prepare("SELECT creator_id FROM videos WHERE url = ?").get(ZOO_VIDEO_URL)).toEqual({
      creator_id: outcome.creator.id,
    });
    expect(count("profile_videos")).toBe(0);
    expect(listCreators(db).map((creator) => creator.id)).toEqual([outcome.creator.id]);
  });

  it("promotes a channel that was a source-only host, without a duplicate", async () => {
    const luke = person("Luke", "luke");
    const imported = await importVideos(
      db,
      { urls: [ZOO_VIDEO_URL], profileId: luke.profileId, followHost: false },
      resolveDeps(youtubeVideoRunner()),
    );
    const hostId = Number(imported.results[0].hostCreatorId);
    expect(getCreator(db, hostId)?.followed).toBe(false);
    resetPreviewCacheForTests();

    const outcome = await followHostWithVideo(db, ZOO_VIDEO_URL, [], {
      resolve: resolveDeps(youtubeVideoRunner()),
      avatar: avatarDeps(),
    });

    expect(outcome.ok && outcome.status).toBe("created");
    expect(outcome.ok && outcome.creator.id).toBe(hostId);
    expect(getCreator(db, hostId)).toMatchObject({ followed: true, avatarUrl: AVATAR });
    expect(listAllCreators(db)).toHaveLength(2);
    // Luke's attribution is untouched.
    expect(count("profile_videos")).toBe(1);
  });

  it("calls a channel that was already followed already saved", async () => {
    const first = await followHostWithVideo(db, ZOO_VIDEO_URL, [], {
      resolve: resolveDeps(youtubeVideoRunner()),
      avatar: avatarDeps(),
    });
    expect(first.ok && first.status).toBe("created");
    resetPreviewCacheForTests();

    // The video is cached but has no transcript yet, so its captions are checked again.
    const second = await followHostWithVideo(db, ZOO_VIDEO_URL, [], {
      resolve: resolveDeps(youtubeVideoRunner()),
      avatar: avatarDeps(),
    });
    expect(second.ok && second.status).toBe("already_saved");
    expect(listAllCreators(db)).toHaveLength(1);
    expect(count("videos")).toBe(1);
  });

  it("rejects a video without English captions and writes nothing", async () => {
    const outcome = await followHostWithVideo(db, ZOO_VIDEO_URL, [], {
      resolve: resolveDeps(youtubeVideoRunner("none")),
      avatar: avatarDeps(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toMatchObject({ code: "no_english_captions", retryable: false });
    expect(count("creators")).toBe(0);
    expect(count("videos")).toBe(0);
  });

  it("reports a transient failure as retryable", async () => {
    const runner = routedRunner({
      [ZOO_VIDEO_URL]: {
        metadata: failure("nonzero_exit", "ERROR: HTTP Error 429: Too Many Requests"),
        discovery: discoveryStdout("human_english"),
      },
    });
    const outcome = await followHostWithVideo(db, ZOO_VIDEO_URL, [], {
      resolve: resolveDeps(runner),
      avatar: avatarDeps(),
    });
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "throttled", retryable: true });
  });

  it("checks the categories before any network work", async () => {
    const runner = youtubeVideoRunner();
    const deps = { resolve: resolveDeps(runner), avatar: avatarDeps() };
    const bad = await followHostWithVideo(db, ZOO_VIDEO_URL, ["x"], deps);
    expect(!bad.ok && bad.error.code).toBe("invalid_payload");
    const missing = await followHostWithVideo(db, ZOO_VIDEO_URL, [999], deps);
    expect(!missing.ok && missing.error.code).toBe("invalid_payload");
    expect(runner.calls).toEqual([]);
    expect(count("creators")).toBe(0);
  });

  it("rejects text that is not a video link", async () => {
    const outcome = await followHostWithVideo(db, "https://www.youtube.com/@mkbhd", [], {
      resolve: resolveDeps(routedRunner({})),
    });
    expect(!outcome.ok && outcome.error.code).toBe("invalid_link");
    expect(count("creators")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rumble video links go through the same engine
// ---------------------------------------------------------------------------

describe("Rumble video links", () => {
  const LINK = "https://rumble.com/v7emyxa-warning-this-new-flu-shot.html";

  it("addCreatorFromUrl follows the channel and imports the video through the engine", async () => {
    const outcome = await addCreatorFromUrl(db, LINK, undefined, {
      resolve: resolveDeps(rumbleVideoRunner()),
      avatar: avatarDeps(RUMBLE_AVATAR),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("created");
    expect(outcome.creator).toMatchObject({
      displayName: "Redacted News",
      platform: "rumble",
      channelUrl: "https://rumble.com/c/Redacted",
      avatarUrl: RUMBLE_AVATAR,
    });
    const host = getCreator(db, outcome.creator.id);
    // The old path stamped the host as refreshed; importing one video does not.
    expect(host).toMatchObject({ followed: true, handle: "redacted", lastRefreshedAt: null });
    expect(db.prepare("SELECT id, creator_id FROM videos").all()).toEqual([
      { id: "v7emyxa", creator_id: outcome.creator.id },
    ]);
    expect(count("profile_videos")).toBe(0);
  });

  it("applies the English-caption gate it did not have before", async () => {
    const outcome = await addCreatorFromUrl(db, LINK, undefined, {
      resolve: resolveDeps(rumbleVideoRunner("none")),
      avatar: avatarDeps(RUMBLE_AVATAR),
    });
    expect(!outcome.ok && outcome.error.code).toBe("no_english_captions");
    expect(count("creators")).toBe(0);
    expect(count("videos")).toBe(0);
  });

  it("reuses a followed channel and promotes a source-only one", async () => {
    // A hidden host for the same channel (as an Other videos import leaves it).
    const { creator: hidden } = addCreator(db, {
      youtubeChannelId: null,
      handle: "redacted",
      displayName: "Redacted News",
      channelUrl: "https://rumble.com/c/Redacted",
      avatarUrl: null,
      platform: "rumble",
      followed: false,
    });
    const deps = {
      resolve: resolveDeps(rumbleVideoRunner()),
      avatar: avatarDeps(RUMBLE_AVATAR),
    };

    const first = await addCreatorFromUrl(db, LINK, undefined, deps);
    expect(first.ok && first.status).toBe("created");
    expect(first.ok && first.creator.id).toBe(hidden.id);
    expect(getCreator(db, hidden.id)?.followed).toBe(true);

    resetPreviewCacheForTests();
    const again = await addCreatorFromUrl(db, LINK, undefined, deps);
    expect(again.ok && again.status).toBe("already_saved");
    expect(listAllCreators(db)).toHaveLength(1);
  });

  it("saveRumbleCreatorPayload follows the channel for a payload carrying a video link", async () => {
    const marketsId = createCategory(db, { name: "Markets", color: "sky" }).id;
    const outcome = await saveRumbleCreatorPayload(
      db,
      { platform: "rumble", videoUrl: RUMBLE_VIDEO_URL },
      [marketsId],
      { resolve: resolveDeps(rumbleVideoRunner()), avatar: avatarDeps(RUMBLE_AVATAR) },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.creator.displayName).toBe("Redacted News");
    expect(outcome.creator.categories.map((category) => category.name)).toEqual(["Markets"]);
    expect(getCreator(db, outcome.creator.id)?.lastRefreshedAt).toBeNull();
  });

  it("saveRumbleCreatorPayload still saves a plain channel payload", async () => {
    const outcome = await saveRumbleCreatorPayload(db, {
      platform: "rumble",
      displayName: "Redacted News",
      handle: "redacted",
      channelUrl: "https://rumble.com/c/Redacted",
      avatarUrl: null,
    });
    expect(outcome.ok && outcome.status).toBe("created");
    expect(count("videos")).toBe(0);
  });

  it("resolveCreatorFromAnyUrl previews the channel the video would follow, saving nothing", async () => {
    const outcome = await resolveCreatorFromAnyUrl(db, LINK, undefined, {
      resolve: resolveDeps(rumbleVideoRunner()),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.creator).toMatchObject({
      platform: "rumble",
      displayName: "Redacted News",
      handle: "redacted",
      channelUrl: "https://rumble.com/c/Redacted",
      videoUrl: RUMBLE_VIDEO_URL,
      avatarUrl: null,
    });
    expect(count("creators")).toBe(0);
    expect(count("videos")).toBe(0);
  });

  it("resolveCreatorFromAnyUrl runs the caption gate on a video link", async () => {
    const outcome = await resolveCreatorFromAnyUrl(db, LINK, undefined, {
      resolve: resolveDeps(rumbleVideoRunner("none")),
    });
    expect(!outcome.ok && outcome.error.code).toBe("no_english_captions");
  });

  it("keeps the YouTube channel parser's message for a YouTube video link", async () => {
    const runner = routedRunner({});
    const outcome = await resolveCreatorFromAnyUrl(db, ZOO_VIDEO_URL, undefined, {
      resolve: resolveDeps(runner),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("invalid_url");
      expect(outcome.error.message).toMatch(/single video link/i);
    }
    expect(runner.calls).toEqual([]);
  });
});

describe("httpStatusForServiceError", () => {
  it("maps the video import codes to client errors", () => {
    const status = (code: string) => httpStatusForServiceError({ code, message: "" });
    expect(status("no_english_captions")).toBe(422);
    expect(status("live_or_upcoming")).toBe(422);
    expect(status("no_channel")).toBe(422);
    expect(status("unsupported_site")).toBe(400);
    expect(status("invalid_input")).toBe(400);
    expect(status("throttled")).toBe(429);
    expect(status("something_else")).toBe(500);
  });
});
