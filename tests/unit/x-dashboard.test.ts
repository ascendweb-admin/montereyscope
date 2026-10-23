import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addCreator } from "@/lib/creators/repository";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { mergeCreatorTimeline } from "@/lib/x/repository";
import { mapXTimelineItem } from "@/lib/x/mapper";
import { saveResearchList } from "@/lib/x/research/repository";
import type { AiRunner } from "@/lib/ai/backend";
import type { CodexRunOptions } from "@/lib/ai/codex";
import type { ChatModeId } from "@/lib/ai/chat-modes";
import { CodexError } from "@/lib/ai/codex";
import { markSeen, parseSearchBox, readDashboardFeed, unreadCounts } from "@/lib/x/dashboard/feed";
import { InsightEngine, renderPost } from "@/lib/x/dashboard/insights";
import { insightHtml, saveInsightReport } from "@/lib/x/dashboard/report";
import { publicReportFor } from "@/lib/ai/reports";
import { parseInline, parseMarkdown } from "@/lib/x/dashboard/markdown";
import { periodBounds, showTypes } from "@/lib/x/dashboard/model";
import { syncSnapshot } from "@/lib/x/dashboard/sync";
import type { RetrievalEngine } from "@/lib/x/research/retrieval";
import type { RetrievalCreatorState } from "@/lib/x/research/retrieval-model";
import { getXSyncSettings, setXSyncSettings } from "@/lib/settings/settings";

const dir = mkdtempSync(path.join(tmpdir(), "scope-x-dashboard-"));
let db: Database.Database;
vi.mock("@/lib/db/connection", () => ({ getDb: () => db }));
vi.mock("@/lib/x/providers", () => ({
  getXProvider: () => {
    throw new Error("Unexpected X read");
  },
}));

const NOW = Date.now();
const ago = (hours: number) => new Date(NOW - hours * 3600_000).toISOString();

function creator(handle: string) {
  return addCreator(db, {
    platform: "x",
    platformUserId: `${handle}-id`,
    youtubeChannelId: null,
    displayName: handle.toUpperCase(),
    handle,
    channelUrl: `https://x.com/${handle}`,
    avatarUrl: null,
  }).creator.id;
}
function post(
  creatorId: number,
  id: string,
  text: string,
  publishedAt: string,
  extra: Record<string, unknown> = {},
  kind: "post" | "reply" | "repost" = "post",
) {
  const item = mapXTimelineItem({
    tweet: {
      id,
      author: {
        userId: `${creatorId}`,
        handle: `author${creatorId}`,
        displayName: `Author ${creatorId}`,
      },
      text,
      publishedAt,
      contentStatus: "complete",
      ...extra,
    },
    timelineKind: kind,
    timelineAt: publishedAt,
  })!;
  mergeCreatorTimeline(db, creatorId, [item]);
}

let alice: number, bob: number;
beforeEach(() => {
  db?.close();
  db = new Database(path.join(dir, `${Math.random()}.db`));
  db.pragma("foreign_keys = ON");
  runMigrations(db, ALL_MIGRATIONS);
  alice = creator("alice");
  bob = creator("bob");
  post(alice, "1001", "ETH looks strong into the merge anniversary", ago(2));
  post(alice, "1002", "Rotating from SOL into ETH", ago(30));
  post(bob, "2001", "BTC dominance is rising, careful with alts", ago(5));
  post(
    bob,
    "2002",
    "Replying about ETH fees",
    ago(1),
    { inReplyToTweetId: "999", inReplyToHandle: "carol" },
    "reply",
  );
  post(bob, "2003", "Old thought on ETH", ago(24 * 40));
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("dashboard feed", () => {
  it("reads rolling windows and post filters from the local archive", () => {
    const week = readDashboardFeed(db, { creatorIds: [alice, bob], period: "7d", show: "posts" });
    expect(week.posts.map((p) => p.tweet.id)).toEqual(["1001", "2001", "1002"]);
    expect(week.hasMore).toBe(false);
    const withReplies = readDashboardFeed(db, {
      creatorIds: [alice, bob],
      period: "7d",
      show: "replies",
    });
    expect(withReplies.posts[0].tweet.id).toBe("2002");
    const all = readDashboardFeed(db, { creatorIds: [bob], period: "all", show: "posts" });
    expect(all.posts.map((p) => p.tweet.id)).toEqual(["2001", "2003"]);
    expect(readDashboardFeed(db, { creatorIds: [], period: "7d", show: "posts" }).total).toBe(0);
  });

  it("searches with plain words, quoted phrases and exclusions", () => {
    const eth = readDashboardFeed(db, {
      creatorIds: [alice, bob],
      period: "all",
      show: "posts",
      query: "eth",
    });
    expect(eth.posts.map((p) => p.tweet.id)).toEqual(["1001", "1002", "2003"]);
    expect(eth.scopeTotal).toBe(4);
    expect(
      readDashboardFeed(db, {
        creatorIds: [alice, bob],
        period: "all",
        show: "posts",
        query: 'eth -"sol"',
      }).posts.map((p) => p.tweet.id),
    ).toEqual(["1001", "2003"]);
    expect(parseSearchBox('"merge anniversary" $ETH')).toMatchObject({
      terms: ["merge anniversary", "$ETH"],
    });
    expect(parseSearchBox("  ")).toBeNull();
    expect(() => parseSearchBox("-eth")).toThrow("at least one word");
  });

  it("counts unread posts per scope only after a scope was first seen", () => {
    const list = saveResearchList(db, { name: "Bob", creatorIds: [bob] });
    expect(unreadCounts(db, [list], [alice, bob])).toEqual({ all: 0, [`list:${list.id}`]: 0 });
    markSeen(db, null, new Date(NOW - 3 * 3600_000));
    markSeen(db, list.id, new Date(NOW - 6 * 3600_000));
    expect(unreadCounts(db, [list], [alice, bob])).toEqual({ all: 2, [`list:${list.id}`]: 2 });
    // Seen markers never move backwards.
    markSeen(db, null, new Date(NOW - 48 * 3600_000));
    expect(unreadCounts(db, [list], [alice, bob]).all).toBe(2);
  });

  it("maps filters and windows", () => {
    expect(showTypes("posts")).toEqual(["original", "quote"]);
    expect(showTypes("everything")).toContain("repost");
    const { since, until } = periodBounds("24h", NOW);
    expect(Date.parse(until) - Date.parse(since)).toBe(86_400_000 + 60_000);
  });
});

describe("X sync settings", () => {
  it("defaults, validates and persists", () => {
    expect(getXSyncSettings(db)).toEqual({ autoSyncMinutes: 30, initialHistoryDays: 7 });
    expect(setXSyncSettings(db, { autoSyncMinutes: 0 })).toEqual({
      autoSyncMinutes: 0,
      initialHistoryDays: 7,
    });
    expect(() => setXSyncSettings(db, { autoSyncMinutes: 7 })).toThrow("interval");
    expect(getXSyncSettings(db).autoSyncMinutes).toBe(0);
  });
});

describe("sync snapshot", () => {
  type Progress = RetrievalCreatorState["head"] & {};
  const progress = (creatorId: number, extra: Partial<Progress> = {}): Progress => ({
    creatorId,
    name: "c",
    mode: "catchup",
    status: "complete",
    pages: 1,
    newPosts: 3,
    updatedPosts: 0,
    oldest: null,
    newest: null,
    reason: null,
    error: null,
    errorCode: null,
    retryAt: null,
    updatedAt: ago(0),
    ...extra,
  });
  const state = (
    creatorId: number,
    {
      head,
      history,
      synced = null,
    }: { head?: Partial<Progress>; history?: Partial<Progress>; synced?: string | null } = {},
  ): RetrievalCreatorState => ({
    creatorId,
    initialized: synced !== null,
    lastSuccessfulRefresh: synced,
    coveredSince: null,
    head: head ? progress(creatorId, head) : null,
    history: history
      ? {
          ...progress(creatorId, { mode: "history", status: "running", ...history }),
          since: ago(1),
          reach: null,
          extend: false,
        }
      : null,
  });
  const engine = (states: RetrievalCreatorState[]) =>
    ({
      creatorStates: (ids: number[]) =>
        ids.map((id) => states.find((s) => s.creatorId === id) ?? state(id)),
    }) as unknown as RetrievalEngine;

  it("reports syncing, waiting and finished states in plain terms", () => {
    const running = syncSnapshot(
      [alice, bob],
      engine([
        state(alice, { head: { mode: "initial", status: "running" } }),
        state(bob, { head: {}, synced: ago(0) }),
      ]),
    );
    expect(running).toMatchObject({ state: "syncing", pending: 1, total: 2, backfilling: 0 });
    expect(running.creators[0]).toMatchObject({ state: "syncing", firstSync: true });
    const retryAt = new Date(NOW + 600_000).toISOString();
    const waiting = syncSnapshot(
      [alice],
      engine([state(alice, { head: { status: "running", reason: "waiting", retryAt } })]),
    );
    expect(waiting).toMatchObject({ state: "waiting", retryAt });
    expect(waiting.message).toContain("continues automatically");
    const done = syncSnapshot(
      [alice, bob],
      engine([
        state(alice, { head: {}, synced: ago(1) }),
        state(bob, { head: {}, synced: ago(2) }),
      ]),
    );
    expect(done).toMatchObject({ state: "idle", lastSyncedAt: ago(2), newPosts: 6 });
  });

  it("explains disconnected accounts and failures without jargon", () => {
    const disconnected = syncSnapshot(
      [alice],
      engine([state(alice, { head: { status: "failed", errorCode: "session_expired" } })]),
    );
    expect(disconnected).toMatchObject({ state: "disconnected" });
    expect(disconnected.message).toMatch(/Reconnect in Settings/);
    const failed = syncSnapshot(
      [alice, bob],
      engine([
        state(alice, { head: { status: "failed", errorCode: "network" } }),
        state(bob, { head: { status: "failed", errorCode: "protected_account" } }),
      ]),
    );
    expect(failed.state).toBe("error");
    expect(failed.creators.map((c) => c.errorCode)).toEqual(["network", "protected_account"]);
    expect(failed.message).toMatch(/^2 accounts couldn't be synced/);
    expect(syncSnapshot([alice], engine([])).state).toBe("never");
  });

  it("pauses instead of failing when X keeps rate limiting", () => {
    const retryAt = new Date(NOW + 600_000).toISOString();
    const paused = syncSnapshot(
      [alice, bob],
      engine([
        state(alice, {
          head: { status: "failed", errorCode: "rate_limited", retryAt },
          synced: ago(1),
        }),
        state(bob, { head: {}, synced: ago(0) }),
      ]),
    );
    expect(paused).toMatchObject({ state: "paused", pending: 0, retryAt });
    expect(paused.creators[0]).toMatchObject({ state: "paused", errorCode: "rate_limited" });
    expect(paused.message).toMatch(/tries again on the next update/);
  });

  it("counts a background import of older posts as synced, not pending", () => {
    const synced = syncSnapshot([alice], engine([state(alice, { history: {}, synced: ago(0) })]));
    expect(synced).toMatchObject({ state: "idle", pending: 0, backfilling: 1 });
    expect(synced.creators[0].olderPosts).toEqual({ since: ago(1), waiting: false });
    // A newer catch-up speaks for recent posts while the older import keeps going.
    const both = syncSnapshot(
      [alice],
      engine([state(alice, { head: { status: "running" }, history: {}, synced: ago(0) })]),
    );
    expect(both).toMatchObject({ state: "syncing", pending: 1, backfilling: 1 });
  });
});

describe("markdown", () => {
  it("parses tables, nested lists and grouped citations", () => {
    const blocks = parseMarkdown(
      "## Tickers\n\n| Asset | Stance |\n|---|:--:|\n| ETH | bullish [post:1001] |\n\n- one\n  - nested\n- two [post:1][post:2]\n\n> quoted\n",
    );
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "table", "list", "quote"]);
    expect(blocks[1]).toMatchObject({
      align: ["left", "center"],
      rows: [["ETH", "bullish [post:1001]"]],
    });
    expect(blocks[2]).toMatchObject({
      items: [
        { text: "one", children: { items: [{ text: "nested" }] } },
        { text: "two [post:1][post:2]" },
      ],
    });
    expect(parseInline("**ETH** up [post:1], [post:2] see [x](https://x.com/a)")).toEqual([
      { kind: "strong", children: [{ kind: "text", text: "ETH" }] },
      { kind: "text", text: " up " },
      { kind: "cite", ids: ["1", "2"] },
      { kind: "text", text: " see " },
      { kind: "link", href: "https://x.com/a", children: [{ kind: "text", text: "x" }] },
    ]);
  });
});

describe("insights", () => {
  function runner(
    answer: (options: CodexRunOptions) => string,
    seen: CodexRunOptions[] = [],
  ): () => Promise<AiRunner> {
    return async () => (options) => {
      seen.push(options);
      const text = answer(options);
      return {
        events: (async function* () {
          yield { type: "text_delta" as const, text: text.slice(0, 5) };
          yield { type: "message_completed" as const, text };
        })(),
        completed: Promise.resolve({ sessionId: "session-1", finalMessage: text, usage: null }),
      };
    };
  }
  const resolve = async (_db: unknown, mode: ChatModeId) => ({
    backend: "claude" as const,
    model: `${mode}-model`,
    reasoningEffort: mode === "deep" ? "high" : null,
    mode,
  });
  const scope = () => ({
    label: "Everyone",
    listId: null,
    creatorIds: [alice, bob],
    period: "7d",
    show: "posts",
  });

  it("analyzes the scope with citations, keeps the conversation and resumes the session", async () => {
    const seen: CodexRunOptions[] = [];
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "## TL;DR\n- ETH is strong [post:1001]", seen),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({ scope: scope(), preset: "brief" });
    expect(created).toMatchObject({
      status: "running",
      postCount: 3,
      title: "Brief me · Everyone",
    });
    await engine.settle(created.id);
    const done = engine.detail(created.id);
    expect(done.status).toBe("complete");
    expect(done.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(done.sources["1001"]).toMatchObject({ authorHandle: "author" + alice });
    expect(seen[0].prompt).toContain("[post:1001] @author");
    expect(seen[0].prompt).toContain("Task: Write a brief");
    expect(seen[0].prompt).not.toContain("2003"); // Outside the 7-day window.

    await engine.followUp(created.id, "And BTC?");
    await engine.settle(created.id);
    expect(seen[1]).toMatchObject({ resumeSessionId: "session-1" });
    expect(seen[1].prompt).toBe("Follow-up question about the same posts: And BTC?");
    expect(engine.detail(created.id).messages).toHaveLength(4);
    expect(engine.list()[0].id).toBe(created.id);
  });

  it("freezes cited text and follow-up material independently of the post cache", async () => {
    const seen: CodexRunOptions[] = [];
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Evidence [post:1001]", seen),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({ scope: scope(), preset: "brief" });
    await engine.settle(created.id);
    const original = engine.detail(created.id).sources["1001"];
    db.prepare("UPDATE tweets SET text = 'Later edited text' WHERE id = '1001'").run();
    expect(engine.detail(created.id).sources["1001"]).toEqual(original);
    db.prepare("DELETE FROM creator_tweets").run();
    db.prepare("DELETE FROM tweets").run();
    expect(engine.detail(created.id).sources["1001"]).toEqual(original);
    // A lost provider session requires rebuilding the prompt from frozen inputs.
    db.prepare("UPDATE x_insights SET session_id = NULL WHERE id = ?").run(created.id);
    await engine.followUp(created.id, "What did the original post say?");
    await engine.settle(created.id);
    expect(seen[1].prompt).toContain("ETH looks strong into the merge anniversary");
    expect(seen[1].prompt).not.toContain("Later edited text");
    expect(seen[1].prompt).toContain("3 posts from 2 accounts");
    expect(engine.detail(created.id).sources["1001"]).toEqual(original);
    const saved = publicReportFor(db, saveInsightReport(db, engine, created.id));
    expect(saved.sourceCount).toBe(3);
    expect(saved.sources).toHaveLength(3);
    expect(saved.sources.find((source) => source.id === "1001")?.title).toBe(original.text);
  });

  it("snapshots available legacy analysis evidence during the additive upgrade", async () => {
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Evidence [post:1001] [post:2002]"),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({
      scope: { ...scope(), show: "everything" },
      preset: "brief",
    });
    await engine.settle(created.id);
    const original = engine.detail(created.id).sources;
    // Model the released schema, which froze IDs but not their source bodies.
    db.exec("ALTER TABLE x_insight_posts DROP COLUMN source_snapshot");
    db.prepare("DELETE FROM schema_migrations WHERE id = '031'").run();
    runMigrations(db, ALL_MIGRATIONS);
    db.prepare("DELETE FROM creator_tweets").run();
    db.prepare("DELETE FROM tweets").run();
    expect(engine.detail(created.id).sources).toEqual(original);
    expect(Object.keys(original)).toHaveLength(2);
    db.prepare("UPDATE x_insight_posts SET source_snapshot = '{}' WHERE tweet_id = '1001'").run();
    expect(engine.detail(created.id).sources["1001"]).toBeUndefined();
    expect(engine.detail(created.id).messages).toHaveLength(2);
  });

  it("runs in the chosen mode, keeps it for follow-ups and lets a follow-up switch it", async () => {
    const seen: CodexRunOptions[] = [];
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Answer [post:1001]", seen),
      resolve,
      jobsRoot: dir,
    });
    const balanced = await engine.create({ scope: scope(), preset: "brief" });
    expect(balanced).toMatchObject({ mode: "balanced", model: "balanced-model" });
    await engine.settle(balanced.id);

    const deep = await engine.create({ scope: scope(), preset: "brief", mode: "deep" });
    await engine.settle(deep.id);
    expect(seen[1]).toMatchObject({ model: "deep-model", reasoningEffort: "high" });
    expect(engine.detail(deep.id)).toMatchObject({ mode: "deep", model: "deep-model" });

    await engine.followUp(deep.id, "And BTC?");
    await engine.settle(deep.id);
    expect(seen[2]).toMatchObject({ model: "deep-model", reasoningEffort: "high" });

    const switched = await engine.followUp(deep.id, "Briefly?", "quick");
    expect(switched.mode).toBe("quick");
    await engine.settle(deep.id);
    expect(seen[3]).toMatchObject({
      model: "quick-model",
      reasoningEffort: null,
      resumeSessionId: "session-1",
    });
    expect(engine.detail(deep.id)).toMatchObject({ mode: "quick", model: "quick-model" });
    expect(db.prepare("SELECT reasoning_effort FROM x_insights WHERE id = ?").get(deep.id)).toEqual(
      { reasoning_effort: null },
    );

    await expect(engine.create({ scope: scope(), preset: "brief", mode: "max" })).rejects.toThrow(
      "Choose Quick, Balanced or Deep.",
    );
    await expect(engine.followUp(deep.id, "Again?", "turbo")).rejects.toThrow("Choose Quick");
  });

  it("analyzes only selected posts and saves the answer to Reports", async () => {
    const seen: CodexRunOptions[] = [];
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Only one post [post:2001]", seen),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({
      scope: { ...scope(), tweetIds: ["2001"] },
      question: "What is Bob worried about?",
    });
    await engine.settle(created.id);
    expect(seen[0].prompt).toContain("[post:2001]");
    expect(seen[0].prompt).not.toContain("[post:1001]");
    const report = saveInsightReport(db, engine, created.id);
    expect(report).toMatchObject({ status: "done", title: "What is Bob worried about?" });
    expect(engine.detail(created.id).reportId).toBe(report.id);
    const html = insightHtml(engine.detail(created.id));
    expect(html).toContain('href="#post-2001"');
    expect(html).toContain("BTC dominance is rising");
  });

  it("keeps a saved brief's source metadata after analysis deletion and cache eviction", async () => {
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Only one post [post:2001]"),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({
      scope: { ...scope(), tweetIds: ["2001"] },
      preset: "brief",
    });
    await engine.settle(created.id);
    const report = saveInsightReport(db, engine, created.id);
    expect(publicReportFor(db, report).sourceCount).toBe(1);
    engine.remove(created.id);
    const saved = publicReportFor(db, report);
    expect(saved.sourceCount).toBe(1);
    expect(saved.sources).toHaveLength(1);
    db.prepare("DELETE FROM creator_tweets").run();
    db.prepare("DELETE FROM tweets").run();
    const evicted = publicReportFor(db, report);
    expect(evicted.sourceCount).toBe(1);
    expect(evicted.sources[0]).toMatchObject({
      id: "2001",
      creatorName: "BOB",
      title: "BTC dominance is rising, careful with alts",
    });
  });

  it("does not claim zero sources for legacy orphaned briefs and tolerates invalid snapshots", async () => {
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Only one post [post:2001]"),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({
      scope: { ...scope(), tweetIds: ["2001"] },
      preset: "brief",
    });
    await engine.settle(created.id);
    const report = saveInsightReport(db, engine, created.id);
    db.prepare("UPDATE ai_reports SET source_snapshot = ? WHERE id = ?").run(
      '{"version":99}',
      report.id,
    );
    expect(publicReportFor(db, report).sourceCount).toBe(1);
    db.prepare(
      "UPDATE ai_reports SET source_snapshot = NULL, selected_sources = '[]' WHERE id = ?",
    ).run(report.id);
    engine.remove(created.id);
    expect(publicReportFor(db, { ...report, sources: [] })).toMatchObject({
      sourceCountKnown: false,
      sources: [],
    });
  });

  it("refreshes saved metadata after follow-up without losing cache-evicted source titles", async () => {
    const engine = new InsightEngine({
      database: () => db,
      runner: runner(() => "Only one post [post:2001]"),
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({
      scope: { ...scope(), tweetIds: ["2001"] },
      preset: "brief",
    });
    await engine.settle(created.id);
    const first = saveInsightReport(db, engine, created.id);
    await engine.followUp(created.id, "Explain the risk", "quick");
    await engine.settle(created.id);
    db.prepare("DELETE FROM creator_tweets").run();
    db.prepare("DELETE FROM tweets").run();
    const updated = saveInsightReport(db, engine, created.id);
    expect(updated.id).toBe(first.id);
    const html = (
      db.prepare("SELECT research_html AS html FROM ai_reports WHERE id = ?").get(updated.id) as {
        html: string;
      }
    ).html;
    expect(html).toContain('id="post-2001"');
    expect(html).toContain("BTC dominance is rising");
    expect(publicReportFor(db, updated)).toMatchObject({
      sourceCount: 1,
      sourceCountKnown: true,
      sources: [{ id: "2001", creatorName: "BOB" }],
    });
  });

  it("reports provider problems in plain language and recovers interrupted runs", async () => {
    const engine = new InsightEngine({
      database: () => db,
      runner: async () => () => {
        throw new CodexError("not_authenticated", "no login");
      },
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({ scope: scope(), preset: "tickers" });
    await engine.settle(created.id);
    expect(engine.detail(created.id)).toMatchObject({
      status: "failed",
      error: "Claude isn't signed in. Connect it in Settings → AI, then try again.",
    });
    db.prepare("UPDATE x_insights SET status = 'running' WHERE id = ?").run(created.id);
    new InsightEngine({ database: () => db, resolve, jobsRoot: dir });
    expect(engine.detail(created.id).status).toBe("failed");
  });

  it("explains a reply cut off by the model's output limit", async () => {
    const engine = new InsightEngine({
      database: () => db,
      runner: async () => () => {
        throw new CodexError("output_truncated", "hit the output limit");
      },
      resolve,
      jobsRoot: dir,
    });
    const created = await engine.create({ scope: scope(), preset: "brief" });
    await engine.settle(created.id);
    expect(engine.detail(created.id).status).toBe("failed");
    expect(engine.detail(created.id).error).toMatch(
      /output budget .* lower reasoning effort, or analyze fewer posts\.$/,
    );
  });

  it("refuses empty scopes and unknown requests", async () => {
    const engine = new InsightEngine({ database: () => db, resolve, jobsRoot: dir });
    await expect(engine.create({ scope: scope() })).rejects.toThrow("Pick an analysis");
    await expect(
      engine.create({
        scope: { ...scope(), period: "24h", creatorIds: [alice], query: "nothing" },
        preset: "brief",
      }),
    ).rejects.toThrow("no posts");
    expect(engine.preview(scope())).toEqual({ postCount: 3, total: 3, accounts: 2 });
  });

  it("labels quoted words and replies for the model", () => {
    const text = renderPost({
      tweet: {
        id: "5",
        authorName: "A",
        authorHandle: "a",
        text: "Agree",
        quoted: { handle: "q", name: "Q", text: "Buy ETH", url: "" },
        inReplyToHandle: "z",
        media: [],
      } as never,
      eventAt: "2026-10-01T10:00:00.000Z",
      postType: "reply",
    });
    expect(text).toBe(
      "[post:5] @a (A) · 2026-10-01 10:00 UTC · reply to @z\nAgree\n> Quoting @q: Buy ETH",
    );
  });
});

describe("markdown emphasis", () => {
  it("never treats underscores inside handles as italics", () => {
    expect(parseInline("@solana_sam is bullish while @onchain_olivia waits")).toEqual([
      { kind: "text", text: "@solana_sam is bullish while @onchain_olivia waits" },
    ]);
    expect(parseInline("a _real_ emphasis")[1]).toEqual({
      kind: "em",
      children: [{ kind: "text", text: "real" }],
    });
  });
});
