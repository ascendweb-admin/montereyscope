/*
 * Route tests for the AI chat API (stage 3), driving the real route handlers
 * against a real migrated SQLite file. The Codex boundary is mocked exactly
 * where the spawner seam lives: runCodex is replaced with a scripted fake
 * that records the options it was called with (prompt, work dir, sandbox,
 * resume session id, signal) and replays codex JSONL events as a CodexRun.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodexAbortedError,
  CodexBinaryNotFoundError,
  CodexNonZeroExitError,
  CodexNotAuthenticatedError,
  CodexQuotaExceededError,
  CodexTimeoutError,
  type CodexRun,
  type CodexRunOptions,
  type CodexStreamEvent,
  type CodexUsage,
} from "@/lib/ai/codex";
import { SYSTEM_INSTRUCTION, buildSystemInstruction } from "@/lib/ai/chat";
import { getChatMode } from "@/lib/ai/chat-modes";
import { MAX_SCOPE_VIDEOS } from "@/lib/ai";
import { POST as POST_CHAT } from "@/app/api/ai/chat/route";
import { GET as GET_THREADS } from "@/app/api/ai/chat/threads/route";
import { GET as GET_THREAD_BY_ID } from "@/app/api/ai/chat/threads/[id]/route";
import { closeDatabase, getDb } from "@/lib/db/connection";
import { setAiBackend, setAiChatModeSettings } from "@/lib/settings/settings";
import { ModelCatalogService, setModelCatalogForTests } from "@/lib/ai/models/catalog";
import { bundledCatalogModels } from "@/lib/ai/models/bundled";
import { getDefaultAiChatModeSettings } from "@/lib/ai/model-catalog";
import { saveTranscript } from "@/lib/transcripts/repository";
import { setTranscriptResolverForTests } from "@/lib/transcripts/prepare";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION_ID = "0f1e2d3c-4b5a-4678-8796-a5b4c3d2e1f0";
const OTHER_SESSION_ID = "99999999-aaaa-bbbb-cccc-dddddddddddd";
const OPENCODE_SESSION_ID = "ses_f972bd039ffeuagY7F24bvfLFF";

const USAGE: CodexUsage = {
  inputTokens: 120,
  cachedInputTokens: 12,
  cacheWriteInputTokens: 0,
  outputTokens: 34,
  reasoningOutputTokens: 8,
  totalTokens: 174,
};

const VIDEO_WITH_TRANSCRIPT = "abc12345678";
const SECOND_VIDEO_WITH_TRANSCRIPT = "def12345678";
const VIDEO_WITHOUT_TRANSCRIPT = "without1111";
const UNKNOWN_VIDEO = "ghost000001";

interface RunScript {
  /** CodexStreamEvents replayed in order before completion/failure. */
  events?: CodexStreamEvent[];
  /** When set, the event stream and completion reject with this error. */
  failure?: Error;
  sessionId?: string;
  finalMessage?: string;
  usage?: CodexUsage | null;
}

/** Builds a CodexRun from a script, mirroring the real adapter's contract. */
function scriptRun(script: RunScript): CodexRun {
  const completed = script.failure
    ? Promise.reject(script.failure)
    : Promise.resolve({
        sessionId: script.sessionId ?? null,
        finalMessage: script.finalMessage ?? "",
        usage: script.usage ?? null,
      });
  // The real adapter attaches its own handler; keep rejections handled here.
  completed.catch(() => {});

  async function* iterate(): AsyncGenerator<CodexStreamEvent> {
    for (const event of script.events ?? []) {
      yield event;
    }
    if (script.failure) {
      throw script.failure;
    }
  }
  return { events: iterate(), completed };
}

function scriptSuccessfulTurn(finalText: string, sessionId = SESSION_ID): RunScript {
  return {
    events: [
      { type: "session_started", sessionId },
      { type: "message_completed", text: finalText },
      { type: "turn_completed", usage: USAGE },
    ],
    sessionId,
    finalMessage: finalText,
    usage: USAGE,
  };
}

function seedFeed(): void {
  const db = getDb();
  const { lastInsertRowid } = db
    .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
    .run("Test Channel", "https://www.youtube.com/@testchannel");
  const creatorId = Number(lastInsertRowid);
  const insertVideo = db.prepare(
    "INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)",
  );
  const insertTranscript = db.prepare(
    "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
  );
  const entries = [
    { videoId: VIDEO_WITH_TRANSCRIPT, withTranscript: true },
    { videoId: SECOND_VIDEO_WITH_TRANSCRIPT, withTranscript: true },
    { videoId: VIDEO_WITHOUT_TRANSCRIPT, withTranscript: false },
  ];
  for (const entry of entries) {
    insertVideo.run(
      entry.videoId,
      creatorId,
      `Video ${entry.videoId}`,
      `https://www.youtube.com/watch?v=${entry.videoId}`,
    );
    if (entry.withTranscript) {
      insertTranscript.run(entry.videoId, "en", "manual", `Transcript body for ${entry.videoId}.`);
    }
  }
}

function postChat(body: unknown): Promise<Response> {
  return POST_CHAT(
    new Request("http://127.0.0.1:3000/api/ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function threadByIdRequest(threadId: string): {
  request: Request;
  ctx: { params: Promise<{ id: string }> };
} {
  return {
    request: new Request(`http://127.0.0.1:3000/api/ai/chat/threads/${threadId}`),
    ctx: { params: Promise.resolve({ id: threadId }) },
  };
}

interface ParsedSse {
  event: string;
  data: Record<string, unknown> | null;
}

function parseSse(text: string): ParsedSse[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const lines = block.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event: "));
      const dataLine = lines.find((line) => line.startsWith("data: "));
      return {
        event: eventLine ? eventLine.slice("event: ".length) : "",
        data: dataLine
          ? (JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>)
          : null,
      };
    });
}

function lastRunOptions(): CodexRunOptions {
  const calls = runCodexMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as CodexRunOptions;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "localtube-chat-route-"));
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
  runCodexMock.mockImplementation(() => {
    throw new Error("this test must script runCodex before making a request");
  });
  runOpencodeMock.mockReset();
  runOpencodeMock.mockImplementation(() => {
    throw new Error("this test must script runOpencode before making a request");
  });
  runClaudeMock.mockReset();
  runClaudeMock.mockImplementation(() => {
    throw new Error("this test must script runClaude before making a request");
  });
  // Background caption fetching never reaches yt-dlp in these tests.
  setTranscriptResolverForTests(async () => ({
    ok: false,
    error: { code: "no_captions", message: "No original English captions are available." },
  }));
});

afterEach(() => {
  setTranscriptResolverForTests(null);
  setModelCatalogForTests(null);
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  delete process.env.LOCALTUBE_AI_JOBS_ROOT;
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — new threads
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — new thread", () => {
  it("streams fine-grained SSE events and persists the whole turn", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() =>
      scriptRun({
        events: [
          { type: "session_started", sessionId: SESSION_ID },
          { type: "text_delta", text: "Hello" },
          { type: "text_delta", text: ", world" },
          { type: "message_completed", text: "Hello, world" },
          { type: "turn_completed", usage: USAGE },
        ],
        sessionId: SESSION_ID,
        finalMessage: "Hello, world",
        usage: USAGE,
      }),
    );

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT, SECOND_VIDEO_WITH_TRANSCRIPT],
      message: "Which video hooks viewers faster?",
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const parsed = parseSse(await response.text());
    expect(parsed.map((entry) => entry.event)).toEqual([
      "thread",
      "user_message",
      "status",
      "status",
      "delta",
      "delta",
      "message",
      "done",
    ]);
    const [thread, userMessage, thinking, writing, delta1, delta2, message, done] = parsed;
    expect(thread.data).toMatchObject({ threadId: expect.any(Number), created: true });
    const threadId = thread.data?.threadId as number;
    expect(userMessage.data).toMatchObject({ content: "Which video hooks viewers faster?" });
    expect(thinking.data).toEqual({ type: "status", phase: "thinking" });
    expect(writing.data).toEqual({ type: "status", phase: "writing" });
    expect(delta1.data).toEqual({ type: "delta", text: "Hello" });
    expect(delta2.data).toEqual({ type: "delta", text: ", world" });
    expect(message.data).toEqual({ type: "message", text: "Hello, world" });
    expect(done.data).toMatchObject({
      threadId,
      sessionId: SESSION_ID,
      usage: USAGE,
    });
    expect(typeof done.data?.assistantMessageId).toBe("number");

    // The codex run: read-only sandbox, seeded first-turn prompt, materialized work dir.
    const options = lastRunOptions();
    expect(options.sandbox).toBe("read-only");
    expect(options.skipGitRepoCheck).toBe(true);
    expect(options.resumeSessionId).toBeUndefined();
    expect(options.prompt).toContain(SYSTEM_INSTRUCTION);
    expect(options.prompt).toContain("Which video hooks viewers faster?");
    // The default mode is deep: Sol at extra-high reasoning with a 15-minute ceiling.
    expect(options.model).toBe("gpt-6.1-sol");
    expect(options.reasoningEffort).toBe("xhigh");
    expect(options.timeoutMs).toBe(15 * 60_000);

    // Persistence: thread with session id + JSON scope, three messages.
    const db = getDb();
    const threadRow = db
      .prepare<
        [number],
        {
          title: string;
          codex_session_id: string | null;
          codex_work_dir: string;
          selected_video_ids: string;
        }
      >(
        "SELECT title, codex_session_id, codex_work_dir, selected_video_ids FROM ai_threads WHERE id = ?",
      )
      .get(threadId);
    expect(threadRow?.title).toBe("Which video hooks viewers faster?");
    expect(threadRow?.codex_session_id).toBe(SESSION_ID);
    expect(JSON.parse(threadRow?.selected_video_ids ?? "[]")).toEqual([
      VIDEO_WITH_TRANSCRIPT,
      SECOND_VIDEO_WITH_TRANSCRIPT,
    ]);
    expect(existsSync(threadRow?.codex_work_dir ?? "")).toBe(true);
    expect(options.workDir).toBe(threadRow?.codex_work_dir);
    // The job dir doubles as the work dir: transcripts are materialized inside it.
    expect(
      existsSync(
        path.join(threadRow?.codex_work_dir ?? "", "transcripts", `${VIDEO_WITH_TRANSCRIPT}.txt`),
      ),
    ).toBe(true);

    const roles = db
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY id",
      )
      .all(threadId);
    expect(roles).toEqual([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: "Which video hooks viewers faster?" },
      { role: "assistant", content: "Hello, world" },
    ]);
  });

  it("joins multiple agent messages into one assistant message", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() =>
      scriptRun({
        events: [
          { type: "session_started", sessionId: SESSION_ID },
          { type: "message_completed", text: "Part one" },
          { type: "message_completed", text: "Part two" },
          { type: "turn_completed", usage: USAGE },
        ],
        sessionId: SESSION_ID,
        finalMessage: "Part two",
        usage: USAGE,
      }),
    );

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Two-part answer please.",
    });
    const parsed = parseSse(await response.text());
    expect(parsed.map((entry) => entry.event)).toEqual([
      "thread",
      "user_message",
      "status",
      "message",
      "message",
      "done",
    ]);

    const assistant = getDb()
      .prepare<[string], { content: string }>(
        "SELECT content FROM ai_messages WHERE role = 'assistant' AND content = ?",
      )
      .get("Part one\n\nPart two");
    expect(assistant?.content).toBe("Part one\n\nPart two");
  });

  it("drops codex's interim plan message when the answer supersedes it", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() =>
      scriptRun({
        events: [
          { type: "session_started", sessionId: SESSION_ID },
          {
            type: "message_completed",
            text: "I'll inspect the transcript headers and content, then summarize.",
          },
          { type: "message_superseded" },
          { type: "message_completed", text: "The final answer." },
          { type: "turn_completed", usage: USAGE },
        ],
        sessionId: SESSION_ID,
        finalMessage: "The final answer.",
        usage: USAGE,
      }),
    );

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Summarize in one sentence.",
    });
    const parsed = parseSse(await response.text());
    expect(parsed.map((entry) => entry.event)).toEqual([
      "thread",
      "user_message",
      "status",
      "message",
      "message_superseded",
      "message",
      "done",
    ]);

    // The plan never reaches persistence: the stored answer is answer-only.
    const threadId = parsed[0].data?.threadId as number;
    const messages = getDb()
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY id",
      )
      .all(threadId);
    expect(messages).toEqual([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: "Summarize in one sentence." },
      { role: "assistant", content: "The final answer." },
    ]);
  });

  it("fetches missing transcripts in the background before the thread starts", async () => {
    seedFeed();
    const fetched: string[] = [];
    setTranscriptResolverForTests(async (db, videoId) => {
      fetched.push(videoId);
      const fetchedAt = new Date().toISOString();
      saveTranscript(
        db,
        {
          videoId,
          language: "en",
          source: "automatic",
          plainText: `Fresh captions for ${videoId}.`,
        },
        fetchedAt,
      );
      return {
        ok: true,
        transcript: {
          text: `Fresh captions for ${videoId}.`,
          language: "en",
          captionSource: "automatic",
          fetchedAt,
          fromCache: false,
        },
      };
    });
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Read it.")));

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT, VIDEO_WITHOUT_TRANSCRIPT],
      message: "Compare them.",
    });
    expect(response.status).toBe(200);
    const parsed = parseSse(await response.text());

    // Only the video without a transcript is fetched, with progress first.
    expect(fetched).toEqual([VIDEO_WITHOUT_TRANSCRIPT]);
    expect(parsed.slice(0, 3).map((entry) => [entry.event, entry.data])).toEqual([
      ["status", { type: "status", phase: "preparing", done: 0, total: 1 }],
      ["status", { type: "status", phase: "preparing", done: 1, total: 1 }],
      ["thread", expect.objectContaining({ created: true })],
    ]);
    expect(parsed.some((entry) => entry.event === "notice")).toBe(false);
    expect(parsed.at(-1)?.event).toBe("done");

    // Both videos were materialized into the work dir the AI reads.
    const workDir = lastRunOptions().workDir;
    expect(existsSync(path.join(workDir, "transcripts", `${VIDEO_WITH_TRANSCRIPT}.txt`))).toBe(
      true,
    );
    expect(existsSync(path.join(workDir, "transcripts", `${VIDEO_WITHOUT_TRANSCRIPT}.txt`))).toBe(
      true,
    );
  });

  it("leaves out videos whose captions cannot be read and says so", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Partial answer.")));

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT, VIDEO_WITHOUT_TRANSCRIPT],
      message: "Compare them.",
    });
    const parsed = parseSse(await response.text());
    const notice = parsed.find((entry) => entry.event === "notice");
    expect(notice?.data?.message).toBe(
      `Left out 1 video scope couldn't read captions for: “Video ${VIDEO_WITHOUT_TRANSCRIPT}” (no English captions).`,
    );
    expect(parsed.at(-1)?.event).toBe("done");
    const workDir = lastRunOptions().workDir;
    expect(existsSync(path.join(workDir, "transcripts", `${VIDEO_WITHOUT_TRANSCRIPT}.txt`))).toBe(
      false,
    );
  });

  it("ends the turn without a thread when no selected video can be read", async () => {
    seedFeed();
    const response = await postChat({
      videoIds: [VIDEO_WITHOUT_TRANSCRIPT, UNKNOWN_VIDEO],
      message: "Anything?",
    });

    expect(response.status).toBe(200);
    const parsed = parseSse(await response.text());
    expect(parsed.map((entry) => entry.event)).toEqual(["status", "status", "error"]);
    expect(parsed[2].data).toMatchObject({
      code: "no_ready_sources",
      message: expect.stringContaining(`“Video ${VIDEO_WITHOUT_TRANSCRIPT}” (no English captions)`),
    });
    expect(runCodexMock).not.toHaveBeenCalled();

    const threadCount = getDb()
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM ai_threads")
      .get();
    expect(Number(threadCount?.n)).toBe(0);
  });

  it("rejects a new thread up front when nothing selected exists", async () => {
    seedFeed();
    const response = await postChat({ videoIds: [UNKNOWN_VIDEO], message: "Anything?" });

    expect(response.status).toBe(422);
    const body = (await response.json()) as {
      error: { code: string };
      unknownSources: Array<{ kind: string; id: string }>;
    };
    expect(body.error.code).toBe("no_ready_sources");
    expect(body.unknownSources).toEqual([{ kind: "video", id: UNKNOWN_VIDEO }]);
    expect(runCodexMock).not.toHaveBeenCalled();
  });

  it("validates the request body before any work starts", async () => {
    seedFeed();

    const cases: Array<{ body: unknown; code: string }> = [
      { body: "{not json", code: "invalid_body" },
      { body: { message: "Hi" }, code: "invalid_video_ids" },
      { body: { videoIds: [], message: "Hi" }, code: "invalid_video_ids" },
      { body: { videoIds: [42], message: "Hi" }, code: "invalid_video_ids" },
      { body: { videoIds: [VIDEO_WITH_TRANSCRIPT], message: "   " }, code: "invalid_message" },
      { body: { videoIds: [VIDEO_WITH_TRANSCRIPT], message: 7 }, code: "invalid_message" },
      {
        body: { videoIds: [VIDEO_WITH_TRANSCRIPT], message: "x".repeat(100_001) },
        code: "invalid_message",
      },
      {
        body: { videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Hi", threadId: "abc" },
        code: "invalid_thread",
      },
      {
        body: { videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Hi", threadId: 0 },
        code: "invalid_thread",
      },
    ];
    for (const testCase of cases) {
      const response = await postChat(testCase.body);
      expect(response.status, JSON.stringify(testCase.body)).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, JSON.stringify(testCase.body)).toBe(testCase.code);
    }

    expect(runCodexMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — resume path
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — existing thread", () => {
  async function createThreadWithFirstTurn(): Promise<number> {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("First answer")));
    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "First question?",
    });
    const parsed = parseSse(await response.text());
    const thread = parsed.find((entry) => entry.event === "thread");
    return thread?.data?.threadId as number;
  }

  it("resumes the codex session with just the new message", async () => {
    const threadId = await createThreadWithFirstTurn();

    runCodexMock.mockImplementation(() =>
      scriptRun({
        events: [
          { type: "message_completed", text: "Second answer" },
          { type: "turn_completed", usage: USAGE },
        ],
        sessionId: OTHER_SESSION_ID,
        finalMessage: "Second answer",
        usage: USAGE,
      }),
    );
    const response = await postChat({ threadId, message: "Follow-up?" });

    expect(response.status).toBe(200);
    const parsed = parseSse(await response.text());
    expect(parsed.map((entry) => entry.event)).toEqual([
      "thread",
      "user_message",
      "status",
      "message",
      "done",
    ]);
    expect(parsed[0].data).toMatchObject({ threadId, created: false });

    // Resume targets the same codex session and work dir; the prompt is only
    // the new message — transcripts stay in the session context.
    expect(runCodexMock).toHaveBeenCalledTimes(2);
    const firstOptions = runCodexMock.mock.calls[0][0] as CodexRunOptions;
    const secondOptions = lastRunOptions();
    expect(secondOptions.resumeSessionId).toBe(SESSION_ID);
    expect(secondOptions.prompt).toBe("Follow-up?");
    expect(secondOptions.workDir).toBe(firstOptions.workDir);

    const done = parsed.at(-1);
    expect(done?.data).toMatchObject({ threadId, sessionId: OTHER_SESSION_ID });

    // History: one seeded instruction, two user messages, two answers; the
    // session id was updated to the one codex announced on the resume run.
    const db = getDb();
    const messages = db
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY id",
      )
      .all(threadId);
    expect(messages).toEqual([
      { role: "system", content: SYSTEM_INSTRUCTION },
      { role: "user", content: "First question?" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow-up?" },
      { role: "assistant", content: "Second answer" },
    ]);
    const session = db
      .prepare<[number], { codex_session_id: string | null }>(
        "SELECT codex_session_id FROM ai_threads WHERE id = ?",
      )
      .get(threadId);
    expect(session?.codex_session_id).toBe(OTHER_SESSION_ID);
  });

  it("returns 404 for an unknown thread id", async () => {
    seedFeed();
    const response = await postChat({ threadId: 999, message: "Hello?" });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("thread_not_found");
    expect(runCodexMock).not.toHaveBeenCalled();
  });

  it("re-seeds a thread whose first turn never produced a session", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() =>
      scriptRun({ failure: new CodexNonZeroExitError("codex exited with 1: boom") }),
    );
    const failed = parseSse(
      await (
        await postChat({
          videoIds: [VIDEO_WITH_TRANSCRIPT],
          message: "First attempt",
        })
      ).text(),
    );
    expect(failed.at(-1)?.event).toBe("error");
    const threadId = failed[0].data?.threadId as number;

    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Recovered answer")));
    const response = await postChat({ threadId, message: "Second attempt" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.event).toBe("done");

    // No session to resume yet: the turn is re-seeded with the instruction.
    const options = lastRunOptions();
    expect(options.resumeSessionId).toBeUndefined();
    expect(options.prompt).toContain(SYSTEM_INSTRUCTION);
    expect(options.prompt).toContain("Second attempt");

    const db = getDb();
    const roles = db
      .prepare<[number], { role: string }>(
        "SELECT role FROM ai_messages WHERE thread_id = ? ORDER BY id",
      )
      .all(threadId);
    expect(roles.map((row) => row.role)).toEqual(["system", "user", "user", "assistant"]);
    const session = db
      .prepare<[number], { codex_session_id: string | null }>(
        "SELECT codex_session_id FROM ai_threads WHERE id = ?",
      )
      .get(threadId);
    expect(session?.codex_session_id).toBe(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — error mapping
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — codex failure mapping", () => {
  it.each([
    [new CodexNotAuthenticatedError("Not logged in"), "codex_not_authenticated"],
    [new CodexBinaryNotFoundError("spawn codex ENOENT"), "codex_unavailable"],
    [new CodexQuotaExceededError("usage limit reached"), "codex_quota_exceeded"],
    [new CodexTimeoutError("exceeded 900000 ms timeout"), "codex_timeout"],
    [new CodexAbortedError("aborted before completion"), "aborted"],
    [new CodexNonZeroExitError("exit code 1: PANIC_DETAILS"), "codex_failed"],
  ])("maps a %s to an SSE error event with code %s", async (failure, expectedCode) => {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun({ failure }));

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Question?",
    });

    // The stream has already started, so failures arrive in-stream.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const parsed = parseSse(await response.text());
    const errorEvent = parsed.find((entry) => entry.event === "error");
    expect(errorEvent?.data).toMatchObject({ code: expectedCode });
    expect(typeof errorEvent?.data?.message).toBe("string");
    // Diagnostics never leak to the client.
    expect(JSON.stringify(parsed)).not.toContain("PANIC_DETAILS");
    expect(JSON.stringify(parsed)).not.toContain("Not logged in");
    expect(parsed.at(-1)?.event).toBe("error");

    // The user message is kept, but no assistant message is invented.
    const roles = getDb()
      .prepare<[], { role: string }>("SELECT role FROM ai_messages ORDER BY id")
      .all();
    expect(roles.map((row) => row.role)).toEqual(["system", "user"]);
  });

  it("maps an unexpected failure to a generic chat_failed error", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun({ failure: new Error("socket exploded") }));

    const response = await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Question?" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.data).toMatchObject({ code: "chat_failed" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — opencode backend (stage 9)
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — opencode backend", () => {
  it("passes the active provider's model and reasoning variant to opencode", async () => {
    seedFeed();
    setAiBackend(getDb(), "opencode");
    const settings = getDefaultAiChatModeSettings();
    settings.opencode.deep = { model: "deepseek-v4-pro", reasoningEffort: "max" };
    setAiChatModeSettings(getDb(), settings);
    runOpencodeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Answer via DeepSeek.", OPENCODE_SESSION_ID),
        sessionId: OPENCODE_SESSION_ID,
      }),
    );

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Question?",
      mode: "deep",
    });
    await response.text();

    expect(runOpencodeMock).toHaveBeenCalledTimes(1);
    const options = runOpencodeMock.mock.calls[0][0] as CodexRunOptions;
    expect(options.model).toBe("opencode-go/deepseek-v4-pro");
    expect(options.reasoningEffort).toBe("max");
  });

  it("runs the turn on opencode when the ai_backend setting selects it", async () => {
    seedFeed();
    setAiBackend(getDb(), "opencode");
    runOpencodeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Answer via opencode."),
        sessionId: OPENCODE_SESSION_ID,
      }),
    );

    const response = await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Question?" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.event).toBe("done");

    // The codex adapter is never touched; the opencode session id lands in
    // the thread and the thread records which backend ran it.
    expect(runCodexMock).not.toHaveBeenCalled();
    expect(runOpencodeMock).toHaveBeenCalledTimes(1);
    const threadRow = getDb()
      .prepare<[number], { codex_session_id: string; backend: string }>(
        "SELECT codex_session_id, backend FROM ai_threads WHERE id = ?",
      )
      .get(1);
    expect(threadRow).toMatchObject({ codex_session_id: OPENCODE_SESSION_ID, backend: "opencode" });
  });

  it("maps opencode failures to opencode-prefixed error codes", async () => {
    seedFeed();
    setAiBackend(getDb(), "opencode");
    runOpencodeMock.mockImplementation(() =>
      scriptRun({ failure: new CodexNotAuthenticatedError("No credentials found") }),
    );

    const response = await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Question?" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.data).toMatchObject({ code: "opencode_not_authenticated" });
  });

  it("re-seeds instead of resuming when a codex thread switches to opencode", async () => {
    seedFeed();
    // The codex turn creates a thread bound to codex with a session id.
    runCodexMock.mockImplementation(() =>
      scriptRun({ ...scriptSuccessfulTurn("Codex answer."), sessionId: SESSION_ID }),
    );
    await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "First question?" });

    // Switching backends abandons the codex session: opencode gets no
    // resumeSessionId and the seeded instruction is sent again.
    setAiBackend(getDb(), "opencode");
    runOpencodeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("OpenCode answer.", OPENCODE_SESSION_ID),
        sessionId: OPENCODE_SESSION_ID,
      }),
    );
    const response = await postChat({
      threadId: 1,
      message: "Second question?",
      mode: "deep",
    });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.event).toBe("done");
    const opencodeOptions = runOpencodeMock.mock.calls[0][0] as CodexRunOptions;
    expect(opencodeOptions.resumeSessionId).toBeUndefined();
    expect(opencodeOptions.prompt).toContain(SYSTEM_INSTRUCTION);

    const threadRow = getDb()
      .prepare<[number], { codex_session_id: string; backend: string }>(
        "SELECT codex_session_id, backend FROM ai_threads WHERE id = ?",
      )
      .get(1);
    expect(threadRow).toMatchObject({ codex_session_id: OPENCODE_SESSION_ID, backend: "opencode" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — claude backend (stage 10)
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — claude backend", () => {
  const CLAUDE_SESSION_ID = "5b35d928-2f44-489a-a7da-c493517fb797";

  it("passes the active provider's runtime model alias and effort to claude", async () => {
    seedFeed();
    setAiBackend(getDb(), "claude");
    const settings = getDefaultAiChatModeSettings();
    settings.claude.deep = { model: "claude-opus", reasoningEffort: "max" };
    setAiChatModeSettings(getDb(), settings);
    runClaudeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Answer via Claude.", CLAUDE_SESSION_ID),
        sessionId: CLAUDE_SESSION_ID,
      }),
    );

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Question?",
      mode: "deep",
    });
    await response.text();

    expect(runClaudeMock).toHaveBeenCalledTimes(1);
    const options = runClaudeMock.mock.calls[0][0] as CodexRunOptions;
    // The public catalog id maps to the CLI's family alias.
    expect(options.model).toBe("opus");
    expect(options.reasoningEffort).toBe("max");
    expect(options.sandbox).toBe("read-only");
    expect(runCodexMock).not.toHaveBeenCalled();
    expect(runOpencodeMock).not.toHaveBeenCalled();
  });

  it("stores the claude session id and backend on the thread", async () => {
    seedFeed();
    setAiBackend(getDb(), "claude");
    runClaudeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Answer via Claude.", CLAUDE_SESSION_ID),
        sessionId: CLAUDE_SESSION_ID,
      }),
    );

    const response = await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Question?" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.event).toBe("done");

    const threadRow = getDb()
      .prepare<[number], { codex_session_id: string; backend: string }>(
        "SELECT codex_session_id, backend FROM ai_threads WHERE id = ?",
      )
      .get(1);
    expect(threadRow).toMatchObject({ codex_session_id: CLAUDE_SESSION_ID, backend: "claude" });
  });

  it("resumes the same claude session on a follow-up turn", async () => {
    seedFeed();
    setAiBackend(getDb(), "claude");
    runClaudeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("First Claude answer.", CLAUDE_SESSION_ID),
        sessionId: CLAUDE_SESSION_ID,
      }),
    );
    await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "First question?" }).then(
      (response) => response.text(),
    );
    expect(runClaudeMock).toHaveBeenCalledTimes(1);

    runClaudeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Second Claude answer.", CLAUDE_SESSION_ID),
        sessionId: CLAUDE_SESSION_ID,
      }),
    );
    const response = await postChat({ threadId: 1, message: "Second question?", mode: "deep" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.event).toBe("done");

    const secondOptions = runClaudeMock.mock.calls[1][0] as CodexRunOptions;
    expect(secondOptions.resumeSessionId).toBe(CLAUDE_SESSION_ID);
    // A plain follow-up sends only the new message, not the seed again.
    expect(secondOptions.prompt).toBe("Second question?");
  });

  it("maps claude failures to claude-prefixed error codes", async () => {
    seedFeed();
    setAiBackend(getDb(), "claude");
    runClaudeMock.mockImplementation(() =>
      scriptRun({ failure: new CodexNotAuthenticatedError("Not logged in") }),
    );

    const response = await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Question?" });
    const parsed = parseSse(await response.text());
    expect(parsed.at(-1)?.data).toMatchObject({ code: "claude_not_authenticated" });
  });

  it("re-seeds when switching codex → claude → codex", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() =>
      scriptRun({ ...scriptSuccessfulTurn("Codex answer."), sessionId: SESSION_ID }),
    );
    await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "First question?" }).then(
      (response) => response.text(),
    );

    // codex → claude: the codex session id is not resumable by claude, so the
    // turn re-seeds with the instruction.
    setAiBackend(getDb(), "claude");
    runClaudeMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Claude answer.", CLAUDE_SESSION_ID),
        sessionId: CLAUDE_SESSION_ID,
      }),
    );
    await postChat({ threadId: 1, message: "Second question?", mode: "deep" }).then((response) =>
      response.text(),
    );
    const claudeOptions = runClaudeMock.mock.calls[0][0] as CodexRunOptions;
    expect(claudeOptions.resumeSessionId).toBeUndefined();
    expect(claudeOptions.prompt).toContain(SYSTEM_INSTRUCTION);

    // claude → codex: same rule in the other direction.
    setAiBackend(getDb(), "codex");
    runCodexMock.mockImplementation(() =>
      scriptRun({
        ...scriptSuccessfulTurn("Codex again.", OTHER_SESSION_ID),
        sessionId: OTHER_SESSION_ID,
      }),
    );
    await postChat({ threadId: 1, message: "Third question?", mode: "deep" }).then((response) =>
      response.text(),
    );
    const codexOptions = lastRunOptions();
    expect(codexOptions.resumeSessionId).toBeUndefined();
    expect(codexOptions.prompt).toContain(SYSTEM_INSTRUCTION);

    const threadRow = getDb()
      .prepare<[number], { codex_session_id: string; backend: string }>(
        "SELECT codex_session_id, backend FROM ai_threads WHERE id = ?",
      )
      .get(1);
    expect(threadRow).toMatchObject({ codex_session_id: OTHER_SESSION_ID, backend: "codex" });
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — cancellation
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — client disconnect", () => {
  it("aborts the codex run when the client cancels the stream", async () => {
    seedFeed();
    let seenSignal: AbortSignal | undefined;
    runCodexMock.mockImplementation((options: CodexRunOptions) => {
      seenSignal = options.signal ?? undefined;
      const signal = options.signal;
      const completed = Promise.reject(new CodexAbortedError("Codex run aborted."));
      completed.catch(() => {});
      return {
        events: (async function* () {
          yield { type: "session_started", sessionId: SESSION_ID } as CodexStreamEvent;
          if (signal) {
            await new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
              } else {
                signal.addEventListener("abort", () => resolve(), { once: true });
              }
            });
          }
          throw new CodexAbortedError("Codex run aborted.");
        })(),
        completed,
      };
    });

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "A very long turn",
    });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    // Wait until the turn actually reached the codex boundary, then hang up:
    // the run is killed through the very signal codex was handed.
    await vi.waitFor(() => expect(seenSignal).toBeDefined());
    await reader!.cancel();

    await vi.waitFor(() => expect(seenSignal?.aborted).toBe(true));

    // The cancelled turn kept the user message but no assistant message.
    const roles = getDb()
      .prepare<[], { role: string }>("SELECT role FROM ai_messages ORDER BY id")
      .all();
    expect(roles.map((row) => row.role)).toEqual(["system", "user"]);
  });

  it("never starts codex for a request that arrives already aborted", async () => {
    seedFeed();

    const response = await POST_CHAT(
      new Request("http://127.0.0.1:3000/api/ai/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoIds: [VIDEO_WITH_TRANSCRIPT], message: "Too late?" }),
        signal: AbortSignal.abort(),
      }),
    );

    expect(response.status).toBe(200);
    const parsed = parseSse(await response.text());
    // The turn wound down without spending anything: no codex run, and an
    // abort-shaped error for the client that is no longer there.
    expect(runCodexMock).not.toHaveBeenCalled();
    expect(parsed.at(-1)?.data).toMatchObject({ code: "aborted" });

    const roles = getDb()
      .prepare<[], { role: string }>("SELECT role FROM ai_messages ORDER BY id")
      .all();
    expect(roles.map((row) => row.role)).toEqual(["system", "user"]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — scope guardrails (stage 7)
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — scope guardrails", () => {
  it("refuses selections beyond the analysis cap before any work starts", async () => {
    seedFeed();
    const ids = Array.from(
      { length: MAX_SCOPE_VIDEOS + 1 },
      (_, index) => `capvid${String(index).padStart(5, "0")}`,
    );

    const response = await postChat({ videoIds: ids, message: "Too much?" });

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("scope_too_large");
    expect(body.error.message).toContain(String(MAX_SCOPE_VIDEOS));
    expect(runCodexMock).not.toHaveBeenCalled();

    // Duplicates collapse first: exactly at the cap passes the guard.
    const atCap = [
      VIDEO_WITH_TRANSCRIPT,
      ...Array.from(
        { length: MAX_SCOPE_VIDEOS - 1 },
        (_, index) => `capvid${String(index).padStart(5, "0")}`,
      ),
      VIDEO_WITH_TRANSCRIPT,
    ];
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Answer")));
    const ok = await postChat({ videoIds: atCap, message: "At the cap" });
    expect(ok.status).toBe(200);
  });

  it("discloses byte-budget truncation as a notice event before the answer", async () => {
    seedFeed();
    getDb()
      .prepare("UPDATE transcripts SET plain_text = ? WHERE video_id = ?")
      .run("L".repeat(2000), VIDEO_WITH_TRANSCRIPT);
    process.env.LOCALTUBE_AI_MAX_MATERIALIZED_BYTES = "400";
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Grounded answer")));

    try {
      const response = await postChat({
        videoIds: [VIDEO_WITH_TRANSCRIPT],
        message: "What does it say?",
      });
      const parsed = parseSse(await response.text());

      const noticeIndex = parsed.findIndex((entry) => entry.event === "notice");
      expect(noticeIndex).toBeGreaterThan(0);
      const noticeText = String(parsed[noticeIndex]?.data?.message);
      expect(noticeText).toContain("cut short");
      expect(noticeText).toContain(`“Video ${VIDEO_WITH_TRANSCRIPT}”`);
      // The notice lands before the answer starts streaming.
      expect(parsed.slice(0, noticeIndex).map((entry) => entry.event)).toEqual([
        "thread",
        "user_message",
      ]);

      // The turn itself still completes normally.
      expect(parsed.at(-1)?.event).toBe("done");
      const done = parsed.at(-1);
      expect(done?.data).toMatchObject({ sessionId: SESSION_ID });
    } finally {
      delete process.env.LOCALTUBE_AI_MAX_MATERIALIZED_BYTES;
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — per-thread turn serialization (stage 7)
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — per-thread turn serialization", () => {
  it("queues a second turn for the same thread until the first finishes", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("First answer")));
    const seeded = parseSse(
      await (
        await postChat({
          videoIds: [VIDEO_WITH_TRANSCRIPT],
          message: "First question?",
        })
      ).text(),
    );
    const threadId = seeded[0].data?.threadId as number;

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    runCodexMock.mockImplementation(() => {
      calls += 1;
      const isFirst = calls === 1;
      const finalText = isFirst ? "First answer done" : "Second answer done";
      const completed = Promise.resolve({
        sessionId: SESSION_ID,
        finalMessage: finalText,
        usage: USAGE,
      });
      completed.catch(() => {});
      async function* iterate(): AsyncGenerator<CodexStreamEvent> {
        if (isFirst) {
          // The first turn stays in flight until the test releases it; the
          // second turn waits behind the per-thread lock the whole time.
          yield { type: "session_started", sessionId: SESSION_ID };
          await firstGate;
        }
        yield { type: "message_completed", text: finalText };
        yield { type: "turn_completed", usage: USAGE };
      }
      return { events: iterate(), completed };
    });

    const first = postChat({ threadId, message: "Turn one" }).then((r) => r.text());
    await vi.waitFor(() => expect(calls).toBe(1));

    const second = postChat({ threadId, message: "Turn two" }).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The second turn is queued, not running: codex has been called once.
    expect(calls).toBe(1);

    releaseFirst();
    const [firstText, secondText] = await Promise.all([first, second]);
    expect(calls).toBe(2);

    const firstEvents = parseSse(firstText).map((entry) => entry.event);
    const secondEvents = parseSse(secondText).map((entry) => entry.event);
    expect(firstEvents.at(-1)).toBe("done");
    expect(secondEvents.at(-1)).toBe("done");

    // Both turns persisted, in dispatch order.
    const messages = getDb()
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY id",
      )
      .all(threadId);
    expect(messages.map((row) => row.content)).toEqual([
      SYSTEM_INSTRUCTION,
      "First question?",
      "First answer",
      "Turn one",
      "First answer done",
      "Turn two",
      "Second answer done",
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ai/chat — chat intelligence modes (stage 8)
// ---------------------------------------------------------------------------

describe("POST /api/ai/chat — chat intelligence modes", () => {
  it("runs a quick-mode turn on Luna at low reasoning and records the mode", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Quick answer")));

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Just a quick one?",
      mode: "quick",
    });

    expect(response.status).toBe(200);
    // Drain the stream so the turn actually runs to completion.
    await response.text();
    const options = lastRunOptions();
    expect(options.model).toBe("gpt-6-luna");
    expect(options.reasoningEffort).toBe("low");
    expect(options.timeoutMs).toBe(5 * 60_000);
    // The seed carries the quick mode's directive, not the deep one.
    expect(options.prompt).toContain(buildSystemInstruction("quick"));
    expect(options.prompt).not.toContain(SYSTEM_INSTRUCTION);

    const db = getDb();
    const threadRow = db
      .prepare<[string], { mode: string }>("SELECT mode FROM ai_threads WHERE title = ?")
      .get("Just a quick one?");
    expect(threadRow?.mode).toBe("quick");
    const seeds = db
      .prepare<[], { content: string }>("SELECT content FROM ai_messages WHERE role = 'system'")
      .all();
    expect(seeds.map((seed) => seed.content)).toEqual([buildSystemInstruction("quick")]);
  });

  it("uses the saved Codex model and effort for the selected mode", async () => {
    seedFeed();
    const settings = getDefaultAiChatModeSettings();
    settings.codex.quick = { model: "gpt-5.4-mini", reasoningEffort: "high" };
    setAiChatModeSettings(getDb(), settings);
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Configured answer")));

    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Use my configured model.",
      mode: "quick",
    });
    await response.text();

    const options = lastRunOptions();
    expect(options.model).toBe("gpt-5.4-mini");
    expect(options.reasoningEffort).toBe("high");
  });

  it("rejects an unknown mode before any work starts", async () => {
    seedFeed();
    const response = await postChat({
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      message: "Hello?",
      mode: "ultra",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_mode");
    expect(runCodexMock).not.toHaveBeenCalled();
    const threadCount = getDb()
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM ai_threads")
      .get();
    expect(Number(threadCount?.n)).toBe(0);
  });

  it("announces a mid-thread mode switch to the session and updates the thread", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Deep answer")));
    const seeded = parseSse(
      await (
        await postChat({
          videoIds: [VIDEO_WITH_TRANSCRIPT],
          message: "Analyze everything.",
        })
      ).text(),
    );
    const threadId = seeded[0].data?.threadId as number;

    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Quick follow-up")));
    const response = await postChat({
      threadId,
      message: "Actually, just the highlights?",
      mode: "quick",
    });

    expect(response.status).toBe(200);
    await response.text();
    const options = lastRunOptions();
    expect(options.model).toBe("gpt-6-luna");
    expect(options.reasoningEffort).toBe("low");
    // The resume prompt leads with the switch note, then the message.
    expect(options.prompt).toContain("Mode switched to Quick");
    expect(options.prompt).toContain(getChatMode("quick").directive);
    expect(options.prompt.endsWith("Actually, just the highlights?")).toBe(true);

    const db = getDb();
    const threadRow = db
      .prepare<[number], { mode: string; codex_session_id: string | null }>(
        "SELECT mode, codex_session_id FROM ai_threads WHERE id = ?",
      )
      .get(threadId);
    expect(threadRow?.mode).toBe("quick");
    expect(threadRow?.codex_session_id).toBe(SESSION_ID);

    const messages = db
      .prepare<[number], { role: string; content: string }>(
        "SELECT role, content FROM ai_messages WHERE thread_id = ? ORDER BY id",
      )
      .all(threadId);
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "system",
      "user",
      "assistant",
    ]);
    expect(messages[3]?.content).toContain("Mode switched to Quick");
  });

  it("re-seeds a failed first turn with the switched mode's instruction", async () => {
    seedFeed();
    runCodexMock.mockImplementation(() =>
      scriptRun({ failure: new CodexNonZeroExitError("codex exited with 1: boom") }),
    );
    const failed = parseSse(
      await (
        await postChat({
          videoIds: [VIDEO_WITH_TRANSCRIPT],
          message: "First attempt",
        })
      ).text(),
    );
    const threadId = failed[0].data?.threadId as number;

    runCodexMock.mockImplementation(() => scriptRun(scriptSuccessfulTurn("Recovered")));
    const response = await postChat({ threadId, message: "Second attempt", mode: "balanced" });

    expect(response.status).toBe(200);
    await response.text();
    const options = lastRunOptions();
    expect(options.model).toBe("gpt-6.1-sol");
    expect(options.reasoningEffort).toBe("medium");
    expect(options.resumeSessionId).toBeUndefined();
    expect(options.prompt).toContain(buildSystemInstruction("balanced"));

    const db = getDb();
    const threadRow = db
      .prepare<[number], { mode: string }>("SELECT mode FROM ai_threads WHERE id = ?")
      .get(threadId);
    expect(threadRow?.mode).toBe("balanced");
    const seeds = db
      .prepare<[number], { content: string }>(
        "SELECT content FROM ai_messages WHERE thread_id = ? AND role = 'system' ORDER BY id",
      )
      .all(threadId);
    // Both the original deep seed and the switched balanced seed are recorded.
    expect(seeds.map((seed) => seed.content)).toEqual([
      SYSTEM_INSTRUCTION,
      buildSystemInstruction("balanced"),
    ]);
  });
});

describe("AI chat history routes", () => {
  async function createTwoThreads(): Promise<number[]> {
    seedFeed();
    const ids: number[] = [];
    for (const message of ["First question?", "Second question?"]) {
      runCodexMock.mockImplementation(() =>
        scriptRun(scriptSuccessfulTurn(`Answer to: ${message}`)),
      );
      const response = await postChat({ videoIds: [VIDEO_WITH_TRANSCRIPT], message });
      const parsed = parseSse(await response.text());
      ids.push(parsed[0].data?.threadId as number);
    }
    return ids;
  }

  it("lists threads with scope summaries, most recently active first", async () => {
    const [firstThreadId, secondThreadId] = await createTwoThreads();

    const response = await GET_THREADS();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      threads: Array<{
        id: number;
        title: string;
        videoIds: string[];
        messageCount: number;
        mode: string;
        createdAt: string;
        lastMessageAt: string | null;
      }>;
    };

    expect(body.threads).toHaveLength(2);
    expect(body.threads[0]).toMatchObject({
      id: secondThreadId,
      title: "Second question?",
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      messageCount: 3,
      mode: "deep",
    });
    expect(body.threads[0].lastMessageAt).toBeTruthy();
    expect(body.threads[1]).toMatchObject({
      id: firstThreadId,
      title: "First question?",
      messageCount: 3,
    });
    // Message bodies are not part of the list payload.
    expect(JSON.stringify(body.threads)).not.toContain("Answer to:");
  });

  it("returns one thread with its full message history", async () => {
    const [threadId] = await createTwoThreads();

    const { request, ctx } = threadByIdRequest(String(threadId));
    const response = await GET_THREAD_BY_ID(request, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread: {
        id: number;
        title: string;
        codexSessionId: string | null;
        videoIds: string[];
        mode: string;
        codexWorkDir?: string;
      };
      messages: Array<{ id: number; role: string; content: string; createdAt: string }>;
    };

    expect(body.thread).toMatchObject({
      id: threadId,
      title: "First question?",
      codexSessionId: SESSION_ID,
      videoIds: [VIDEO_WITH_TRANSCRIPT],
      mode: "deep",
    });
    // Server filesystem paths stay on the server.
    expect(body.thread.codexWorkDir).toBeUndefined();

    expect(body.messages.map((message) => message.role)).toEqual(["system", "user", "assistant"]);
    expect(body.messages[1].content).toBe("First question?");
    expect(body.messages[2].content).toBe("Answer to: First question?");
  });

  it("404s for an unknown thread and 400s for a malformed id", async () => {
    const missingCall = threadByIdRequest("999");
    const missing = await GET_THREAD_BY_ID(missingCall.request, missingCall.ctx);
    expect(missing.status).toBe(404);

    const malformedCall = threadByIdRequest("not-a-number");
    const malformed = await GET_THREAD_BY_ID(malformedCall.request, malformedCall.ctx);
    expect(malformed.status).toBe(400);
  });
});
