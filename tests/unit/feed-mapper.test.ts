import { describe, expect, it } from "vitest";

import {
  mapDurationSeconds,
  mapFeedEntry,
  mapLiveStatus,
  mapPublishedAt,
  mergeFeedResults,
  parseChannelFeedPayload,
  pickThumbnailUrl,
  videoIdFromWatchUrl,
} from "@/lib/videos/mapper";
import videosTabFixture from "../fixtures/channel-videos-tab.fixture.json";
import streamsTabFixture from "../fixtures/channel-streams-tab.fixture.json";

function dump(payload: unknown): string {
  return JSON.stringify(payload);
}

describe("parseChannelFeedPayload — ordinary videos", () => {
  const parsed = parseChannelFeedPayload(dump(videosTabFixture));

  it("parses successfully", () => {
    expect(parsed.ok).toBe(true);
  });

  it("normalizes a fully-populated ordinary upload", () => {
    if (!parsed.ok) throw new Error("parse failed");
    const first = parsed.videos.find((video) => video.id === "aBcD1234EfG");
    expect(first).toEqual({
      id: "aBcD1234EfG",
      title: "An ordinary upload with complete metadata",
      url: "https://www.youtube.com/watch?v=aBcD1234EfG",
      // Largest HTTPS YouTube-host thumbnail wins; the insecure http one is dropped.
      thumbnailUrl: "https://i.ytimg.com/vi/aBcD1234EfG/maxresdefault.jpg?sqp=def",
      publishedAt: new Date(1787529600 * 1000).toISOString(),
      durationSeconds: 676,
      liveStatus: "unknown", // null live_status from flat extraction
      description: null,
    });
  });

  it("treats missing dates, durations, thumbnails as expected nulls", () => {
    if (!parsed.ok) throw new Error("parse failed");
    const undated = parsed.videos.find((video) => video.id === "xYzW9876543");
    expect(undated?.publishedAt).toBeNull();
    expect(undated?.durationSeconds).toBeNull();
    expect(undated?.liveStatus).toBe("unknown");

    const thumbless = parsed.videos.find((video) => video.id === "nO7iThumbs1");
    expect(thumbless?.thumbnailUrl).toBeNull();
    expect(thumbless?.liveStatus).toBe("not_live");
    // A reconstructed watch URL is used when yt-dlp omits `url`.
    expect(thumbless?.url).toBe("https://www.youtube.com/watch?v=nO7iThumbs1");
  });
});

describe("parseChannelFeedPayload — livestream states", () => {
  const parsed = parseChannelFeedPayload(dump(streamsTabFixture));
  if (!parsed.ok) throw new Error("streams fixture must parse");

  it("marks an actively-live stream", () => {
    const live = parsed.videos.find((video) => video.id === "L1vEstr34m1");
    expect(live?.liveStatus).toBe("is_live");
    expect(live?.publishedAt).toBeNull();
    expect(live?.durationSeconds).toBeNull();
  });

  it("marks an upcoming scheduled stream without crashing on unknown timing", () => {
    const upcoming = parsed.videos.find((video) => video.id === "Upcom1ngStr");
    expect(upcoming?.liveStatus).toBe("upcoming");
    expect(upcoming?.publishedAt).toBeNull();
    expect(upcoming?.durationSeconds).toBeNull();
  });

  it("maps past livestreams to was_live with their archived metadata", () => {
    const past = parsed.videos.find((video) => video.id === "WasL1veVide");
    expect(past?.liveStatus).toBe("was_live");
    expect(past?.publishedAt).toBe(new Date(1787184000 * 1000).toISOString());
    expect(past?.durationSeconds).toBe(32259);
  });

  it("folds post_live (just-ended) into was_live", () => {
    const processing = parsed.videos.find((video) => video.id === "PostL1veVid");
    expect(processing?.liveStatus).toBe("was_live");
    expect(processing?.thumbnailUrl).toBeNull(); // empty thumbnail array
  });
});

describe("parseChannelFeedPayload — malformed input", () => {
  it("rejects syntactically invalid JSON with a typed error", () => {
    const result = parseChannelFeedPayload("{not json at all]");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unexpected_response");
      // Error messages never echo raw payload text.
      expect(result.error.message).not.toContain("not json");
    }
  });

  it("rejects a JSON array where an object was expected", () => {
    expect(parseChannelFeedPayload("[]").ok).toBe(false);
  });

  it("rejects payloads without an entries array", () => {
    expect(parseChannelFeedPayload(dump({ id: "playlist-but-no-entries" })).ok).toBe(false);
  });

  it("skips unusable entries instead of failing the whole feed", () => {
    const result = parseChannelFeedPayload(
      dump({
        entries: [
          "a bare string",
          null,
          { title: "no id here" },
          { id: "bad id chars!" },
          { id: "g00dId12345" }, // valid id but no title → skipped
          { id: "g00dId67890", title: "Fine entry" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videos.map((video) => video.id)).toEqual(["g00dId67890"]);
      expect(result.skippedEntries).toBe(5);
    }
  });

  it("accepts an empty entries array as a legitimate empty tab", () => {
    const result = parseChannelFeedPayload(dump({ entries: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videos).toEqual([]);
      expect(result.skippedEntries).toBe(0);
    }
  });
});

describe("duplicate handling", () => {
  const draft = (id: string, liveStatus: "is_live" | "was_live" | "unknown") => ({
    id,
    title: `Video ${id}`,
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnailUrl: null,
    publishedAt: null,
    durationSeconds: 60,
    liveStatus,
    description: null,
  });

  it("collapses duplicates inside one payload, preferring richer live status", () => {
    const result = parseChannelFeedPayload(
      dump({
        entries: [
          { id: "SameVideo01", title: "Videos-tab copy" }, // live_status absent → unknown
          { id: "SameVideo02", title: "First copy" },
          { id: "SameVideo02", title: "Second copy", live_status: "was_live" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.videos).toHaveLength(2);
      expect(result.duplicatesCollapsed).toBe(1);
      const winner = result.videos.find((video) => video.id === "SameVideo02");
      expect(winner?.liveStatus).toBe("was_live");
    }
  });

  it("merges across tabs deterministically with the same preference rule", () => {
    const videosTab = [draft("Shared001", "unknown"), draft("OnlyVideo1", "unknown")];
    const streamsTab = [draft("Shared001", "was_live"), draft("OnlyStream", "is_live")];
    const merged = mergeFeedResults(videosTab, streamsTab);

    expect(merged.videos).toHaveLength(3);
    expect(merged.duplicatesCollapsed).toBe(1);
    const shared = merged.videos.find((video) => video.id === "Shared001");
    expect(shared?.liveStatus).toBe("was_live"); // streams-tab copy won
  });
});

describe("field-level normalizers", () => {
  it.each([
    ["not_live", "not_live"],
    ["is_live", "is_live"],
    ["was_live", "was_live"],
    ["post_live", "was_live"],
    ["is_upcoming", "upcoming"],
    [null, "unknown"],
    [undefined, "unknown"],
    ["garbage", "unknown"],
    [42, "unknown"],
  ] as const)("mapLiveStatus(%j) → %j", (input, expected) => {
    expect(mapLiveStatus(input)).toBe(expected);
  });

  it.each([
    [1787529600, new Date(1787529600 * 1000).toISOString()],
    [1, new Date(1000).toISOString()],
    [0, null],
    [-5, null],
    [Number.NaN, null],
    ["1787529600", null],
    [null, null],
  ] as const)("mapPublishedAt(%j)", (input, expected) => {
    expect(mapPublishedAt(input)).toBe(expected ?? null);
  });

  it.each([
    [676, 676],
    [12.4, 12],
    [0, 0],
    [null, null],
    [-1, null],
    ["90", null],
    [Number.POSITIVE_INFINITY, null],
  ] as const)("mapDurationSeconds(%j) → %j", (input, expected) => {
    expect(mapDurationSeconds(input)).toBe(expected);
  });

  it("picks the largest safe thumbnail and rejects unsafe hosts", () => {
    expect(
      pickThumbnailUrl([
        { url: "https://i.ytimg.com/vi/x/small.jpg", width: 168, height: 94 },
        { url: "https://i.ytimg.com/vi/x/big.jpg", width: 1280, height: 720 },
        { url: "https://tracker.example/big.jpg", width: 4096, height: 2160 },
        { url: "ftp://i.ytimg.com/vi/x/weird.jpg", width: 8000, height: 4500 },
        "not-an-object",
      ]),
    ).toBe("https://i.ytimg.com/vi/x/big.jpg");
    expect(pickThumbnailUrl(undefined)).toBeNull();
    expect(pickThumbnailUrl([{ width: 10 }])).toBeNull();
  });

  it("extracts video IDs from watch URLs", () => {
    expect(videoIdFromWatchUrl("https://www.youtube.com/watch?v=aBcD1234EfG")).toBe("aBcD1234EfG");
    expect(videoIdFromWatchUrl("https://example.com/nothing")).toBeNull();
  });
});

describe("mapFeedEntry guards", () => {
  it("returns null for non-objects and entries lacking ids/titles", () => {
    expect(mapFeedEntry(null)).toBeNull();
    expect(mapFeedEntry(42)).toBeNull();
    expect(mapFeedEntry({})).toBeNull();
    expect(mapFeedEntry({ id: "validId12345" })).toBeNull();
    expect(mapFeedEntry({ title: "no id" })).toBeNull();
  });

  it("truncates absurdly long titles defensively", () => {
    const draft = mapFeedEntry({ id: "validId12345", title: "x".repeat(5000) });
    expect(draft?.title.length).toBeLessThanOrEqual(300);
  });
});
