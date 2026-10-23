import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { readDashboardFeed } from "@/lib/x/dashboard/feed";
import { InsightEngine } from "@/lib/x/dashboard/insights";
import { freezeCorpus, getCorpusPost } from "@/lib/x/research/corpus";
import { readCachedFeed } from "@/lib/x/research/repository";
import { parseExactSearch } from "@/lib/x/research/search";
import { addXCreator, corpusInput, putPost } from "../helpers/x-analysis";

let db: Database.Database, directory: string, creator: number;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "scope-cjk-search-"));
  db = new Database(path.join(directory, "db.sqlite"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
  creator = addXCreator(db, "markets");
  putPost(db, creator, "100", "東京の市場はどうなる？ ETH 強気");
  putPost(db, creator, "101", "An external report", {
    quoted: { tweetId: "900", text: "東京の市場はどうなる？", handle: "quoted" },
  });
  putPost(db, creator, "102", "上海の市場は弱気");
  putPost(db, creator, "103", "東京の市場 ETHEREUM 弱気");
  putPost(db, addXCreator(db, "outside"), "104", "東京の市場 ETH");
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
const feed = (query: string) =>
  readDashboardFeed(db, { creatorIds: [creator], period: "all", show: "posts", query });

it("finds CJK phrases without spaces, while preserving authored-only scope and Latin word boundaries", () => {
  expect(
    feed("東京")
      .posts.map((p) => p.tweet.id)
      .sort(),
  ).toEqual(["100", "103"]);
  expect(feed("市場").total).toBe(3);
  expect(feed("東京 ETH").posts.map((p) => p.tweet.id)).toEqual(["100"]);
  expect(feed("東京 -弱気").posts.map((p) => p.tweet.id)).toEqual(["100"]);
  expect(feed('東京" OR "x').total).toBe(0);
});

it("retains CJK alias matches and exclusions in exact-search results", () => {
  const result = readCachedFeed(db, {
    creatorIds: [creator],
    since: "2026-09-01T00:00:00Z",
    until: "2026-10-01T00:00:00Z",
    types: ["original", "quote"],
    search: parseExactSearch({ terms: "市場", aliases: "東京\n上海", exclusions: "弱気" }),
  });
  expect(result.posts.map((p) => p.tweet.id)).toEqual(["100"]);
  expect(result.posts[0].match?.aliases).toEqual(["東京"]);
});

it("freezes the same CJK result set for durable analysis and keeps it after cache deletion", () => {
  const scope = freezeCorpus(
    db,
    {
      ...corpusInput,
      creatorIds: [creator],
      selection: { kind: "exact", search: { terms: "東京", exclusions: "弱気" } },
    },
    1_000_000,
  );
  expect(scope.summary.total).toBe(1);
  db.prepare("DELETE FROM creators").run();
  expect(getCorpusPost(db, scope.id, "100").tweet.text).toContain("東京");
  expect(() => getCorpusPost(db, scope.id, "101")).toThrow("not in the saved research scope");
});

it("uses the displayed CJK search result set for insight preview counts", () => {
  const engine = new InsightEngine({ database: () => db, jobsRoot: directory });
  const preview = engine.preview({
    label: "CJK markets",
    listId: null,
    creatorIds: [creator],
    period: "all",
    show: "posts",
    query: "東京 -弱気",
  });
  expect(preview).toMatchObject({ postCount: feed("東京 -弱気").total, total: 1, accounts: 1 });
});
