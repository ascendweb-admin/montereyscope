/*
 * Background transcript preparation: which videos get fetched, progress
 * reporting, the process-wide concurrency limit, failure disclosure, and
 * cancellation. The yt-dlp resolver is replaced through the test seam.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDb } from "@/lib/db/connection";
import {
  describePreparationFailures,
  ensureTranscripts,
  MAX_CONCURRENT_EXTRACTIONS,
  setTranscriptResolverForTests,
  videosMissingTranscripts,
  type PrepareProgress,
} from "@/lib/transcripts/prepare";
import { saveTranscript } from "@/lib/transcripts/repository";
import type { TranscriptOutcome } from "@/lib/transcripts/service";

let tempDir = "";

const okOutcome = (videoId: string): TranscriptOutcome => ({
  ok: true,
  transcript: {
    text: `Captions for ${videoId}.`,
    language: "en",
    captionSource: "automatic",
    fetchedAt: new Date().toISOString(),
    fromCache: false,
  },
});

function seedVideos(ids: string[], withTranscript: string[] = []): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO creators (id, display_name, channel_url) VALUES (1, 'C', 'https://x')",
  ).run();
  const insert = db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, 1, ?, ?)");
  for (const id of ids) {
    insert.run(id, `Video ${id}`, `https://www.youtube.com/watch?v=${id}`);
  }
  for (const id of withTranscript) {
    saveTranscript(
      db,
      { videoId: id, language: "en", source: "manual", plainText: "Cached." },
      "2026-01-01T00:00:00.000Z",
    );
  }
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "scope-prepare-"));
  process.env.LOCALTUBE_DB_PATH = path.join(tempDir, "prepare.db");
});

afterEach(() => {
  setTranscriptResolverForTests(null);
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("videosMissingTranscripts", () => {
  it("lists known videos without a cached transcript, in request order", () => {
    seedVideos(["vid0000001", "vid0000002", "vid0000003"], ["vid0000002"]);
    const missing = videosMissingTranscripts(getDb(), [
      "vid0000003",
      "unknown0001",
      "vid0000002",
      "vid0000001",
      "vid0000003",
    ]);
    expect(missing.map((row) => row.id)).toEqual(["vid0000003", "vid0000001"]);
  });
});

describe("ensureTranscripts", () => {
  it("does nothing when every video already has a transcript", async () => {
    seedVideos(["vid0000001"], ["vid0000001"]);
    const calls: string[] = [];
    setTranscriptResolverForTests(async (_db, videoId) => {
      calls.push(videoId);
      return okOutcome(videoId);
    });
    const progress: PrepareProgress[] = [];
    const outcome = await ensureTranscripts(getDb(), ["vid0000001"], {
      onProgress: (entry) => progress.push(entry),
    });
    expect(outcome).toEqual({ fetched: [], failed: [] });
    expect(calls).toEqual([]);
    expect(progress).toEqual([]);
  });

  it("fetches missing videos, reports progress, and returns failures", async () => {
    seedVideos(["vid0000001", "vid0000002", "vid0000003"]);
    setTranscriptResolverForTests(async (_db, videoId) =>
      videoId === "vid0000002"
        ? { ok: false, error: { code: "no_captions", message: "No English captions." } }
        : okOutcome(videoId),
    );
    const progress: PrepareProgress[] = [];
    const outcome = await ensureTranscripts(getDb(), ["vid0000001", "vid0000002", "vid0000003"], {
      onProgress: (entry) => progress.push(entry),
    });
    expect(outcome.fetched).toEqual(["vid0000001", "vid0000003"]);
    expect(outcome.failed).toEqual([
      { videoId: "vid0000002", code: "no_captions", message: "No English captions." },
    ]);
    expect(progress[0]).toEqual({ done: 0, total: 3 });
    expect(progress.at(-1)).toEqual({ done: 3, total: 3 });
  });

  it("turns a throwing resolver into a reported failure", async () => {
    seedVideos(["vid0000001"]);
    setTranscriptResolverForTests(async () => {
      throw new Error("boom");
    });
    const outcome = await ensureTranscripts(getDb(), ["vid0000001"]);
    expect(outcome.failed).toEqual([
      expect.objectContaining({ videoId: "vid0000001", code: "unexpected_response" }),
    ]);
  });

  it("never runs more than the limit of extractions at once", async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `vid000000${index}`);
    seedVideos(ids);
    let active = 0;
    let peak = 0;
    setTranscriptResolverForTests(async (_db, videoId) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return okOutcome(videoId);
    });
    const outcome = await ensureTranscripts(getDb(), ids);
    expect(outcome.fetched).toHaveLength(8);
    expect(peak).toBe(MAX_CONCURRENT_EXTRACTIONS);
  });

  it("rejects with an AbortError once the signal aborts", async () => {
    seedVideos(["vid0000001"]);
    setTranscriptResolverForTests(
      (_db, videoId) => new Promise((resolve) => setTimeout(() => resolve(okOutcome(videoId)), 50)),
    );
    const controller = new AbortController();
    const pending = ensureTranscripts(getDb(), ["vid0000001"], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("describePreparationFailures", () => {
  it("names each left-out video with a short reason", () => {
    expect(describePreparationFailures([], () => "unused")).toBe("");
    expect(
      describePreparationFailures(
        [
          { videoId: "a", code: "no_captions", message: "" },
          { videoId: "b", code: "timeout", message: "" },
        ],
        (id) => `Title ${id}`,
      ),
    ).toBe(
      "Left out 2 videos scope couldn't read captions for: “Title a” (no English captions), “Title b” (took too long).",
    );
  });
});
