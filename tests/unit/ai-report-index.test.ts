import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildReportMatchExpression,
  searchReportText,
  syncReportIndex,
} from "@/lib/ai/report-index";
import { getReport, publicReportFor, renameReport } from "@/lib/ai/reports";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

/**
 * What the Reports page knows about a finished document without opening it
 * — its outline, reading time, and searchable text, kept current lazily —
 * and who a report is about: the people, categories, and platforms behind
 * its sources, including the posts an X Dashboard brief was written from.
 */

const FORK_HTML = [
  '<!doctype html><html lang="en"><head><title>Fork</title></head><body>',
  "<header><h1>Markets at a Fork</h1>",
  '<p class="dek">A single-source analysis of a livestream.</p></header>',
  '<section><h2 id="overview">Executive overview</h2>',
  "<p>The central signal is a fragile, highly selective trading environment.</p></section>",
  "<section><h2>Key themes</h2><h3>Distribution may matter as much as the asset</h3>",
  "<p>Warsh at Jackson Hole is the hinge for the week.</p></section>",
  "</body></html>",
].join("");

let db: Database.Database;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "scope-report-index-"));
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeReport(name: string, html: string): string {
  const file = path.join(dir, `${name}.html`);
  writeFileSync(file, html);
  return file;
}

/** A report row in the given state, with its sources and document. */
function insertReport(input: {
  status?: "queued" | "done";
  filePath?: string | null;
  title?: string | null;
  sources?: Array<{ kind: "video" | "tweet"; id: string }>;
  researchHtml?: string;
}): number {
  const sources = input.sources ?? [];
  return Number(
    db
      .prepare(
        `INSERT INTO ai_reports
           (selected_video_ids, selected_sources, status, file_path, title, research_html, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        JSON.stringify(sources.filter((ref) => ref.kind === "video").map((ref) => ref.id)),
        JSON.stringify({ version: 1, sources }),
        input.status ?? "done",
        input.filePath ?? null,
        input.title ?? null,
        input.researchHtml ?? null,
        input.status === "queued" ? null : "2026-08-28T12:04:00.000Z",
      ).lastInsertRowid,
  );
}

function addCreator(name: string, platform: "youtube" | "x", avatarUrl: string | null = null) {
  return Number(
    db
      .prepare(
        "INSERT INTO creators (display_name, channel_url, platform, platform_user_id, avatar_url) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        name,
        `https://example.invalid/${name}-${platform}`,
        platform,
        `${name}-${platform}`,
        avatarUrl,
      ).lastInsertRowid,
  );
}

function profileOf(creatorId: number): number {
  return Number(
    (
      db.prepare("SELECT profile_id FROM creators WHERE id = ?").get(creatorId) as {
        profile_id: number;
      }
    ).profile_id,
  );
}

function addVideo(id: string, creatorId: number): void {
  db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
    id,
    creatorId,
    `Video ${id}`,
    `https://www.youtube.com/watch?v=${id}`,
  );
}

function addTweet(id: string, creatorId: number, publishedAt: string): void {
  db.prepare(
    "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    "1",
    "handle",
    "Author",
    `https://x.com/handle/status/${id}`,
    `Post ${id}`,
    publishedAt,
  );
  db.prepare(
    "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, 'post', ?)",
  ).run(creatorId, id, publishedAt);
}

function publicReport(id: number) {
  return publicReportFor(db, getReport(db, id)!);
}

describe("syncReportIndex", () => {
  it("reads each finished document once and again only when it changes", () => {
    const fork = insertReport({
      filePath: writeReport("fork", FORK_HTML),
      title: "Markets at a Fork",
    });
    insertReport({ status: "queued" });

    expect(publicReport(fork).outline).toEqual([]);
    expect(syncReportIndex(db)).toBe(1);
    expect(syncReportIndex(db)).toBe(0);

    expect(publicReport(fork)).toMatchObject({
      outline: [
        { id: "overview", text: "Executive overview", level: 2 },
        { id: "scope-section-1", text: "Key themes", level: 2 },
        { id: "scope-section-2", text: "Distribution may matter as much as the asset", level: 3 },
      ],
      readingMinutes: 1,
    });
    expect(publicReport(fork).wordCount).toBeGreaterThan(20);

    // A rename changes what the index searches, so the report is read again.
    renameReport(db, fork, "My fork notes");
    expect(syncReportIndex(db)).toBe(1);
    expect(searchReportText(db, "notes")).toEqual([{ id: fork, snippet: null }]);
  });

  it("retries a document it could not read and forgets deleted reports", () => {
    const file = path.join(dir, "late.html");
    const late = insertReport({ filePath: file });
    expect(syncReportIndex(db)).toBe(0);
    expect(publicReport(late)).toMatchObject({
      outline: [],
      wordCount: null,
      readingMinutes: null,
    });

    writeFileSync(file, FORK_HTML);
    expect(syncReportIndex(db)).toBe(1);
    expect(searchReportText(db, "fragile")).toHaveLength(1);

    db.prepare("DELETE FROM ai_reports WHERE id = ?").run(late);
    expect(searchReportText(db, "fragile")).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ai_report_index").get()).toEqual({ n: 0 });
  });

  it("indexes briefs stored in the database and re-reads them when re-saved", () => {
    const brief = insertReport({
      researchHtml: "<h1>Brief</h1><h3>TL;DR</h3><p>BTC rebound conviction dominated.</p>",
    });
    syncReportIndex(db);
    expect(searchReportText(db, "rebound")).toHaveLength(1);

    db.prepare("UPDATE ai_reports SET research_html = ?, completed_at = ? WHERE id = ?").run(
      "<h1>Brief</h1><h3>TL;DR</h3><p>Memecoin recovery trades.</p>",
      "2026-08-29T08:00:00.000Z",
      brief,
    );
    expect(syncReportIndex(db)).toBe(1);
    expect(searchReportText(db, "rebound")).toEqual([]);
    expect(searchReportText(db, "memecoin")).toHaveLength(1);
  });
});

describe("searchReportText", () => {
  it("finds words and word prefixes in the body, with the hit marked", () => {
    const fork = insertReport({
      filePath: writeReport("fork", FORK_HTML),
      title: "Markets at a Fork",
    });
    syncReportIndex(db);

    const [hit] = searchReportText(db, "jackson hole");
    expect(hit.id).toBe(fork);
    expect(hit.snippet).toContain("\u0002Jackson\u0003 \u0002Hole\u0003");
    expect(searchReportText(db, "selec")).toHaveLength(1);
    // Every term must match.
    expect(searchReportText(db, "jackson unicorn")).toEqual([]);
    // A headline-only match has nothing new to show.
    expect(searchReportText(db, "fork")).toEqual([{ id: fork, snippet: null }]);
  });

  it("takes what the user typed literally", () => {
    insertReport({ filePath: writeReport("fork", FORK_HTML) });
    syncReportIndex(db);

    expect(searchReportText(db, "")).toEqual([]);
    expect(searchReportText(db, "  — … ")).toEqual([]);
    expect(searchReportText(db, 'NEAR( "warsh OR AND')).toEqual([]);
    expect(searchReportText(db, '"warsh"')).toHaveLength(1);
    expect(buildReportMatchExpression('Warsh "AND" fed*')).toBe('"warsh"* "and"* "fed*"*');
  });
});

describe("publicReportFor", () => {
  it("names the people, categories, and platforms behind a report's sources", () => {
    const youtube = addCreator("threadguy", "youtube");
    const x = addCreator("notthreadguy", "x", "https://pbs.twimg.com/profile/a.jpg");
    const person = profileOf(youtube);
    // The X account belongs to the same person.
    db.prepare("UPDATE creators SET profile_id = ? WHERE id = ?").run(person, x);
    const other = addCreator("Bijan", "youtube");
    const crypto = Number(
      db.prepare("INSERT INTO categories (name, color) VALUES ('Crypto', 'sky')").run()
        .lastInsertRowid,
    );
    const ai = Number(
      db.prepare("INSERT INTO categories (name, color) VALUES ('AI', 'violet')").run()
        .lastInsertRowid,
    );
    db.prepare("INSERT INTO profile_categories (profile_id, category_id) VALUES (?, ?)").run(
      person,
      crypto,
    );
    db.prepare("INSERT INTO profile_categories (profile_id, category_id) VALUES (?, ?)").run(
      profileOf(other),
      ai,
    );
    addVideo("vid0000001", youtube);
    addVideo("vid0000002", other);
    addTweet("1000000000000000001", x, "2026-08-27T10:00:00.000Z");

    const id = insertReport({
      sources: [
        { kind: "video", id: "vid0000001" },
        { kind: "tweet", id: "1000000000000000001" },
        { kind: "video", id: "vid0000002" },
      ],
    });
    expect(publicReport(id)).toMatchObject({
      origin: "report",
      scopeLabel: null,
      creators: [
        {
          id: person,
          name: "threadguy",
          sourceCount: 2,
          // The only account with an avatar represents the person.
          avatarCreatorId: x,
          avatarUrl: "https://pbs.twimg.com/profile/a.jpg",
        },
        { id: profileOf(other), name: "Bijan", sourceCount: 1, avatarCreatorId: null },
      ],
      categories: [
        { id: ai, name: "AI", color: "violet" },
        { id: crypto, name: "Crypto", color: "sky" },
      ],
      platforms: ["youtube", "x"],
    });
  });

  it("resolves an X Dashboard brief's posts as its sources, newest first", () => {
    const ansem = addCreator("Ansem", "x");
    const flood = addCreator("Flood", "x");
    addTweet("1000000000000000011", ansem, "2026-10-15T09:00:00.000Z");
    addTweet("1000000000000000012", flood, "2026-10-15T11:00:00.000Z");
    addTweet("1000000000000000013", ansem, "2026-10-15T10:00:00.000Z");
    const brief = insertReport({ researchHtml: "<h1>Brief me · Crypto KOL's</h1>" });
    db.prepare(
      `INSERT INTO x_insights (id, title, scope_json, post_count, backend, model, status, report_id)
       VALUES ('insight-1', 'Brief me', ?, 3, 'codex', 'gpt', 'complete', ?)`,
    ).run(JSON.stringify({ label: "Crypto KOL's", period: "24h" }), brief);
    for (const tweet of ["1000000000000000011", "1000000000000000012", "1000000000000000013"]) {
      db.prepare("INSERT INTO x_insight_posts (insight_id, tweet_id) VALUES ('insight-1', ?)").run(
        tweet,
      );
    }

    const report = publicReport(brief);
    expect(report).toMatchObject({
      origin: "x-dashboard",
      scopeLabel: "Crypto KOL's",
      sourceCount: 3,
      platforms: ["x"],
      fileUrl: `/api/ai/reports/${brief}/file`,
    });
    expect(report.sources.map((source) => source.id)).toEqual([
      "1000000000000000012",
      "1000000000000000013",
      "1000000000000000011",
    ]);
    expect(report.creators.map((creator) => [creator.name, creator.sourceCount])).toEqual([
      ["Ansem", 2],
      ["Flood", 1],
    ]);
  });
});
