/**
 * Feed items for hand-picked videos: an appearance on someone else's channel
 * is labelled with the person it features (name, avatar, categories, link to
 * their Other videos) plus "on {host}", while the detail and transcript URLs
 * keep pointing at the real hosting account.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { FeedVideoItemModel } from "@/components/feed/feed-stream";
import { addCreator } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { buildFeedItems } from "@/lib/feed/items";
import { attachVideoToProfile } from "@/lib/videos/attribution";

const tempDirs: string[] = [];
let db: ScopeDatabase;

beforeEach(() => {
  if (db) db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "scope-feed-items-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function channel(
  name: string,
  handle: string,
  options: { followed?: boolean; avatarUrl?: string | null } = {},
): { creatorId: number; profileId: number } {
  const { creator } = addCreator(db, {
    youtubeChannelId: null,
    handle,
    displayName: name,
    channelUrl: `https://www.youtube.com/@${handle}`,
    avatarUrl: options.avatarUrl ?? null,
    followed: options.followed ?? true,
  });
  return { creatorId: creator.id, profileId: creator.profileId };
}

function video(creatorId: number, id: string, publishedAt: string): void {
  db.prepare(
    "INSERT INTO videos (id, creator_id, title, url, published_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, creatorId, `Video ${id}`, `https://www.youtube.com/watch?v=${id}`, publishedAt);
}

function category(name: string, profileId: number): number {
  const id = Number(
    db.prepare("INSERT INTO categories (name, color) VALUES (?, 'sky')").run(name).lastInsertRowid,
  );
  db.prepare("INSERT INTO profile_categories (profile_id, category_id) VALUES (?, ?)").run(
    profileId,
    id,
  );
  return id;
}

function videoItems(items: ReturnType<typeof buildFeedItems>): FeedVideoItemModel[] {
  return items.filter((item): item is FeedVideoItemModel => item.kind === "video");
}

describe("buildFeedItems with hand-picked videos", () => {
  it("labels an appearance with the featured person and links to their Other videos", () => {
    const luke = channel("Luke Belmar", "luke", { avatarUrl: "https://img.example/luke.jpg" });
    const pbd = channel("PBD Podcast", "pbd", { followed: false });
    const lukeCategory = category("Founders", luke.profileId);
    category("Podcasts", pbd.profileId);
    video(pbd.creatorId, "guestVid0001", "2026-09-01T00:00:00.000Z");
    attachVideoToProfile(db, luke.profileId, "guestVid0001");

    const [item] = videoItems(buildFeedItems(db));

    expect(item).toMatchObject({
      id: "guestVid0001",
      // The real, hidden host stays the account for detail and transcript URLs.
      creatorId: pbd.creatorId,
      profileId: luke.profileId,
      creatorName: "Luke Belmar",
      accountLabel: "on PBD Podcast",
      creatorAvatarUrl: "https://img.example/luke.jpg",
      creatorAvatarCreatorId: luke.creatorId,
      creatorPlatform: "youtube",
      featured: true,
      // The channel's name travels on its own, for the citation's "on {channel}".
      hostName: "PBD Podcast",
      categoryIds: [lukeCategory],
    });
  });

  it("labels a followed host's video the same way and leaves its other videos alone", () => {
    const luke = channel("Luke Belmar", "luke");
    const pbd = channel("PBD Podcast", "pbd");
    video(pbd.creatorId, "guestVid0001", "2026-09-01T00:00:00.000Z");
    video(pbd.creatorId, "hostVid00001", "2026-08-01T00:00:00.000Z");
    attachVideoToProfile(db, luke.profileId, "guestVid0001");

    const items = new Map(videoItems(buildFeedItems(db)).map((item) => [item.id, item]));

    expect(items.get("guestVid0001")).toMatchObject({
      profileId: luke.profileId,
      creatorName: "Luke Belmar",
      accountLabel: "on PBD Podcast",
      featured: true,
    });
    expect(items.get("hostVid00001")).toMatchObject({
      profileId: pbd.profileId,
      creatorName: "PBD Podcast",
      accountLabel: "YouTube",
    });
    expect(items.get("hostVid00001")?.featured).toBeUndefined();
    expect(items.get("hostVid00001")).not.toHaveProperty("hostName");
  });

  it("does not label a channel's owner as featured on their own video", () => {
    const luke = channel("Luke Belmar", "luke");
    video(luke.creatorId, "ownVideo0001", "2026-09-01T00:00:00.000Z");
    attachVideoToProfile(db, luke.profileId, "ownVideo0001");

    const [item] = videoItems(buildFeedItems(db));

    expect(item.featured).toBeUndefined();
    expect(item).not.toHaveProperty("hostName");
    expect(item).toMatchObject({ profileId: luke.profileId, accountLabel: "YouTube" });
  });

  it("labels with the first attached person in the shared feed", () => {
    const luke = channel("Luke Belmar", "luke");
    const dana = channel("Dana Guest", "dana");
    const pbd = channel("PBD Podcast", "pbd", { followed: false });
    video(pbd.creatorId, "guestVid0001", "2026-09-01T00:00:00.000Z");
    attachVideoToProfile(db, dana.profileId, "guestVid0001");
    attachVideoToProfile(db, luke.profileId, "guestVid0001");
    db.prepare("UPDATE profile_videos SET added_at = ? WHERE profile_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      dana.profileId,
    );

    const [item] = videoItems(buildFeedItems(db));

    expect(item).toMatchObject({ creatorName: "Dana Guest", profileId: dana.profileId });
  });

  it("includes a person's appearances on their page and labels them as that person", () => {
    const luke = channel("Luke Belmar", "luke");
    const dana = channel("Dana Guest", "dana");
    const pbd = channel("PBD Podcast", "pbd", { followed: false });
    video(luke.creatorId, "ownVideo0001", "2026-08-01T00:00:00.000Z");
    video(pbd.creatorId, "guestVid0001", "2026-09-01T00:00:00.000Z");
    video(pbd.creatorId, "otherGuest001", "2026-09-02T00:00:00.000Z");
    // Dana was attached first, but on Luke's page the label is Luke.
    attachVideoToProfile(db, dana.profileId, "guestVid0001");
    attachVideoToProfile(db, luke.profileId, "guestVid0001");
    db.prepare("UPDATE profile_videos SET added_at = ? WHERE profile_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      dana.profileId,
    );
    attachVideoToProfile(db, dana.profileId, "otherGuest001");

    const items = buildFeedItems(db, [{ id: luke.creatorId, platform: "youtube" }], {
      featuredProfileId: luke.profileId,
    });

    expect(videoItems(items).map((item) => item.id)).toEqual(["guestVid0001", "ownVideo0001"]);
    expect(videoItems(items)[0]).toMatchObject({
      creatorName: "Luke Belmar",
      profileId: luke.profileId,
      accountLabel: "on PBD Podcast",
      featured: true,
    });
  });

  it("lists a video once when it is both on the person's channel and attributed to them", () => {
    const luke = channel("Luke Belmar", "luke");
    video(luke.creatorId, "ownVideo0001", "2026-08-01T00:00:00.000Z");
    attachVideoToProfile(db, luke.profileId, "ownVideo0001");

    const items = buildFeedItems(db, [{ id: luke.creatorId, platform: "youtube" }], {
      featuredProfileId: luke.profileId,
    });

    expect(videoItems(items)).toHaveLength(1);
  });

  it("leaves a person's page without appearances unless asked", () => {
    const luke = channel("Luke Belmar", "luke");
    const pbd = channel("PBD Podcast", "pbd", { followed: false });
    video(pbd.creatorId, "guestVid0001", "2026-09-01T00:00:00.000Z");
    attachVideoToProfile(db, luke.profileId, "guestVid0001");

    expect(buildFeedItems(db, [{ id: luke.creatorId, platform: "youtube" }])).toEqual([]);
  });
});
