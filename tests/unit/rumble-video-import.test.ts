import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  buildRumbleVideoDiscoveryArgs,
  classifyDiscoveryFailure,
  importRumbleVideo,
  parseRumbleVideoPayload,
  pickRumbleThumbnail,
} from "@/lib/rumble/video-import";
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { getCreator } from "@/lib/creators/repository";
import { getVideoForCreator } from "@/lib/videos/repository";

const FIXTURE = path.join(__dirname, "..", "fixtures", "rumble-video-discovery.fixture.json");

function success(stdout: string): ExecFileResult {
  return { ok: true, stdout, stderr: "" };
}

function failure(kind: string, stderrTail = ""): Extract<ExecFileResult, { ok: false }> {
  return { ok: false, kind, stderrTail } as Extract<ExecFileResult, { ok: false }>;
}

const tempDirs: string[] = [];
let db: ScopeDatabase;

beforeAll(() => {});
afterAll(() => {
  if (db?.open) db.close();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  if (db) {
    db.close();
  }
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-rumble-import-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

describe("buildRumbleVideoDiscoveryArgs", () => {
  it("uses cheap metadata-only flags", () => {
    const args = buildRumbleVideoDiscoveryArgs("https://rumble.com/v7emyxa");
    expect(args.at(-1)).toBe("https://rumble.com/v7emyxa");
    expect(args).toContain("--dump-single-json");
    expect(args).toContain("--skip-download");
    expect(args).not.toContain("--write-subs");
  });
});

describe("parseRumbleVideoPayload", () => {
  it("maps the real yt-dlp discovery payload into the import model", () => {
    const payload = readFileSync(FIXTURE, "utf8");
    const outcome = parseRumbleVideoPayload(payload, "v7emyxa");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const { video } = outcome;
    // The slug comes from webpage_url, not from yt-dlp's embed id.
    expect(video.id).toBe("v7emyxa");
    expect(video.title).toContain("WARNING: This New Flu Shot");
    expect(video.channelName).toBe("Redacted News");
    expect(video.channelUrl).toBe("https://rumble.com/c/Redacted");
    expect(video.draft.thumbnailUrl).toContain("hugh.cdn.rumble.cloud");
    expect(video.draft.publishedAt).not.toBeNull();
    expect(video.draft.liveStatus).toBe("not_live");
    expect(video.draft.durationSeconds).toBeGreaterThan(0);
  });

  it("rejects garbage payloads", () => {
    expect(parseRumbleVideoPayload("not json", "v7emyxa").ok).toBe(false);
    expect(parseRumbleVideoPayload("{}", "v7emyxa").ok).toBe(false);
  });
});

describe("pickRumbleThumbnail", () => {
  it("picks the largest thumbnail on a Rumble CDN", () => {
    const url = pickRumbleThumbnail([
      { url: "https://hugh.cdn.rumble.cloud/small.jpg", width: 320, height: 180 },
      { url: "https://hugh.cdn.rumble.cloud/big.jpg", width: 1280, height: 720 },
    ]);
    expect(url).toBe("https://hugh.cdn.rumble.cloud/big.jpg");
  });

  it("rejects foreign hosts", () => {
    expect(pickRumbleThumbnail([{ url: "https://evil.example/x.jpg", width: 999, height: 999 }])).toBeNull();
  });
});

describe("classifyDiscoveryFailure", () => {
  it("maps typed runner failures", () => {
    expect(classifyDiscoveryFailure(failure("missing_executable")).code).toBe("ytdlp_missing");
    expect(classifyDiscoveryFailure(failure("timeout")).code).toBe("timeout");
    expect(
      classifyDiscoveryFailure(failure("nonzero_exit", "ERROR: Video unavailable")).code,
    ).toBe("unavailable_video");
    expect(
      classifyDiscoveryFailure(failure("nonzero_exit", "Temporary failure in name resolution"))
        .code,
    ).toBe("network");
    expect(classifyDiscoveryFailure(failure("nonzero_exit", "")).code).toBe("unexpected_response");
  });
});

describe("importRumbleVideo", () => {
  function setupDeps(overrides: Record<string, unknown> = {}) {
    const payload = readFileSync(FIXTURE, "utf8");
    const run = vi.fn().mockResolvedValue(success(payload));
    const fetchChannelIdentity = vi.fn().mockResolvedValue({
      ok: true,
      identity: {
        displayName: "Redacted News",
        channelUrl: "https://rumble.com/c/Redacted",
        avatarUrl: "https://hugh.cdn.rumble.cloud/video/z8/t/j/s/b/tjsba.baa.1-Styxhexenhammer666-qyv16v.png",
        followerCount: 152218,
        verified: true,
      },
    });
    const deps = {
      command: "yt-dlp-stub",
      run,
      now: () => new Date("2026-09-06T10:00:00Z"),
      fetchChannelIdentity,
      ...overrides,
    };
    return { deps, run, fetchChannelIdentity };
  }

  it("imports a video and auto-provisions its creator", async () => {
    const { deps, run, fetchChannelIdentity } = setupDeps();
    const outcome = await importRumbleVideo(db, "https://rumble.com/v7emyxa-warning.html", deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.status).toBe("created");
    expect(outcome.videoId).toBe("v7emyxa");
    expect(outcome.videoTitle).toContain("WARNING: This New Flu Shot");

    // The creator carries the identity from the video + the avatar fetch.
    const creator = getCreator(db, outcome.creatorId);
    expect(creator?.displayName).toBe("Redacted News");
    expect(creator?.platform).toBe("rumble");
    expect(creator?.channelUrl).toBe("https://rumble.com/c/Redacted");
    expect(creator?.handle).toBe("redacted");
    expect(creator?.avatarUrl).toContain("hugh.cdn.rumble.cloud");
    expect(creator?.youtubeChannelId).toBeNull();

    // The video landed in the cache with real metadata.
    const video = getVideoForCreator(db, outcome.creatorId, "v7emyxa");
    expect(video?.title).toContain("WARNING: This New Flu Shot");
    expect(video?.liveStatus).toBe("not_live");

    // Exactly one yt-dlp invocation with discovery-only flags.
    expect(run).toHaveBeenCalledTimes(1);
    expect(fetchChannelIdentity).toHaveBeenCalledTimes(1);
  });

  it("attaches the video to an already-saved Rumble creator", async () => {
    const { deps } = setupDeps();
    const first = await importRumbleVideo(db, "https://rumble.com/v7emyxa-warning.html", deps);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const creators = db.prepare("SELECT COUNT(*) AS n FROM creators").get() as { n: number };
    expect(creators.n).toBe(1);

    // The same link again is a friendly no-op on the same creator row.
    const second = await importRumbleVideo(db, "https://rumble.com/v7emyxa-warning.html", deps);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.status).toBe("already_saved");
      expect(second.creatorId).toBe(first.creatorId);
    }
  });

  it("still imports when the avatar lookup is throttled", async () => {
    const { deps } = setupDeps({
      fetchChannelIdentity: vi
        .fn()
        .mockResolvedValue({ ok: false, failure: { reason: "throttled" } }),
    });
    const outcome = await importRumbleVideo(db, "https://rumble.com/v7emyxa-warning.html", deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const creator = getCreator(db, outcome.creatorId);
      expect(creator?.avatarUrl).toBeNull();
      expect(creator?.displayName).toBe("Redacted News");
    }
  });

  it("rejects non-video rumble links and non-rumble URLs", async () => {
    const { deps } = setupDeps();
    const channelLink = await importRumbleVideo(db, "https://rumble.com/c/Redacted", deps);
    expect(channelLink.ok).toBe(false);

    const external = await importRumbleVideo(db, "https://youtube.com/@x", deps);
    expect(external.ok).toBe(false);
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("surfaces yt-dlp failures as typed errors", async () => {
    const { deps } = setupDeps({
      run: vi.fn().mockResolvedValue(failure("nonzero_exit", "ERROR: Video unavailable")),
    });
    const outcome = await importRumbleVideo(db, "https://rumble.com/v7emyxa-warning.html", deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("unavailable_video");
    }
  });
});
