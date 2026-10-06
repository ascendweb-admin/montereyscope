import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTranscriptMaterializer,
  DEFAULT_MAX_MATERIALIZED_BYTES,
  materializeTranscripts,
  maxMaterializedBytes,
  TRUNCATION_MARKER,
} from "@/lib/ai/materialize";
import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";

const JOB_ID = "job-0001";
const NOW = new Date("2026-08-27T12:00:00.000Z");

describe("ai transcript materialization", () => {
  let db: Database.Database;
  let dir: string;
  let jobsRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "localtube-ai-materialize-"));
    jobsRoot = path.join(dir, "ai-jobs");
    db = new Database(path.join(dir, "test.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, INITIAL_MIGRATIONS);
    db.prepare(
      "INSERT INTO creators (id, display_name, channel_url) VALUES (1, 'Sample Creator', 'https://example.invalid/c')",
    ).run();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedVideo(id: string, overrides: Partial<{ publishedAt: string | null }> = {}): void {
    db.prepare(
      "INSERT INTO videos (id, creator_id, title, url, published_at) VALUES (?, 1, ?, ?, ?)",
    ).run(
      id,
      `Video ${id}`,
      `https://www.youtube.com/watch?v=${id}`,
      overrides.publishedAt === undefined ? "2026-02-03T09:30:00.000Z" : overrides.publishedAt,
    );
  }

  function seedTranscript(videoId: string, plainText: string, source = "manual"): void {
    db.prepare(
      "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, 'en', ?, ?)",
    ).run(videoId, source, plainText);
  }

  function materialize(videoIds: string[]) {
    return materializeTranscripts(db, videoIds, { jobsRoot, jobId: JOB_ID, now: () => NOW });
  }

  it("writes one file per video with a metadata header followed by the transcript", () => {
    seedVideo("videoManual01");
    seedVideo("videoAuto0001");
    seedTranscript("videoManual01", "All right, so here we are, in front of the elephants.");
    seedTranscript("videoAuto0001", "Automatic caption text.", "automatic");

    const { jobDir } = materialize(["videoManual01", "videoAuto0001"]);

    expect(readFileSync(path.join(jobDir, "transcripts", "videoManual01.txt"), "utf8")).toBe(
      [
        "Title: Video videoManual01",
        "Creator: Sample Creator",
        "URL: https://www.youtube.com/watch?v=videoManual01",
        "Published: 2026-02-03T09:30:00.000Z",
        "Language: en",
        "Caption source: manual",
        "",
        "All right, so here we are, in front of the elephants.",
        "",
      ].join("\n"),
    );
    const automatic = readFileSync(path.join(jobDir, "transcripts", "videoAuto0001.txt"), "utf8");
    expect(automatic).toContain("Caption source: automatic");
    expect(automatic.endsWith("Automatic caption text.\n")).toBe(true);
  });

  it("writes a manifest at the job root listing the scope and the files", () => {
    seedVideo("videoManual01");
    seedTranscript("videoManual01", "Some transcript text.");

    const { jobDir, manifest } = materialize(["videoManual01"]);

    expect(jobDir).toBe(path.join(jobsRoot, JOB_ID));
    const parsed = JSON.parse(readFileSync(path.join(jobDir, "manifest.json"), "utf8"));
    expect(parsed).toEqual(manifest);
    expect(manifest.jobId).toBe(JOB_ID);
    expect(manifest.createdAt).toBe("2026-08-27T12:00:00.000Z");
    expect(manifest.scope).toEqual({
      videos: [
        {
          id: "videoManual01",
          title: "Video videoManual01",
          creator: "Sample Creator",
          publishedAt: "2026-02-03T09:30:00.000Z",
          hasTranscript: true,
          durationSeconds: null,
        },
      ],
      unknownVideoIds: [],
      missingTranscriptVideoIds: [],
    });
    expect(manifest.transcripts).toEqual([
      {
        videoId: "videoManual01",
        file: "transcripts/videoManual01.txt",
        language: "en",
        source: "manual",
        truncated: false,
      },
    ]);
    expect(existsSync(path.join(jobDir, manifest.transcripts[0].file))).toBe(true);
  });

  it("excludes videos without transcripts and records the exclusion", () => {
    seedVideo("videoManual01");
    seedVideo("videoNoText01");
    seedTranscript("videoManual01", "Some transcript text.");

    const { jobDir, manifest } = materialize(["videoManual01", "videoNoText01"]);

    expect(manifest.transcripts.map((entry) => entry.videoId)).toEqual(["videoManual01"]);
    expect(existsSync(path.join(jobDir, "transcripts", "videoNoText01.txt"))).toBe(false);
    expect(manifest.scope.missingTranscriptVideoIds).toEqual(["videoNoText01"]);
    expect(manifest.excluded).toEqual([{ videoId: "videoNoText01", reason: "missing_transcript" }]);
  });

  it("records unknown ids as exclusions without creating files for them", () => {
    seedVideo("videoManual01");
    seedTranscript("videoManual01", "Some transcript text.");

    const { manifest } = materialize(["videoManual01", "videoGone0001"]);

    expect(manifest.scope.unknownVideoIds).toEqual(["videoGone0001"]);
    expect(manifest.excluded).toEqual([{ videoId: "videoGone0001", reason: "unknown_video" }]);
    expect(manifest.transcripts).toHaveLength(1);
  });

  it("creates the job even when nothing can be materialized", () => {
    const { jobDir, manifest } = materialize(["videoGone0001"]);

    expect(existsSync(jobDir)).toBe(true);
    expect(manifest.transcripts).toEqual([]);
    expect(manifest.scope.videos).toEqual([]);
    expect(manifest.excluded).toEqual([{ videoId: "videoGone0001", reason: "unknown_video" }]);
    expect(readdirSync(path.join(jobDir, "transcripts"))).toEqual([]);
  });

  it("renders unknown for videos without a publish date", () => {
    seedVideo("videoUndated1", { publishedAt: null });
    seedTranscript("videoUndated1", "Some transcript text.");

    const { jobDir } = materialize(["videoUndated1"]);

    expect(readFileSync(path.join(jobDir, "transcripts", "videoUndated1.txt"), "utf8")).toContain(
      "Published: unknown",
    );
  });

  it("generates a unique default job id and timestamp when not injected", () => {
    seedVideo("videoManual01");
    seedTranscript("videoManual01", "Some transcript text.");

    const first = materializeTranscripts(db, ["videoManual01"], { jobsRoot });
    const second = materializeTranscripts(db, ["videoManual01"], { jobsRoot });

    expect(first.jobDir).not.toBe(second.jobDir);
    expect(first.manifest.jobId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{12}$/);
    expect(new Date(first.manifest.createdAt).toISOString()).toBe(first.manifest.createdAt);
    expect(existsSync(first.jobDir)).toBe(true);
    expect(existsSync(second.jobDir)).toBe(true);
  });

  it("exposes the same behavior through the interface factory", () => {
    seedVideo("videoManual01");
    seedTranscript("videoManual01", "Some transcript text.");

    const materializer = createTranscriptMaterializer(db, {
      jobsRoot,
      jobId: JOB_ID,
      now: () => NOW,
    });

    expect(materializer.materializeTranscripts(["videoManual01"]).manifest).toEqual(
      materialize(["videoManual01"]).manifest,
    );
  });

  describe("materialized-bytes budget (stage 7)", () => {
    function seedTwoLargeTranscripts(): void {
      seedVideo("videoBig00001");
      seedVideo("videoBig00002");
      seedTranscript("videoBig00001", "A".repeat(950));
      seedTranscript("videoBig00002", "B".repeat(950));
    }

    it("leaves no truncation record when everything fits", () => {
      seedVideo("videoManual01");
      seedTranscript("videoManual01", "Small text.");

      const { manifest } = materializeTranscripts(db, ["videoManual01"], {
        jobsRoot,
        jobId: JOB_ID,
        now: () => NOW,
        maxTotalBytes: 10_000,
      });

      expect(manifest.truncation).toBeNull();
      expect(manifest.transcripts[0]?.truncated).toBe(false);
    });

    it("cuts the file that crosses the budget and marks it in the manifest", () => {
      seedTwoLargeTranscripts();

      const { jobDir, manifest } = materializeTranscripts(db, ["videoBig00001", "videoBig00002"], {
        jobsRoot,
        jobId: JOB_ID,
        now: () => NOW,
        maxTotalBytes: 500,
      });

      // The first file fits under the budget only in truncated form.
      expect(manifest.transcripts).toHaveLength(1);
      expect(manifest.transcripts[0]).toMatchObject({
        videoId: "videoBig00001",
        truncated: true,
      });
      const body = readFileSync(path.join(jobDir, "transcripts", "videoBig00001.txt"), "utf8");
      expect(body.length).toBeLessThanOrEqual(500);
      expect(body).toContain(TRUNCATION_MARKER);
      expect(body.startsWith("Title: Video videoBig00001")).toBe(true);

      expect(manifest.truncation).toEqual({
        limitBytes: 500,
        writtenBytes: expect.any(Number),
        truncatedVideoIds: ["videoBig00001"],
        skippedVideoIds: ["videoBig00002"],
      });
      expect(manifest.truncation?.writtenBytes).toBeLessThanOrEqual(500);
    });

    it("skips later files entirely once the budget is exhausted", () => {
      seedTwoLargeTranscripts();

      const { jobDir, manifest } = materializeTranscripts(db, ["videoBig00001", "videoBig00002"], {
        jobsRoot,
        jobId: JOB_ID,
        now: () => NOW,
        maxTotalBytes: 1000,
      });

      // The first transcript's truncated file consumes the whole budget; the
      // second is never written.
      expect(manifest.transcripts.map((entry) => entry.videoId)).toEqual(["videoBig00001"]);
      expect(manifest.transcripts[0]?.truncated).toBe(true);
      expect(existsSync(path.join(jobDir, "transcripts", "videoBig00002.txt"))).toBe(false);
      expect(manifest.excluded).toEqual([
        { videoId: "videoBig00002", reason: "byte_budget_exhausted" },
      ]);
      expect(manifest.truncation?.truncatedVideoIds).toEqual(["videoBig00001"]);
      expect(manifest.truncation?.skippedVideoIds).toEqual(["videoBig00002"]);
    });

    it("keeps the metadata header intact on a truncated file", () => {
      seedVideo("videoManual01");
      seedTranscript("videoManual01", "Z".repeat(2000));

      const { jobDir, manifest } = materializeTranscripts(db, ["videoManual01"], {
        jobsRoot,
        jobId: JOB_ID,
        now: () => NOW,
        maxTotalBytes: 300,
      });

      const body = readFileSync(path.join(jobDir, "transcripts", "videoManual01.txt"), "utf8");
      for (const headerLine of ["Title: Video videoManual01", "Caption source: manual"]) {
        expect(body).toContain(headerLine);
      }
      expect(manifest.transcripts[0]?.truncated).toBe(true);
    });

    it("honors a positive SCOPE_AI_MAX_MATERIALIZED_BYTES override and rejects bad values", () => {
      seedVideo("videoManual01");
      seedTranscript("videoManual01", "X".repeat(2000));

      vi.stubEnv("SCOPE_AI_MAX_MATERIALIZED_BYTES", "250");
      expect(maxMaterializedBytes()).toBe(250);
      const { manifest } = materializeTranscripts(db, ["videoManual01"], {
        jobsRoot,
        jobId: JOB_ID,
        now: () => NOW,
      });
      expect(manifest.transcripts[0]?.truncated).toBe(true);
      vi.unstubAllEnvs();

      vi.stubEnv("SCOPE_AI_MAX_MATERIALIZED_BYTES", "-5");
      expect(maxMaterializedBytes()).toBe(DEFAULT_MAX_MATERIALIZED_BYTES);
      vi.unstubAllEnvs();
    });
  });
});
