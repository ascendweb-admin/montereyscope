import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { addCreator } from "@/lib/creators/repository";
import { countAllTweets, mergeCreatorTimeline } from "@/lib/x/repository";
import { buildFakeTimeline, createFakeXProvider } from "@/lib/x/providers/fake";
import { XProviderError, type XProvider, type XTimelineItem } from "@/lib/x/model";
import { RetrievalEngine, type RetrievalEngineOptions } from "@/lib/x/research/retrieval";
import type { RetrievalRequest } from "@/lib/x/research/retrieval-model";
import { X_PRIORITY } from "@/lib/x/scheduler";
import type { XExclusiveOptions } from "@/lib/x/service";

vi.mock("@/lib/x/service", async (original) => ({
  ...(await original<typeof import("@/lib/x/service")>()),
  getXConnectionStatus: vi.fn(async () => ({ capability: "connected" })),
}));
const { getXConnectionStatus } = await import("@/lib/x/service");
const {
  checkEveryMs,
  dueCreators,
  ensureHistory,
  feedCoverage,
  historyHorizon,
  runXSyncPass,
  scopeRevision,
} = await import("@/lib/x/dashboard/sync");
const { resetXFocus, setXFocus } = await import("@/lib/x/focus");

/** The fixture's "now": every post below is older, a negative `n` is newer than this. */
const BASE = Date.UTC(2026, 9, 2);
const at = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString();
/** Post `n` was published n+1 minutes before BASE. */
const t = (n: number) => at(-(n + 1));
function item(n: number): XTimelineItem {
  const base = buildFakeTimeline("fixture", 1)[0];
  return {
    ...base,
    tweet: { ...base.tweet, id: String(9000000 + n), text: `Post ${n}`, publishedAt: t(n) },
    timelineAt: t(n),
  };
}
const span = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => item(from + i));

let dir: string, db: Database.Database, provider: XProvider, engine: RetrievalEngine;
let source: XTimelineItem[];
let calls: Array<{ cursor: string | null; priority: number | null; background: boolean }>;
let resolves: number;
let creatorId: number;

const request = (extra: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  kind: "refresh",
  listId: null,
  label: "Fixture",
  creatorIds: [creatorId],
  since: t(500),
  until: at(0),
  initialDays: 7,
  maxPages: null,
  ...extra,
});
function make(options: RetrievalEngineOptions = {}) {
  return new RetrievalEngine(
    () => db,
    () => provider,
    async (operation, opts?: XExclusiveOptions) => {
      const priority =
        typeof opts?.priority === "function" ? opts.priority() : (opts?.priority ?? null);
      pendingPriority = { priority, background: opts?.background ?? false };
      return operation();
    },
    180_000,
    6_000,
    options,
  );
}
let pendingPriority: { priority: number | null; background: boolean } = {
  priority: null,
  background: false,
};
function checkpoint(lane = "head") {
  const row = db
    .prepare("SELECT state_json FROM x_retrieval_checkpoints WHERE creator_id = ? AND lane = ?")
    .get(creatorId, lane) as { state_json: string } | undefined;
  return row ? JSON.parse(row.state_json) : null;
}
function tasks() {
  return (
    db.prepare("SELECT state_json FROM x_retrieval_tasks ORDER BY rowid").all() as Array<{
      state_json: string;
    }>
  ).map((row) => JSON.parse(row.state_json));
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "scope-sync-engine-"));
  db = new Database(path.join(dir, "db.sqlite"));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
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
  source = span(0, 2000);
  calls = [];
  resolves = 0;
  provider.listUserTweets = vi.fn(async (input) => {
    calls.push({ cursor: input.cursor ?? null, ...pendingPriority });
    const offset = Number(input.cursor ?? 0);
    const items = source.slice(offset, offset + 100);
    const next = offset + items.length;
    return {
      items,
      nextCursor: next >= source.length ? null : String(next),
      exhausted: false,
      skipped: 0,
    };
  });
  const resolve = provider.resolveUser.bind(provider);
  provider.resolveUser = async (handle, signal) => {
    resolves++;
    return resolve(handle, signal);
  };
  resetXFocus();
});
afterEach(async () => {
  await engine?.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("checks for new posts", () => {
  it("reads a catch-up's newest pages first and fills the rest of the gap in the background", async () => {
    engine = make({ catchupPages: 1 });
    await engine.wait(engine.start(request()).id);
    expect(checkpoint()).toMatchObject({
      initialized: true,
      coveredSince: t(500),
      coverageCursor: "800",
    });
    const historyBefore = checkpoint("history");
    // The first import finished at the fixture's "now".
    db.prepare(
      "UPDATE x_retrieval_checkpoints SET state_json = json_set(state_json, '$.lastSuccessfulRefresh', ?) WHERE lane = 'head'",
    ).run(at(0));

    // 250 posts arrived since the first import: three pages back to the last sync.
    source = [...span(-250, 0), ...source];
    calls = [];
    const refresh = engine.start(request({ until: at(300) }));
    expect((await engine.wait(refresh.id)).creators[0]).toMatchObject({
      status: "complete",
      reason: "overlap",
    });
    // The first import stopped two pages past its window: 800 posts, plus the 250 new ones.
    expect(countAllTweets(db)).toBe(1050);
    expect(calls.map((c) => c.cursor)).toEqual([null, "100", "200"]);
    // Only the newest page counts as new posts; the rest yields to everything else.
    expect(calls.map((c) => c.priority)).toEqual([
      X_PRIORITY.head,
      X_PRIORITY.backfill,
      X_PRIORITY.backfill,
    ]);
    expect(checkpoint()).toMatchObject({ lastSuccessfulRefresh: at(300), boundaryAt: at(300) });
    // A gap fill never claims the history lane, and never moves how far back history reaches.
    expect(checkpoint("history")).toEqual(historyBefore);
    expect(checkpoint()).toMatchObject({ coveredSince: t(500) });
    expect(tasks().at(-1)).toMatchObject({
      mode: "history",
      gap: true,
      promoted: true,
      status: "complete",
    });

    // The next check meets the newest posts it remembered on its first page.
    calls = [];
    expect((await engine.wait(engine.start(request({ until: at(400) })).id)).status).toBe(
      "complete",
    );
    expect(calls.map((c) => c.cursor)).toEqual([null]);
  });

  it("retires a catch-up left from an earlier run, so new posts come first", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    source = [...span(-500, 0), ...source];
    // The app closed two pages into this catch-up.
    const stopped = engine.start(request({ until: at(600), maxPages: 2 }));
    expect((await engine.wait(stopped.id)).creators[0]).toMatchObject({
      status: "partial",
      reason: "page_budget",
    });
    expect(checkpoint().boundaryAt).toBe(at(0));

    engine = make();
    source = [...span(-550, -500), ...source];
    calls = [];
    const fresh = engine.start(request({ until: at(700) }));
    await engine.wait(fresh.id);
    // The new check read only the newest page: it met what the old one had already read.
    expect(calls.map((c) => c.cursor)).toEqual([null]);
    expect(engine.job(fresh.id).creators[0]).toMatchObject({ mode: "catchup", reason: "overlap" });
    expect(checkpoint()).toMatchObject({ boundaryAt: at(700) });
    const leftover = tasks().find((task) => task.gap);
    expect(leftover).toMatchObject({ mode: "history", status: "partial" });

    // The old pages continue in the background from where they stopped, down to the first import.
    engine = make({ autoContinue: true });
    calls = [];
    expect(engine.resumeBackfills([creatorId])).toBe(1);
    await engine.wait(stopped.id);
    expect(calls[0].cursor).toBe("200");
    expect(tasks().find((task) => task.gap)).toMatchObject({
      status: "complete",
      reason: "overlap",
    });
    expect(countAllTweets(db)).toBe(1350);
  });

  it("replaces a leftover catch-up that never read a page", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    let fail = true;
    const list = provider.listUserTweets;
    provider.listUserTweets = vi.fn(async (input, signal) => {
      if (fail) throw new XProviderError("network");
      return list(input, signal);
    });
    const failed = engine.start(request({ until: at(100) }));
    expect((await engine.wait(failed.id)).creators[0]).toMatchObject({
      status: "failed",
      pages: 0,
    });
    fail = false;
    const next = engine.start(request({ until: at(200) }));
    await engine.wait(next.id);
    expect(engine.job(failed.id).creators[0]).toMatchObject({
      status: "cancelled",
      reason: "superseded",
    });
    // Its window is read by the new check, which still reaches back to the last sync.
    expect(tasks().at(-1)).toMatchObject({ since: at(0), status: "complete" });
  });

  it("looks a profile up once a day instead of on every check", async () => {
    engine = make({ resolveTtlMs: 3600_000 });
    await engine.wait(engine.start(request()).id);
    await engine.wait(engine.start(request({ until: at(10) })).id);
    await engine.wait(engine.start(request({ until: at(20) })).id);
    expect(resolves).toBe(1);
    engine = make();
    await engine.wait(engine.start(request({ until: at(30) })).id);
    expect(resolves).toBe(2);
  });

  it("reports each creator's latest check and a failure without consulting jobs", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    provider.listUserTweets = vi.fn(async () => {
      throw new XProviderError("protected_account");
    });
    await engine.wait(engine.start(request({ until: at(10) })).id);
    const [state] = engine.creatorStates([creatorId]);
    expect(state).toMatchObject({
      initialized: true,
      lastSuccessfulRefresh: expect.any(String),
      coveredSince: t(500),
      head: {
        mode: "catchup",
        status: "failed",
        errorCode: "protected_account",
        updatedAt: expect.any(String),
      },
      history: null,
    });
  });
});

describe("history for the timeframe on screen", () => {
  it("extends history from where the archive reaches, without reading the newest pages again", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    calls = [];
    const job = engine.start(request({ kind: "backfill", since: t(1200) }));
    await engine.wait(job.id);
    expect(calls[0].cursor).toBe("800");
    expect(calls.every((c) => c.background)).toBe(true);
    expect(checkpoint()).toMatchObject({ coveredSince: t(1200), coverageCursor: "1500" });
    expect(engine.creatorStates([creatorId])[0].coveredSince).toBe(t(1200));
    expect(() => engine.start(request({ kind: "backfill", since: t(1100) }))).toThrow(
      "already reaches",
    );
    // The end of the timeline means everything is saved.
    await engine.wait(
      engine.start(request({ kind: "backfill", since: "2020-01-01T00:00:00.000Z" })).id,
    );
    expect(checkpoint().coveredSince).toBe("2006-01-01T00:00:00.000Z");
    expect(countAllTweets(db)).toBe(2000);
  });

  it("estimates coverage for archives synced before Scope tracked it", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    const head = checkpoint();
    delete head.coveredSince;
    delete head.coverageCursor;
    db.prepare(
      "UPDATE x_retrieval_checkpoints SET state_json = ? WHERE creator_id = ? AND lane = 'head'",
    ).run(JSON.stringify(head), creatorId);
    // The oldest post read from the timeline, not one imported from a single status link.
    mergeCreatorTimeline(db, creatorId, []);
    expect(engine.coverage([creatorId])[0].coveredSince).toBe(t(799));
  });

  it("fills the timeframe on screen once, then reports it covered", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    expect(feedCoverage([creatorId], 1, engine, BASE)).toMatchObject({
      covered: 0,
      total: 1,
      importing: 0,
    });
    const job = ensureHistory([creatorId], 1, engine, BASE)!;
    expect(job.request).toMatchObject({ kind: "backfill", since: historyHorizon(1, BASE) });
    await engine.wait(job.id);
    expect(feedCoverage([creatorId], 1, engine, BASE)).toMatchObject({
      since: "2026-10-01T00:00:00.000Z",
      covered: 1,
      total: 1,
      reach: "2026-10-01T00:00:00.000Z",
    });
    expect(ensureHistory([creatorId], 1, engine, BASE)).toBeNull();
  });
});

describe("bookkeeping", () => {
  it("retires stale catch-ups on recovery instead of resuming them ahead of new posts", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    source = [...span(-500, 0), ...source];
    const old = engine.start(request({ until: at(600), maxPages: 2 }));
    await engine.wait(old.id);
    // Interrupted mid-run: a restart finds it "running" under another owner.
    const task = tasks().at(-1);
    db.prepare("UPDATE x_retrieval_tasks SET state_json = ? WHERE id = ?").run(
      JSON.stringify({ ...task, status: "running", owner: "previous-run" }),
      task.id,
    );
    db.prepare("UPDATE x_retrieval_jobs SET created_at = ?").run(new Date().toISOString());
    engine = make({ autoContinue: true });
    calls = [];
    expect(engine.recover()).toContain(old.id);
    await engine.wait(old.id);
    expect(tasks().at(-1)).toMatchObject({ gap: true, status: "complete", reason: "overlap" });
    expect(calls.every((c) => c.priority === X_PRIORITY.backfill)).toBe(true);
    expect(checkpoint().boundaryAt).toBe(at(600));
  });

  it("forgets old finished jobs but keeps unfinished work and every post", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    const unfinished = engine.start(request({ until: at(10), maxPages: 1 }));
    source = [...span(-300, 0), ...source];
    await engine.wait(unfinished.id);
    db.prepare("UPDATE x_retrieval_jobs SET created_at = ?").run("2026-01-01T00:00:00.000Z");
    engine.prune();
    const left = db.prepare("SELECT id FROM x_retrieval_jobs").all() as Array<{ id: string }>;
    expect(left.map((j) => j.id)).toEqual([unfinished.id]);
    expect(tasks()).toHaveLength(1);
    expect(countAllTweets(db)).toBe(900);
    expect(checkpoint().initialized).toBe(true);
  });
});

describe("scheduling", () => {
  const state = (id: number, extra: Record<string, unknown> = {}) =>
    ({
      creatorId: id,
      initialized: true,
      lastSuccessfulRefresh: null,
      coveredSince: null,
      head: null,
      history: null,
      ...extra,
    }) as never;
  const head = (extra: Record<string, unknown>) => ({
    status: "complete",
    errorCode: null,
    retryAt: null,
    updatedAt: null,
    ...extra,
  });

  it("checks the accounts on screen as often as their share of X's quota allows", () => {
    expect(checkEveryMs(2, 30)).toBe(3 * 60_000);
    expect(checkEveryMs(14, 30)).toBe(10.5 * 60_000);
    expect(checkEveryMs(100, 30)).toBe(30 * 60_000);
    expect(checkEveryMs(14, 0)).toBe(0);
  });

  it("finds who is due, leaving running work alone and backing off failures", () => {
    const now = BASE;
    const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const states = [
      state(1),
      state(2, { lastSuccessfulRefresh: ago(5) }),
      state(3, { lastSuccessfulRefresh: ago(40) }),
      state(4, { lastSuccessfulRefresh: ago(40), head: head({ status: "running" }) }),
      state(5, {
        lastSuccessfulRefresh: ago(40),
        head: head({ status: "failed", errorCode: "network", updatedAt: ago(10) }),
      }),
      state(6, {
        lastSuccessfulRefresh: ago(140),
        head: head({ status: "failed", errorCode: "not_found", updatedAt: ago(40) }),
      }),
      state(7, {
        lastSuccessfulRefresh: ago(40),
        head: head({ status: "failed", errorCode: "rate_limited", retryAt: ago(-5) }),
      }),
      state(8, {
        lastSuccessfulRefresh: ago(40),
        head: head({ status: "failed", errorCode: "network", updatedAt: ago(31) }),
      }),
    ];
    expect(dueCreators(states, () => 30 * 60_000, now)).toEqual([1, 3, 8]);
    // On screen: a three-minute interval makes the five-minute-old sync due.
    expect(dueCreators(states, (id) => (id === 2 ? 3 * 60_000 : 30 * 60_000), now)).toEqual([
      1, 2, 3, 8,
    ]);
    expect(dueCreators(states, () => 0, now)).toEqual([]);
  });

  it("runs a pass that checks due accounts and fills the timeframe on screen", async () => {
    engine = make();
    await engine.wait(engine.start(request()).id);
    const start = vi.spyOn(engine, "start");
    const now = Date.now();
    // Synced just now and nothing on screen: nothing to do, and X is never asked.
    vi.mocked(getXConnectionStatus).mockClear();
    let result = await runXSyncPass(db as never, engine, now);
    expect(result).toEqual({ due: [], backfill: [] });
    expect(getXConnectionStatus).not.toHaveBeenCalled();
    // On screen with a 30-day timeframe: due after three minutes, and history stops short.
    setXFocus([creatorId], 30, now + 4 * 60_000);
    result = await runXSyncPass(db as never, engine, now + 4 * 60_000);
    expect(result).toEqual({ due: [creatorId], backfill: [creatorId] });
    expect(start.mock.calls.map(([r]) => r.kind)).toEqual(["refresh", "backfill"]);
    await Promise.all(start.mock.results.map((r) => engine.wait((r.value as { id: string }).id)));
    // Disconnected: nothing automatic reaches X.
    vi.mocked(getXConnectionStatus).mockResolvedValueOnce({ capability: "disconnected" } as never);
    start.mockClear();
    result = await runXSyncPass(db as never, engine, now + 60 * 60_000);
    expect(result).toEqual({ due: [], backfill: [] });
    expect(start).not.toHaveBeenCalled();
  });

  it("changes the scope revision whenever a post is saved", async () => {
    const before = scopeRevision(db as never, [creatorId]);
    mergeCreatorTimeline(db, creatorId, [item(1)]);
    const after = scopeRevision(db as never, [creatorId]);
    expect(after).not.toBe(before);
    mergeCreatorTimeline(db, creatorId, [item(1)]);
    expect(scopeRevision(db as never, [creatorId])).toBe(after);
  });
});
