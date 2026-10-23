/**
 * Mixed-source materialization (v2): cached X posts land next to video
 * transcripts in a fresh job directory, every requested source is recorded
 * in the manifest whether or not a file was written, and the shared byte
 * budget still cuts files byte-accurately.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { materializeSources, POST_BUNDLE_MAX_BYTES, TRUNCATION_MARKER } from "@/lib/ai/materialize";
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
  db.prepare(
    "INSERT INTO videos (id, creator_id, title, url, published_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
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
  it("labels every file with the person, so linked platforms read as one creator", () => {
    const db = createDb();
    const jobsRoot = mkdtempSync(path.join(tmpdir(), "scope-jobs-"));
    tempDirs.push(jobsRoot);
    // Link the X account into the video creator's profile under one name.
    const [xAccount, videoAccount] = db
      .prepare<[], { id: number; profile_id: number }>(
        "SELECT id, profile_id FROM creators ORDER BY id",
      )
      .all();
    db.prepare("UPDATE creators SET handle = 'fixture_dev' WHERE id = ?").run(xAccount.id);
    db.prepare("UPDATE creators SET handle = 'videos' WHERE id = ?").run(videoAccount.id);
    db.prepare("UPDATE creators SET profile_id = ? WHERE id = ?").run(
      videoAccount.profile_id,
      xAccount.id,
    );
    db.prepare("UPDATE creator_profiles SET display_name = 'Dana Fixture' WHERE id = ?").run(
      videoAccount.profile_id,
    );

    const outcome = materializeSources(
      db,
      [
        { kind: "video", id: "videoManual01" },
        { kind: "tweet", id: "1234567890123456701" },
      ],
      { jobsRoot, jobId: "linked-job" },
    );
    const videoFile = readFileSync(
      path.join(outcome.jobDir, "transcripts", "videoManual01.txt"),
      "utf8",
    );
    // Posts bundle per saved account, named after its handle.
    const tweetFile = readFileSync(path.join(outcome.jobDir, "tweets", "fixture_dev.txt"), "utf8");
    expect(videoFile).toContain("Creator: Dana Fixture\nChannel: YouTube @videos\n");
    expect(tweetFile).toContain("Creator: Dana Fixture\nChannel: X @fixture_dev\n");
    // The post still credits whoever wrote it.
    expect(tweetFile).toContain("[tweets/1234567890123456701.txt] Fixture Dev (@fixture_dev)");
  });

  it("names the featured people in the header of a guest appearance's file", () => {
    const db = createDb();
    const jobsRoot = mkdtempSync(path.join(tmpdir(), "scope-jobs-"));
    tempDirs.push(jobsRoot);
    // The video lives on a hidden host and features the X account's person.
    const host = db
      .prepare<[], { id: number }>("SELECT id FROM creators WHERE platform = 'youtube'")
      .get()!;
    db.prepare("UPDATE creators SET followed = 0, handle = 'hostchannel' WHERE id = ?").run(
      host.id,
    );
    db.prepare(
      "INSERT INTO profile_videos (profile_id, video_id) SELECT profile_id, 'videoManual01' FROM creators WHERE platform = 'x'",
    ).run();

    const outcome = materializeSources(db, [{ kind: "video", id: "videoManual01" }], {
      jobsRoot,
      jobId: "job-featuring",
    });

    const file = readFileSync(
      path.join(outcome.jobDir, "transcripts", "videoManual01.txt"),
      "utf8",
    );
    expect(file.split("\n").slice(0, 4)).toEqual([
      "Title: Manual caption video",
      "Creator: Video Creator",
      "Channel: YouTube @hostchannel",
      "Featuring: Fixture Dev",
    ]);
    // The manifest keeps who is featured, so a saved thread can cite
    // "{person} on {channel}" after the live library changes.
    expect(outcome.manifest.sources.find((entry) => entry.id === "videoManual01")).toMatchObject({
      creator: "Video Creator",
      featuring: ["Fixture Dev"],
    });
  });

  it("omits the Featuring line when the video features nobody", () => {
    const db = createDb();
    const jobsRoot = mkdtempSync(path.join(tmpdir(), "scope-jobs-"));
    tempDirs.push(jobsRoot);

    const outcome = materializeSources(db, [{ kind: "video", id: "videoManual01" }], {
      jobsRoot,
      jobId: "job-plain",
    });

    expect(
      readFileSync(path.join(outcome.jobDir, "transcripts", "videoManual01.txt"), "utf8"),
    ).not.toContain("Featuring");
    // Left out of the manifest too, so older and plain entries look the same.
    expect(outcome.manifest.sources[0]).not.toHaveProperty("featuring");
  });

  it("writes a file per ready video, a bundle per account, and the full manifest", () => {
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
    const byKey = new Map(
      outcome.manifest.sources.map((source) => [`${source.kind}:${source.id}`, source]),
    );
    // An account without a known handle bundles under its id.
    const bundle = byKey.get("tweet:1234567890123456701")?.file;
    expect(bundle).toMatch(/^tweets\/account-\d+\.txt$/);
    const tweetFile = readFileSync(path.join(outcome.jobDir, bundle!), "utf8");
    expect(tweetFile).toContain("Type: X posts, newest first");
    expect(tweetFile).toContain(
      "[tweets/1234567890123456701.txt] Fixture Dev (@fixture_dev) · 2026-09-16 10:00 UTC · quote · https://x.com/fixture_dev/status/1234567890123456701",
    );
    expect(tweetFile).toContain("🌍");
    // Quoted material is labelled as context, not attributed to the author.
    expect(tweetFile).toContain("Quoted post by @somebody (Somebody):");
    expect(tweetFile).toContain("> The quoted claim that started this.");

    const videoFile = readFileSync(
      path.join(outcome.jobDir, "transcripts", "videoManual01.txt"),
      "utf8",
    );
    expect(videoFile).toContain("Transcript body for the mixed job.");
    expect(videoFile).toContain("Creator: Video Creator\nChannel: YouTube\n");
    expect(tweetFile).toContain("Creator: Fixture Dev\nChannel: X\n");

    expect(outcome.manifest.version).toBe(2);
    expect(byKey.get("video:videoManual01")?.file).toBe("transcripts/videoManual01.txt");
    expect(byKey.get("tweet:1234567890123456702")?.exclusionReason).toBe("missing_text");
    expect(byKey.get("tweet:999999999")?.exclusionReason).toBe("unknown_source");
    expect(outcome.manifest.truncation).toBeNull();
    // What was written, as the selection meter measures it: the video has
    // no known length, so it counts as an hour.
    expect(outcome.manifest.load).toEqual({
      videos: 1,
      posts: 1,
      videoSeconds: 3_600,
      tokens: 14_000 + 120,
    });
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
    expect(readdirSync(path.join(outcome.jobDir, "tweets"))).toEqual([]);
    db.close();
  });

  it("bundles an account's posts newest first and splits long timelines", () => {
    const db = createDb();
    const jobsRoot = mkdtempSync(path.join(tmpdir(), "scope-jobs-"));
    tempDirs.push(jobsRoot);
    const account = db
      .prepare<[], { id: number }>("SELECT id FROM creators WHERE platform = 'x'")
      .get()!;
    db.prepare("UPDATE creators SET handle = 'fixture_dev' WHERE id = ?").run(account.id);
    const insert = db.prepare(
      "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, published_at, content_status, media_json) VALUES (?, '1234567890123456789', 'fixture_dev', 'Fixture Dev', ?, ?, ?, 'complete', ?)",
    );
    const link = db.prepare(
      "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, 'post', ?)",
    );
    const ids: string[] = [];
    // Enough long posts to need more than one bundle file.
    for (let index = 0; index < 40; index += 1) {
      const id = `90000000000000000${String(index).padStart(2, "0")}`;
      const at = new Date(Date.UTC(2026, 9, 1, index)).toISOString();
      insert.run(
        id,
        `https://x.com/fixture_dev/status/${id}`,
        `Post number ${index}. ${"Long thread text. ".repeat(60)}`,
        at,
        index === 0 ? JSON.stringify([{ type: "photo" }]) : null,
      );
      link.run(account.id, id, at);
      ids.push(id);
    }

    const outcome = materializeSources(
      db,
      ids.map((id) => ({ kind: "tweet" as const, id })),
      { jobsRoot, jobId: "bundle-job" },
    );

    const files = readdirSync(path.join(outcome.jobDir, "tweets")).sort();
    expect(files.length).toBeGreaterThan(1);
    expect(files[0]).toBe("fixture_dev-2.txt");
    expect(files).toContain("fixture_dev.txt");
    for (const file of files) {
      const bytes = readFileSync(path.join(outcome.jobDir, "tweets", file));
      expect(bytes.byteLength).toBeLessThanOrEqual(POST_BUNDLE_MAX_BYTES);
    }
    // Newest first: the first bundle opens with the latest post.
    const first = readFileSync(path.join(outcome.jobDir, "tweets", "fixture_dev.txt"), "utf8");
    expect(first).toMatch(/^Type: X posts, newest first\n/);
    expect(first).toMatch(/Posts: \d+ \(file 1 of \d+\)/);
    expect(first.indexOf("Post number 39.")).toBeLessThan(first.indexOf("Post number 38."));
    // Media is named as text-only rather than described.
    const all = files
      .map((file) => readFileSync(path.join(outcome.jobDir, "tweets", file), "utf8"))
      .join("\n");
    expect(all).toContain("(1 media attachment: only the text was analyzed)");
    // Every post points at the bundle that holds it.
    for (const source of outcome.manifest.sources) {
      const bundle = readFileSync(path.join(outcome.jobDir, source.file!), "utf8");
      expect(bundle).toContain(`[tweets/${source.id}.txt]`);
    }
    expect(outcome.manifest.load?.posts).toBe(40);
    db.close();
  });
});
