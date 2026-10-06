/**
 * Integration tests for the channel feed invocation (lib/ytdlp/channel-feed.ts)
 * against the fake yt-dlp executable — real processes, no mocks, no network.
 *
 * Verifies that the bounded flat-playlist argument array reaches a real
 * process intact, that the per-tab fixtures parse into the scope model,
 * and that yt-dlp's "no such tab" stderr is recognized as an empty result.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { fetchChannelFeedTab, isEmptyTabStderr } from "@/lib/ytdlp/channel-feed";
import { mapLiveStatus, parseChannelFeedPayload } from "@/lib/videos/mapper";

const FAKE_YTDLP = path.join(__dirname, "fake-yt-dlp.cjs");

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fetchChannelFeedTab against a real process", () => {
  afterEach(() => {
    delete process.env.FAKE_YTDLP_LOG;
  });

  it("fetches the videos tab and parses ordinary uploads end to end", async () => {
    const result = await fetchChannelFeedTab(
      "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      "videos",
      30,
      { command: FAKE_YTDLP },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const parsed = parseChannelFeedPayload(result.stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.videos.length).toBeGreaterThanOrEqual(3);
    expect(parsed.skippedEntries).toBe(0);

    const first = parsed.videos.find((video) => video.id === "aBcD1234EfG");
    expect(first).toMatchObject({
      id: "aBcD1234EfG",
      title: "An ordinary upload with complete metadata",
      liveStatus: mapLiveStatus(null),
      durationSeconds: 676,
      thumbnailUrl: expect.stringContaining("https://i.ytimg.com/"),
    });
    expect(first?.publishedAt).not.toBeNull();
  });

  it("fetches the streams tab with every livestream state mapped", async () => {
    const result = await fetchChannelFeedTab(
      "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      "streams",
      30,
      { command: FAKE_YTDLP },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const parsed = parseChannelFeedPayload(result.stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const statuses = parsed.videos.map((video) => video.liveStatus).sort();
    // is_live, upcoming (is_upcoming), was_live, and post_live→was_live.
    expect(statuses).toEqual(["is_live", "upcoming", "was_live", "was_live"]);
  });

  it("honors --playlist-items inside a real process (bounded window)", async () => {
    const logPath = path.join(makeTempDir("localtube-argv-"), "argv.jsonl");
    process.env.FAKE_YTDLP_LOG = logPath;

    const result = await fetchChannelFeedTab(
      "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
      "videos",
      7,
      { command: FAKE_YTDLP },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const parsed = parseChannelFeedPayload(result.stdout);
    if (parsed.ok) {
      // The fake truncates entries exactly like the real extractor would.
      expect(parsed.videos.length).toBeLessThanOrEqual(7);
    }

    const logged = readFileSync(logPath, "utf8").trim().split("\n");
    const argv = JSON.parse(logged[logged.length - 1]) as string[];
    const itemsIndex = argv.indexOf("--playlist-items");
    expect(itemsIndex).toBeGreaterThanOrEqual(0);
    // The configured limit is clamped into the safe 5–300 window.
    expect(argv[itemsIndex + 1]).toBe("1:7");

    delete process.env.FAKE_YTDLP_LOG;
  });

  it("recognizes the missing-streams-tab stderr as an expected empty result", async () => {
    const result = await fetchChannelFeedTab(
      "https://www.youtube.com/watch?v=localtube-no-streams-tab",
      "streams",
      30,
      { command: FAKE_YTDLP },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isEmptyTabStderr(result.stderrTail, "streams")).toBe(true);
      expect(isEmptyTabStderr(result.stderrTail, "videos")).toBe(false);
    }
  });
});
