import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { getTranscript, saveTranscript, type TranscriptSource } from "@/lib/transcripts/repository";

const VIDEO_ID = "abc12345678";

describe("transcript repository", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "localtube-transcript-repo-"));
    db = new Database(path.join(dir, "test.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, INITIAL_MIGRATIONS);
    db.prepare(
      "INSERT INTO creators (id, display_name, channel_url) VALUES (1, 'T', 'https://example.invalid/c')",
    ).run();
    db.prepare(
      `INSERT INTO videos (id, creator_id, title, url) VALUES (?, 1, 'T', 'https://example.invalid/v')`,
    ).run(VIDEO_ID);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a transcript record", () => {
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "pt-BR", source: "automatic", plainText: "Olá — mundo." },
      "2026-08-24T12:00:00.000Z",
    );

    const record = getTranscript(db, VIDEO_ID);
    expect(record).toEqual({
      videoId: VIDEO_ID,
      language: "pt-BR",
      source: "automatic",
      plainText: "Olá — mundo.",
      fetchedAt: "2026-08-24T12:00:00.000Z",
    });
  });

  it("replaces the row for the same video (one transcript per video)", () => {
    const sources: TranscriptSource[] = ["manual", "automatic"];
    saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "en", source: sources[0], plainText: "First" },
      "2026-08-24T10:00:00.000Z",
    );
    const replaced = saveTranscript(
      db,
      { videoId: VIDEO_ID, language: "de", source: sources[1], plainText: "Second" },
      "2026-08-24T11:00:00.000Z",
    );
    expect(replaced.fetchedAt).toBe("2026-08-24T11:00:00.000Z");

    expect(getTranscript(db, VIDEO_ID)?.language).toBe("de");
    expect(getTranscript(db, VIDEO_ID)?.source).toBe("automatic");
    expect(getTranscript(db, VIDEO_ID)?.plainText).toBe("Second");
  });

  it("returns null for videos without a cached transcript", () => {
    expect(getTranscript(db, "missing00001")).toBeNull();
  });

  it("rejects sources outside the database CHECK constraint", () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO transcripts (video_id, language, source, plain_text)
           VALUES (?, 'en', 'whisper', 'nope')`,
        )
        .run(VIDEO_ID),
    ).toThrow(/CHECK|constraint/i);
  });
});
