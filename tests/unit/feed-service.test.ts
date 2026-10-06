import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import { setRecentItemsPerTab } from "@/lib/settings/settings";
import { refreshCreatorFeeds, resetInFlightRefreshes } from "@/lib/videos/service";
import type { ExecFileResult } from "@/lib/ytdlp/runner";
import { buildChannelFeedArgs, feedTimeoutMsFor } from "@/lib/ytdlp/channel-feed";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function createTempDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-feedservice-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  return database;
}

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
  db = createTempDb();
  runMigrations(db, ALL_MIGRATIONS);
  resetInFlightRefreshes();
});

const CREATOR = {
  youtubeChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
  handle: "samplecreator",
  displayName: "Sample Creator",
  channelUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
  avatarUrl: null,
};

const BASE_DEPS = { command: "yt-dlp-stub", timeoutMs: 1000, maxOutputBytes: 1024 * 1024 };

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

const VIDEOS_PAYLOAD = JSON.stringify({
  entries: [
    { id: "Ordinary01A", title: "Video A", duration: 60, timestamp: 1787529600 },
    { id: "Shared00001", title: "Also on streams tab" },
  ],
});

const STREAMS_PAYLOAD = JSON.stringify({
  entries: [
    { id: "LiveNow00001", title: "Live now", live_status: "is_live" },
    { id: "Shared00001", title: "Also on videos tab", live_status: "was_live" },
  ],
});

/** Stub runner that answers per yt-dlp tab based on the invoked URL. */
function tabbedRunner(responses: {
  videos?: () => ExecFileResult;
  streams?: () => ExecFileResult;
}) {
  return vi.fn(((_command: string, args: readonly string[]) => {
    const url = args.at(-1) ?? "";
    if (url.endsWith("/videos")) {
      return responses.videos ? responses.videos() : success('{"entries": []}');
    }
    if (url.endsWith("/streams")) {
      return responses.streams ? responses.streams() : success('{"entries": []}');
    }
    throw new Error(`unexpected invocation: ${url}`);
  }) as unknown as (file: string, args: readonly string[]) => Promise<ExecFileResult>);
}

describe("refreshCreatorFeeds — success path", () => {
  it("fetches both tabs with bounded flat args and merges duplicates", async () => {
    const { creator } = addCreator(db, CREATOR);
    const run = tabbedRunner({
      videos: () => success(VIDEOS_PAYLOAD),
      streams: () => success(STREAMS_PAYLOAD),
    });

    const outcome = await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Shared00001 appears on both tabs; the richer was_live copy wins.
    expect(outcome.videoCount).toBe(1);
    expect(outcome.livestreamCount).toBe(2);
    expect(outcome.refreshedAt).toBeTruthy();

    // Both tab URLs were requested with the bounded flag set.
    expect(run).toHaveBeenCalledTimes(2);
    const videosArgs = (run.mock.calls[0] as [string, readonly string[]])[1];
    const streamsUrl = (run.mock.calls[1] as [string, readonly string[]])[1].at(-1);
    expect(videosArgs.at(-1)).toContain("/videos");
    expect(streamsUrl).toContain("/streams");
    expect(videosArgs).toContain("--flat-playlist");
    expect(videosArgs).toContain("youtubetab:approximate_date");
    expect(videosArgs).not.toContain("--download");

    // last_refreshed_at stamped only after the successful swap.
    const stamp = db
      .prepare<[number], { last_refreshed_at: string | null }>(
        "SELECT last_refreshed_at FROM creators WHERE id = ?",
      )
      .get(creator.id);
    expect(stamp?.last_refreshed_at).toBe(outcome.refreshedAt);
  });

  it("honors the recent-items-per-tab setting when bounding playlist-items", async () => {
    const { creator } = addCreator(db, CREATOR);
    setRecentItemsPerTab(db, 7);
    const run = tabbedRunner({});

    await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run });

    const args = (run.mock.calls[0] as [string, readonly string[]])[1];
    const itemsIndex = args.indexOf("--playlist-items");
    expect(args[itemsIndex + 1]).toBe("1:7");
  });

  it("treats a missing channel tab as an empty feed, not an error", async () => {
    const { creator } = addCreator(db, CREATOR);
    const run = tabbedRunner({
      videos: () => success(VIDEOS_PAYLOAD),
      streams: () =>
        failure(
          "nonzero_exit",
          "ERROR: [youtube:tab] UCX6…: This channel does not have a streams tab",
          { exitCode: 1 },
        ),
    });

    const outcome = await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.livestreamCount).toBe(0);
      // The shared video still lands in cache from the videos tab.
      const rows = db.prepare<[], { id: string }>("SELECT id FROM videos").all();
      expect(rows.map((row) => row.id)).toEqual(["Ordinary01A", "Shared00001"]);
    }
  });

  it("accumulates across refreshes instead of replacing the cache", async () => {
    const { creator } = addCreator(db, CREATOR);
    const firstRun = tabbedRunner({ videos: () => success(VIDEOS_PAYLOAD) });
    await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: firstRun });

    // A later refresh only fetches the newer window; earlier entries stay.
    const laterPayload = JSON.stringify({
      entries: [{ id: "NewerVideo1", title: "Newer upload", timestamp: 1787616000 }],
    });
    const secondRun = tabbedRunner({ videos: () => success(laterPayload) });
    const outcome = await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: secondRun });

    expect(outcome.ok).toBe(true);
    const rows = db.prepare<[], { id: string }>("SELECT id FROM videos ORDER BY id").all();
    expect(rows.map((row) => row.id)).toEqual(["NewerVideo1", "Ordinary01A", "Shared00001"]);
  });
});

describe("refreshCreatorFeeds — failure paths preserve the cache", () => {
  it.each([
    ["timeout", (): ExecFileResult => failure("timeout", "", { signal: "SIGTERM" }), "timeout"],
    [
      "network outage",
      (): ExecFileResult =>
        failure("nonzero_exit", "<urlopen error> getaddrinfo failed", { exitCode: 1 }),
      "network",
    ],
    [
      "terminated channel",
      (): ExecFileResult =>
        failure("nonzero_exit", "This channel does not exist.", { exitCode: 1 }),
      "unavailable_creator",
    ],
    ["missing yt-dlp", (): ExecFileResult => failure("missing_executable"), "ytdlp_missing"],
    ["output cap", (): ExecFileResult => failure("output_limit"), "output_limit"],
  ] as const)(
    "maps %s to a typed error and keeps the previous feed + stamp",
    async (_label, videosFailure, expectedCode) => {
      const { creator } = addCreator(db, CREATOR);

      // Seed a good previous refresh.
      const goodRun = tabbedRunner({ videos: () => success(VIDEOS_PAYLOAD) });
      const first = await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: goodRun });
      if (!first.ok) throw new Error("seeding refresh must succeed");
      expect(first.refreshedAt).toBeTruthy();

      const badRun = tabbedRunner({ videos: () => videosFailure() });
      const second = await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: badRun });

      expect(second.ok).toBe(false);
      if (second.ok) throw new Error("expected failure");
      expect(second.error.code).toBe(expectedCode);

      // Cache untouched; last_refreshed_at unchanged.
      const rows = db.prepare<[], { id: string }>("SELECT id FROM videos").all();
      expect(rows.length).toBeGreaterThan(0);
      const stamp = db
        .prepare<[number], { last_refreshed_at: string | null }>(
          "SELECT last_refreshed_at FROM creators WHERE id = ?",
        )
        .get(creator.id);
      expect(stamp?.last_refreshed_at).toBe(first.refreshedAt);
    },
  );

  it("rejects invalid JSON output without erasing cached rows", async () => {
    const { creator } = addCreator(db, CREATOR);
    const goodRun = tabbedRunner({ videos: () => success(VIDEOS_PAYLOAD) });
    await refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: goodRun });

    const malformedRun = tabbedRunner({ videos: () => success("{broken json") });
    const outcome = await refreshCreatorFeeds(db, creator.id, {
      ...BASE_DEPS,
      run: malformedRun,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("unexpected_response");
    }
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM videos").get()?.n).toBe(2);
  });

  it("fails cleanly for unknown creators without invoking yt-dlp", async () => {
    const run = tabbedRunner({});
    const outcome = await refreshCreatorFeeds(db, 424242, { ...BASE_DEPS, run });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.code).toBe("invalid_creator");
    }
    expect(run).not.toHaveBeenCalled();
  });
});

describe("duplicate refresh prevention", () => {
  it("collapses concurrent refreshes for one creator into a single yt-dlp pass", async () => {
    const { creator } = addCreator(db, CREATOR);

    let releaseVideos!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseVideos = resolve;
    });

    const slowRun = vi.fn((_command: string, args: readonly string[]) => {
      if ((args.at(-1) ?? "").endsWith("/videos")) {
        return gate.then(() => success(VIDEOS_PAYLOAD));
      }
      return Promise.resolve(success(STREAMS_PAYLOAD));
    }) as unknown as (file: string, args: readonly string[]) => Promise<ExecFileResult>;

    const first = refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: slowRun });
    const second = refreshCreatorFeeds(db, creator.id, { ...BASE_DEPS, run: slowRun });

    releaseVideos();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    // Exactly one full pass: two tabs fetched once.
    expect(slowRun).toHaveBeenCalledTimes(2);
    expect(firstOutcome.ok).toBe(true);
    expect(firstOutcome.status).toBe("refreshed");
    if (secondOutcome.ok) {
      expect(secondOutcome.status).toBe("already_in_progress");
    }

    // After completion, a fresh refresh may run again.
    const third = await refreshCreatorFeeds(db, creator.id, {
      ...BASE_DEPS,
      run: tabbedRunner({}),
    });
    expect(third.ok).toBe(true);
    if (third.ok) {
      expect(third.status).toBe("refreshed");
    }
  });
});

describe("buildChannelFeedArgs (version-pinned flags)", () => {
  it("builds bounded flat extraction args for each tab", () => {
    const args = buildChannelFeedArgs(
      "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
      "videos",
      30,
    );
    expect(args.at(-1)).toBe("https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/videos");
    expect(args).toContain("--flat-playlist");
    expect(args).toContain("--dump-single-json");
    const itemsIndex = args.indexOf("--playlist-items");
    expect(args.slice(itemsIndex, itemsIndex + 2)).toEqual(["--playlist-items", "1:30"]);
    expect(args).toContain("youtubetab:approximate_date");
    // Never anything that downloads media.
    expect(
      args.some((arg) => /download|write-|format/i.test(arg) && arg !== "--skip-download"),
    ).toBe(false);
  });

  it("clamps limits into the safe range and trims trailing slashes", () => {
    const streamsArgs = buildChannelFeedArgs("https://www.youtube.com/@x/", "streams", 500);
    expect(streamsArgs.at(-1)).toBe("https://www.youtube.com/@x/streams");
    const tiny = buildChannelFeedArgs("https://www.youtube.com/@x", "videos", 1);
    const idx = tiny.indexOf("--playlist-items");
    expect(tiny[idx + 1]).toBe("1:5");
    const huge = buildChannelFeedArgs("https://www.youtube.com/@x", "videos", 1000);
    const idx2 = huge.indexOf("--playlist-items");
    expect(huge[idx2 + 1]).toBe("1:300");
  });
});

describe("feedTimeoutMsFor (per-tab timeout scaled to the window)", () => {
  it("keeps the default timeout up to 100 items and adds 30 s per extra 100", () => {
    expect(feedTimeoutMsFor(30)).toBe(60_000);
    expect(feedTimeoutMsFor(100)).toBe(60_000);
    expect(feedTimeoutMsFor(200)).toBe(90_000);
    expect(feedTimeoutMsFor(300)).toBe(120_000);
    // Out-of-range inputs clamp first, exactly like the playlist window.
    expect(feedTimeoutMsFor(1000)).toBe(120_000);
    expect(feedTimeoutMsFor(1)).toBe(60_000);
  });
});
