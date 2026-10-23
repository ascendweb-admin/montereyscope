/**
 * Shared fixtures and a fake yt-dlp runner for the video import tests. The
 * runner answers by argument shape, like the real tool: the metadata job is
 * Rumble's `--dump-single-json` or YouTube's field-subset `--print`, and the
 * other `--print` is caption discovery.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ExecFileResult } from "@/lib/ytdlp/runner";

const FIXTURES = path.join(__dirname, "..", "fixtures");

export const ZOO_VIDEO_ID = "jNQXAC9IVRw";
export const ZOO_VIDEO_URL = `https://www.youtube.com/watch?v=${ZOO_VIDEO_ID}`;
export const ZOO_CHANNEL_ID = "UC4QobU6STFB0P71PMvOGN5A";

export const RUMBLE_VIDEO_SLUG = "v7emyxa";
export const RUMBLE_VIDEO_URL = `https://rumble.com/${RUMBLE_VIDEO_SLUG}`;

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

export function ok(stdout: string): ExecFileResult {
  return { ok: true, stdout, stderr: "" };
}

export function failure(kind: string, stderrTail = ""): Extract<ExecFileResult, { ok: false }> {
  return { ok: false, kind, stderrTail } as Extract<ExecFileResult, { ok: false }>;
}

/** True for the metadata job's arguments, false for caption discovery's. */
export function isMetadataJob(args: readonly string[]): boolean {
  if (args.includes("--dump-single-json")) {
    return true;
  }
  const printAt = args.indexOf("--print");
  return printAt >= 0 && (args[printAt + 1] ?? "").startsWith("%(.{");
}

/** A real yt-dlp metadata payload (trimmed): human English captions, public, not live. */
export function youtubeMetadata(
  change: (payload: Record<string, unknown>) => void = () => undefined,
): string {
  const payload = JSON.parse(readFixture("youtube-video-captions.fixture.json")) as Record<
    string,
    unknown
  >;
  change(payload);
  return JSON.stringify(payload);
}

/** The same video with no channel identity (yt-dlp omits it for some uploads). */
export function youtubeMetadataWithoutChannel(): string {
  return youtubeMetadata((payload) => {
    delete payload.channel_id;
  });
}

export function youtubeMetadataLiveStatus(liveStatus: "is_live" | "is_upcoming"): string {
  return youtubeMetadata((payload) => {
    payload.live_status = liveStatus;
  });
}

export function rumbleMetadata(): string {
  return readFixture("rumble-video-discovery.fixture.json");
}

export type DiscoveryFixtureName =
  "human_english" | "auto_english_only" | "translated_only" | "none" | "unusable";

export const DISCOVERY_FIXTURE_NAMES: DiscoveryFixtureName[] = [
  "human_english",
  "auto_english_only",
  "translated_only",
  "none",
  "unusable",
];

/** Compact discovery stdout in the shape `buildSubtitleDiscoveryArgs` prints. */
export function discoveryStdout(name: DiscoveryFixtureName): string {
  const fixtures = JSON.parse(readFixture("video-caption-discovery.fixture.json")) as Record<
    DiscoveryFixtureName,
    unknown
  >;
  const value = fixtures[name];
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** One reply, or a sequence (the last repeats): a string is a successful stdout. */
export type FakeReply = ExecFileResult | string | readonly (ExecFileResult | string)[];

export interface FakeRunner {
  run: (file: string, args: readonly string[]) => Promise<ExecFileResult>;
  /** Argument arrays of every call, in order. */
  calls: string[][];
  metadataCalls: () => string[][];
  discoveryCalls: () => string[][];
}

/** Builds a `run` that answers the metadata and caption-discovery jobs from canned replies. */
export function fakeRunner(replies: { metadata?: FakeReply; discovery?: FakeReply }): FakeRunner {
  const calls: string[][] = [];
  const used = { metadata: 0, discovery: 0 };

  const next = (job: "metadata" | "discovery"): ExecFileResult => {
    const reply = replies[job];
    if (reply === undefined) {
      throw new Error(`Unexpected ${job} job: no canned reply`);
    }
    const sequence: readonly (ExecFileResult | string)[] = Array.isArray(reply)
      ? reply
      : [reply as ExecFileResult | string];
    const item = sequence[Math.min(used[job], sequence.length - 1)];
    used[job] += 1;
    return typeof item === "string" ? ok(item) : item;
  };

  return {
    calls,
    metadataCalls: () => calls.filter(isMetadataJob),
    discoveryCalls: () => calls.filter((args) => !isMetadataJob(args) && args.includes("--print")),
    run: async (_file, args) => {
      calls.push([...args]);
      if (isMetadataJob(args)) {
        return next("metadata");
      }
      if (args.includes("--print")) {
        return next("discovery");
      }
      throw new Error(`Unexpected yt-dlp arguments: ${args.join(" ")}`);
    },
  };
}

/**
 * Like `fakeRunner`, but each video link has its own replies, picked by the
 * link every yt-dlp invocation ends with. Several links can resolve at once.
 */
export function routedRunner(
  routes: Record<string, { metadata?: FakeReply; discovery?: FakeReply }>,
): {
  run: FakeRunner["run"];
  calls: string[][];
  runnerFor: (url: string) => FakeRunner;
} {
  const runners = new Map<string, FakeRunner>();
  const calls: string[][] = [];
  for (const [url, replies] of Object.entries(routes)) {
    runners.set(url, fakeRunner(replies));
  }
  return {
    calls,
    runnerFor: (url) => {
      const runner = runners.get(url);
      if (runner === undefined) {
        throw new Error(`No route for ${url}`);
      }
      return runner;
    },
    run: async (file, args) => {
      calls.push([...args]);
      const url = args[args.length - 1];
      const runner = runners.get(url);
      if (runner === undefined) {
        throw new Error(`Unexpected video link: ${url}`);
      }
      return runner.run(file, args);
    },
  };
}
