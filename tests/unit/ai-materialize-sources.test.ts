/**
 * Mixed-source materialization (v2): cached X posts land next to video
 * transcripts in a fresh job directory, every requested source is recorded
 * in the manifest whether or not a file was written, and the shared byte
 * budget still cuts files byte-accurately.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { materializeSources, TRUNCATION_MARKER } from "@/lib/ai/materialize";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-materialize-sources-"));
  tempDirs.push(dir);
  const db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);

  const creatorId = Number(
    db
      .prepare(
        "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, 'x', ?)",
      )
      .run("Fixture Dev", "https://x.com/fixture_dev", "1234567890123456789").lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, published_at, fetched_at, content_status, is_repost, reposted_by_handle, quoted_handle, quoted_name, quoted_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "1234567890123456701",
    "1234567890123456789",
    "fixture_dev",
    "Fixture Dev",
    "https://x.com/fixture_dev/status/1234567890123456701",
    "First line of the post.\n\nA long-note tail with 日本語 and emoji 🌍.",
    "2026-09-16T10:00:00.000Z",
    "2026-09-16T11:00:00.000Z",
    "complete",
    0,
    null,
    "somebody",
    "Somebody",
    "The quoted claim that started this.",
  );
  db.prepare(
    "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, content_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "1234567890123456702",
    "999",
    "somebody",
    "Somebody",
    "https://x.com/somebody/status/1234567890123456702",
    "",
    "unavailable",
  );
  db.prepare(
    "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, ?, ?)",
  ).run(creatorId, "1234567890123456701", "post", "2026-09-16T10:00:00.000Z");
  db.prepare(
    "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, ?, ?)",
  ).run(creatorId, "1234567890123456702", "repost", "2026-09-15T10:00:00.000Z");

  const videoCreator = Number(
    db
      .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
      .run("Video Creator", "https://www.youtube.com/@videos").lastInsertRowid,
  );
  db.prepare("INSERT INTO videos (id, creator_id, title, url, published_at) VALUES (?, ?, ?, ?, ?)").run(
    "videoManual01",
    videoCreator,
    "Manual caption video",
    "https://www.youtube.com/watch?v=videoManual01",
    "2026-08-01T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
  ).run("videoManual01", "en", "manual", "Transcript body for the mixed job.");

  return db;
}

describe("materializeSources", () => {
  it("writes one file per ready source and records the full manifest", () => {
    const db = createDb();
    const jobsRoot = mkdtempSync(path.join(tmpdir(), "scope-jobs-"));
    tempDirs.push(jobsRoot);

    const outcome = materializeSources(
      db,
      [
        { kind: "tweet", id: "1234567890123456701" },
        { kind: "video", id: "videoManual01" },
        { kind: "tweet", id: "1234567890123456702" },
        { kind: "tweet", id: "999999999" },
      ],
      { jobsRoot, jobId: "mixed-job" },
    );

    expect(existsSync(path.join(outcome.jobDir, "manifest.json"))).toBe(true);
    const tweetFile = readFileSync(
      path.join(outcome.jobDir, "tweets", "1234567890123456701.txt"),
      "utf8",
    );
    expect(tweetFile).toContain("Type: X post");
    expect(tweetFile).toContain("Author: Fixture Dev (@fixture_dev)");
    expect(tweetFile).toContain("🌍");
    // Quoted material is labelled as context, not attributed to the author.
    expect(tweetFile).toContain("Quoted post by @somebody (Somebody):");
    expect(tweetFile).toContain("> The quoted claim that started this.");

    const videoFile = readFileSync(
      path.join(outcome.jobDir, "transcripts", "videoManual01.txt"),
      "utf8",
    );
    expect(videoFile).toContain("Transcript body for the mixed job.");

    expect(outcome.manifest.version).toBe(2);
    const byKey = new Map(
      outcome.manifest.sources.map((source) => [`${source.kind}:${source.id}`, source]),
    );
    expect(byKey.get("tweet:1234567890123456701")?.file).toBe(
      "tweets/1234567890123456701.txt",
    );
    expect(byKey.get("video:videoManual01")?.file).toBe("transcripts/videoManual01.txt");
    expect(byKey.get("tweet:1234567890123456702")?.exclusionReason).toBe("missing_text");
    expect(byKey.get("tweet:999999999")?.exclusionReason).toBe("unknown_source");
    expect(outcome.manifest.truncation).toBeNull();
    db.close();
  });

  it("applies the shared byte budget across kinds with a truncation marker", () => {
    const db = createDb();
    const jobsRoot = mkdtempSync(path.join(tmpdir(), "scope-jobs-"));
    tempDirs.push(jobsRoot);

    const outcome = materializeSources(
      db,
      [
        { kind: "video", id: "videoManual01" },
        { kind: "tweet", id: "1234567890123456701" },
      ],
      { jobsRoot, jobId: "budget-job", maxTotalBytes: 150 },
    );

    const truncation = outcome.manifest.truncation;
    expect(truncation).not.toBeNull();
    expect(truncation?.limitBytes).toBe(150);
    expect(truncation?.truncatedSourceKeys).toContain("video:videoManual01");
    expect(truncation?.skippedSourceKeys).toContain("tweet:1234567890123456701");
    const videoFile = readFileSync(
      path.join(outcome.jobDir, "transcripts", "videoManual01.txt"),
      "utf8",
    );
    expect(videoFile).toContain(TRUNCATION_MARKER);
    expect(existsSync(path.join(outcome.jobDir, "tweets", "1234567890123456701.txt"))).toBe(false);
    db.close();
  });
});
