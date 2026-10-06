import { describe, expect, it, vi } from "vitest";

import { buildResolutionArgs, pickAvatarUrl, resolveCreatorFromUrl } from "@/lib/creators/resolver";
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import channelFixture from "../fixtures/resolved-channel.fixture.json";

function success(stdout: string): ExecFileResult {
  return { ok: true, stdout, stderr: "" };
}

function failure(
  kind: string,
  stderrTail = "",
  extra: Record<string, unknown> = {},
): ExecFileResult {
  return { ok: false, kind, stderrTail, ...extra } as ExecFileResult;
}

const VALID_HANDLE_URL = "https://www.youtube.com/@youtube";
const TYPED_HANDLE_URL = "https://www.youtube.com/@YouTube";
const BASE_DEPS = { command: "yt-dlp-stub", timeoutMs: 5000, maxOutputBytes: 1024 * 1024 };

describe("buildResolutionArgs", () => {
  it("passes the URL as one element of an argument array with cheap flags", () => {
    const args = buildResolutionArgs(VALID_HANDLE_URL);
    expect(args.at(-1)).toBe(VALID_HANDLE_URL);
    expect(args).toContain("--dump-single-json");
    expect(args).toContain("--flat-playlist");
    // Flat + first-entry-only keeps the call cheap; no download flags exist.
    expect(args).not.toContain("--download");
    expect(args.filter((arg) => arg === "--playlist-items").length).toBe(1);
  });
});
describe("pickAvatarUrl", () => {
  it("prefers square avatar thumbnails over wide banner crops", () => {
    const url = pickAvatarUrl(channelFixture.thumbnails);
    expect(url).toBe("https://yt3.googleusercontent.com/example-avatar-3333333333333333");
  });

  it("returns null for missing or unsafe thumbnail data", () => {
    expect(pickAvatarUrl(undefined)).toBeNull();
    expect(pickAvatarUrl([])).toBeNull();
    expect(pickAvatarUrl([{ url: "http://insecure.example/x.png" }])).toBeNull();
  });
});

describe("resolveCreatorFromUrl", () => {
  it("extracts canonical identity from a yt-dlp channel payload (fixture)", async () => {
    const run = vi.fn().mockResolvedValue(success(JSON.stringify(channelFixture)));
    const result = await resolveCreatorFromUrl(TYPED_HANDLE_URL, { ...BASE_DEPS, run });

    expect(run).toHaveBeenCalledTimes(1);
    const [command, args] = run.mock.calls[0];
    expect(command).toBe("yt-dlp-stub");
    // Handle URLs are normalized to lowercase before invocation.
    expect(args.at(-1)).toBe(VALID_HANDLE_URL);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.creator.youtubeChannelId).toBe("UCBR8-60-B28hp2BmDPdntcQ");
      expect(result.creator.handle).toBe("youtube");
      expect(result.creator.displayName).toBe("YouTube");
      expect(result.creator.channelUrl).toBe(
        "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      );
      expect(result.creator.avatarUrl?.startsWith("https://yt3.googleusercontent.com/")).toBe(true);
    }
  });

  it("resolves /channel/<ID> URLs without invoking yt-dlp on invalid input", async () => {
    const run = vi.fn().mockResolvedValue(success("{}"));
    const bad = await resolveCreatorFromUrl("https://www.youtube.com/watch?v=abc", {
      ...BASE_DEPS,
      run,
    });

    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe("invalid_url");
      expect(bad.error.message).toMatch(/video link/i);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("falls back to the input handle when yt-dlp omits uploader_id", async () => {
    const payload = { ...channelFixture };
    delete (payload as { uploader_id?: string }).uploader_id;
    const run = vi.fn().mockResolvedValue(success(JSON.stringify(payload)));
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.creator.handle).toBe("youtube");
    }
  });

  it.each([
    ["missing_executable", "ytdlp_missing"],
    ["timeout", "timeout"],
  ] as const)("maps runner failure %s to %s", async (runnerKind, expectedCode) => {
    const run = vi.fn().mockResolvedValue(failure(runnerKind));
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(expectedCode);
    }
  });

  it("maps unavailable channels by inspecting captured stderr", async () => {
    const run = vi.fn().mockResolvedValue(
      failure("nonzero_exit", "ERROR: [youtube] @gone: This channel does not exist.", {
        exitCode: 1,
      }),
    );
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unavailable_channel");
    }
  });

  it("maps network problems reported by yt-dlp", async () => {
    const run = vi
      .fn()
      .mockResolvedValue(failure("nonzero_exit", "URLError: getaddrinfo failed", { exitCode: 1 }));
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("network");
    }
  });

  it("reports unexpected_response when stdout is not valid JSON", async () => {
    const run = vi.fn().mockResolvedValue(success("this is not json"));
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unexpected_response");
    }
  });

  it("reports unexpected_response when no display name is present", async () => {
    const run = vi.fn().mockResolvedValue(success('{"channel_id":"UCBR8-60-B28hp2BmDPdntcQ"}'));
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unexpected_response");
    }
  });

  it("never exposes raw stderr in any error message", async () => {
    const secretish = "cmd --passwd /home/paffol/secret-path stderr details";
    const run = vi.fn().mockResolvedValue(failure("nonzero_exit", secretish, { exitCode: 2 }));
    const result = await resolveCreatorFromUrl(VALID_HANDLE_URL, { ...BASE_DEPS, run });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toContain(secretish);
      expect(result.error.message).not.toContain("/home/paffol");
    }
  });
});

describe("committed fixture sanity", () => {
  it("contains only public channel-level metadata (no entries array)", () => {
    const raw = JSON.stringify(channelFixture);
    expect(raw).toContain("UCBR8-60-B28hp2BmDPdntcQ");
    expect(channelFixture).not.toHaveProperty("entries");
  });
});
