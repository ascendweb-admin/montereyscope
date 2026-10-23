import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { loadSourceLibrary } from "@/lib/ai/source-library";
import { listProfileSummaries, removeProfileById } from "@/lib/creators/profile-service";
import { addCreator, getCreator, listAllCreators, listCreators } from "@/lib/creators/repository";
import { removeCreatorById } from "@/lib/creators/service";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { saveTranscript } from "@/lib/transcripts/repository";
import {
  attachVideoToProfile,
  countProfileVideos,
  detachVideoFromProfile,
  labelProfileOf,
  listAllFeaturedProfiles,
  listFeaturedProfiles,
  listProfileVideos,
  listVideoProfileIds,
  pruneSourceOnlyHosts,
  removeAttributedVideo,
  removeAttributedVideos,
} from "@/lib/videos/attribution";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function openDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-attribution-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  return database;
}

beforeEach(() => {
  if (db) db.close();
  db = openDb();
  runMigrations(db, ALL_MIGRATIONS);
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A channel the user follows, and the person (profile) it belongs to. */
function person(name: string, handle: string): { creatorId: number; profileId: number } {
  const { creator } = addCreator(db, {
    youtubeChannelId: null,
    handle,
    displayName: name,
    channelUrl: `https://www.youtube.com/@${handle}`,
    avatarUrl: null,
  });
  return { creatorId: creator.id, profileId: creator.profileId };
}

/** A channel saved only because a hand-picked video lives on it. */
function host(name: string, handle: string, followed = false): number {
  return addCreator(db, {
    youtubeChannelId: null,
    handle,
    displayName: name,
    channelUrl: `https://www.youtube.com/@${handle}`,
    avatarUrl: null,
    followed,
  }).creator.id;
}

function video(creatorId: number, id: string, publishedAt: string | null = null): string {
  db.prepare(
    "INSERT INTO videos (id, creator_id, title, url, published_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, creatorId, `Video ${id}`, `https://www.youtube.com/watch?v=${id}`, publishedAt);
  return id;
}

function count(table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

function setAddedAt(profileId: number, videoId: string, addedAt: string): void {
  db.prepare("UPDATE profile_videos SET added_at = ? WHERE profile_id = ? AND video_id = ?").run(
    addedAt,
    profileId,
    videoId,
  );
}

describe("attaching and detaching", () => {
  it("attaches idempotently and reports whether anything changed", () => {
    const { profileId } = person("Luke", "luke");
    const id = video(host("PBD", "pbd"), "hostVid0001");

    expect(attachVideoToProfile(db, profileId, id)).toBe(true);
    expect(attachVideoToProfile(db, profileId, id)).toBe(false);
    expect(count("profile_videos")).toBe(1);
  });

  it("detaches idempotently and leaves the video itself alone", () => {
    const { profileId } = person("Luke", "luke");
    const id = video(host("PBD", "pbd"), "hostVid0001");
    attachVideoToProfile(db, profileId, id);

    expect(detachVideoFromProfile(db, profileId, id)).toBe(true);
    expect(detachVideoFromProfile(db, profileId, id)).toBe(false);
    expect(count("videos")).toBe(1);
  });

  it("rejects an attribution to a profile or video that does not exist", () => {
    const { profileId } = person("Luke", "luke");
    const id = video(host("PBD", "pbd"), "hostVid0001");
    expect(() => attachVideoToProfile(db, 9999, id)).toThrow(/FOREIGN KEY/);
    expect(() => attachVideoToProfile(db, profileId, "nopeVideo01")).toThrow(/FOREIGN KEY/);
  });

  it("cascades attributions when the video, or the person, is deleted", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const first = video(host("PBD", "pbd"), "hostVid0001");
    const second = video(host("Other", "other"), "hostVid0002");
    attachVideoToProfile(db, luke.profileId, first);
    attachVideoToProfile(db, dana.profileId, second);

    db.prepare("DELETE FROM videos WHERE id = ?").run(first);
    expect(count("profile_videos")).toBe(1);

    db.prepare("DELETE FROM creators WHERE id = ?").run(dana.creatorId);
    expect(count("profile_videos")).toBe(0);
    expect(count("videos")).toBe(1);
  });
});

describe("listVideoProfileIds and listFeaturedProfiles", () => {
  it("orders people by when they were attached, then by profile id", () => {
    const first = person("First", "first");
    const second = person("Second", "second");
    const third = person("Third", "third");
    const id = video(host("PBD", "pbd"), "hostVid0001");
    for (const entry of [third, first, second]) {
      attachVideoToProfile(db, entry.profileId, id);
    }
    setAddedAt(third.profileId, id, "2026-01-01T00:00:00.000Z");
    setAddedAt(first.profileId, id, "2026-02-01T00:00:00.000Z");
    setAddedAt(second.profileId, id, "2026-02-01T00:00:00.000Z");

    expect(listVideoProfileIds(db, id)).toEqual([
      third.profileId,
      Math.min(first.profileId, second.profileId),
      Math.max(first.profileId, second.profileId),
    ]);
    expect(listVideoProfileIds(db, "unattached01")).toEqual([]);
  });

  it("maps each video to the people it features, in label order", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const pbd = host("PBD", "pbd");
    const both = video(pbd, "hostVid0001");
    const one = video(pbd, "hostVid0002");
    const none = video(pbd, "hostVid0003");
    attachVideoToProfile(db, dana.profileId, both);
    attachVideoToProfile(db, luke.profileId, both);
    attachVideoToProfile(db, luke.profileId, one);
    setAddedAt(dana.profileId, both, "2026-01-01T00:00:00.000Z");
    setAddedAt(luke.profileId, both, "2026-01-02T00:00:00.000Z");

    const featured = listFeaturedProfiles(db, [both, one, none, "missing0001", both]);

    expect([...featured.keys()].sort()).toEqual([both, one].sort());
    expect(featured.get(both)).toEqual([
      { profileId: dana.profileId, displayName: "Dana" },
      { profileId: luke.profileId, displayName: "Luke" },
    ]);
    expect(featured.get(one)).toEqual([{ profileId: luke.profileId, displayName: "Luke" }]);
    expect(featured.has(none)).toBe(false);
  });

  it("answers for more ids than fit in one query chunk", () => {
    const luke = person("Luke", "luke");
    const pbd = host("PBD", "pbd");
    const attributed = video(pbd, "hostVid0001");
    attachVideoToProfile(db, luke.profileId, attributed);
    const ids = Array.from({ length: 1_300 }, (_, index) => `missing${index}`);
    ids.splice(700, 0, attributed);

    expect(listFeaturedProfiles(db, ids).get(attributed)).toEqual([
      { profileId: luke.profileId, displayName: "Luke" },
    ]);
    expect(listFeaturedProfiles(db, []).size).toBe(0);
  });
});

describe("listProfileVideos and countProfileVideos", () => {
  it("lists a person's videos newest first, undated first, with the host", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const pbd = host("PBD Podcast", "pbd");
    const old = video(pbd, "hostVid0001", "2026-01-01T00:00:00.000Z");
    const recent = video(pbd, "hostVid0002", "2026-06-01T00:00:00.000Z");
    const undated = video(pbd, "hostVid0003");
    const hers = video(pbd, "hostVid0004", "2026-03-01T00:00:00.000Z");
    for (const id of [old, recent, undated]) {
      attachVideoToProfile(db, luke.profileId, id);
    }
    attachVideoToProfile(db, dana.profileId, hers);

    const videos = listProfileVideos(db, luke.profileId);

    expect(videos.map((entry) => entry.id)).toEqual([undated, recent, old]);
    expect(videos[0]).toMatchObject({
      creatorId: pbd,
      hostName: "PBD Podcast",
      hostPlatform: "youtube",
      title: `Video ${undated}`,
      liveStatus: "unknown",
    });
    expect(countProfileVideos(db, luke.profileId)).toBe(3);
    expect(countProfileVideos(db, dana.profileId)).toBe(1);
    expect(listProfileVideos(db, 9999)).toEqual([]);
    expect(countProfileVideos(db, 9999)).toBe(0);
  });
});

describe("pruneSourceOnlyHosts", () => {
  it("deletes source-only hosts with no attributed video, with their videos and profile", () => {
    const luke = person("Luke", "luke");
    const keeper = host("Keeper", "keeper");
    const orphan = host("Orphan", "orphan");
    const empty = host("Empty", "empty");
    attachVideoToProfile(db, luke.profileId, video(keeper, "hostVid0001"));
    video(orphan, "hostVid0002");
    const orphanProfile = getCreator(db, orphan)?.profileId;

    expect(pruneSourceOnlyHosts(db)).toBe(2);

    expect(
      listAllCreators(db)
        .map((creator) => creator.displayName)
        .sort(),
    ).toEqual(["Keeper", "Luke"]);
    expect(getCreator(db, empty)).toBeNull();
    expect(count("videos")).toBe(1);
    expect(
      db.prepare("SELECT 1 FROM creator_profiles WHERE id = ?").get(orphanProfile),
    ).toBeUndefined();
    expect(pruneSourceOnlyHosts(db)).toBe(0);
  });

  it("never deletes a followed channel, however empty", () => {
    const followedEmpty = host("Followed", "followed", true);
    expect(pruneSourceOnlyHosts(db)).toBe(0);
    expect(getCreator(db, followedEmpty)).not.toBeNull();
  });
});

describe("removeAttributedVideo", () => {
  it("deletes the video and its source-only host with the last attribution", () => {
    const luke = person("Luke", "luke");
    const pbd = host("PBD", "pbd");
    const id = video(pbd, "hostVid0001");
    saveTranscript(
      db,
      { videoId: id, language: "en", source: "manual", plainText: "Words." },
      "2026-08-21T10:00:00.000Z",
    );
    attachVideoToProfile(db, luke.profileId, id);

    expect(removeAttributedVideo(db, luke.profileId, id)).toEqual({
      removedVideo: true,
      removedHost: true,
    });

    expect(count("videos")).toBe(0);
    expect(count("transcripts")).toBe(0);
    expect(count("profile_videos")).toBe(0);
    expect(getCreator(db, pbd)).toBeNull();
    expect(getCreator(db, luke.creatorId)).not.toBeNull();
  });

  it("keeps the video while another person is still featured in it", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const pbd = host("PBD", "pbd");
    const id = video(pbd, "hostVid0001");
    attachVideoToProfile(db, luke.profileId, id);
    attachVideoToProfile(db, dana.profileId, id);

    expect(removeAttributedVideo(db, luke.profileId, id)).toEqual({
      removedVideo: false,
      removedHost: false,
    });
    expect(listVideoProfileIds(db, id)).toEqual([dana.profileId]);
    expect(getCreator(db, pbd)).not.toBeNull();

    expect(removeAttributedVideo(db, dana.profileId, id)).toEqual({
      removedVideo: true,
      removedHost: true,
    });
  });

  it("keeps a source-only host that still hosts another attributed video", () => {
    const luke = person("Luke", "luke");
    const pbd = host("PBD", "pbd");
    const gone = video(pbd, "hostVid0001");
    const stays = video(pbd, "hostVid0002");
    attachVideoToProfile(db, luke.profileId, gone);
    attachVideoToProfile(db, luke.profileId, stays);

    expect(removeAttributedVideo(db, luke.profileId, gone)).toEqual({
      removedVideo: true,
      removedHost: false,
    });
    expect(listProfileVideos(db, luke.profileId).map((entry) => entry.id)).toEqual([stays]);
  });

  it("never deletes a video of a followed host", () => {
    const luke = person("Luke", "luke");
    const followedHost = host("PBD", "pbd", true);
    const id = video(followedHost, "hostVid0001");
    attachVideoToProfile(db, luke.profileId, id);

    expect(removeAttributedVideo(db, luke.profileId, id)).toEqual({
      removedVideo: false,
      removedHost: false,
    });
    expect(count("videos")).toBe(1);
    expect(listVideoProfileIds(db, id)).toEqual([]);
    expect(getCreator(db, followedHost)).not.toBeNull();
  });

  it("is a no-op for a video that was never attributed to that person", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const pbd = host("PBD", "pbd");
    const id = video(pbd, "hostVid0001");
    attachVideoToProfile(db, dana.profileId, id);

    expect(removeAttributedVideo(db, luke.profileId, id)).toEqual({
      removedVideo: false,
      removedHost: false,
    });
    expect(removeAttributedVideo(db, luke.profileId, "missing0001")).toEqual({
      removedVideo: false,
      removedHost: false,
    });
    expect(listVideoProfileIds(db, id)).toEqual([dana.profileId]);
  });
});

describe("removing a person prunes their source-only hosts", () => {
  function seedPerson(): { luke: { creatorId: number; profileId: number }; pbd: number } {
    const luke = person("Luke", "luke");
    const pbd = host("PBD", "pbd");
    attachVideoToProfile(db, luke.profileId, video(pbd, "hostVid0001"));
    return { luke, pbd };
  }

  it("removes hosts when the person's only account is removed", () => {
    const { luke, pbd } = seedPerson();

    expect(removeCreatorById(db, luke.creatorId)).toEqual({ ok: true, removed: true });

    expect(getCreator(db, pbd)).toBeNull();
    expect(count("videos")).toBe(0);
    expect(count("profile_videos")).toBe(0);
  });

  it("removes hosts when the whole person is removed", () => {
    const { luke, pbd } = seedPerson();

    expect(removeProfileById(db, luke.profileId)).toEqual({ ok: true, removedAccounts: 1 });

    expect(getCreator(db, pbd)).toBeNull();
    expect(count("videos")).toBe(0);
  });

  it("keeps the hosts while the person still has another account", () => {
    const { luke, pbd } = seedPerson();
    const second = addCreator(db, {
      youtubeChannelId: null,
      handle: "lukeclips",
      displayName: "Luke Clips",
      channelUrl: "https://www.youtube.com/@lukeclips",
      avatarUrl: null,
      profileId: luke.profileId,
    }).creator;

    expect(removeCreatorById(db, luke.creatorId)).toEqual({ ok: true, removed: true });

    expect(getCreator(db, pbd)).not.toBeNull();
    expect(listProfileVideos(db, second.profileId)).toHaveLength(1);
  });

  it("keeps a host that another person still features", () => {
    const { luke, pbd } = seedPerson();
    const dana = person("Dana", "dana");
    attachVideoToProfile(db, dana.profileId, "hostVid0001");

    removeProfileById(db, luke.profileId);

    expect(getCreator(db, pbd)).not.toBeNull();
    expect(count("videos")).toBe(1);
  });
});

describe("library-wide featured lookups", () => {
  it("lists every attributed video's people in one read, in label order", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const shared = video(host("PBD", "pbd"), "hostVid0001");
    const solo = video(host("Other", "other"), "hostVid0002");
    video(host("Third", "third"), "hostVid0003");
    attachVideoToProfile(db, luke.profileId, shared);
    attachVideoToProfile(db, dana.profileId, shared);
    attachVideoToProfile(db, dana.profileId, solo);
    setAddedAt(dana.profileId, shared, "2000-01-01T00:00:00.000Z");

    const featured = listAllFeaturedProfiles(db);

    expect(featured.get(shared)).toEqual([
      { profileId: dana.profileId, displayName: "Dana" },
      { profileId: luke.profileId, displayName: "Luke" },
    ]);
    expect(featured.get(solo)).toEqual([{ profileId: dana.profileId, displayName: "Dana" }]);
    expect(featured.has("hostVid0003")).toBe(false);
    expect(featured).toEqual(listFeaturedProfiles(db, [shared, solo, "hostVid0003"]));
  });

  it("labels with the first person who does not own the hosting channel", () => {
    const luke = { profileId: 1, displayName: "Luke" };
    const dana = { profileId: 2, displayName: "Dana" };

    expect(labelProfileOf([luke, dana], 99)).toBe(luke);
    expect(labelProfileOf([luke, dana], 1)).toBe(dana);
    expect(labelProfileOf([luke], 1)).toBeNull();
    expect(labelProfileOf([luke], null)).toBe(luke);
    expect(labelProfileOf(undefined, 1)).toBeNull();
  });
});

describe("removeAttributedVideos", () => {
  it("removes several videos at once, deleting hidden hosts with their last video", () => {
    const luke = person("Luke", "luke");
    const first = video(host("PBD", "pbd"), "hostVid0001");
    const second = video(host("Other", "other"), "hostVid0002");
    attachVideoToProfile(db, luke.profileId, first);
    attachVideoToProfile(db, luke.profileId, second);

    expect(removeAttributedVideos(db, luke.profileId, [first, second, first])).toEqual({
      removed: 2,
      deletedVideos: 2,
      deletedHosts: 2,
    });
    expect(count("videos")).toBe(0);
    expect(count("profile_videos")).toBe(0);
    expect(listAllCreators(db)).toHaveLength(1);
  });

  it("keeps a video another person still features, and skips ids that were never attributed", () => {
    const luke = person("Luke", "luke");
    const dana = person("Dana", "dana");
    const shared = video(host("PBD", "pbd"), "hostVid0001");
    const danas = video(host("Other", "other"), "hostVid0002");
    attachVideoToProfile(db, luke.profileId, shared);
    attachVideoToProfile(db, dana.profileId, shared);
    attachVideoToProfile(db, dana.profileId, danas);

    expect(removeAttributedVideos(db, luke.profileId, [shared, danas, "missing0001"])).toEqual({
      removed: 1,
      deletedVideos: 0,
      deletedHosts: 0,
    });
    expect(count("videos")).toBe(2);
    expect(listVideoProfileIds(db, shared)).toEqual([dana.profileId]);
    expect(listVideoProfileIds(db, danas)).toEqual([dana.profileId]);
  });

  it("never deletes a followed host's video", () => {
    const luke = person("Luke", "luke");
    const followed = host("PBD", "pbd", true);
    const id = video(followed, "hostVid0001");
    attachVideoToProfile(db, luke.profileId, id);

    expect(removeAttributedVideos(db, luke.profileId, [id])).toEqual({
      removed: 1,
      deletedVideos: 0,
      deletedHosts: 0,
    });
    expect(count("videos")).toBe(1);
    expect(getCreator(db, followed)).not.toBeNull();
  });
});

describe("library views with hand-picked videos", () => {
  it("shows nothing new for a hidden host: not a person, an account, or a picker creator", () => {
    const luke = person("Luke", "luke");
    const before = {
      people: JSON.stringify(listProfileSummaries(db)),
      creators: listCreators(db).map((creator) => creator.id),
      pickerCreators: loadSourceLibrary(db).creators.map((creator) => creator.id),
    };

    const hostId = host("PBD", "pbd");
    const id = video(hostId, "hostVid0001", "2026-09-01T00:00:00.000Z");
    attachVideoToProfile(db, luke.profileId, id);

    expect(JSON.stringify(listProfileSummaries(db))).toBe(before.people);
    expect(listCreators(db).map((creator) => creator.id)).toEqual(before.creators);
    expect(listAllCreators(db).map((creator) => creator.id)).toContain(hostId);
    expect(loadSourceLibrary(db).creators.map((creator) => creator.id)).toEqual(
      before.pickerCreators,
    );
    // The video itself is still pickable, under the person it features.
    expect(loadSourceLibrary(db).videos).toEqual([
      expect.objectContaining({ id, creatorId: hostId, featuredProfileId: luke.profileId }),
    ]);
  });
});
