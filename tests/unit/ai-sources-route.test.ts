/**
 * GET /api/ai/sources: the library the Reports page's "New report" picks
 * from, read against a real migrated SQLite file — every cached video and X
 * post with its person and categories, linked accounts grouped under one
 * person, and posts flagged by whether their full text is cached.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as GET_SOURCES } from "@/app/api/ai/sources/route";
import { closeDatabase, getDb } from "@/lib/db/connection";
import type { SourceLibrary } from "@/lib/ai/source-library";

const VIDEO_ID = "videoDana001";
const COMPLETE_TWEET = "1234567890123456701";
const SUMMARY_TWEET = "1234567890123456702";

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "localtube-sources-route-"));
  process.env.LOCALTUBE_DB_PATH = path.join(tempDir, "sources.db");
});

afterEach(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

/** One person with a YouTube channel and an X account, filed under one category. */
function seed(): { youtube: number; x: number; person: number; category: number } {
  const db = getDb();
  const youtube = Number(
    db
      .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
      .run("Dana's Channel", "https://www.youtube.com/@dana").lastInsertRowid,
  );
  const x = Number(
    db
      .prepare(
        "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, 'x', ?)",
      )
      .run("Dana on X", "https://x.com/dana", "1").lastInsertRowid,
  );
  const { profile_id: person } = db
    .prepare<[number], { profile_id: number }>("SELECT profile_id FROM creators WHERE id = ?")
    .get(youtube) as { profile_id: number };
  db.prepare("UPDATE creators SET profile_id = ? WHERE id = ?").run(person, x);
  db.prepare("UPDATE creator_profiles SET display_name = 'Dana Fixture' WHERE id = ?").run(person);
  const category = Number(
    db.prepare("INSERT INTO categories (name, color) VALUES ('Markets', 'sky')").run()
      .lastInsertRowid,
  );
  db.prepare("INSERT INTO profile_categories (profile_id, category_id) VALUES (?, ?)").run(
    person,
    category,
  );

  db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
    VIDEO_ID,
    youtube,
    "Rates, explained",
    `https://www.youtube.com/watch?v=${VIDEO_ID}`,
  );
  const insertTweet = db.prepare(
    "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, published_at, media_json, content_status) VALUES (?, '1', 'dana', 'Dana', ?, ?, ?, ?, ?)",
  );
  insertTweet.run(
    COMPLETE_TWEET,
    `https://x.com/dana/status/${COMPLETE_TWEET}`,
    "The whole post is cached.",
    "2026-09-16T10:00:00.000Z",
    JSON.stringify([{ kind: "photo", url: "https://pbs.twimg.com/media/x.jpg" }]),
    "complete",
  );
  insertTweet.run(
    SUMMARY_TWEET,
    `https://x.com/dana/status/${SUMMARY_TWEET}`,
    "Only the start of a long post…",
    "2026-09-16T11:00:00.000Z",
    JSON.stringify([]),
    "summary",
  );
  const linkTweet = db.prepare(
    "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, 'post', ?)",
  );
  linkTweet.run(x, COMPLETE_TWEET, "2026-09-16T10:00:00.000Z");
  linkTweet.run(x, SUMMARY_TWEET, "2026-09-16T11:00:00.000Z");
  return { youtube, x, person, category };
}

describe("GET /api/ai/sources", () => {
  it("lists every cached source with its person and categories, uncached", async () => {
    const { youtube, x, person, category } = seed();

    const response = await GET_SOURCES();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const library = (await response.json()) as SourceLibrary;

    expect(library.videos).toEqual([
      expect.objectContaining({
        id: VIDEO_ID,
        creatorId: youtube,
        title: "Rates, explained",
        creatorName: "Dana Fixture",
        categoryIds: [category],
      }),
    ]);
    const tweets = new Map(library.tweets.map((tweet) => [tweet.id, tweet]));
    expect(tweets.get(COMPLETE_TWEET)).toMatchObject({
      creatorId: x,
      authorHandle: "dana",
      text: "The whole post is cached.",
      mediaPreviewUrl: "https://pbs.twimg.com/media/x.jpg",
      categoryIds: [category],
      readyForAnalysis: true,
    });
    // A post with only its summary cached is listed, but cannot ground a report yet.
    expect(tweets.get(SUMMARY_TWEET)).toMatchObject({ readyForAnalysis: false });
    // Both accounts belong to one person, so the picker groups them.
    expect(library.creators).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: youtube, profileId: person, displayName: "Dana Fixture" }),
        expect.objectContaining({ id: x, profileId: person, platform: "x" }),
      ]),
    );
    expect(library.categories).toEqual([
      expect.objectContaining({ id: category, name: "Markets" }),
    ]);
  });

  describe("appearances on other channels", () => {
    const GUEST_VIDEO = "videoGuest001";

    /** Dana appears on a hidden host's podcast; the host has its own category. */
    function seedAppearance(): { host: number; person: number; hostCategory: number } {
      const { person } = seed();
      const db = getDb();
      const host = Number(
        db
          .prepare(
            "INSERT INTO creators (display_name, channel_url, followed, handle) VALUES (?, ?, 0, 'pbd')",
          )
          .run("PBD Podcast", "https://www.youtube.com/@pbd").lastInsertRowid,
      );
      db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
        GUEST_VIDEO,
        host,
        "Dana on the podcast",
        `https://www.youtube.com/watch?v=${GUEST_VIDEO}`,
      );
      db.prepare("INSERT INTO profile_videos (profile_id, video_id) VALUES (?, ?)").run(
        person,
        GUEST_VIDEO,
      );
      const hostCategory = Number(
        db.prepare("INSERT INTO categories (name, color) VALUES ('Podcasts', 'rose')").run()
          .lastInsertRowid,
      );
      db.prepare(
        "INSERT INTO profile_categories (profile_id, category_id) SELECT profile_id, ? FROM creators WHERE id = ?",
      ).run(hostCategory, host);
      return { host, person, hostCategory };
    }

    it("labels a guest video with the person it features and files it under their categories", async () => {
      const { host, person, hostCategory } = seedAppearance();

      const library = (await (await GET_SOURCES()).json()) as SourceLibrary;
      const guest = library.videos.find((video) => video.id === GUEST_VIDEO);

      expect(guest).toMatchObject({
        creatorId: host,
        creatorName: "Dana Fixture",
        featuredProfileId: person,
        featuredName: "Dana Fixture",
        hostName: "PBD Podcast",
        platform: "youtube",
      });
      // Dana's categories, not the hidden host's.
      expect(guest?.categoryIds).toHaveLength(1);
      expect(guest?.categoryIds).not.toContain(hostCategory);
    });

    it("leaves a channel's own video unlabelled", async () => {
      seedAppearance();

      const library = (await (await GET_SOURCES()).json()) as SourceLibrary;
      const own = library.videos.find((video) => video.id === VIDEO_ID);

      expect(own).toMatchObject({
        creatorName: "Dana Fixture",
        featuredProfileId: null,
        featuredName: null,
        hostName: null,
      });
    });

    it("keeps the hidden host out of the creators list and the person's group", async () => {
      const { host } = seedAppearance();

      const library = (await (await GET_SOURCES()).json()) as SourceLibrary;

      expect(library.creators.map((creator) => creator.id)).not.toContain(host);
      expect(library.creators).toHaveLength(2);
    });

    it("does not call a channel's owner featured on their own video", async () => {
      const { person } = seed();
      getDb()
        .prepare("INSERT INTO profile_videos (profile_id, video_id) VALUES (?, ?)")
        .run(person, VIDEO_ID);

      const library = (await (await GET_SOURCES()).json()) as SourceLibrary;

      expect(library.videos[0]).toMatchObject({
        featuredProfileId: null,
        hostName: null,
        creatorName: "Dana Fixture",
      });
    });

    it("labels with the first attached person when several are featured", async () => {
      const { person } = seedAppearance();
      const db = getDb();
      const other = Number(
        db
          .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
          .run("Sam Guest", "https://www.youtube.com/@sam").lastInsertRowid,
      );
      const otherProfile = db
        .prepare<[number], { profile_id: number }>("SELECT profile_id FROM creators WHERE id = ?")
        .get(other)!.profile_id;
      db.prepare(
        "UPDATE profile_videos SET added_at = '2000-01-01T00:00:00.000Z' WHERE profile_id = ?",
      ).run(person);
      db.prepare(
        "INSERT INTO profile_videos (profile_id, video_id, added_at) VALUES (?, ?, '1999-01-01T00:00:00.000Z')",
      ).run(otherProfile, GUEST_VIDEO);

      const library = (await (await GET_SOURCES()).json()) as SourceLibrary;

      expect(library.videos.find((video) => video.id === GUEST_VIDEO)).toMatchObject({
        featuredProfileId: otherProfile,
        featuredName: "Sam Guest",
      });
    });
  });

  it("answers an empty library with empty lists", async () => {
    const library = (await (await GET_SOURCES()).json()) as SourceLibrary;
    expect(library).toEqual({ videos: [], tweets: [], creators: [], categories: [] });
  });
});
