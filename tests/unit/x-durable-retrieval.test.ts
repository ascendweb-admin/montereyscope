import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import {
  countAllTweets,
  getTweetById,
  getTweetForCreator,
  recordTweetNotRetrievable,
  getXFeedState,
  mergeCreatorTimeline,
  upsertXFeedState,
} from "@/lib/x/repository";
import { createFakeXProvider, buildFakeTimeline } from "@/lib/x/providers/fake";
import { XProviderError, type XProvider, type XTimelineItem } from "@/lib/x/model";
import { RetrievalEngine } from "@/lib/x/research/retrieval";
import type { RetrievalRequest } from "@/lib/x/research/retrieval-model";
import { readCachedFeed } from "@/lib/x/research/repository";
import { parseExactSearch } from "@/lib/x/research/search";

let dir: string, file: string, db: Database.Database, provider: XProvider, engine: RetrievalEngine;
let source: XTimelineItem[], calls: Array<{ handle: string; cursor: string | null }>;
let creatorId: number;
function item(n: number): XTimelineItem {
  const base = buildFakeTimeline("fixture", 1)[0];
  const id = String(9000000 + n);
  return {
    ...base,
    tweet: {
      ...base.tweet,
      id,
      text: `Archived text ${n}`,
      publishedAt: new Date(Date.UTC(2026, 9, 1) - n * 60000).toISOString(),
    },
  };
}
const request = (extra: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  kind: "refresh",
  listId: null,
  label: "Fixture",
  creatorIds: [creatorId],
  since: "2026-08-01T00:00:00.000Z",
  until: "2026-10-02T00:00:00.000Z",
  initialDays: 365,
  maxPages: 100,
  ...extra,
});
function open() {
  db = new Database(file);
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
}
function checkpoint(lane = "head") {
  return JSON.parse(
    (
      db
        .prepare("SELECT state_json FROM x_retrieval_checkpoints WHERE creator_id = ? AND lane = ?")
        .get(creatorId, lane) as { state_json: string }
    ).state_json,
  );
}
function pending() {
  return JSON.parse(
    (
      db.prepare("SELECT state_json FROM x_retrieval_tasks ORDER BY rowid DESC LIMIT 1").get() as {
        state_json: string;
      }
    ).state_json,
  );
}
function persistTask(task: ReturnType<typeof pending>) {
  db.prepare("UPDATE x_retrieval_tasks SET state_json = ? WHERE id = ?").run(
    JSON.stringify(task),
    task.id,
  );
}
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "scope-durable-"));
  file = path.join(dir, "db.sqlite");
  open();
  provider = createFakeXProvider({ connected: true });
  const lookup = await provider.resolveUser("fixture");
  creatorId = addCreator(db, {
    platform: "x",
    platformUserId: lookup.user.userId,
    youtubeChannelId: null,
    displayName: "Fixture",
    handle: "fixture",
    channelUrl: "https://x.com/fixture",
    avatarUrl: null,
  }).creator.id;
  source = Array.from({ length: 2000 }, (_, n) => item(n));
  calls = [];
  provider.listUserTweets = vi.fn(async (input) => {
    calls.push({ handle: input.handle, cursor: input.cursor ?? null });
    const offset = Number(input.cursor ?? 0);
    const items = source.slice(offset, offset + 100);
    return {
      items: [item(99999), ...items],
      nextCursor: offset + items.length >= source.length ? null : String(offset + items.length),
      exhausted: false,
      skipped: 0,
    };
  });
  const resolve = provider.resolveUser.bind(provider);
  provider.resolveUser = async (handle, signal) => ({
    ...(await resolve(handle, signal)),
    pinnedTweetId: item(99999).tweet.id,
  });
  engine = new RetrievalEngine(
    () => db,
    () => provider,
  );
});
afterEach(async () => {
  await engine.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("durable manual X retrieval", () => {
  it("imports 2,000 posts, survives restart, then catches up 15 posts using only new span and saved overlap", async () => {
    // The recurring pinned post is one of the 2,000 canonical archived posts.
    const pin = item(1999);
    source[1999] = item(99999);
    expect(pin.tweet.text).toBe("Archived text 1999");
    const initial = engine.start(request());
    await engine.wait(initial.id);
    expect(countAllTweets(db)).toBe(2000);
    expect(checkpoint().initialized).toBe(true);
    const archived = db.prepare("SELECT id, text FROM tweets ORDER BY id").all() as Array<{
      id: string;
      text: string;
    }>;
    const anchors = checkpoint().anchors;
    expect(anchors).toHaveLength(200);
    upsertXFeedState(db, { creatorId, configKey: "legacy", olderCursor: "keep-older" });
    db.close();
    open();
    engine = new RetrievalEngine(
      () => db,
      () => provider,
    );
    calls = [];
    expect(engine.jobs()[0].status).toBe("complete");
    engine.coverage([creatorId]);
    expect(calls).toHaveLength(0);
    source = [...Array.from({ length: 15 }, (_, n) => item(-15 + n)), ...source];
    const refresh = engine.start(request());
    expect((await engine.wait(refresh.id)).status).toBe("complete");
    expect(countAllTweets(db)).toBe(2015);
    expect(
      readCachedFeed(db, {
        creatorIds: [creatorId],
        since: "2020-01-01T00:00:00.000Z",
        until: request().until,
        types: ["original", "reply", "quote"],
        search: parseExactSearch({ terms: "Archived text" }),
      }).total,
    ).toBe(2015);
    db.exec("INSERT INTO x_tweet_text(x_tweet_text, rank) VALUES ('integrity-check', 1)");
    for (const original of archived)
      expect(getTweetById(db, original.id)?.text).toBe(original.text);
    expect(calls.map((c) => c.cursor)).toEqual([null, "100", "200"]);
    expect(refresh.request.creatorIds).toEqual([creatorId]);
    expect(getTweetById(db, item(0).tweet.id)?.text).toBe("Archived text 0");
    expect(getXFeedState(db, creatorId)?.olderCursor).toBe("keep-older");
  });
  it("commits page + checkpoint together, resumes initial import after restart without losing text", async () => {
    const job = engine.start(request({ maxPages: 1 }));
    expect((await engine.wait(job.id)).status).toBe("partial");
    expect(pending().cursor).toBe("100");
    expect(checkpoint().initialized).toBe(false);
    // Simulate a process exit after the committed page but before terminal status was saved.
    persistTask({ ...pending(), status: "running", owner: "exited-process" });
    db.close();
    open();
    engine = new RetrievalEngine(
      () => db,
      () => provider,
    );
    calls = [];
    expect(engine.job(job.id).status).toBe("interrupted");
    expect(calls).toHaveLength(0);
    engine.resume(job.id);
    await engine.wait(job.id);
    expect(calls.map((c) => c.cursor)).toEqual(["100"]);
    expect(countAllTweets(db)).toBe(201); // Includes recurring pin.
    expect(
      readCachedFeed(db, {
        creatorIds: [creatorId],
        since: request().since,
        until: request().until,
        types: ["original", "reply", "quote"],
        search: parseExactSearch({ terms: "Archived text" }),
      }).total,
    ).toBe(200);
    db.exec("INSERT INTO x_tweet_text(x_tweet_text, rank) VALUES ('integrity-check', 1)");
    expect(pending().cursor).toBe("200");
  });
  it("does not advance a successful boundary after a latest-page fetch; resumes a catch-up gap", async () => {
    await engine.wait(engine.start(request()).id);
    const established = checkpoint();
    source = [...Array.from({ length: 250 }, (_, n) => item(-250 + n)), ...source];
    calls = [];
    const job = engine.start(request({ maxPages: 1 }));
    await engine.wait(job.id);
    expect(checkpoint().anchors).toEqual(established.anchors);
    expect(checkpoint().lastSuccessfulRefresh).toBe(established.lastSuccessfulRefresh);
    expect(checkpoint().pendingTask).toBe(job.creators.length ? pending().id : "");
    db.close();
    open();
    engine = new RetrievalEngine(
      () => db,
      () => provider,
    );
    for (let n = 0; n < 4; n++) {
      engine.resume(job.id);
      await engine.wait(job.id);
    }
    expect(engine.job(job.id).status).toBe("complete");
    expect(calls.map((c) => c.cursor)).toEqual([null, "100", "200", "300", "400"]);
    expect(checkpoint().pendingTask).toBeNull();
  });
  it("ignores familiar pins, individual imports and reposts as overlap evidence", async () => {
    await engine.wait(engine.start(request()).id);
    const imported = item(-50);
    mergeCreatorTimeline(db, creatorId, [imported]);
    source = [
      imported,
      { ...item(-49), timelineKind: "repost" },
      ...Array.from({ length: 300 }, (_, n) => item(-348 + n)),
      ...source,
    ];
    calls = [];
    const job = engine.start(request());
    await engine.wait(job.id);
    expect(engine.job(job.id).status).toBe("complete");
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });
  it("preserves separate historical state and qualifies a boundary only after two ordinary older pages", async () => {
    const job = engine.start(request({ kind: "history", since: item(50).tweet.publishedAt! }));
    await engine.wait(job.id);
    expect(engine.job(job.id).creators[0].reason).toBe("boundary");
    expect(calls).toHaveLength(3);
    expect(checkpoint("history").status).toBe("boundary");
    expect(engine.coverage([creatorId])[0].initialized).toBe(false);
    const old = checkpoint("history");
    await engine.wait(engine.start(request({ maxPages: 1 })).id);
    expect(checkpoint("history")).toEqual(old);
  });
  it("rejects a pin/missing timestamp as sufficient date coverage", async () => {
    source = Array.from({ length: 400 }, (_, n) => ({
      ...item(n),
      tweet: { ...item(n).tweet, publishedAt: null },
    }));
    const job = engine.start(request({ kind: "history", maxPages: 3 }));
    await engine.wait(job.id);
    expect(engine.job(job.id).status).toBe("partial");
    expect(engine.job(job.id).creators[0].reason).toBe("page_budget");
  });
  it("restarts an expired cursor with deduplication, preserving committed archive", async () => {
    const job = engine.start(request({ maxPages: 2 }));
    await engine.wait(job.id);
    const list = provider.listUserTweets.bind(provider);
    let expired = true;
    provider.listUserTweets = async (input, signal) => {
      if (input.cursor && expired) {
        expired = false;
        throw new XProviderError("invalid_response");
      }
      return list(input, signal);
    };
    engine.resume(job.id);
    await engine.wait(job.id);
    expect(countAllTweets(db)).toBe(201);
    expect(calls.slice(-2).map((c) => c.cursor)).toEqual([null, "100"]);
    expect(pending().cursor).toBe("200");
  });
  it("detects cyclic cursors and repeating pages, then offers a bounded restart", async () => {
    provider.listUserTweets = async () => ({
      items: [item(0)],
      nextCursor: "same",
      exhausted: false,
      skipped: 0,
    });
    const job = engine.start(request());
    await engine.wait(job.id);
    expect(engine.job(job.id).creators[0].reason).toBe("cursor_stall");
    expect(pending().pages).toBe(2);
    engine.resume(job.id);
    await engine.wait(job.id);
    expect(pending().pages).toBe(4);
    expect(countAllTweets(db)).toBe(1);
  });
  it("coalesces duplicate clicks and shared creator work, cancelling only the detached job", async () => {
    let release!: () => void;
    const list = provider.listUserTweets.bind(provider);
    provider.listUserTweets = async (input, signal) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return list(input, signal);
    };
    const a = engine.start(request({ listId: 1, maxPages: 1 }));
    const duplicate = engine.start(request({ listId: 1, maxPages: 1 }));
    expect(duplicate.id).toBe(a.id);
    const b = engine.start(request({ listId: 2, maxPages: 1 }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(db.prepare("SELECT * FROM x_retrieval_tasks").all()).toHaveLength(1);
    engine.cancel(a.id);
    release();
    await engine.wait(b.id);
    expect(engine.job(a.id).status).toBe("cancelled");
    expect(engine.job(b.id).status).toBe("partial");
    expect(calls).toHaveLength(1);
  });
  it("cancels an in-flight page without marking uncommitted data saved, then resumes manually", async () => {
    provider.listUserTweets = async (_input, signal) =>
      new Promise((_, reject) =>
        signal!.addEventListener("abort", () => reject(new XProviderError("cancelled")), {
          once: true,
        }),
      );
    const job = engine.start(request());
    await vi.waitFor(() => expect(pending().resolved).toBe(true));
    engine.cancel(job.id);
    await engine.wait(job.id);
    expect(countAllTweets(db)).toBe(0);
    expect(engine.job(job.id).status).toBe("cancelled");
    provider.listUserTweets = async () => ({
      items: [item(0)],
      nextCursor: null,
      exhausted: true,
      skipped: 0,
    });
    engine.resume(job.id);
    await engine.wait(job.id);
    expect(engine.job(job.id).status).toBe("complete");
  });
  it("records a rate limit and respects its delay across manual retries", async () => {
    provider.listUserTweets = vi.fn(async () => {
      throw new XProviderError("rate_limited", undefined, 900);
    });
    const job = engine.start(request());
    await engine.wait(job.id);
    expect(engine.job(job.id).creators[0].retryAt).not.toBeNull();
    expect(provider.listUserTweets).toHaveBeenCalledTimes(1);
    expect(() => engine.resume(job.id)).toThrow("wait");
    expect(checkpoint().initialized).toBe(false);
  });
  it("a failed creator does not discard another creator's committed results", async () => {
    const lookup = await provider.resolveUser("protected");
    const other = addCreator(db, {
      platform: "x",
      platformUserId: lookup.user.userId,
      youtubeChannelId: null,
      displayName: "Protected",
      handle: "protected",
      channelUrl: "https://x.com/protected",
      avatarUrl: null,
    }).creator.id;
    const list = provider.listUserTweets.bind(provider);
    provider.listUserTweets = async (input, signal) => {
      if (input.handle === "protected") throw new XProviderError("protected_account");
      return list(input, signal);
    };
    const job = engine.start(request({ creatorIds: [creatorId, other] }));
    await engine.wait(job.id);
    expect(engine.job(job.id).status).toBe("partial");
    expect(engine.job(job.id).creators.map((c) => c.status)).toEqual(["complete", "failed"]);
    expect(countAllTweets(db)).toBe(2001);
  });
  it("configuration changes start a new bounded traversal and preserve previous evidence", async () => {
    const job = engine.start(request({ maxPages: 1 }));
    await engine.wait(job.id);
    provider = {
      ...provider,
      id: "changed",
      resolveUser: provider.resolveUser.bind(provider),
      listUserTweets: provider.listUserTweets.bind(provider),
    };
    expect(() => engine.resume(job.id)).toThrow("configuration changed");
    calls = [];
    await engine.wait(engine.start(request({ maxPages: 1 })).id);
    expect(calls.map((c) => c.cursor)).toEqual([null]);
    expect(countAllTweets(db)).toBe(101);
    expect(db.prepare("SELECT * FROM x_retrieval_checkpoints").all()).toHaveLength(2);
  });
  it("rolls back normalized posts and checkpoints when a page cannot be committed", async () => {
    db.exec(
      "CREATE TRIGGER fail_tweet BEFORE INSERT ON tweets BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;",
    );
    const job = engine.start(request());
    await engine.wait(job.id);
    expect(countAllTweets(db)).toBe(0);
    expect(checkpoint().initialized).toBe(false);
    // Terminal failure must preserve the last committed cursor/progress, not the mutated page.
    expect(pending().cursor).toBeNull();
    expect(pending().pages).toBe(0);
  });
  it("retains stronger archived text and counts unique new rows separately from actual updates", async () => {
    mergeCreatorTimeline(db, creatorId, [item(0)]);
    provider.listUserTweets = async () => ({
      items: [
        item(0),
        item(0),
        { ...item(1), tweet: { ...item(1).tweet, text: "", contentStatus: "unavailable" } },
      ],
      nextCursor: null,
      exhausted: true,
      skipped: 0,
    });
    const job = engine.start(request());
    await engine.wait(job.id);
    expect(engine.job(job.id).creators[0].newPosts).toBe(1);
    expect(engine.job(job.id).creators[0].updatedPosts).toBe(0);
    expect(getTweetById(db, item(0).tweet.id)?.text).toBe(item(0).tweet.text);
    provider.listUserTweets = async () => ({
      items: [{ ...item(0), tweet: { ...item(0).tweet, text: "", contentStatus: "unavailable" } }],
      nextCursor: null,
      exhausted: true,
      skipped: 0,
    });
    await engine.wait(engine.start(request()).id);
    expect(getTweetById(db, item(0).tweet.id)?.text).toBe(item(0).tweet.text);
  });
  it("read-only recovery never constructs a provider or starts retrieval", async () => {
    const readProvider = vi.fn(() => {
      throw new Error("unexpected provider");
    });
    const reader = new RetrievalEngine(() => db, readProvider);
    expect(reader.jobs()).toEqual([]);
    expect(reader.coverage([creatorId])[0].initialized).toBe(false);
    expect(readProvider).not.toHaveBeenCalled();
  });
});

it("bounds transient retries within a user-started attempt", async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    provider.listUserTweets = vi.fn(async () => {
      attempts++;
      if (attempts <= 2) throw new XProviderError("network");
      return { items: [item(0)], nextCursor: null, exhausted: true, skipped: 0 };
    });
    const job = engine.start(request());
    await vi.advanceTimersByTimeAsync(3100);
    await engine.wait(job.id);
    expect(attempts).toBe(3);
    expect(engine.job(job.id).status).toBe("complete");
  } finally {
    vi.useRealTimers();
  }
});
it("pauses when the attempt time budget expires without advancing the cursor", async () => {
  engine = new RetrievalEngine(
    () => db,
    () => provider,
    undefined,
    25,
  );
  provider.listUserTweets = async (_input, signal) =>
    new Promise((_, reject) =>
      signal!.addEventListener("abort", () => reject(new XProviderError("timeout")), {
        once: true,
      }),
    );
  const job = engine.start(request());
  await engine.wait(job.id);
  expect(engine.job(job.id).creators[0].reason).toBe("time_budget");
  expect(pending().cursor).toBeNull();
  expect(countAllTweets(db)).toBe(0);
});
it("qualifies skipped provider entries and does not falsely complete initialization", async () => {
  provider.listUserTweets = async () => ({
    items: [item(0)],
    nextCursor: null,
    exhausted: true,
    skipped: 1,
  });
  const job = engine.start(request());
  await engine.wait(job.id);
  expect(engine.job(job.id).creators[0].reason).toBe("skipped");
  expect(engine.job(job.id).status).toBe("partial");
  expect(checkpoint().initialized).toBe(false);
});
it("preserves the archive when a session expires mid-import", async () => {
  const list = provider.listUserTweets.bind(provider);
  provider.listUserTweets = async (input, signal) => {
    if (input.cursor) throw new XProviderError("session_expired");
    return list(input, signal);
  };
  const job = engine.start(request());
  await engine.wait(job.id);
  expect(engine.job(job.id).status).toBe("failed");
  expect(countAllTweets(db)).toBe(101);
  expect(pending().cursor).toBe("100");
  expect(checkpoint().lastSuccessfulRefresh).toBeNull();
});
it("keeps a full body when a weaker duplicate appears within the same new page", async () => {
  provider.listUserTweets = async () => ({
    items: [
      item(0),
      { ...item(0), tweet: { ...item(0).tweet, text: "", contentStatus: "unavailable" } },
    ],
    nextCursor: null,
    exhausted: true,
    skipped: 0,
  });
  const job = engine.start(request());
  await engine.wait(job.id);
  expect(engine.job(job.id).creators[0].newPosts).toBe(1);
  expect(getTweetById(db, item(0).tweet.id)?.text).toBe(item(0).tweet.text);
});
it("serializes X calls even when the service is loaded through separate route bundles", async () => {
  const first = await import("@/lib/x/service");
  vi.resetModules();
  const second = await import("@/lib/x/service");
  const order: string[] = [];
  let release!: () => void;
  const a = first.runXExclusive(async () => {
    order.push("a-start");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push("a-end");
  });
  await Promise.resolve();
  const b = second.runXExclusive(async () => {
    order.push("b-start");
  });
  await Promise.resolve();
  expect(order).toEqual(["a-start"]);
  release();
  await Promise.all([a, b]);
  expect(order).toEqual(["a-start", "a-end", "b-start"]);
});
it("keeps old unfinished retrievals discoverable after more than 50 subsequent jobs", async () => {
  const job = engine.start(request({ maxPages: 1 }));
  await engine.wait(job.id);
  const insert = db.prepare(
    "INSERT INTO x_retrieval_jobs(id,scope_key,request_json,created_at,finished_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (let n = 0; n < 55; n++)
    insert.run(
      `later-${n}`,
      `later-${n}`,
      JSON.stringify(request()),
      "2099-01-01T00:00:00Z",
      "2099-01-01T00:00:00Z",
    );
  expect(engine.jobs().find((j) => j.id === job.id)?.status).toBe("partial");
});
it("keeps text retrieval time separate from weak observations and unavailable detail reads", async () => {
  mergeCreatorTimeline(db, creatorId, [item(0)]);
  db.prepare("UPDATE tweets SET text_fetched_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(
    item(0).tweet.id,
  );
  mergeCreatorTimeline(db, creatorId, [
    { ...item(0), tweet: { ...item(0).tweet, text: "", contentStatus: "unavailable" } },
  ]);
  const cached = getTweetForCreator(db, creatorId, item(0).tweet.id)!;
  expect(cached.textFetchedAt).toBe("2026-01-01T00:00:00.000Z");
  expect(cached.availability).toBe("unknown");
  expect(cached.availabilityCheckedAt).not.toBeNull();
  expect(cached.tweet.text).toBe(item(0).tweet.text);
  recordTweetNotRetrievable(db, item(0).tweet.id);
  expect(getTweetForCreator(db, creatorId, item(0).tweet.id)?.availability).toBe("not_retrievable");
  expect(getTweetForCreator(db, creatorId, item(0).tweet.id)?.textFetchedAt).toBe(
    cached.textFetchedAt,
  );
  db.close();
  open();
  expect(getTweetForCreator(db, creatorId, item(0).tweet.id)?.tweet.text).toBe(item(0).tweet.text);
});
it("does not lose a Resume click while the cancelled provider operation is still settling", async () => {
  let release!: () => void;
  provider.listUserTweets = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { items: [item(0)], nextCursor: null, exhausted: true, skipped: 0 };
  };
  const job = engine.start(request());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  engine.cancel(job.id);
  expect(() => engine.resume(job.id)).toThrow("Cancellation is finishing");
  expect(() => engine.start(request())).toThrow("Cancellation is finishing");
  release();
  await engine.wait(job.id);
  expect(countAllTweets(db)).toBe(0);
  provider.listUserTweets = async () => ({
    items: [item(0)],
    nextCursor: null,
    exhausted: true,
    skipped: 0,
  });
  engine.resume(job.id);
  await engine.wait(job.id);
  expect(engine.job(job.id).status).toBe("complete");
});
