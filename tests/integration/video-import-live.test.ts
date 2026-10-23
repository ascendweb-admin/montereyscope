import Database from "better-sqlite3";
import { expect, it } from "vitest";

import { addCreator, listAllCreators, listCreators } from "@/lib/creators/repository";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { listProfileVideos } from "@/lib/videos/attribution";
import { parseVideoLink } from "@/lib/videos/import/links";
import { resolveVideoLink } from "@/lib/videos/import/resolve";
import { importVideos } from "@/lib/videos/import/service";

// "Me at the zoo": 19 seconds, human-written English captions, public since 2005.
const VIDEO_ID = "jNQXAC9IVRw";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function openDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
  return db;
}

function zooLink() {
  const parsed = parseVideoLink(VIDEO_URL);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.link;
}

// Opt-in: real public video, real yt-dlp and network, no mocked captions. It
// spends no AI quota.
it.skipIf(process.env.SCOPE_LIVE_VIDEO_IMPORT !== "1")(
  "resolves a public video with human English captions",
  async () => {
    const db = openDatabase();
    try {
      const result = await resolveVideoLink(db, zooLink());
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.video.captions).toBe("manual");
      expect(result.video.videoId).toBe(VIDEO_ID);
      expect(result.video.draft.title).toBe("Me at the zoo");
      expect(result.video.draft.durationSeconds).toBe(19);
      expect(result.video.draft.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
      expect(result.video.host.platform).toBe("youtube");
      expect(result.video.host.youtubeChannelId).toMatch(/^UC[0-9A-Za-z_-]{22}$/);
      expect(result.video.inLibrary).toBeNull();
    } finally {
      db.close();
    }
  },
  120_000,
);

it.skipIf(process.env.SCOPE_LIVE_VIDEO_IMPORT !== "1")(
  "imports a public video onto a person under a hidden host",
  async () => {
    const db = openDatabase();
    try {
      const { creator } = addCreator(db, {
        youtubeChannelId: null,
        handle: "someone",
        displayName: "Someone",
        channelUrl: "https://www.youtube.com/@someone",
        avatarUrl: null,
      });

      const { results } = await importVideos(db, {
        urls: [VIDEO_URL],
        profileId: creator.profileId,
        followHost: false,
      });
      expect(results[0], JSON.stringify(results)).toMatchObject({
        status: "added",
        videoId: VIDEO_ID,
      });

      // The host exists but stays out of the library.
      expect(listCreators(db).map((c) => c.displayName)).toEqual(["Someone"]);
      expect(listAllCreators(db)).toHaveLength(2);
      expect(listAllCreators(db).find((c) => !c.followed)).toMatchObject({
        platform: "youtube",
        avatarUrl: null,
        lastRefreshedAt: null,
      });
      expect(listProfileVideos(db, creator.profileId).map((video) => video.id)).toEqual([VIDEO_ID]);

      const again = await importVideos(db, {
        urls: [VIDEO_URL],
        profileId: creator.profileId,
        followHost: false,
      });
      expect(again.results[0].status).toBe("already_attached");
    } finally {
      db.close();
    }
  },
  120_000,
);
