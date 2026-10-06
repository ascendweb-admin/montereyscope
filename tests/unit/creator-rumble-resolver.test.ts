import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { resolveRumbleCreatorPreview } from "@/lib/creators/rumble-resolver";
import { fetchRumbleChannelIdentity } from "@/lib/rumble/identity";
import { validateRumbleCreatorPayload } from "@/lib/creators/service";
import type { ExecFileResult } from "@/lib/ytdlp/runner";

const VIDEO_FIXTURE = path.join(__dirname, "..", "fixtures", "rumble-video-discovery.fixture.json");

function success(stdout: string): ExecFileResult {
  return { ok: true, stdout, stderr: "" };
}

function identityOk() {
  return {
    ok: true as const,
    identity: {
      displayName: "Styxhexenhammer666",
      channelUrl: "https://rumble.com/c/Styxhexenhammer666",
      avatarUrl: "https://hugh.cdn.rumble.cloud/video/z8/t/j/s/b/tjsba.baa.1-Styxhexenhammer666-qyv16v.png",
      followerCount: 152218,
      verified: true,
    },
  };
}

describe("resolveRumbleCreatorPreview — channel links", () => {
  it("preserves the shared user URL and resolves its header avatar through validation", async () => {
    const html = readFileSync(path.join(__dirname, "..", "fixtures", "rumble-user-crypto.fixture.html"), "utf8");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(html));
    const result = await resolveRumbleCreatorPreview(
      "https://rumble.com/user/HowToCultivateCrypto?e9s=src_v1_sa%2Csrc_v5_sa_o",
      { fetchIdentity: (url, slug) => fetchRumbleChannelIdentity(url, slug, { fetchImpl }) },
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://rumble.com/user/HowToCultivateCrypto");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.creator.displayName).toBe("HowToCultivateCrypto");
    expect(result.creator.channelUrl).toBe("https://rumble.com/user/HowToCultivateCrypto");
    expect(result.creator.avatarUrl).toBe("https://hugh.cdn.rumble.cloud/video/z0/Y/W/F/-/YWF-q.asF.2-4pknci-tfmefx.jpeg");
    const validated = validateRumbleCreatorPayload(result.creator);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.input.avatarUrl).toBe(result.creator.avatarUrl);
  });

  it("resolves identity from one channel-page fetch", async () => {
    const fetchIdentity = vi.fn().mockResolvedValue(identityOk());
    const result = await resolveRumbleCreatorPreview("https://rumble.com/c/Styxhexenhammer666", {
      fetchIdentity,
    });

    expect(fetchIdentity).toHaveBeenCalledWith("https://rumble.com/c/Styxhexenhammer666", "Styxhexenhammer666");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.creator.platform).toBe("rumble");
    expect(result.creator.displayName).toBe("Styxhexenhammer666");
    expect(result.creator.channelUrl).toBe("https://rumble.com/c/Styxhexenhammer666");
    expect(result.creator.handle).toBe("styxhexenhammer666");
    expect(result.creator.avatarUrl).toContain("hugh.cdn.rumble.cloud");
    expect(result.creator.followerCount).toBe(152218);
    expect(result.creator.videoTitle).toBeNull();
  });

  it("maps throttled identity fetches to a typed error", async () => {
    const fetchIdentity = vi
      .fn()
      .mockResolvedValue({ ok: false, failure: { reason: "throttled" } });
    const result = await resolveRumbleCreatorPreview("https://rumble.com/c/Styxhexenhammer666", {
      fetchIdentity,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("throttled");
      expect(result.error.message).toMatch(/throttling/i);
    }
  });
});

describe("resolveRumbleCreatorPreview — video links", () => {
  it("resolves the video via yt-dlp, then the creator identity", async () => {
    const run = vi.fn().mockResolvedValue(success(readFileSync(VIDEO_FIXTURE, "utf8")));
    const fetchIdentity = vi
      .fn()
      .mockResolvedValue({
        ok: true as const,
        identity: {
          displayName: "Redacted News",
          channelUrl: "https://rumble.com/c/Redacted",
          avatarUrl: "https://hugh.cdn.rumble.cloud/avatar.png",
          followerCount: 50000,
          verified: false,
        },
      });
    const result = await resolveRumbleCreatorPreview(
      "https://rumble.com/v7emyxa-warning-this-new-flu-shot.html",
      { command: "yt-dlp-stub", run, fetchIdentity },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.creator.platform).toBe("rumble");
    expect(result.creator.videoTitle).toContain("WARNING: This New Flu Shot");
    expect(result.creator.videoId).toBe("v7emyxa");
    expect(result.creator.videoUrl).toContain("rumble.com/v7emyxa");
    expect(result.creator.channelUrl).toBe("https://rumble.com/c/Redacted");
    expect(result.creator.avatarUrl).toBe("https://hugh.cdn.rumble.cloud/avatar.png");

    // One yt-dlp call, metadata-only flags.
    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0][1];
    expect(args).toContain("--dump-single-json");
    expect(args).toContain("--skip-download");
  });

  it("does not fail the preview when the avatar lookup throttles", async () => {
    const run = vi.fn().mockResolvedValue(success(readFileSync(VIDEO_FIXTURE, "utf8")));
    const fetchIdentity = vi
      .fn()
      .mockResolvedValue({ ok: false as const, failure: { reason: "throttled" } });
    const result = await resolveRumbleCreatorPreview("https://rumble.com/v7emyxa-warning.html", {
      command: "yt-dlp-stub",
      run,
      fetchIdentity,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.creator.avatarUrl).toBeNull();
      expect(result.creator.displayName).toBe("Redacted News");
    }
  });

  it("propagates yt-dlp unavailability as a typed error", async () => {
    const run = vi
      .fn()
      .mockResolvedValue({ ok: false, kind: "nonzero_exit", stderrTail: "ERROR: Video unavailable" } as ExecFileResult);
    const fetchIdentity = vi.fn();
    const result = await resolveRumbleCreatorPreview("https://rumble.com/v7emyxa-warning.html", {
      command: "yt-dlp-stub",
      run,
      fetchIdentity,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unavailable_video");
    }
    expect(fetchIdentity).not.toHaveBeenCalled();
  });

  it("rejects non-rumble input without any fetch", async () => {
    const run = vi.fn();
    const fetchIdentity = vi.fn();
    const result = await resolveRumbleCreatorPreview("https://youtube.com/@mkbhd", {
      command: "yt-dlp-stub",
      run,
      fetchIdentity,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_url");
      expect(result.error.message).toMatch(/Rumble/i);
    }
    expect(run).not.toHaveBeenCalled();
    expect(fetchIdentity).not.toHaveBeenCalled();
  });
});
