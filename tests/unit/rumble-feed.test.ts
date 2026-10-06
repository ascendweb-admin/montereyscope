import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";

import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  classifyRumbleFetchFailure,
  fetchRumbleListingPage,
  mergeRumbleListing,
} from "@/lib/rumble/feed";
import { parseRumbleChannelPage } from "@/lib/rumble/channel-page";
import { addCreator } from "@/lib/creators/repository";
import { countCachedVideos } from "@/lib/videos/repository";

const FIXTURE = path.join(__dirname, "..", "fixtures", "rumble-channel-page.fixture.html");

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

describe("fetchRumbleListingPage", () => {
  it("parses a real listing page into drafts and identity", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const fetchImpl = vi.fn().mockResolvedValue(htmlResponse(html));
    const result = await fetchRumbleListingPage("https://rumble.com/c/Styxhexenhammer666", {
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.videos).toHaveLength(4);
    expect(result.identity?.displayName).toBe("Styxhexenhammer666");
  });

  it("maps throttling to a typed retryable failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("no", { status: 429 }));
    const result = await fetchRumbleListingPage("https://rumble.com/c/Redacted", {
      fetchImpl,
      sleep: () => Promise.resolve(),
      attempts: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.reason).toBe("throttled");
      expect(result.failure.message).toMatch(/throttling/i);
    }
  });
});

describe("classifyRumbleFetchFailure", () => {
  it("maps every reason to a user-safe sentence", () => {
    expect(classifyRumbleFetchFailure("throttled")).toContain("Rumble is throttling");
    expect(classifyRumbleFetchFailure("unavailable_channel")).toContain("Rumble does not serve");
    expect(classifyRumbleFetchFailure("unusable_page")).toContain("could not read");
    expect(classifyRumbleFetchFailure("network")).toBeTruthy();
  });
});

describe("mergeRumbleListing", () => {
  const tempDirs: string[] = [];
  let db: ScopeDatabase;

  afterAll(() => {
    if (db?.open) db.close();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes drafts into the creator's cached feed and stamps the refresh", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "localtube-rumble-feed-"));
    tempDirs.push(dir);
    db = new Database(path.join(dir, "test.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, ALL_MIGRATIONS);

    const created = addCreator(db, {
      youtubeChannelId: null,
      handle: "styxhexenhammer666",
      displayName: "Styxhexenhammer666",
      channelUrl: "https://rumble.com/c/Styxhexenhammer666",
      avatarUrl: null,
      platform: "rumble",
    });

    // The parse step is pure (the fetch layer has its own tests); parse the
    // real fixture and merge it the way performRumbleRefresh does.
    const parsed = parseRumbleChannelPage(readFileSync(FIXTURE, "utf8"), "styxhexenhammer666");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    const outcome = mergeRumbleListing(
      db,
      created.creator.id,
      parsed.videos,
      "2026-09-06T10:00:00Z",
    );
    expect(outcome.fetchedCount).toBe(4);
    expect(outcome.livestreamCount).toBe(1); // the ended-livestream fixture item
    expect(countCachedVideos(db, created.creator.id)).toBe(4);

    const stamped = db
      .prepare<[number], { last_refreshed_at: string }>(
        "SELECT last_refreshed_at FROM creators WHERE id = ?",
      )
      .get(created.creator.id);
    expect(stamped?.last_refreshed_at).toBe("2026-09-06T10:00:00Z");
  });
});
