import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAbortedError,
  CodexBinaryNotFoundError,
  CodexNonZeroExitError,
  CodexNotAuthenticatedError,
  CodexQuotaExceededError,
  CodexTimeoutError,
  type CodexChildProcess,
  type CodexExitStatus,
  type CodexRun,
  type CodexSpawnRequest,
  type CodexSpawner,
  type CodexStreamEvent,
} from "@/lib/ai/codex";
import { buildClaudeArgs, runClaude, type ClaudeRunOptions } from "@/lib/ai/claude";

// ---------------------------------------------------------------------------
// Fixture JSONL matching the claude 2.1.x stream-json schema
// ---------------------------------------------------------------------------

const SESSION_ID = "5b35d928-2f44-489a-a7da-c493517fb797";
const WORK_DIR = "/tmp/scope-claude-work";
const PROMPT = "Summarize the transcripts in this directory.";

function initLine(sessionId: string = SESSION_ID): string {
  return JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: WORK_DIR,
    session_id: sessionId,
    tools: ["Read", "Grep", "Glob"],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "dontAsk",
  });
}

function deltaLine(text: string): string {
  return JSON.stringify({
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    session_id: SESSION_ID,
  });
}

function assistantLine(
  content: unknown[],
  options: { id?: string; parentToolUseId?: string | null } = {},
): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: options.id ?? "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content,
    },
    parent_tool_use_id: options.parentToolUseId ?? null,
    session_id: SESSION_ID,
  });
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_api_ms: 1_200,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: SESSION_ID,
    total_cost_usd: 0.02,
    usage: {
      input_tokens: 100,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 25,
      output_tokens_details: { thinking_tokens: 7 },
    },
    permission_denials: [],
    terminal_reason: "completed",
    result: "Hello world",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Fake child process and spawner (same shape as the other adapter suites)
// ---------------------------------------------------------------------------

interface FakeChildSpec {
  /** Raw stdout chunks, so split lines and UTF-8 boundaries can be tested. */
  chunks?: string[];
  stderr?: string;
  exit?: CodexExitStatus;
  stayOpen?: boolean;
  spawnError?: Error;
}

class FakeClaudeChild implements CodexChildProcess {
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  readonly killCalls: string[] = [];

  private readonly spec: FakeChildSpec;
  private readonly queuedChunks: string[];
  private readonly chunkWaiters: Array<() => void> = [];
  private readonly exitWaiters: Array<(status: CodexExitStatus) => void> = [];
  private closed = false;
  private exitInfo: CodexExitStatus = { exitCode: 0, signal: null };

  constructor(spec: FakeChildSpec) {
    this.spec = spec;
    this.queuedChunks = [...(spec.chunks ?? [])];
  }

  pushLine(line: string): void {
    this.queuedChunks.push(`${line}\n`);
    this.wake();
  }

  finish(exit: CodexExitStatus = { exitCode: 0, signal: null }): void {
    this.close(exit);
  }

  readonly stdin = {
    write: (chunk: string) => {
      this.stdinWrites.push(chunk);
    },
    end: () => {
      this.stdinEnded = true;
    },
  };

  readonly stdout: AsyncIterable<string> = {
    [Symbol.asyncIterator]: (): AsyncGenerator<string> => this.iterateStdout(),
  };

  readonly stderr: AsyncIterable<string> = {
    [Symbol.asyncIterator]: (): AsyncGenerator<string> => this.iterateStderr(),
  };

  wait(): Promise<CodexExitStatus> {
    if (this.closed) {
      return Promise.resolve(this.exitInfo);
    }
    return new Promise((resolve) => {
      this.exitWaiters.push(resolve);
    });
  }

  kill(signal?: string): void {
    this.killCalls.push(signal ?? "SIGTERM");
    this.close({ exitCode: null, signal: signal ?? "SIGTERM" });
  }

  private async *iterateStdout(): AsyncGenerator<string> {
    for (;;) {
      while (this.queuedChunks.length > 0) {
        yield this.queuedChunks.shift() as string;
      }
      if (this.closed) {
        return;
      }
      if (!this.spec.stayOpen) {
        this.close(this.spec.exit ?? { exitCode: 0, signal: null });
        return;
      }
      await new Promise<void>((resolve) => {
        this.chunkWaiters.push(resolve);
      });
    }
  }

  private async *iterateStderr(): AsyncGenerator<string> {
    if (this.spec.stderr) {
      yield this.spec.stderr;
    }
  }

  private close(exit: CodexExitStatus): void {
    if (this.closed) {
      return;
    }
    this.exitInfo = exit;
    this.closed = true;
    this.wake();
    for (const resolve of this.exitWaiters.splice(0)) {
      resolve(exit);
    }
  }

  private wake(): void {
    for (const resolve of this.chunkWaiters.splice(0)) {
      resolve();
    }
  }
}

function makeFakeSpawner(spec: FakeChildSpec): {
  spawner: CodexSpawner;
  child: FakeClaudeChild;
  requests: CodexSpawnRequest[];
} {
  const child = new FakeClaudeChild(spec);
  const requests: CodexSpawnRequest[] = [];
  const spawner: CodexSpawner = (request) => {
    requests.push(request);
    if (spec.spawnError) {
      const error = spec.spawnError;
      return {
        stdin: { write: () => {}, end: () => {} },
        stdout: {
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {},
        },
        stderr: {
          [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {},
        },
        wait: () => Promise.reject(error),
        kill: () => {},
      };
    }
    return child;
  };
  return { spawner, child, requests };
}

async function drainEvents(run: CodexRun): Promise<{ events: CodexStreamEvent[]; error: unknown }> {
  const events: CodexStreamEvent[] = [];
  let error: unknown;
  try {
    for await (const event of run.events) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return { events, error };
}

function runWith(
  spec: FakeChildSpec,
  overrides: Partial<ClaudeRunOptions> = {},
): {
  run: CodexRun;
  child: FakeClaudeChild;
  requests: CodexSpawnRequest[];
} {
  const fake = makeFakeSpawner(spec);
  const run = runClaude({
    prompt: PROMPT,
    workDir: WORK_DIR,
    spawner: fake.spawner,
    command: "/usr/bin/claude",
    ...overrides,
  });
  return { run, child: fake.child, requests: fake.requests };
}

/** A complete successful turn: init, deltas, assistant message, result. */
function successfulTurn(text = "Hello world"): string[] {
  return [
    initLine(),
    deltaLine("Hello "),
    deltaLine("world"),
    assistantLine([{ type: "text", text }]),
    resultLine({ result: text }),
  ];
}

afterEach(() => {
  // Nothing global to clean; symmetry with the other adapter suites.
});

// ---------------------------------------------------------------------------
// Argument construction and prompt delivery
// ---------------------------------------------------------------------------

describe("buildClaudeArgs", () => {
  it("isolates configuration and restricts chat tools to read-only", () => {
    const args = buildClaudeArgs({ model: "haiku", sandbox: "read-only" });
    expect(args).toContain("-p");
    expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json"]));
    expect(args).toEqual(expect.arrayContaining(["--include-partial-messages"]));
    expect(args).toEqual(expect.arrayContaining(["--model", "haiku"]));
    // No user/project/local settings, no MCP servers, no prompt-capable tools.
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", ""]));
    expect(args).toContain("--safe-mode");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toEqual(expect.arrayContaining(["--mcp-config", '{"mcpServers":{}}']));
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read,Grep,Glob"]));
    expect(args).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk"]));
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--effort");
  });

  it("adds effort, resume, and the scoped write-only report policy", () => {
    const args = buildClaudeArgs({
      model: "opus",
      reasoningEffort: "xhigh",
      sandbox: "workspace-write",
      resumeSessionId: SESSION_ID,
    });
    expect(args).toEqual(expect.arrayContaining(["--effort", "xhigh"]));
    expect(args).toEqual(expect.arrayContaining(["--resume", SESSION_ID]));
    expect(args).toEqual(expect.arrayContaining(["--tools", "Read,Grep,Glob,Write"]));
    // Writes are pre-approved only inside the job directory; transcripts and
    // the manifest stay protected.
    expect(args).toEqual(expect.arrayContaining(["--allowedTools", "Edit(./**)"]));
    expect(args).toEqual(
      expect.arrayContaining(["--disallowedTools", "Edit(transcripts/**),Edit(manifest.json)"]),
    );
    // Never the bypass modes.
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("bypassPermissions");
  });
});

describe("runClaude arguments", () => {
  it("spawns the resolved command, delivers the prompt on stdin, and ends it", async () => {
    const { run, child, requests } = runWith({ chunks: successfulTurn().map((l) => `${l}\n`) });
    await run.completed;
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe("/usr/bin/claude");
    expect(requests[0].cwd).toBe(WORK_DIR);
    expect(child.stdinWrites).toEqual([PROMPT]);
    expect(child.stdinEnded).toBe(true);
  });

  it("defaults to the Haiku model when none is supplied", async () => {
    const { run, requests } = runWith({ chunks: [`${initLine()}\n`, `${resultLine()}\n`] });
    await run.completed;
    expect(requests[0].args).toEqual(expect.arrayContaining(["--model", "haiku"]));
  });
});

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

describe("runClaude events", () => {
  it("maps init, text deltas, the completed message, and usage", async () => {
    const { run } = runWith({ chunks: successfulTurn().map((l) => `${l}\n`) });
    const { events, error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(events.some((event) => event.type === "session_started")).toBe(true);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.text),
    ).toEqual(["Hello ", "world"]);
    expect(
      events.filter((event) => event.type === "message_completed").map((event) => event.text),
    ).toEqual(["Hello world"]);
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.finalMessage).toBe("Hello world");
    // Cache reads/writes are counted once, in their own fields, and folded
    // into totalTokens exactly once.
    expect(result.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 10,
      outputTokens: 25,
      reasoningOutputTokens: 7,
      totalTokens: 175,
    });
  });

  it("parses NDJSON across arbitrary chunk splits without a final newline", async () => {
    const raw = successfulTurn()
      .map((line) => `${line}\n`)
      .join("");
    const chunks: string[] = [];
    for (let index = 0; index < raw.length; index += 17) {
      chunks.push(raw.slice(index, index + 17));
    }
    const { run } = runWith({ chunks: [...chunks.slice(0, -1), chunks.at(-1)?.trimEnd() ?? ""] });
    const result = await run.completed;
    expect(result.finalMessage).toBe("Hello world");
  });

  it("tolerates non-JSON noise and CRLF line endings", async () => {
    const lines = [
      initLine(),
      "mise: booting claude",
      `${deltaLine("done")}\r`,
      assistantLine([{ type: "text", text: "done" }]),
      resultLine({ result: "done" }),
    ];
    const { run } = runWith({ chunks: lines.map((line) => `${line}\n`) });
    const result = await run.completed;
    expect(result.finalMessage).toBe("done");
  });

  it("never exposes thinking, tool blocks, or nested-agent text", async () => {
    const assistant = assistantLine([
      { type: "thinking", thinking: "secret chain of thought" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/etc/passwd" } },
      { type: "text", text: "public answer" },
    ]);
    const nested = assistantLine([{ type: "text", text: "subagent answer" }], {
      id: "msg_nested",
      parentToolUseId: "toolu_parent",
    });
    const { run } = runWith({
      chunks: [initLine(), assistant, nested, resultLine({ result: "public answer" })].map(
        (line) => `${line}\n`,
      ),
    });
    const { events } = await drainEvents(run);
    const completed = events
      .filter((event) => event.type === "message_completed")
      .map((event) => event.text);
    expect(completed).toEqual(["public answer"]);
  });

  it("deduplicates repeated assistant messages with the same id", async () => {
    const assistant = assistantLine([{ type: "text", text: "once" }], { id: "msg_same" });
    const { run } = runWith({
      chunks: [assistant, assistant, resultLine({ result: "once" })].map((line) => `${line}\n`),
    });
    const { events } = await drainEvents(run);
    expect(events.filter((event) => event.type === "message_completed")).toHaveLength(1);
  });

  it("falls back to the result text when no assistant message carried text", async () => {
    const { run } = runWith({
      chunks: [initLine(), resultLine({ result: "result-only answer" })].map((line) => `${line}\n`),
    });
    const result = await run.completed;
    expect(result.finalMessage).toBe("result-only answer");
  });

  it("keeps the newest assistant message as the final answer across steps", async () => {
    const { run } = runWith({
      chunks: [
        initLine(),
        assistantLine([{ type: "text", text: "interim" }], { id: "msg_a" }),
        assistantLine([{ type: "text", text: "final" }], { id: "msg_b" }),
        resultLine({ result: "final" }),
      ].map((line) => `${line}\n`),
    });
    const { events } = await drainEvents(run);
    const result = await run.completed;
    expect(
      events.filter((event) => event.type === "message_completed").map((event) => event.text),
    ).toEqual(["interim", "final"]);
    expect(result.finalMessage).toBe("final");
  });

  it("reports a null usage when the result carries none", async () => {
    const { run } = runWith({
      chunks: [resultLine({ usage: undefined })].map((line) => `${line}\n`),
    });
    const result = await run.completed;
    expect(result.usage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe("runClaude failures", () => {
  it("treats an error result with exit code zero as a failure", async () => {
    const line = resultLine({
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: null,
      result: "Not logged in · Please run /login",
    });
    const { run } = runWith({ chunks: [initLine(), line].map((l) => `${l}\n`) });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexNotAuthenticatedError);
    await expect(run.completed).rejects.toBeInstanceOf(CodexNotAuthenticatedError);
  });

  it("classifies a 429 result as quota_exceeded even with auth-shaped text", async () => {
    const line = resultLine({
      is_error: true,
      api_error_status: 429,
      terminal_reason: "api_error",
      result: "unauthorized: usage limit reached",
    });
    const { run } = runWith({ chunks: [line].map((l) => `${l}\n`) });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexQuotaExceededError);
  });

  it("classifies a 401 result as not_authenticated", async () => {
    const line = resultLine({
      is_error: true,
      api_error_status: 401,
      terminal_reason: "api_error",
      result: "OAuth token expired",
    });
    const { run } = runWith({ chunks: [line].map((l) => `${l}\n`) });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexNotAuthenticatedError);
  });

  it("surfaces permission denials with a readable diagnostic", async () => {
    const line = resultLine({
      is_error: true,
      result: "Claude requested permission to use Write, but permission was denied.",
    });
    const { run } = runWith({ chunks: [line].map((l) => `${l}\n`) });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexNonZeroExitError);
    expect((error as Error).message).toMatch(/permission/i);
  });

  it("treats a missing terminal result as a protocol failure, not success", async () => {
    const { run } = runWith({
      chunks: [initLine(), assistantLine([{ type: "text", text: "partial" }])].map(
        (line) => `${line}\n`,
      ),
    });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexNonZeroExitError);
    expect((error as Error).message).toMatch(/terminal result/i);
  });

  it("classifies a nonzero exit with stderr diagnostics", async () => {
    const { run } = runWith({
      chunks: [],
      stderr: "Error: --resume session not found",
      exit: { exitCode: 1, signal: null },
    });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexNonZeroExitError);
    expect((error as Error).message).toContain("session not found");
  });

  it("maps spawn failure to binary_not_found", async () => {
    const { run } = runWith({
      spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
    });
    await expect(run.completed).rejects.toBeInstanceOf(CodexBinaryNotFoundError);
  });

  it("maps abort to CodexAbortedError and kills the child", async () => {
    const controller = new AbortController();
    const { run, child } = runWith(
      { chunks: [`${initLine()}\n`], stayOpen: true },
      { signal: controller.signal },
    );
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await drainEvents(run);
    await expect(run.completed).rejects.toBeInstanceOf(CodexAbortedError);
    expect(child.killCalls).toContain("SIGTERM");
  });

  it("maps a timeout to CodexTimeoutError and kills the child", async () => {
    const { run, child } = runWith(
      { chunks: [`${initLine()}\n`], stayOpen: true },
      { timeoutMs: 10 },
    );
    await expect(run.completed).rejects.toBeInstanceOf(CodexTimeoutError);
    expect(child.killCalls).toContain("SIGTERM");
  });
});
