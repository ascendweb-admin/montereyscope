import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addCreator, getCreator } from "@/lib/creators/repository";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import {
  mergeCreatorTimeline,
  countAllTweets,
  getXFeedState,
  upsertXFeedState,
} from "@/lib/x/repository";
import { mapXTimelineItem } from "@/lib/x/mapper";
import { calendarBounds, calendarDate, shiftDate } from "@/lib/x/research/dates";
import {
  creatorIds,
  deleteResearchList,
  getResearchList,
  listResearchLists,
  readCachedFeed,
  saveResearchList,
} from "@/lib/x/research/repository";
import { GET as feedGET } from "@/app/api/x-research/feed/route";
import { GET as listsGET, POST as listsPOST } from "@/app/api/x-research/lists/route";
import { PATCH, DELETE } from "@/app/api/x-research/lists/[id]/route";

const dir = mkdtempSync(path.join(tmpdir(), "scope-x-research-"));
const file = path.join(dir, "test.db");
let db: Database.Database;
vi.mock("@/lib/db/connection", () => ({ getDb: () => db }));
// Cached dashboard operations must never cross the provider boundary.
vi.mock("@/lib/x/providers", () => ({
  getXProvider: () => {
    throw new Error("Unexpected X read");
  },
}));
function creator(handle: string, platform: "x" | "youtube" = "x") {
  return addCreator(db, {
    platform,
    platformUserId: platform === "x" ? handle : null,
    youtubeChannelId: null,
    displayName: handle,
    handle,
    channelUrl: `https://x.com/${handle}`,
    avatarUrl: null,
  }).creator.id;
}
function post(
  creatorId: number,
  id: string,
  publishedAt: string | null,
  options: Record<string, unknown> = {},
  kind: "post" | "repost" | "reply" = "post",
  timelineAt = publishedAt,
) {
  const item = mapXTimelineItem({
    tweet: {
      id,
      author: { userId: "123", handle: "author", displayName: "Author" },
      text: `Exact saved text ${id}`,
      publishedAt,
      contentStatus: "complete",
      ...options,
    },
    timelineKind: kind,
    timelineAt,
  })!;
  mergeCreatorTimeline(db, creatorId, [item]);
}
const bounds = { since: "2026-09-24T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" };
function feed(ids: number[], extra = {}) {
  return readCachedFeed(db, {
    creatorIds: ids,
    ...bounds,
    types: ["original", "reply", "quote"],
    ...extra,
  });
}
const json = (body: unknown) =>
  new Request("http://localhost/api/x-research/lists", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  if (db?.open) db.close();
  rmSync(file, { force: true });
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});
afterAll(() => {
  if (db?.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("persistent research lists and shared cache", () => {
  it("reuses one canonical archive across lists, survives reopen, and keeps text and checkpoints after membership/list deletion", () => {
    const a = creator("alpha");
    post(a, "100", "2026-09-30T12:00:00Z");
    upsertXFeedState(db, {
      creatorId: a,
      configKey: "fixture",
      lastRefreshedAt: "2026-10-01T00:00:00Z",
      olderCursor: "older",
      lastError: "fixture failure",
    });
    const first = saveResearchList(db, { name: "Ethereum", creatorIds: [a, a] });
    const second = saveResearchList(db, { name: "Markets", creatorIds: [a] });
    expect(first.creatorIds).toEqual([a]);
    expect(countAllTweets(db)).toBe(1);
    const initial = feed(first.creatorIds);
    db.close();
    db = new Database(file);
    db.pragma("foreign_keys = ON");
    runMigrations(db, ALL_MIGRATIONS);
    expect(feed(getResearchList(db, second.id).creatorIds)).toEqual(initial);
    expect(initial.coverage[0]).toMatchObject({
      cachedPosts: 1,
      hasError: true,
      lastRefreshedAt: "2026-10-01T00:00:00Z",
    });
    saveResearchList(db, { ...first, name: "Renamed", creatorIds: [] });
    deleteResearchList(db, second.id);
    expect(getCreator(db, a)).not.toBeNull();
    expect(countAllTweets(db)).toBe(1);
    expect(feed([a]).posts[0].tweet.text).toBe("Exact saved text 100");
    expect(getXFeedState(db, a)?.olderCursor).toBe("older");
    expect(listResearchLists(db)[0]).toMatchObject({ name: "Renamed", creatorIds: [] });
  });
  it("rejects non-X or invalid memberships atomically, and cascades library deletion only to membership", () => {
    const a = creator("alpha"),
      y = creator("youtube", "youtube");
    const list = saveResearchList(db, { name: "Keep", creatorIds: [a] });
    expect(() => saveResearchList(db, { id: list.id, name: "Wrong", creatorIds: [y] })).toThrow();
    expect(() => saveResearchList(db, { name: "Invalid", creatorIds: [999] })).toThrow();
    expect(() => saveResearchList(db, { name: " " })).toThrow();
    expect(() => creatorIds(db, ["1 OR 1=1"])).toThrow();
    expect(listResearchLists(db)).toEqual([list]);
    db.prepare("DELETE FROM creators WHERE id = ?").run(a);
    expect(getResearchList(db, list.id).creatorIds).toEqual([]);
  });
});
describe("scoped paginated cached feed", () => {
  it("scopes before deduplicating and retains relevant sharers independently of canonical repost flags", () => {
    const outside = creator("outside"),
      a = creator("alpha"),
      b = creator("beta");
    post(outside, "100", "2026-09-28T12:00:00Z");
    post(a, "100", "2026-09-28T12:00:00Z");
    post(
      b,
      "100",
      "2026-09-28T12:00:00Z",
      { isRepost: true, repostedByHandle: "beta" },
      "repost",
      "2026-09-30T12:00:00Z",
    );
    expect(feed([a]).posts).toHaveLength(1);
    expect(feed([a]).posts[0].tweet.isRepost).toBe(false);
    const result = feed([a, b], { types: ["original", "repost"] });
    expect(result.total).toBe(1);
    expect(result.posts[0].provenance.map((p) => p.creatorId)).toEqual([b, a]);
    expect(result.posts[0].tweet.repostedByHandle).toBe("beta");
    expect(result.posts[0].eventAt).toBe("2026-09-30T12:00:00.000Z");
  });
  it("filters originals, quotes, replies, repost event dates, unknown dates and incomplete text without pruning", () => {
    const a = creator("alpha");
    post(a, "100", "2026-09-24T00:00:00Z");
    post(a, "101", "2026-09-29T12:00:00Z", { inReplyToTweetId: "100" }, "reply");
    post(a, "102", "2026-09-30T12:00:00Z", {
      quoted: { tweetId: "99", text: "Quoted speaker", url: "https://x.com/i/status/99" },
    });
    post(a, "103", "2020-01-01T00:00:00Z", { isRepost: true }, "repost", "2026-09-30T12:00:00Z");
    post(a, "104", null);
    post(a, "105", "2026-10-02T00:00:00Z");
    post(a, "106", "2026-09-30T12:00:00Z", { contentStatus: "summary" });
    post(a, "107", "2026-09-30T12:00:00Z", { contentStatus: "unavailable", text: "" });
    post(a, "108", "2026-09-30T12:00:00Z", { isRepost: true }, "repost", null);
    expect(
      feed([a], { types: ["original"] })
        .posts.map((p) => p.tweet.id)
        .sort(),
    ).toEqual(["100", "106", "107"]);
    expect(feed([a], { types: ["reply"] }).posts[0].parentCached).toBe(true);
    expect(feed([a], { types: ["quote"] }).posts[0].tweet.quoted?.text).toBe("Quoted speaker");
    expect(feed([a], { types: ["repost"] }).posts.map((p) => p.tweet.id)).toEqual(["103"]);
    expect(feed([a], { types: ["original", "repost"] }).unknownDates).toBe(2);
    expect(feed([a]).posts.find((p) => p.tweet.id === "106")?.tweet.readyForAnalysis).toBe(false);
    expect(feed([a], { types: [] }).total).toBe(0);
    expect(countAllTweets(db)).toBe(9);
  });
  it("pages all results with stable ordering and never sends the entire archive to the client", () => {
    const a = creator("alpha");
    for (let i = 0; i < 67; i++) post(a, String(1000 + i), "2026-09-30T12:00:00Z");
    const pages = [1, 2, 3].map((page) => feed([a], { page }));
    expect(pages.map((p) => p.posts.length)).toEqual([30, 30, 7]);
    expect(new Set(pages.flatMap((p) => p.posts.map((r) => r.tweet.id))).size).toBe(67);
    expect(pages[0].total).toBe(67);
    expect(feed([], {}).total).toBe(0);
  });
});
describe("inclusive calendar dates", () => {
  it("uses 23-hour and 25-hour DST days and half-open UTC boundaries", () => {
    expect(calendarBounds("2026-03-29", "2026-03-29", "Europe/Amsterdam")).toEqual({
      since: "2026-03-28T23:00:00.000Z",
      until: "2026-03-29T22:00:00.000Z",
    });
    expect(calendarBounds("2026-10-25", "2026-10-25", "Europe/Amsterdam")).toEqual({
      since: "2026-10-24T22:00:00.000Z",
      until: "2026-10-25T23:00:00.000Z",
    });
    const a = creator("alpha");
    post(a, "100", "2026-03-28T23:00:00Z");
    post(a, "101", "2026-03-29T21:59:59.999Z");
    post(a, "102", "2026-03-29T22:00:00Z");
    expect(feed([a], calendarBounds("2026-03-29", "2026-03-29", "Europe/Amsterdam")).total).toBe(2);
    expect(calendarDate(new Date("2026-09-30T23:00:00Z"), "Europe/Amsterdam")).toBe("2026-10-01");
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(() => calendarBounds("2026-02-30", "2026-03-01", "UTC")).toThrow();
    expect(() => calendarBounds("2026-10-02", "2026-10-01", "UTC")).toThrow();
    expect(() => calendarBounds("2011-12-30", "2011-12-30", "Pacific/Apia")).toThrow();
  });
});
describe("research routes", () => {
  it("validates list CRUD, stale lists, malformed JSON, and creator scope without provider access", async () => {
    const a = creator("alpha"),
      b = creator("beta");
    post(a, "100", "2026-09-30T12:00:00Z");
    const response = await listsPOST(json({ name: "Ethereum", creatorIds: [a] }));
    expect(response.status).toBe(201);
    const { list } = await response.json();
    const context = { params: Promise.resolve({ id: String(list.id) }) };
    expect((await PATCH(json({ name: "Renamed", creatorIds: [a, b] }), context)).status).toBe(200);
    const renamed = await PATCH(json({ name: "Rename only" }), context);
    expect((await renamed.json()).list.creatorIds).toEqual([a, b]);
    expect((await listsGET()).headers.get("Cache-Control")).toBe("no-store");
    const url = `http://localhost/api/x-research/feed?listId=${list.id}&start=2026-09-24&end=2026-10-01&timezone=Europe/Amsterdam`;
    expect((await (await feedGET(new Request(url))).json()).total).toBe(1);
    expect((await feedGET(new Request(url + "&creators=999"))).status).toBe(400);
    expect((await feedGET(new Request(url + "&page=0"))).status).toBe(400);
    expect((await feedGET(new Request(url + "&types=video"))).status).toBe(400);
    expect((await feedGET(new Request(url.replace("Europe/Amsterdam", "Invalid")))).status).toBe(
      400,
    );
    expect(
      (await listsPOST(new Request("http://localhost", { method: "POST", body: "{" }))).status,
    ).toBe(400);
    expect((await DELETE(new Request("http://localhost"), context)).status).toBe(200);
    expect((await feedGET(new Request(url))).status).toBe(404);
    expect(countAllTweets(db)).toBe(1);
  });
});
