import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { getCreator, listCreators } from "@/lib/creators/repository";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  connectX,
  disconnectX,
  fetchTweetsForCreator,
  getCachedCreatorTimeline,
  refreshCreatorTweets,
  resetXInFlightRefreshes,
  resolveXCreator,
  saveXCreator,
  type XRefreshOutcome,
  mergeCreatorTimeline,
} from "@/lib/x";
import { getXProvider, resetXProvider } from "@/lib/x/providers";

const tempDirs: string[] = [];
const databases: ScopeDatabase[] = [];
let db: ScopeDatabase;

beforeAll(() => {
  process.env.SCOPE_X_FAKE_PROVIDER = "1";
  resetXProvider();
});

beforeEach(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-x-service-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, ALL_MIGRATIONS);
  db = database;
  databases.push(database);
  resetXInFlightRefreshes();
  // Every test starts from a clean connection state.
  await disconnectX();
  await connectX();
});

afterAll(() => {
  delete process.env.SCOPE_X_FAKE_PROVIDER;
  for (const database of databases) {
    if (database.open) database.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dbPathForTemp(): ScopeDatabase {
  return db;
}

async function saveCreator(handle = "market_watch") {
  const resolved = await resolveXCreator(`https://x.com/${handle}`);
  if (!resolved.ok) {
    throw new Error(`resolve failed: ${resolved.error.code}`);
  }
  const saved = await saveXCreator(dbPathForTemp(), { payload: resolved.creator });
  if (!saved.ok) {
    throw new Error(`save failed: ${saved.error.code}`);
  }
  return saved;
}

describe("resolveXCreator / saveXCreator", () => {
  it("resolves a profile and saves a platform-identified creator", async () => {
    const resolved = await resolveXCreator("https://x.com/market_watch");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.creator.platform).toBe("x");
    expect(resolved.creator.handle).toBe("market_watch");
    expect(resolved.creator.platformUserId).toMatch(/^\d+$/);
    expect(resolved.creator.channelUrl).toBe("https://x.com/market_watch");

    const saved = await saveXCreator(db, { payload: resolved.creator });
    expect(saved.ok).toBe(true);
    if (!saved.ok) {
      return;
    }
    expect(saved.status).toBe("created");
    const record = getCreator(db, saved.creator.id);
    expect(record?.platform).toBe("x");
    expect(record?.platformUserId).toBe(resolved.creator.platformUserId);
  });

  it("deduplicates by stable user id even when the handle changes", async () => {
    const first = await saveCreator("market_watch");
    const resolvedAgain = await resolveXCreator("https://x.com/other_handle");
    if (!resolvedAgain.ok) {
      throw new Error("resolve failed");
    }
    // Same fake account identity under a different handle.
    const payload = {
      ...resolvedAgain.creator,
      platformUserId: first.creator.platformUserId,
      handle: "renamed_handle",
      channelUrl: "https://x.com/renamed_handle",
    };
    const second = await saveXCreator(db, { payload });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.status).toBe("already_saved");
    expect(listCreators(db)).toHaveLength(1);
  });

  it("imports a status link as a single cached post", async () => {
    const preview = await resolveXCreator("https://x.com/market_watch");
    if (!preview.ok) {
      throw new Error("resolve failed");
    }
    const saved = await saveXCreator(db, {
      payload: {
        ...preview.creator,
        tweetId: null,
      },
    });
    if (!saved.ok) {
      throw new Error("save failed");
    }
    const refresh = await refreshCreatorTweets(db, saved.creator.id, { mode: "recent", limit: 1 });
    expect(refresh.ok).toBe(true);
    if (!refresh.ok) {
      return;
    }
    const page = getCachedCreatorTimeline(db, saved.creator.id, { limit: 10 });
    expect(page.items.length).toBeGreaterThan(0);
    const firstId = page.items[0].tweet.id;
    const fetch = await fetchTweetsForCreator(db, saved.creator.id, [firstId]);
    expect(fetch.ok).toBe(true);
    if (fetch.ok) {
      expect(fetch.alreadyCompleteCount).toBe(1);
      expect(fetch.results[0].status).toBe("already_complete");
    }
  });

  it("previews a status link with its author and post", async () => {
    const resolved = await resolveXCreator(
      "https://x.com/market_watch/status/9006728309997861000",
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      return;
    }
    expect(resolved.creator.handle).toBe("market_watch");
    expect(resolved.creator.tweetId).toBe("9006728309997861000");
    expect(resolved.creator.tweetText ?? "").toContain("long-form post");
    expect(resolved.creator.tweetUrl).toBe(
      "https://x.com/market_watch/status/9006728309997861000",
    );
  });

  it("rejects deceptive look-alike hosts through the resolver", async () => {
    const resolved = await resolveXCreator("https://x.com.evil.example/market_watch");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.message).toContain("x.com");
    }
  });

  it("rejects a malformed confirmed payload", async () => {
    const outcome = await saveXCreator(db, {
      payload: { platformUserId: "not-numeric", handle: "a", displayName: "A", channelUrl: "https://x.com/a" },
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("refreshCreatorTweets", () => {
  it("uses the saved creator identity, not the connected reader, for timeline requests", async () => {
    const saved = await saveCreator();
    const provider = getXProvider();
    const spy = vi.spyOn(provider, "listUserTweets");
    try {
      await refreshCreatorTweets(db, saved.creator.id);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ userId: saved.creator.platformUserId, handle: saved.creator.handle }));
      expect(saved.creator.platformUserId).not.toBe((await provider.status()).user?.userId);
    } finally { spy.mockRestore(); }
  });

  it("preserves complete text when a later timeline contains only a summary", async () => {
    const saved = await saveCreator();
    await refreshCreatorTweets(db, saved.creator.id);
    const original = getCachedCreatorTimeline(db, saved.creator.id).items[0];
    mergeCreatorTimeline(db, saved.creator.id, [{ ...original, tweet: { ...original.tweet, text: "Shortened…", contentStatus: "summary" } }]);
    const updated = getCachedCreatorTimeline(db, saved.creator.id).items.find((item) => item.tweet.id === original.tweet.id)!;
    expect(updated.tweet.text).toBe(original.tweet.text);
    expect(updated.tweet.contentStatus).toBe("complete");
  });

  it("merges recent posts, follows the older cursor, and reports exhaustion", async () => {
    const saved = await saveCreator();
    const creatorId = saved.creator.id;

    const recent = await refreshCreatorTweets(db, creatorId, { mode: "recent", limit: 10 });
    expect(recent.ok).toBe(true);
    expect(recent.ok && recent.newItemCount).toBe(10);
    expect(recent.ok && recent.hasOlderAvailable).toBe(true);

    const older = await refreshCreatorTweets(db, creatorId, { mode: "older", limit: 20 });
    expect(older.ok).toBe(true);
    if (older.ok) {
      expect(older.newItemCount).toBeGreaterThan(0);
      expect(older.hasOlderAvailable).toBe(false);
    }

    const exhausted = await refreshCreatorTweets(db, creatorId, { mode: "older", limit: 20 });
    expect(exhausted.ok).toBe(true);
    expect(exhausted.ok && exhausted.status).toBe("exhausted");

    // A repeat recent refresh updates in place instead of duplicating.
    const before = getCachedCreatorTimeline(db, creatorId, { limit: 100 }).totalCount;
    const again = await refreshCreatorTweets(db, creatorId, { mode: "recent", limit: 10 });
    expect(again.ok).toBe(true);
    const after = getCachedCreatorTimeline(db, creatorId, { limit: 100 }).totalCount;
    expect(after).toBe(before);
  });

  it("keeps cached posts when the session is gone", async () => {
    const saved = await saveCreator();
    await refreshCreatorTweets(db, saved.creator.id, { mode: "recent", limit: 5 });
    const cachedBefore = getCachedCreatorTimeline(db, saved.creator.id, {
      limit: 100,
      includeReplies: true,
    }).totalCount;
    expect(cachedBefore).toBe(5);

    await disconnectX();
    const failed = await refreshCreatorTweets(db, saved.creator.id, { mode: "recent", limit: 5 });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("not_connected");
    }
    const cachedAfter = getCachedCreatorTimeline(db, saved.creator.id, {
      limit: 100,
      includeReplies: true,
    }).totalCount;
    expect(cachedAfter).toBe(cachedBefore);

    await connectX();
  });

  it("never regresses cached posts on a recent refresh after deep pagination", async () => {
    const saved = await saveCreator();
    const creatorId = saved.creator.id;
    const recent = await refreshCreatorTweets(db, creatorId, { mode: "recent", limit: 10 });
    expect(recent.ok).toBe(true);
    const older = await refreshCreatorTweets(db, creatorId, { mode: "older", limit: 20 });
    expect(older.ok).toBe(true);
    const stateAfterOlder = getCachedCreatorTimeline(db, creatorId, {
      limit: 1,
      includeReplies: true,
    }).state;
    expect(stateAfterOlder?.exhausted).toBe(true);
    const countAfterOlder = getCachedCreatorTimeline(db, creatorId, {
      limit: 100,
      includeReplies: true,
    }).totalCount;

    const refreshAgain = await refreshCreatorTweets(db, creatorId, { mode: "recent", limit: 10 });
    expect(refreshAgain.ok).toBe(true);
    const countAfter = getCachedCreatorTimeline(db, creatorId, {
      limit: 100,
      includeReplies: true,
    }).totalCount;
    expect(countAfter).toBe(countAfterOlder);
  });

  it("reports partial fetch outcomes for unknown ids", async () => {
    const saved = await saveCreator();
    await refreshCreatorTweets(db, saved.creator.id, { mode: "recent", limit: 3 });
    const page = getCachedCreatorTimeline(db, saved.creator.id, { limit: 10 });
    // The fixture id must satisfy the real status-id bound.
    expect(page.items[0].tweet.id).toMatch(/^\d{1,20}$/);
    const knownId = page.items[0].tweet.id;
    const outcome = await fetchTweetsForCreator(db, saved.creator.id, [knownId, "987654321"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.alreadyCompleteCount).toBe(1);
      expect(outcome.failedCount).toBe(1);
      expect(outcome.results[1].errorCode).toBe("not_found");
    }
  });
});

describe("refresh outcome typing", () => {
  it("coerces limit bounds instead of rejecting", async () => {
    const saved = await saveCreator();
    const outcome: XRefreshOutcome = await refreshCreatorTweets(db, saved.creator.id, {
      mode: "recent",
      limit: 10_000,
    });
    expect(outcome.ok).toBe(true);
  });
});
