import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAbortedError,
  CodexBinaryNotFoundError,
  CodexNotAuthenticatedError,
  CodexNonZeroExitError,
  CodexQuotaExceededError,
  CodexTimeoutError,
  runCodex,
  type CodexChildProcess,
  type CodexExitStatus,
  type CodexRun,
  type CodexSpawnRequest,
  type CodexSpawner,
  type CodexStreamEvent,
} from "@/lib/ai/codex";

// ---------------------------------------------------------------------------
// Fixture JSONL matching the codex 0.150.1 event schema
// ---------------------------------------------------------------------------

const SESSION_ID = "0f1e2d3c-4b5a-4678-8796-a5b4c3d2e1f0";
const OTHER_SESSION_ID = "99999999-aaaa-bbbb-cccc-dddddddddddd";

const SESSION_LINE = JSON.stringify({ type: "thread.started", thread_id: SESSION_ID });
const TURN_COMPLETED_LINE = JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 100,
    cached_input_tokens: 10,
    cache_write_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 135,
  },
});
const AGENT_MESSAGE_LINE = JSON.stringify({
  type: "item.completed",
  item: { id: "item_0", type: "agent_message", text: "Hello from codex." },
});

const WORK_DIR = "/tmp/localtube-work";
const PROMPT = "Summarize the transcripts in this directory.";

// ---------------------------------------------------------------------------
// Fake child process and spawner
// ---------------------------------------------------------------------------

interface FakeChildSpec {
  /** JSONL lines emitted on stdout, in order. */
  lines?: string[];
  stderr?: string;
  /** Exit status when the child exits; defaults to success. */
  exit?: CodexExitStatus;
  /** Keep the child running after its lines are drained (abort/timeout tests). */
  stayOpen?: boolean;
  /** When set, wait() rejects with this error (spawn failure). */
  spawnError?: Error;
}

class FakeCodexChild implements CodexChildProcess {
  readonly stdinWrites: string[] = [];
  stdinEnded = false;
  readonly killCalls: string[] = [];

  private readonly spec: FakeChildSpec;
  private readonly queuedLines: string[];
  private readonly lineWaiters: Array<() => void> = [];
  private readonly exitWaiters: Array<(status: CodexExitStatus) => void> = [];
  private closed = false;
  private exitInfo: CodexExitStatus = { exitCode: 0, signal: null };

  constructor(spec: FakeChildSpec) {
    this.spec = spec;
    this.queuedLines = [...(spec.lines ?? [])];
  }

  /** Queues one more stdout line on a still-open child. */
  pushLine(line: string): void {
    this.queuedLines.push(line);
    this.wake();
  }

  /** Ends the child with a normal exit status. */
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
      while (this.queuedLines.length > 0) {
        const line = this.queuedLines.shift() as string;
        yield `${line}\n`;
      }
      if (this.closed) {
        return;
      }
      if (!this.spec.stayOpen) {
        // Like the real codex: the process exits once it has said everything.
        this.close(this.spec.exit ?? { exitCode: 0, signal: null });
        return;
      }
      await new Promise<void>((resolve) => {
        this.lineWaiters.push(resolve);
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
    for (const resolve of this.lineWaiters.splice(0)) {
      resolve();
    }
  }
}

function makeFakeSpawner(spec: FakeChildSpec): {
  spawner: CodexSpawner;
  child: FakeCodexChild;
  requests: CodexSpawnRequest[];
} {
  const child = new FakeCodexChild(spec);
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

/** Drains the event iterator, capturing whether/what it threw so the
 * completion promise can always be awaited explicitly (no unhandled
 * rejections). */
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

// ---------------------------------------------------------------------------
// runCodex against the fake spawner
// ---------------------------------------------------------------------------

describe("runCodex", () => {
  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
  });

  it("spawns codex exec with the pinned model, sandbox, work dir, and stdin prompt", async () => {
    const { spawner, child, requests } = makeFakeSpawner({
      lines: [SESSION_LINE, AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);
    await run.completed;

    expect(error).toBeUndefined();
    expect(child.stdinEnded).toBe(true);
    expect(child.stdinWrites.join("")).toBe(PROMPT);
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe("codex");
    expect(requests[0].cwd).toBe(WORK_DIR);
    expect(requests[0].args).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-s",
      "read-only",
      "-C",
      WORK_DIR,
      "-",
    ]);
  });

  it("surfaces the session id, completed message, and usage, then resolves completed", async () => {
    const { spawner, child } = makeFakeSpawner({
      lines: [SESSION_LINE, AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { events, error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(events).toEqual([
      { type: "session_started", sessionId: SESSION_ID },
      { type: "message_completed", text: "Hello from codex." },
      {
        type: "turn_completed",
        usage: {
          inputTokens: 100,
          cachedInputTokens: 10,
          cacheWriteInputTokens: 0,
          outputTokens: 20,
          reasoningOutputTokens: 5,
          totalTokens: 135,
        },
      },
    ]);
    expect(result).toEqual({
      sessionId: SESSION_ID,
      finalMessage: "Hello from codex.",
      usage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 135,
      },
    });
    expect(child.stdinEnded).toBe(true);
  });

  it("streams text deltas when the events carry partial agent-message text", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [
        SESSION_LINE,
        JSON.stringify({
          type: "item.started",
          item: { id: "item_0", type: "agent_message", text: "Hel" },
        }),
        JSON.stringify({
          type: "item.updated",
          item: { id: "item_0", type: "agent_message", text: "Hello wor" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "Hello world" },
        }),
        TURN_COMPLETED_LINE,
      ],
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { events, error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(events).toEqual([
      { type: "session_started", sessionId: SESSION_ID },
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo wor" },
      { type: "message_completed", text: "Hello world" },
      { type: "turn_completed", usage: expect.anything() },
    ]);
    expect(result.finalMessage).toBe("Hello world");
  });

  it("retracts the interim plan message when a second agent message starts", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [
        SESSION_LINE,
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "item_0",
            type: "agent_message",
            text: "I'll inspect the transcript headers and content, then summarize.",
          },
        }),
        JSON.stringify({
          type: "item.started",
          item: { id: "item_1", type: "agent_message", text: "Final" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_1", type: "agent_message", text: "Final answer" },
        }),
        TURN_COMPLETED_LINE,
      ],
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { events, error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    // The retraction lands before the real answer's text streams, so
    // consumers can drop the plan from screen and persistence alike.
    expect(events).toEqual([
      { type: "session_started", sessionId: SESSION_ID },
      {
        type: "message_completed",
        text: "I'll inspect the transcript headers and content, then summarize.",
      },
      { type: "message_superseded" },
      { type: "text_delta", text: "Final" },
      { type: "message_completed", text: "Final answer" },
      { type: "turn_completed", usage: expect.anything() },
    ]);
    expect(result.finalMessage).toBe("Final answer");
  });

  it("emits no retraction for a single agent message", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [SESSION_LINE, AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { events, error } = await drainEvents(run);

    expect(error).toBeUndefined();
    expect(events.some((event) => event.type === "message_superseded")).toBe(false);
  });

  it("switches to `codex exec resume` when resumeSessionId is provided", async () => {
    const { spawner, requests } = makeFakeSpawner({
      lines: [
        JSON.stringify({ type: "thread.started", thread_id: OTHER_SESSION_ID }),
        AGENT_MESSAGE_LINE,
        TURN_COMPLETED_LINE,
      ],
    });

    const run = runCodex({
      prompt: PROMPT,
      workDir: WORK_DIR,
      resumeSessionId: SESSION_ID,
      spawner,
    });
    const { error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(requests[0].args).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-s",
      "read-only",
      "-C",
      WORK_DIR,
      "resume",
      SESSION_ID,
      "-",
    ]);
    // The thread id announced by codex wins over the resumed id.
    expect(result.sessionId).toBe(OTHER_SESSION_ID);
  });

  it("falls back to the resumed id when codex never announces a thread id", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
    });

    const run = runCodex({
      prompt: PROMPT,
      workDir: WORK_DIR,
      resumeSessionId: SESSION_ID,
      spawner,
    });
    const { error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(result.sessionId).toBe(SESSION_ID);
  });

  it("honors a workspace-write sandbox and the git repo check opt-out", async () => {
    const { spawner, requests } = makeFakeSpawner({
      lines: [SESSION_LINE, AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
    });

    const run = runCodex({
      prompt: PROMPT,
      workDir: WORK_DIR,
      sandbox: "workspace-write",
      skipGitRepoCheck: true,
      spawner,
    });
    await drainEvents(run);
    await run.completed;

    expect(requests[0].args).toEqual([
      "exec",
      "--json",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="xhigh"',
      "-s",
      "workspace-write",
      "-C",
      WORK_DIR,
      "--skip-git-repo-check",
      "-",
    ]);
  });

  it("skips blank and non-JSON lines on stdout", async () => {
    const { spawner } = makeFakeSpawner({
      lines: ["", "not json at all", SESSION_LINE, "{}", AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { events, error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      "session_started",
      "message_completed",
      "turn_completed",
    ]);
    expect(result.finalMessage).toBe("Hello from codex.");
  });

  it("kills the child and fails with CodexAbortedError when the signal fires", async () => {
    const { spawner, child } = makeFakeSpawner({
      lines: [SESSION_LINE],
      stayOpen: true,
    });
    const controller = new AbortController();

    const run = runCodex({
      prompt: PROMPT,
      workDir: WORK_DIR,
      signal: controller.signal,
      spawner,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual({ type: "session_started", sessionId: SESSION_ID });

    controller.abort();

    await expect(iterator.next()).rejects.toBeInstanceOf(CodexAbortedError);
    await expect(run.completed).rejects.toBeInstanceOf(CodexAbortedError);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("fails immediately with CodexAbortedError for an already-aborted signal", async () => {
    const { spawner, child } = makeFakeSpawner({
      lines: [SESSION_LINE],
      stayOpen: true,
    });
    const controller = new AbortController();
    controller.abort();

    const run = runCodex({
      prompt: PROMPT,
      workDir: WORK_DIR,
      signal: controller.signal,
      spawner,
    });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexAbortedError);
    await expect(run.completed).rejects.toBe(error);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("fails with CodexTimeoutError and kills the child when the timeout elapses", async () => {
    const { spawner, child } = makeFakeSpawner({
      lines: [SESSION_LINE],
      stayOpen: true,
    });

    const run = runCodex({
      prompt: PROMPT,
      workDir: WORK_DIR,
      timeoutMs: 50,
      spawner,
    });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexTimeoutError);
    await expect(run.completed).rejects.toBe(error);
    expect(child.killCalls).toEqual(["SIGTERM"]);
  });

  it("maps a non-zero exit to CodexNonZeroExitError with the stderr tail", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [SESSION_LINE],
      stderr: "panic: something broke\n",
      exit: { exitCode: 1, signal: null },
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexNonZeroExitError);
    const codexError = error as CodexNonZeroExitError;
    expect(codexError.kind).toBe("nonzero_exit");
    expect(codexError.exitCode).toBe(1);
    expect(codexError.stderrTail).toContain("panic: something broke");
    expect(codexError.message).toContain("exit code 1");
    await expect(run.completed).rejects.toBe(error);
  });

  it("maps a turn.failed event to a typed failure carrying its message", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [
        SESSION_LINE,
        JSON.stringify({
          type: "turn.failed",
          error: { message: "The model refused to answer." },
        }),
      ],
      exit: { exitCode: 1, signal: null },
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexNonZeroExitError);
    expect((error as CodexNonZeroExitError).message).toContain("The model refused to answer.");
    await expect(run.completed).rejects.toBe(error);
  });

  it("maps quota wording to CodexQuotaExceededError", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [SESSION_LINE],
      stderr: "HTTP 429 Too Many Requests\n",
      exit: { exitCode: 1, signal: null },
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexQuotaExceededError);
    expect((error as CodexQuotaExceededError).kind).toBe("quota_exceeded");
    await expect(run.completed).rejects.toBe(error);
  });

  it("maps a usage-limit turn failure to CodexQuotaExceededError", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [
        SESSION_LINE,
        JSON.stringify({
          type: "turn.failed",
          error: { message: "You've hit your usage limit. Your limit will reset at 5pm." },
        }),
      ],
      exit: { exitCode: 1, signal: null },
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexQuotaExceededError);
    expect((error as CodexQuotaExceededError).message).toContain("usage limit");
    await expect(run.completed).rejects.toBe(error);
  });

  it("maps login errors to CodexNotAuthenticatedError", async () => {
    const { spawner } = makeFakeSpawner({
      lines: [],
      stderr: "Not logged in — run `codex login` to authenticate.\n",
      exit: { exitCode: 1, signal: null },
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexNotAuthenticatedError);
    expect((error as CodexNotAuthenticatedError).kind).toBe("not_authenticated");
    expect((error as CodexNotAuthenticatedError).exitCode).toBe(1);
    await expect(run.completed).rejects.toBe(error);
  });

  it("maps a spawn failure to CodexBinaryNotFoundError", async () => {
    const { spawner } = makeFakeSpawner({
      spawnError: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner });
    const { error } = await drainEvents(run);

    expect(error).toBeInstanceOf(CodexBinaryNotFoundError);
    expect((error as CodexBinaryNotFoundError).kind).toBe("binary_not_found");
    expect((error as CodexBinaryNotFoundError).message).toContain("ENOENT");
    await expect(run.completed).rejects.toBe(error);
  });
});

// ---------------------------------------------------------------------------
// Opt-in live smoke test against the real CLI (single subscription call)
// ---------------------------------------------------------------------------

describe("codex adapter live smoke test", () => {
  const live = process.env.SCOPE_AI_LIVE_TEST === "1" || process.env.LOCALTUBE_AI_LIVE_TEST === "1";

  it.skipIf(!live)(
    "answers a tiny read-only prompt in a temp dir",
    { timeout: 240_000 },
    async () => {
      const workDir = mkdtempSync(path.join(tmpdir(), "localtube-codex-smoke-"));
      try {
        const run = runCodex({
          prompt:
            "Reply with exactly: scope live smoke test OK. Do not run any commands or read any files.",
          workDir,
          sandbox: "read-only",
          skipGitRepoCheck: true,
          timeoutMs: 180_000,
        });

        const events: CodexStreamEvent[] = [];
        let streamError: unknown;
        try {
          for await (const event of run.events) {
            events.push(event);
          }
        } catch (caught) {
          streamError = caught;
        }
        if (streamError !== undefined) {
          // Surface the same typed error from the completion promise instead
          // of leaving an unhandled rejection behind.
          await expect(run.completed).rejects.toBe(streamError);
          throw streamError;
        }

        const result = await run.completed;
        // Raw output of the live run, for the stage report.
        console.log("LIVE SMOKE EVENTS:", JSON.stringify(events, null, 2));
        console.log("LIVE SMOKE RESULT:", JSON.stringify(result, null, 2));

        expect(result.sessionId).toBeTruthy();
        expect(result.finalMessage.trim().length).toBeGreaterThan(0);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  );
});

it("omits the reasoning override for an explicit provider default", async () => {
  const { spawner, requests } = makeFakeSpawner({
    lines: [SESSION_LINE, AGENT_MESSAGE_LINE, TURN_COMPLETED_LINE],
  });
  const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, reasoningEffort: null, spawner });
  await drainEvents(run);
  await run.completed;
  expect(requests[0].args.some((arg) => arg.includes("model_reasoning_effort"))).toBe(false);
});
