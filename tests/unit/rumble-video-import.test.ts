import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildRumbleVideoDiscoveryArgs,
  parseRumbleVideoPayload,
  pickRumbleThumbnail,
  runRumbleDiscovery,
} from "@/lib/rumble/video-import";
import type { ExecFileResult } from "@/lib/ytdlp/runner";

// The old single-video import is gone: a Rumble video link now goes through
// the video import engine (see video-import.test.ts and creator-follow.test.ts).
// What stays here is the Rumble-specific metadata job and its parsers, which
// the engine's resolver builds on.

const FIXTURE = path.join(__dirname, "..", "fixtures", "rumble-video-discovery.fixture.json");

function success(stdout: string): ExecFileResult {
  return { ok: true, stdout, stderr: "" };
}

function failure(kind: string, stderrTail = ""): Extract<ExecFileResult, { ok: false }> {
  return { ok: false, kind, stderrTail } as Extract<ExecFileResult, { ok: false }>;
}

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
    expect(
      pickRumbleThumbnail([{ url: "https://evil.example/x.jpg", width: 999, height: 999 }]),
    ).toBeNull();
  });
});

describe("runRumbleDiscovery", () => {
  const URL_A = "https://rumble.com/v7emyxa";

  it("runs the metadata job once when it succeeds", async () => {
    const run = vi.fn().mockResolvedValue(success("{}"));
    const result = await runRumbleDiscovery({ command: "yt-dlp-stub", run }, URL_A);
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe("yt-dlp-stub");
    expect(run.mock.calls[0][1]).toEqual(buildRumbleVideoDiscoveryArgs(URL_A));
  });

  it("retries once after Rumble's edge throttles the first run", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(failure("nonzero_exit", "ERROR: HTTP Error 403: Forbidden"))
      .mockResolvedValueOnce(success("{}"));
    const result = await runRumbleDiscovery(
      { command: "yt-dlp-stub", run, throttleRetryMs: 0 },
      URL_A,
    );
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after that one retry", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(failure("nonzero_exit", "ERROR: HTTP Error 429: Too Many Requests"));
    const result = await runRumbleDiscovery(
      { command: "yt-dlp-stub", run, throttleRetryMs: 0 },
      URL_A,
    );
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not retry a failure that is not throttling", async () => {
    const run = vi.fn().mockResolvedValue(failure("nonzero_exit", "ERROR: Video unavailable"));
    const result = await runRumbleDiscovery(
      { command: "yt-dlp-stub", run, throttleRetryMs: 0 },
      URL_A,
    );
    expect(result.ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
