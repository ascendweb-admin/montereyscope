import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { addCreator } from "@/lib/creators/repository";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { saveTranscript } from "@/lib/transcripts/repository";
import { classifyVideoJobFailure } from "@/lib/videos/import/errors";
import { parseVideoLink, type VideoLink } from "@/lib/videos/import/links";
import {
  buildVideoMetadataArgs,
  parseYoutubeVideoPayload,
  resolveVideoLink,
} from "@/lib/videos/import/resolve";
import { insertVideoIfMissing } from "@/lib/videos/repository";
import { discoverAvailableSubtitles, selectEnglishSubtitleTrack } from "@/lib/ytdlp/subtitles";
import {
  DISCOVERY_FIXTURE_NAMES,
  RUMBLE_VIDEO_URL,
  ZOO_CHANNEL_ID,
  ZOO_VIDEO_ID,
  ZOO_VIDEO_URL,
  discoveryStdout,
  failure,
  fakeRunner,
  isMetadataJob,
  rumbleMetadata,
  youtubeMetadata,
  youtubeMetadataLiveStatus,
  youtubeMetadataWithoutChannel,
} from "../helpers/video-import";

const tempDirs: string[] = [];
let db: ScopeDatabase;

beforeEach(() => {
  if (db) db.close();
  const dir = mkdtempSync(path.join(tmpdir(), "scope-video-resolve-"));
  tempDirs.push(dir);
  db = new Database(path.join(dir, "test.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
});

afterAll(() => {
  if (db) db.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function link(url: string): VideoLink {
  const parsed = parseVideoLink(url);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.link;
}

const YOUTUBE = link(ZOO_VIDEO_URL);
const RUMBLE = link(RUMBLE_VIDEO_URL);

/** Resolves with a fake runner and no pause before the throttle retry. */
function resolveWith(
  videoLink: VideoLink,
  replies: Parameters<typeof fakeRunner>[0],
  extra: Parameters<typeof resolveVideoLink>[2] = {},
) {
  const runner = fakeRunner(replies);
  const promise = resolveVideoLink(db, videoLink, {
    command: "yt-dlp",
    run: runner.run,
    throttleRetryMs: 0,
    ...extra,
  });
  return { runner, promise };
}

describe("buildVideoMetadataArgs", () => {
  it("asks for metadata only, one video, no user config, URL last", () => {
    const args = buildVideoMetadataArgs(ZOO_VIDEO_URL);
    expect(args).toEqual([
      "--print",
      expect.stringMatching(/^%\(\.\{[a-z_,]+\}\)j$/),
      "--skip-download",
      "--no-playlist",
      "--ignore-config",
      "--no-warnings",
      "--no-progress",
      ZOO_VIDEO_URL,
    ]);
    expect(args).not.toContain("--write-subs");
    expect(args).not.toContain("--write-auto-subs");
  });

  it("prints only the fields the parser reads, never the caption maps that bloat the dump", () => {
    const template = buildVideoMetadataArgs(ZOO_VIDEO_URL)[1];
    expect(template).not.toContain("captions");
    expect(template).not.toContain("subtitles");
    expect(template).not.toContain("formats");
    for (const field of ["id", "title", "channel_id", "channel", "duration", "live_status"]) {
      expect(template).toMatch(new RegExp(`[{,]${field}[,}]`));
    }
  });
});

describe("parseYoutubeVideoPayload", () => {
  const youtubeLink = YOUTUBE as Extract<VideoLink, { platform: "youtube" }>;

  it("maps the real payload into a draft and its host", () => {
    const parsed = parseYoutubeVideoPayload(youtubeMetadata(), youtubeLink);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.draft).toMatchObject({
      id: ZOO_VIDEO_ID,
      title: "Me at the zoo",
      url: ZOO_VIDEO_URL,
      durationSeconds: 19,
      publishedAt: "2005-04-24T03:31:52.000Z",
      liveStatus: "not_live",
    });
    // The largest sized thumbnail on YouTube's image host, not a tiny default.
    expect(parsed.draft.thumbnailUrl).toMatch(
      /^https:\/\/i\.ytimg\.com\/vi\/jNQXAC9IVRw\/hqdefault\.jpg\?sqp=/,
    );
    expect(parsed.draft.description).toContain("00:05 The cool thing");
    expect(parsed.host).toEqual({
      platform: "youtube",
      youtubeChannelId: ZOO_CHANNEL_ID,
      handle: "jawed",
      displayName: "jawed",
      channelUrl: `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`,
    });
  });

  it("uses the uploader name when there is no channel name, and drops unusable handles", () => {
    const parsed = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        delete payload.channel;
        payload.uploader = "  Some Uploader  ";
        payload.uploader_id = "@ab";
      }),
      youtubeLink,
    );
    expect(parsed.ok && parsed.host.displayName).toBe("Some Uploader");
    expect(parsed.ok && parsed.host.handle).toBeNull();
  });

  it("lowercases the handle and ignores an uploader id that is not a handle", () => {
    const upper = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        payload.uploader_id = "@PBDPodcast";
      }),
      youtubeLink,
    );
    expect(upper.ok && upper.host.handle).toBe("pbdpodcast");
    const legacy = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        payload.uploader_id = "SomeLegacyName";
      }),
      youtubeLink,
    );
    expect(legacy.ok && legacy.host.handle).toBeNull();
  });

  it("caps long titles and descriptions", () => {
    const parsed = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        payload.title = "t".repeat(400);
        payload.description = "d".repeat(6000);
      }),
      youtubeLink,
    );
    expect(parsed.ok && parsed.draft.title).toHaveLength(300);
    expect(parsed.ok && parsed.draft.description).toHaveLength(5000);
  });

  it("falls back to the upload date when the payload has no timestamp", () => {
    const parsed = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        delete payload.timestamp;
      }),
      youtubeLink,
    );
    expect(parsed.ok && parsed.draft.publishedAt).toBe("2005-04-24T00:00:00.000Z");
  });

  it("stores the canonical link and link id even when yt-dlp reports another URL", () => {
    const parsed = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        payload.webpage_url = "https://www.youtube.com/watch?v=jNQXAC9IVRw&pp=x";
      }),
      youtubeLink,
    );
    expect(parsed.ok && parsed.draft.url).toBe(ZOO_VIDEO_URL);
  });

  it.each([
    ["not json", "WARNING: nope"],
    ["an array", "[]"],
    ["null", "null"],
  ])("rejects %s as unreadable", (_name, stdout) => {
    const parsed = parseYoutubeVideoPayload(stdout, youtubeLink);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatchObject({
      code: "unexpected_response",
      retryable: false,
    });
  });

  it("rejects a payload with no title", () => {
    const parsed = parseYoutubeVideoPayload(
      youtubeMetadata((payload) => {
        payload.title = "   ";
      }),
      youtubeLink,
    );
    expect(!parsed.ok && parsed.error.code).toBe("unexpected_response");
  });

  it("rejects a missing, malformed, or non-channel id as no_channel", () => {
    for (const change of [
      (payload: Record<string, unknown>) => delete payload.channel_id,
      (payload: Record<string, unknown>) => (payload.channel_id = "UCshort"),
      (payload: Record<string, unknown>) => (payload.channel_id = "PL4QobU6STFB0P71PMvOGN5A"),
      (payload: Record<string, unknown>) => {
        delete payload.channel;
        delete payload.uploader;
      },
    ]) {
      const parsed = parseYoutubeVideoPayload(youtubeMetadata(change), youtubeLink);
      expect(!parsed.ok && parsed.error).toMatchObject({ code: "no_channel", retryable: false });
    }
  });
});

describe("resolveVideoLink: YouTube", () => {
  it("runs the metadata and caption jobs and returns a ready video", async () => {
    const { runner, promise } = resolveWith(YOUTUBE, {
      metadata: youtubeMetadata(),
      discovery: discoveryStdout("human_english"),
    });
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.video).toMatchObject({
      platform: "youtube",
      videoId: ZOO_VIDEO_ID,
      url: ZOO_VIDEO_URL,
      captions: "manual",
      inLibrary: null,
    });
    expect(result.video.draft.title).toBe("Me at the zoo");
    expect(result.video.host.youtubeChannelId).toBe(ZOO_CHANNEL_ID);

    expect(runner.metadataCalls()).toHaveLength(1);
    expect(runner.discoveryCalls()).toHaveLength(1);
    for (const args of runner.calls) {
      expect(args.at(-1)).toBe(ZOO_VIDEO_URL);
      expect(args).toContain("--no-playlist");
      expect(args).not.toContain("--dump-json");
    }
    expect(runner.metadataCalls()[0]).toEqual(buildVideoMetadataArgs(ZOO_VIDEO_URL));
  });

  it("starts both jobs before either finishes", async () => {
    const order: string[] = [];
    const deferred: Array<() => void> = [];
    const run = vi.fn(async (_file: string, args: readonly string[]) => {
      order.push(isMetadataJob(args) ? "metadata:start" : "captions:start");
      await new Promise<void>((resolve) => deferred.push(resolve));
      return {
        ok: true as const,
        stdout: isMetadataJob(args)
          ? youtubeMetadata()
          : discoveryStdout("human_english"),
        stderr: "",
      };
    });
    const promise = resolveVideoLink(db, YOUTUBE, { command: "yt-dlp", run });
    await vi.waitFor(() => expect(order).toHaveLength(2));
    expect(order.sort()).toEqual(["captions:start", "metadata:start"]);
    deferred.forEach((release) => release());
    expect((await promise).ok).toBe(true);
  });

  it("reports automatic captions when no human track exists", async () => {
    const { promise } = resolveWith(YOUTUBE, {
      metadata: youtubeMetadata(),
      discovery: discoveryStdout("auto_english_only"),
    });
    const result = await promise;
    expect(result.ok && result.video.captions).toBe("automatic");
  });

  describe("verdicts", () => {
    it.each([
      ["translated-only captions", "translated_only", "no_english_captions"],
      ["no captions at all", "none", "no_english_captions"],
    ] as const)("rejects %s", async (_name, discovery, code) => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: youtubeMetadata(),
        discovery: discoveryStdout(discovery),
      });
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toEqual({
        code,
        message:
          "No original English captions are available for this video. scope currently supports English only.",
        retryable: false,
      });
    });

    it("rejects unusable caption data as an unexpected response", async () => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: youtubeMetadata(),
        discovery: discoveryStdout("unusable"),
      });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({
        code: "unexpected_response",
        retryable: false,
      });
    });

    it.each(["is_live", "is_upcoming"] as const)(
      "rejects a %s video as live_or_upcoming even though captions exist",
      async (status) => {
        const { promise } = resolveWith(YOUTUBE, {
          metadata: youtubeMetadataLiveStatus(status),
          discovery: discoveryStdout("human_english"),
        });
        const result = await promise;
        expect(!result.ok && result.error).toEqual({
          code: "live_or_upcoming",
          message: "Live and scheduled videos have no captions yet. Import it after it ends.",
          retryable: false,
        });
      },
    );

    it("calls a live video without captions live_or_upcoming, not captionless", async () => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: youtubeMetadataLiveStatus("is_live"),
        discovery: discoveryStdout("none"),
      });
      expect((await promise).ok).toBe(false);
      expect(!(await promise).ok && (await promise)).toMatchObject({
        error: { code: "live_or_upcoming" },
      });
    });

    it("treats yt-dlp's refusal of a scheduled stream as live_or_upcoming", async () => {
      const refusal = failure(
        "nonzero_exit",
        "ERROR: [youtube] abc: This live event will begin in 3 hours.",
      );
      const { promise } = resolveWith(YOUTUBE, { metadata: refusal, discovery: refusal });
      const result = await promise;
      expect(!result.ok && result.error.code).toBe("live_or_upcoming");
    });

    it("lets a metadata failure win over a caption verdict", async () => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: failure("nonzero_exit", "ERROR: [youtube] abc: Video unavailable"),
        discovery: discoveryStdout("none"),
      });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({
        code: "unavailable_video",
        message: "YouTube would not serve that video (it may be private, removed, or restricted).",
        retryable: false,
      });
    });

    it("lets a metadata failure win over a successful caption lookup", async () => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: failure("timeout"),
        discovery: discoveryStdout("human_english"),
      });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({ code: "timeout", retryable: true });
    });

    it("reports a caption lookup failure once the metadata is fine", async () => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: youtubeMetadata(),
        discovery: failure("nonzero_exit", "Temporary failure in name resolution"),
      });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({ code: "network", retryable: true });
    });

    it("rejects a video with no channel before looking at captions", async () => {
      const { promise } = resolveWith(YOUTUBE, {
        metadata: youtubeMetadataWithoutChannel(),
        discovery: discoveryStdout("human_english"),
      });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({ code: "no_channel", retryable: false });
    });

    it("reports a missing yt-dlp as retryable", async () => {
      const missing = failure("missing_executable");
      const { promise } = resolveWith(YOUTUBE, { metadata: missing, discovery: missing });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({ code: "ytdlp_missing", retryable: true });
    });
  });

  describe("throttle retry", () => {
    const throttled = failure(
      "nonzero_exit",
      "ERROR: unable to download: HTTP Error 429: Too Many Requests",
    );

    it("retries a throttled metadata job once and succeeds", async () => {
      const { runner, promise } = resolveWith(YOUTUBE, {
        metadata: [throttled, youtubeMetadata()],
        discovery: discoveryStdout("human_english"),
      });
      expect((await promise).ok).toBe(true);
      expect(runner.metadataCalls()).toHaveLength(2);
    });

    it("gives up after one retry with a retryable throttled error", async () => {
      const { runner, promise } = resolveWith(YOUTUBE, {
        metadata: throttled,
        discovery: discoveryStdout("human_english"),
      });
      const result = await promise;
      expect(!result.ok && result.error).toMatchObject({ code: "throttled", retryable: true });
      expect(runner.metadataCalls()).toHaveLength(2);
    });

    it("retries a throttled caption lookup once", async () => {
      const { runner, promise } = resolveWith(YOUTUBE, {
        metadata: youtubeMetadata(),
        discovery: [throttled, discoveryStdout("human_english")],
      });
      expect((await promise).ok).toBe(true);
      expect(runner.discoveryCalls()).toHaveLength(2);
    });

    it("does not retry an ordinary failure", async () => {
      const { runner, promise } = resolveWith(YOUTUBE, {
        metadata: failure("nonzero_exit", "ERROR: Video unavailable"),
        discovery: discoveryStdout("human_english"),
      });
      await promise;
      expect(runner.metadataCalls()).toHaveLength(1);
    });
  });
});

describe("resolveVideoLink: the caption gate is the transcript pipeline's own", () => {
  it.each(DISCOVERY_FIXTURE_NAMES)("matches discover + select for %s", async (name) => {
    const stdout = discoveryStdout(name);

    const reference = fakeRunner({ discovery: stdout });
    const discovered = await discoverAvailableSubtitles(ZOO_VIDEO_URL, {
      command: "yt-dlp",
      run: reference.run,
    });
    const expected = discovered.ok ? selectEnglishSubtitleTrack(discovered.available) : undefined;

    const { promise } = resolveWith(YOUTUBE, {
      metadata: youtubeMetadata(),
      discovery: stdout,
    });
    const result = await promise;

    if (expected === undefined) {
      expect(!result.ok && result.error.code).toBe("unexpected_response");
    } else if (expected === null) {
      expect(!result.ok && result.error.code).toBe("no_english_captions");
    } else {
      expect(result.ok && result.video.captions).toBe(expected.kind);
    }
  });

  it("calls the injected discover function with the canonical link and shared job deps", async () => {
    const discover = vi.fn(async () => ({
      ok: true as const,
      videoId: ZOO_VIDEO_ID,
      available: { manual: [], automatic: ["en-orig"] },
    }));
    const runner = fakeRunner({ metadata: youtubeMetadata() });
    const result = await resolveVideoLink(db, YOUTUBE, {
      command: "custom-yt-dlp",
      run: runner.run,
      discover,
      throttleRetryMs: 5,
    });
    expect(result.ok && result.video.captions).toBe("automatic");
    expect(discover).toHaveBeenCalledWith(ZOO_VIDEO_URL, {
      command: "custom-yt-dlp",
      run: runner.run,
      throttleRetryMs: 5,
    });
  });
});

describe("resolveVideoLink: videos already cached", () => {
  function seedVideo(
    options: {
      transcript?: { language: string; source: "manual" | "automatic" };
      liveStatus?: "upcoming" | "not_live";
    } = {},
  ) {
    const { creator } = addCreator(db, {
      youtubeChannelId: ZOO_CHANNEL_ID,
      handle: "jawed",
      displayName: "jawed",
      channelUrl: `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`,
      avatarUrl: null,
    });
    insertVideoIfMissing(db, creator.id, {
      id: ZOO_VIDEO_ID,
      title: "Cached title",
      url: ZOO_VIDEO_URL,
      thumbnailUrl: "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
      publishedAt: "2005-04-24T11:51:52.000Z",
      durationSeconds: 19,
      liveStatus: options.liveStatus ?? "not_live",
      description: null,
    });
    if (options.transcript) {
      saveTranscript(
        db,
        {
          videoId: ZOO_VIDEO_ID,
          language: options.transcript.language,
          source: options.transcript.source,
          plainText: "alright so here we are",
        },
        "2026-10-23T10:00:00.000Z",
      );
    }
    return creator.id;
  }

  it("skips both jobs when the transcript is cached", async () => {
    const creatorId = seedVideo({ transcript: { language: "en-orig", source: "automatic" } });
    const { runner, promise } = resolveWith(YOUTUBE, {});
    const result = await promise;

    expect(runner.calls).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.video).toMatchObject({
      videoId: ZOO_VIDEO_ID,
      captions: "automatic",
      inLibrary: { creatorId, hasTranscript: true },
    });
    expect(result.video.draft.title).toBe("Cached title");
    expect(result.video.host).toEqual({
      platform: "youtube",
      youtubeChannelId: ZOO_CHANNEL_ID,
      handle: "jawed",
      displayName: "jawed",
      channelUrl: `https://www.youtube.com/channel/${ZOO_CHANNEL_ID}`,
    });
  });

  it("runs only the caption gate when the video has no transcript yet", async () => {
    const creatorId = seedVideo();
    const { runner, promise } = resolveWith(YOUTUBE, {
      discovery: discoveryStdout("human_english"),
    });
    const result = await promise;

    expect(runner.metadataCalls()).toEqual([]);
    expect(runner.discoveryCalls()).toHaveLength(1);
    expect(result.ok && result.video).toMatchObject({
      captions: "manual",
      inLibrary: { creatorId, hasTranscript: false },
    });
  });

  it("still rejects a cached video that has no English captions", async () => {
    seedVideo();
    const { promise } = resolveWith(YOUTUBE, { discovery: discoveryStdout("translated_only") });
    const result = await promise;
    expect(!result.ok && result.error.code).toBe("no_english_captions");
  });

  it("calls a cached upcoming stream without captions live_or_upcoming", async () => {
    seedVideo({ liveStatus: "upcoming" });
    const { promise } = resolveWith(YOUTUBE, { discovery: discoveryStdout("none") });
    const result = await promise;
    expect(!result.ok && result.error.code).toBe("live_or_upcoming");
  });

  it("does not trust a cached transcript that is not English", async () => {
    seedVideo({ transcript: { language: "de", source: "manual" } });
    const { runner, promise } = resolveWith(YOUTUBE, {
      discovery: discoveryStdout("human_english"),
    });
    const result = await promise;
    expect(runner.discoveryCalls()).toHaveLength(1);
    expect(result.ok && result.video.inLibrary?.hasTranscript).toBe(false);
  });

  it("reports a caption lookup failure for a cached video", async () => {
    seedVideo();
    const { promise } = resolveWith(YOUTUBE, { discovery: failure("timeout") });
    const result = await promise;
    expect(!result.ok && result.error).toMatchObject({ code: "timeout", retryable: true });
  });
});

describe("resolveVideoLink: Rumble", () => {
  it("returns the video with its Rumble channel as host", async () => {
    const { runner, promise } = resolveWith(RUMBLE, {
      metadata: rumbleMetadata(),
      discovery: discoveryStdout("human_english"),
    });
    const result = await promise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.video).toMatchObject({
      platform: "rumble",
      videoId: "v7emyxa",
      url: RUMBLE_VIDEO_URL,
      captions: "manual",
      inLibrary: null,
    });
    expect(result.video.draft.title).toContain("WARNING: This New Flu Shot");
    expect(result.video.host).toEqual({
      platform: "rumble",
      youtubeChannelId: null,
      handle: "redacted",
      displayName: "Redacted News",
      channelUrl: "https://rumble.com/c/Redacted",
    });
    expect(runner.metadataCalls()[0]).toContain("--dump-single-json");
    expect(runner.metadataCalls()[0].at(-1)).toBe(RUMBLE_VIDEO_URL);
  });

  it("uses platform-neutral wording naming Rumble", async () => {
    const { promise } = resolveWith(RUMBLE, {
      metadata: failure("nonzero_exit", "HTTP Error 403: Forbidden"),
      discovery: discoveryStdout("human_english"),
    });
    const result = await promise;
    expect(!result.ok && result.error).toEqual({
      code: "throttled",
      message: "Rumble is throttling requests right now. Wait a minute and try again.",
      retryable: true,
    });
  });

  it("applies the same caption gate", async () => {
    const { promise } = resolveWith(RUMBLE, {
      metadata: rumbleMetadata(),
      discovery: discoveryStdout("none"),
    });
    const result = await promise;
    expect(!result.ok && result.error.code).toBe("no_english_captions");
  });

  it("rejects an unreadable payload", async () => {
    const { promise } = resolveWith(RUMBLE, {
      metadata: "not json",
      discovery: discoveryStdout("human_english"),
    });
    const result = await promise;
    expect(!result.ok && result.error).toMatchObject({
      code: "unexpected_response",
      retryable: false,
    });
  });
});

describe("classifyVideoJobFailure", () => {
  const classify = (kind: string, stderrTail = "", platform = "YouTube") =>
    classifyVideoJobFailure(failure(kind, stderrTail), platform);

  it("maps runner failure kinds", () => {
    expect(classify("missing_executable")).toMatchObject({
      code: "ytdlp_missing",
      retryable: true,
    });
    expect(classify("spawn_failed")).toMatchObject({ code: "ytdlp_missing", retryable: true });
    expect(classify("timeout")).toMatchObject({ code: "timeout", retryable: true });
    expect(classify("output_limit")).toMatchObject({
      code: "unexpected_response",
      retryable: false,
    });
  });

  it.each([
    ["HTTP Error 403: Forbidden", "throttled"],
    ["HTTP Error 429: Too Many Requests", "throttled"],
    ["ERROR: Video unavailable. This video is private", "unavailable_video"],
    ["ERROR: Private video. Sign in if you've been granted access", "unavailable_video"],
    ["Join this channel to get access to members-only content", "unavailable_video"],
    ["ERROR: Sign in to confirm you're not a bot", "unavailable_video"],
    ["ERROR: This video is age-restricted", "unavailable_video"],
    ["This live event will begin in 2 days.", "live_or_upcoming"],
    ["Premieres in 4 hours", "live_or_upcoming"],
    ["Temporary failure in name resolution", "network"],
    ["Connection reset by peer", "network"],
    ["something nobody anticipated", "unexpected_response"],
    ["", "unexpected_response"],
  ])("classifies %j as %s", (stderr, code) => {
    expect(classify("nonzero_exit", stderr).code).toBe(code);
  });

  it("names the platform in the wording and never echoes stderr", () => {
    const stderr = "ERROR: /home/someone/.cache/yt-dlp failed: HTTP Error 429";
    const error = classify("nonzero_exit", stderr, "Rumble");
    expect(error.message).toContain("Rumble");
    expect(error.message).not.toContain("/home/");
    expect(error.message).not.toContain("429");
  });
});
