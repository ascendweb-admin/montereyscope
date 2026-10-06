import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import { mapXTimelineItem } from "@/lib/x/mapper";
import { mergeCreatorTimeline, recordTweetNotRetrievable, upsertTweet } from "@/lib/x/repository";
import { readCachedFeed, saveResearchList } from "@/lib/x/research/repository";
import { parseExactSearch } from "@/lib/x/research/search";
import { GET } from "@/app/api/x-research/feed/route";

let db: Database.Database, directory: string, file: string;
vi.mock("@/lib/db/connection", () => ({ getDb: () => db }));
vi.mock("@/lib/x/providers", () => ({
  getXProvider: () => {
    throw new Error("Search must never read X");
  },
}));
const bounds = { since: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" };
function open(legacy = false) {
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  runMigrations(db, legacy ? ALL_MIGRATIONS.filter((m) => m.id !== "018") : ALL_MIGRATIONS);
}
function creator(handle: string) {
  return addCreator(db, {
    platform: "x",
    platformUserId: handle,
    youtubeChannelId: null,
    displayName: handle,
    handle,
    channelUrl: `https://x.com/${handle}`,
    avatarUrl: null,
  }).creator.id;
}
function item(id: string, text: string, extra = {}) {
  return mapXTimelineItem({
    tweet: {
      id,
      text,
      author: { userId: "123", handle: "author", displayName: "Author" },
      publishedAt: "2026-09-15T12:00:00Z",
      contentStatus: "complete",
      ...extra,
    },
    timelineKind: "post",
    timelineAt: "2026-09-15T12:00:00Z",
  })!;
}
function post(creatorId: number, id: string, text: string, extra = {}) {
  mergeCreatorTimeline(db, creatorId, [item(id, text, extra)]);
}
function search(
  ids: number[],
  fields: Parameters<typeof parseExactSearch>[0],
  page = 1,
  extra = {},
) {
  return readCachedFeed(db, {
    creatorIds: ids,
    ...bounds,
    types: ["original", "quote", "reply"],
    search: parseExactSearch(fields),
    page,
    ...extra,
  });
}
function integrity() {
  db.exec("INSERT INTO x_tweet_text(x_tweet_text, rank) VALUES ('integrity-check', 1)");
}
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "scope-search-"));
  file = path.join(directory, "db.sqlite");
  open();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("transactional local text index", () => {
  it("backfills an existing archive once and survives reopening without provider reads", () => {
    db.close();
    rmSync(file);
    open(true);
    const a = creator("alpha");
    post(a, "100", "Ethereum settlement");
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    expect(search([a], { terms: "Ethereum" }).total).toBe(1);
    integrity();
    db.close();
    open();
    expect(search([a], { terms: "settlement" }).posts[0].tweet.text).toBe("Ethereum settlement");
    integrity();
  });
  it("updates inserts, stronger text hydration, quoted speech and deletes atomically", () => {
    const a = creator("alpha");
    post(a, "100", "Preview", { contentStatus: "summary" });
    expect(search([a], { terms: "Ethereum" }).total).toBe(0);
    upsertTweet(
      db,
      item("100", "Ethereum full body", { quoted: { tweetId: "900", text: "Bitcoin" } }).tweet,
    );
    expect(search([a], { terms: "Ethereum" }).total).toBe(1);
    expect(search([a], { terms: "Bitcoin" }).total).toBe(0);
    expect(
      db
        .prepare("SELECT rowid FROM x_tweet_text WHERE x_tweet_text MATCH ?")
        .all('quoted_text : "Bitcoin"'),
    ).toHaveLength(1);
    post(a, "100", "Lost preview", { contentStatus: "summary" });
    post(a, "100", "", { contentStatus: "unavailable" });
    recordTweetNotRetrievable(db, "100");
    expect(search([a], { terms: "Ethereum" }).total).toBe(1);
    expect(search([a], { terms: "Lost" }).total).toBe(0);
    post(a, "100", "Revised Solana body", { quoted: { tweetId: "900", text: "Avalanche" } });
    expect(search([a], { terms: "Ethereum" }).total).toBe(0);
    expect(search([a], { terms: "Solana" }).total).toBe(1);
    expect(
      db
        .prepare("SELECT rowid FROM x_tweet_text WHERE x_tweet_text MATCH ?")
        .all('quoted_text : "Bitcoin"'),
    ).toHaveLength(0);
    integrity();
    db.prepare("DELETE FROM tweets WHERE id = ?").run("100");
    expect(search([a], { terms: "Solana" }).total).toBe(0);
    integrity();
  });
  it("rolls back index updates when a page/checkpoint transaction fails", () => {
    const a = creator("alpha");
    post(a, "100", "Ethereum saved body");
    expect(() =>
      db.transaction(() => {
        mergeCreatorTimeline(db, a, [
          item("100", "Changed Solana body"),
          item("101", "Solana new post"),
        ]);
        throw new Error("checkpoint failed");
      })(),
    ).toThrow("checkpoint failed");
    expect(search([a], { terms: "Ethereum" }).total).toBe(1);
    expect(search([a], { terms: "Solana" }).total).toBe(0);
    integrity();
  });
});

describe("scoped exact results", () => {
  it("enumerates every match through pages, scoping before deduplication", () => {
    const outside = creator("outside"),
      a = creator("alpha"),
      b = creator("beta");
    for (let n = 0; n < 77; n++) {
      post(outside, String(100 + n), "Ethereum fees");
      post(a, String(100 + n), "Ethereum fees");
      if (n % 2 === 0) post(b, String(100 + n), "Ethereum fees");
    }
    post(outside, "999", "Ethereum outside only");
    const pages = [1, 2, 3].map((p) => search([a, b], { terms: "Ethereum" }, p));
    expect(pages.map((p) => p.posts.length)).toEqual([30, 30, 17]);
    expect(pages.map((p) => p.total)).toEqual([77, 77, 77]);
    expect(new Set(pages.flatMap((p) => p.posts.map((post) => post.tweet.id))).size).toBe(77);
    expect(pages[0].posts[0].provenance.map((p) => p.creatorId)).toEqual([a, b]);
    expect(pages[0].posts[0].match).toEqual({ terms: ["Ethereum"], aliases: [] });
    expect(search([a], { terms: "Ethereum" }, 4)).toMatchObject({ page: 3, total: 77 });
  });
  it("keeps remaining matches accessible when text updates remove the open page", () => {
    const a = creator("alpha");
    for (let n = 0; n < 65; n++) post(a, String(100 + n), "Ethereum original body");
    expect(search([a], { terms: "Ethereum" }, 3).posts).toHaveLength(5);
    for (let n = 0; n < 30; n++) post(a, String(100 + n), "Revised Solana body");
    const remaining = search([a], { terms: "Ethereum" }, 3);
    expect(remaining).toMatchObject({ page: 2, total: 35 });
    expect(remaining.posts).toHaveLength(5);
    integrity();
  });
  it("requires literal phrases, explicit aliases and exclusions only in post text", () => {
    const a = creator("alpha");
    post(a, "100", "Ethereum lower fees");
    post(a, "101", "ETH lower fees speculation");
    post(a, "102", "$ETH LOWER FEES");
    post(a, "103", "Ethereum much lower network fees");
    post(a, "104", "Ethereum lower fees", { quoted: { tweetId: "900", text: "speculation" } });
    post(a, "105", "I disagree", { quoted: { tweetId: "901", text: "Ethereum lower fees" } });
    post(a, "106", "ETHICAL lower fees");
    const result = search([a], {
      terms: "lower fees",
      aliases: "ETH\nEthereum\n$ETH",
      exclusions: "speculation",
    });
    expect(result.posts.map((p) => p.tweet.id)).toEqual(["104", "102", "100"]);
    expect(result.posts[1].match?.aliases).toEqual(["$ETH"]);
    expect(search([a], { terms: "ETH" }).posts.map((p) => p.tweet.id)).toEqual(["101"]);
    expect(search([a], { terms: "Ethereum\nnetwork fees" }).posts.map((p) => p.tweet.id)).toEqual([
      "103",
    ]);
  });
  it("escapes SQL/FTS operators, quotes, column selectors and wildcards as literals", () => {
    const a = creator("alpha");
    post(a, "100", "Ethereum OR Bitcoin");
    post(a, "101", "Ethereum");
    post(a, "102", "Bitcoin");
    expect(search([a], { terms: 'Ethereum" OR "Bitcoin' }).posts.map((p) => p.tweet.id)).toEqual([
      "100",
    ]);
    expect(search([a], { terms: "Eth*" }).total).toBe(0);
    expect(search([a], { terms: "text: Ethereum" }).total).toBe(0);
    expect(search([a], { terms: "Ethereum' OR 1=1 --" }).total).toBe(0);
    expect(search([a], { terms: "NEAR(Ethereum Bitcoin)" }).total).toBe(0);
    expect(search([a], { terms: '"Ethereum"' }).total).toBe(2);
    integrity();
  });
  it("honors old requested dates, post types and repost event dates, qualifying missing text/dates", () => {
    const a = creator("alpha");
    post(a, "100", "Ethereum recent", { publishedAt: "2026-10-02T12:00:00Z" });
    post(a, "101", "Ethereum old", { publishedAt: "2026-03-29T12:00:00Z" });
    post(a, "102", "Ethereum unknown", { publishedAt: null });
    post(a, "103", "Ethereum preview", { contentStatus: "summary" });
    post(a, "104", "", { contentStatus: "unavailable" });
    post(a, "105", "Ethereum reply", { inReplyToTweetId: "800" });
    const repost = item("106", "Ethereum shared", { publishedAt: "2020-01-01T00:00:00Z" });
    mergeCreatorTimeline(db, a, [
      { ...repost, timelineKind: "repost", timelineAt: "2026-09-16T00:00:00Z" },
    ]);
    expect(search([a], { terms: "Ethereum" }).total).toBe(2);
    const current = search([a], { terms: "Ethereum" }, 1, {
      types: ["original", "reply", "repost"],
    });
    expect(current.total).toBe(3);
    expect(current.scopeTotal).toBe(4);
    expect(current.incompleteText).toBe(2);
    expect(current.unknownDates).toBe(1);
    expect(current.posts[0].postType).toBe("repost");
    expect(
      search([a], { terms: "Ethereum" }, 1, {
        since: "2026-03-01T00:00:00Z",
        until: "2026-04-01T00:00:00Z",
      }).posts.map((p) => p.tweet.id),
    ).toEqual(["101"]);
  });
  it("validates bounded fields and never accepts exclusion-only searches", () => {
    for (const fields of [
      { exclusions: "Ethereum" },
      { terms: "***" },
      { terms: "\0ETH" },
      { terms: "x".repeat(151) },
      { aliases: Array.from({ length: 13 }, (_, n) => `word${n}`).join("\n") },
      { terms: ["ETH"] },
    ])
      expect(() => parseExactSearch(fields)).toThrow();
    expect(parseExactSearch({ aliases: " ETH\r\nEthereum\nETH\n" }).aliases).toEqual([
      "ETH",
      "Ethereum",
    ]);
  });
});

describe("local search route", () => {
  it("resolves list membership and inclusive timezone dates on the server", async () => {
    const a = creator("alpha"),
      b = creator("beta");
    const list = saveResearchList(db, { name: "Archive", creatorIds: [a] });
    post(a, "100", "Ethereum old", { publishedAt: "2026-03-29T20:00:00Z" });
    post(a, "101", "Ethereum outside", { publishedAt: "2026-03-29T22:00:00Z" });
    const params = new URLSearchParams({
      listId: String(list.id),
      mode: "exact",
      aliases: "ETH\nEthereum\n$ETH",
      start: "2026-03-29",
      end: "2026-03-29",
      timezone: "Europe/Amsterdam",
    });
    const result = await GET(new Request(`http://localhost/api/x-research/feed?${params}`));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const body = await result.json();
    expect(body.total).toBe(1);
    expect(body.posts[0].tweet.id).toBe("100");
    expect(body.bounds).toEqual({
      since: "2026-03-28T23:00:00.000Z",
      until: "2026-03-29T22:00:00.000Z",
    });
    params.set("creators", String(b));
    expect((await GET(new Request(`http://localhost/api/x-research/feed?${params}`))).status).toBe(
      400,
    );
  });
  it("rejects unavailable modes, invalid phrases, dates and pagination", async () => {
    const a = creator("alpha");
    const params = new URLSearchParams({
      creators: String(a),
      mode: "exact",
      terms: "ETH",
      start: "2026-09-01",
      end: "2026-09-30",
    });
    for (const [key, value] of [
      ["mode", "related"],
      ["terms", "***"],
      ["page", "1 OR 1=1"],
      ["start", "bad"],
    ]) {
      const invalid = new URLSearchParams(params);
      invalid.set(key, value);
      expect(
        (await GET(new Request(`http://localhost/api/x-research/feed?${invalid}`))).status,
      ).toBe(400);
    }
  });
});
