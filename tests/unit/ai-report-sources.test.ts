/**
 * Report mixed-source persistence: versioned selected_sources documents,
 * tweet sources resolved for the list UI, and the reports route's
 * normalization/refusal for unusable tweet-only scopes.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDb } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import {
  createReport,
  getReport,
  getReportSources,
  publicReportFor,
} from "@/lib/ai/reports";
import { POST as POST_REPORTS } from "@/app/api/ai/reports/route";

const TWEET_ID = "1234567890123456701";
const VIDEO_ID = "videoManual01";

let tempDir = "";

function seed(db: Database.Database): void {
  const xCreator = Number(
    db
      .prepare(
        "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, 'x', ?)",
      )
      .run("Fixture Dev", "https://x.com/fixture_dev", "1").lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, published_at, media_json, content_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    TWEET_ID,
    "1",
    "fixture_dev",
    "Fixture Dev",
    `https://x.com/fixture_dev/status/${TWEET_ID}`,
    "First line of the cached post.\nSecond line.",
    "2026-09-16T10:00:00.000Z",
    JSON.stringify([{ kind: "photo", url: "https://pbs.twimg.com/media/x.jpg" }]),
    "complete",
  );
  db.prepare(
    "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, 'post', ?)",
  ).run(xCreator, TWEET_ID, "2026-09-16T10:00:00.000Z");

  const videoCreator = Number(
    db
      .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
      .run("Video Creator", "https://www.youtube.com/@videos").lastInsertRowid,
  );
  db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
    VIDEO_ID,
    videoCreator,
    "A video",
    "https://www.youtube.com/watch?v=videoManual01",
  );
  db.prepare(
    "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
  ).run(VIDEO_ID, "en", "manual", "Transcript.");
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "scope-report-sources-"));
  process.env.LOCALTUBE_DB_PATH = path.join(tempDir, "reports.db");
  const direct = new Database(process.env.LOCALTUBE_DB_PATH);
  direct.pragma("foreign_keys = ON");
  runMigrations(direct, ALL_MIGRATIONS);
  seed(direct);
  direct.close();
});

afterEach(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("report sources", () => {
  it("persists mixed references and resolves them for the list", () => {
    const db = getDb();
    const report = createReport(db, [
      { kind: "tweet", id: TWEET_ID },
      { kind: "video", id: VIDEO_ID },
    ]);
    expect(report.sources).toEqual([
      { kind: "tweet", id: TWEET_ID },
      { kind: "video", id: VIDEO_ID },
    ]);
    expect(report.videoIds).toEqual([VIDEO_ID]);

    // Stored and reread through the versioned document.
    const stored = getReport(db, report.id);
    expect(stored?.sources).toEqual(report.sources);

    const resolved = getReportSources(db, report.sources);
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({
      kind: "tweet",
      id: TWEET_ID,
      title: "First line of the cached post.",
      creatorName: "Fixture Dev",
      url: `https://x.com/fixture_dev/status/${TWEET_ID}`,
    });
    expect(resolved[0].thumbnailUrl).toBe("https://pbs.twimg.com/media/x.jpg");
    expect(resolved[1]).toMatchObject({ kind: "video", id: VIDEO_ID });

    const publicReport = publicReportFor(db, report);
    expect(publicReport.sourceCount).toBe(2);
    expect(publicReport.sources).toHaveLength(2);
    expect(publicReport.videos).toHaveLength(1);
  });

  it("accepts legacy video id lists unchanged", () => {
    const db = getDb();
    const report = createReport(db, [VIDEO_ID]);
    expect(report.sources).toEqual([{ kind: "video", id: VIDEO_ID }]);
    expect(report.videoIds).toEqual([VIDEO_ID]);
  });

  it("refuses a tweet-only scope without cached text via the route", async () => {
    const response = await POST_REPORTS(
      new Request("http://127.0.0.1:3000/api/ai/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sources: [
            { kind: "tweet", id: "999" },
            { kind: "tweet", id: "1000" },
          ],
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string };
      unknownSources: unknown[];
    };
    expect(body.error.code).toBe("no_ready_sources");
    expect(body.unknownSources).toHaveLength(2);
  });
});
