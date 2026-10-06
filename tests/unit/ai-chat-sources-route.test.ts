/**
 * Mixed-source chat route: a selection of {video, tweet} references
 * materializes both kinds into one job directory, persists the versioned
 * source document on the thread, and rejects ambiguous or empty scopes.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexRun, CodexRunOptions, CodexStreamEvent } from "@/lib/ai/codex";
import { POST as POST_CHAT } from "@/app/api/ai/chat/route";
import { GET as GET_THREAD_BY_ID } from "@/app/api/ai/chat/threads/[id]/route";
import { closeDatabase, getDb } from "@/lib/db/connection";
import { getThread } from "@/lib/ai/threads";
import { ModelCatalogService, setModelCatalogForTests } from "@/lib/ai/models/catalog";
import { bundledCatalogModels } from "@/lib/ai/models/bundled";

const { runCodexMock, runOpencodeMock, runClaudeMock } = vi.hoisted(() => ({
  runCodexMock: vi.fn(),
  runOpencodeMock: vi.fn(),
  runClaudeMock: vi.fn(),
}));

vi.mock("@/lib/ai/codex", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/codex")>();
  return { ...actual, runCodex: runCodexMock };
});
vi.mock("@/lib/ai/opencode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/opencode")>();
  return { ...actual, runOpencode: runOpencodeMock };
});
vi.mock("@/lib/ai/claude", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/claude")>();
  return { ...actual, runClaude: runClaudeMock };
});

const TWEET_ID = "1234567890123456701";
const VIDEO_ID = "videoManual01";

let tempDir = "";

function scriptedRun(): CodexRun {
  const finalMessage = "An answer grounded in both sources.";
  async function* events(): AsyncGenerator<CodexStreamEvent> {
    yield { type: "session_started", sessionId: "session-1" };
    yield { type: "message_completed", text: finalMessage };
    yield { type: "turn_completed", usage: null };
  }
  return {
    events: events(),
    completed: Promise.resolve({
      sessionId: "session-1",
      finalMessage,
      usage: null,
    }),
  };
}

function seedLibrary(): void {
  const db = getDb();
  const xCreator = Number(
    db
      .prepare(
        "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, 'x', ?)",
      )
      .run("Fixture Dev", "https://x.com/fixture_dev", "1234567890123456789").lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, published_at, content_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    TWEET_ID,
    "1234567890123456789",
    "fixture_dev",
    "Fixture Dev",
    `https://x.com/fixture_dev/status/${TWEET_ID}`,
    "A cached post with its complete text.",
    "2026-09-16T10:00:00.000Z",
    "complete",
  );
  db.prepare(
    "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, 'post', ?)",
  ).run(xCreator, TWEET_ID, "2026-09-16T10:00:00.000Z");

  const videoCreator = Number(
    db
      .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
      .run("Video Creator", "https://www.youtube.com/@videos").lastInsertRowid,
  );
  db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
    VIDEO_ID,
    videoCreator,
    "A video",
    "https://www.youtube.com/watch?v=videoManual01",
  );
  db.prepare(
    "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
  ).run(VIDEO_ID, "en", "manual", "Video transcript body.");
}

function postChat(body: unknown): Promise<Response> {
  return POST_CHAT(
    new Request("http://127.0.0.1:3000/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "scope-chat-sources-"));
  process.env.LOCALTUBE_DB_PATH = path.join(tempDir, "chat.db");
  process.env.LOCALTUBE_AI_JOBS_ROOT = path.join(tempDir, "ai-jobs");
  setModelCatalogForTests(
    new ModelCatalogService({
      db: getDb(),
      adapters: Object.fromEntries(
        (["codex", "opencode", "claude"] as const).map((provider) => [
          provider,
          {
            provider,
            discover: async () => ({
              models: bundledCatalogModels(provider),
              runtimeVersion: null,
              source: "fixture",
            }),
          },
        ]),
      ),
    }),
  );
  runCodexMock.mockReset();
  runOpencodeMock.mockReset();
  runClaudeMock.mockReset();
  runCodexMock.mockImplementation(scriptedRun);
});

afterEach(() => {
  setModelCatalogForTests(null);
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  delete process.env.LOCALTUBE_AI_JOBS_ROOT;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("POST /api/ai/chat with mixed sources", () => {
  it("materializes videos and tweets together and persists the selection", async () => {
    seedLibrary();
    const response = await postChat({
      sources: [
        { kind: "tweet", id: TWEET_ID },
        { kind: "video", id: VIDEO_ID },
      ],
      message: "Compare these two.",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("event: done");

    const runOptions = runCodexMock.mock.calls[0]?.[0] as CodexRunOptions;
    expect(existsSync(path.join(runOptions.workDir, "tweets", `${TWEET_ID}.txt`))).toBe(true);
    expect(existsSync(path.join(runOptions.workDir, "transcripts", `${VIDEO_ID}.txt`))).toBe(true);

    const db = getDb();
    const thread = db
      .prepare<[], { id: number }>("SELECT id FROM ai_threads ORDER BY id DESC LIMIT 1")
      .get();
    const stored = getThread(db, Number(thread?.id));
    expect(stored?.selectedSources).toEqual([
      { kind: "tweet", id: TWEET_ID },
      { kind: "video", id: VIDEO_ID },
    ]);

    const detail = await GET_THREAD_BY_ID(
      new Request(`http://127.0.0.1:3000/api/ai/chat/threads/${stored?.id}`),
      { params: Promise.resolve({ id: String(stored?.id) }) },
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as { thread: { selectedSources: unknown } };
    expect(body.thread.selectedSources).toEqual([
      { kind: "tweet", id: TWEET_ID },
      { kind: "video", id: VIDEO_ID },
    ]);
  });

  it("rejects ambiguous scope payloads", async () => {
    seedLibrary();
    const response = await postChat({
      sources: [{ kind: "tweet", id: TWEET_ID }],
      videoIds: [VIDEO_ID],
      message: "Hello",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ambiguous_scope");
  });

  it("reports unknown and not-ready sources for an unusable selection", async () => {
    seedLibrary();
    const emptyTweet = "1234567890123456999";
    const db = getDb();
    db.prepare(
      "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, content_status) VALUES (?, '9', 'someone', 'Someone', ?, '', 'unavailable')",
    ).run(emptyTweet, `https://x.com/someone/status/${emptyTweet}`);
    db.prepare(
      "INSERT INTO creator_tweets (creator_id, tweet_id) SELECT id, ? FROM creators WHERE platform = 'x'",
    ).run(emptyTweet);

    const response = await postChat({
      sources: [
        { kind: "tweet", id: emptyTweet },
        { kind: "tweet", id: "424242" },
      ],
      message: "Anything?",
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string };
      unknownSources: unknown[];
      notReadySources: unknown[];
    };
    expect(body.error.code).toBe("no_ready_sources");
    expect(body.unknownSources).toEqual([{ kind: "tweet", id: "424242" }]);
    expect(body.notReadySources).toEqual([{ kind: "tweet", id: emptyTweet }]);
  });

  it("rejects malformed source entries", async () => {
    seedLibrary();
    const response = await postChat({
      sources: [{ kind: "video", id: "" }],
      message: "Hi",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_sources");
  });
});
