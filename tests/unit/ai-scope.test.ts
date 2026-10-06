import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveScope } from "@/lib/ai/scope";
import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

describe("ai scope resolution", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "localtube-ai-scope-"));
    db = new Database(path.join(dir, "test.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, INITIAL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedCreator(id: number, displayName: string): void {
    db.prepare(
      "INSERT INTO creators (id, display_name, channel_url) VALUES (?, ?, 'https://example.invalid/c')",
    ).run(id, displayName);
  }

  function seedVideo(
    id: string,
    creatorId: number,
    overrides: Partial<{
      title: string;
      publishedAt: string | null;
      durationSeconds: number | null;
    }> = {},
  ): void {
    db.prepare(
      `INSERT INTO videos (id, creator_id, title, url, published_at, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      creatorId,
      overrides.title ?? `Video ${id}`,
      `https://www.youtube.com/watch?v=${id}`,
      overrides.publishedAt === undefined ? "2026-01-15T10:00:00.000Z" : overrides.publishedAt,
      overrides.durationSeconds === undefined ? 300 : overrides.durationSeconds,
    );
  }

  function seedTranscript(videoId: string, language = "en", source = "manual"): void {
    db.prepare(
      "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
    ).run(videoId, language, source, `Transcript text for ${videoId}.`);
  }

  it("returns per-video metadata with the creator display name", () => {
    seedCreator(1, "Sample Creator");
    seedVideo("videoKnown1", 1, { title: "Me at the zoo", durationSeconds: 19 });
    seedTranscript("videoKnown1");

    expect(resolveScope(db, ["videoKnown1"])).toEqual({
      videos: [
        {
          id: "videoKnown1",
          title: "Me at the zoo",
          creator: "Sample Creator",
          publishedAt: "2026-01-15T10:00:00.000Z",
          hasTranscript: true,
          durationSeconds: 19,
        },
      ],
      unknownVideoIds: [],
      missingTranscriptVideoIds: [],
    });
  });

  it("flags requested ids that are not in the videos table as unknown", () => {
    seedCreator(1, "Sample Creator");
    seedVideo("videoKnown1", 1);
    seedTranscript("videoKnown1");

    const resolution = resolveScope(db, ["videoKnown1", "videoGone0001"]);
    expect(resolution.videos.map((video) => video.id)).toEqual(["videoKnown1"]);
    expect(resolution.unknownVideoIds).toEqual(["videoGone0001"]);
    expect(resolution.missingTranscriptVideoIds).toEqual([]);
  });

  it("flags known videos without a cached transcript", () => {
    seedCreator(1, "Sample Creator");
    seedVideo("videoKnown1", 1);
    seedVideo("videoNoText01", 1);
    seedTranscript("videoKnown1");

    const resolution = resolveScope(db, ["videoKnown1", "videoNoText01"]);
    expect(resolution.videos).toEqual([
      expect.objectContaining({ id: "videoKnown1", hasTranscript: true }),
      expect.objectContaining({ id: "videoNoText01", hasTranscript: false }),
    ]);
    expect(resolution.missingTranscriptVideoIds).toEqual(["videoNoText01"]);
  });

  it("returns empty lists for an empty request", () => {
    expect(resolveScope(db, [])).toEqual({
      videos: [],
      unknownVideoIds: [],
      missingTranscriptVideoIds: [],
    });
  });

  it("collapses repeated ids while preserving request order", () => {
    seedCreator(1, "Sample Creator");
    seedVideo("videoBeta111", 1);
    seedVideo("videoAlpha111", 1);
    seedTranscript("videoAlpha111");

    const resolution = resolveScope(db, ["videoBeta111", "videoAlpha111", "videoBeta111"]);
    expect(resolution.videos.map((video) => video.id)).toEqual(["videoBeta111", "videoAlpha111"]);
    expect(resolution.unknownVideoIds).toEqual([]);
  });

  it("keeps null published dates and durations", () => {
    seedCreator(1, "Sample Creator");
    seedVideo("videoUndated1", 1, { publishedAt: null, durationSeconds: null });
    seedTranscript("videoUndated1");

    const resolution = resolveScope(db, ["videoUndated1"]);
    expect(resolution.videos[0]).toMatchObject({ publishedAt: null, durationSeconds: null });
  });

  it("joins each video with its own creator", () => {
    seedCreator(1, "First Creator");
    seedCreator(2, "Second Creator");
    seedVideo("videoFromOne1", 1);
    seedVideo("videoFromTwo2", 2);
    seedTranscript("videoFromOne1");
    seedTranscript("videoFromTwo2");

    const resolution = resolveScope(db, ["videoFromOne1", "videoFromTwo2"]);
    expect(resolution.videos.map((video) => video.creator)).toEqual([
      "First Creator",
      "Second Creator",
    ]);
  });

  it("resolves requests larger than one query chunk", () => {
    seedCreator(1, "Sample Creator");
    const insert = db.prepare(
      "INSERT INTO videos (id, creator_id, title, url) VALUES (?, 1, ?, ?)",
    );
    const ids = Array.from({ length: 600 }, (_, i) => `videoBatch${String(i).padStart(4, "0")}`);
    db.transaction(() => {
      for (const id of ids) {
        insert.run(id, `Video ${id}`, `https://www.youtube.com/watch?v=${id}`);
      }
    })();

    const resolution = resolveScope(db, ids);
    expect(resolution.videos).toHaveLength(600);
    expect(resolution.unknownVideoIds).toEqual([]);
    expect(resolution.missingTranscriptVideoIds).toHaveLength(600);
  });
});
