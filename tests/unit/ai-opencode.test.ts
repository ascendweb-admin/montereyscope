import { afterEach, describe, expect, it } from "vitest";

import {
  CodexAbortedError,
  CodexBinaryNotFoundError,
  CodexNotAuthenticatedError,
  CodexQuotaExceededError,
} from "@/lib/ai/codex";
import { runOpencode, type OpenCodeRunOptions } from "@/lib/ai/opencode";
import type {
  CodexChildProcess,
  CodexExitStatus,
  CodexRun,
  CodexSpawnRequest,
  CodexSpawner,
  CodexStreamEvent,
} from "@/lib/ai/codex";

// ---------------------------------------------------------------------------
// Fixture JSONL matching the opencode 1.18.x `run --format json` schema
// ---------------------------------------------------------------------------

const SESSION_ID = "ses_f972bd039ffeuagY7F24bvfLFF";
const WORK_DIR = "/tmp/localtube-work";
const PROMPT = "Summarize the transcripts in this directory.";

function stepStart(sessionId: string = SESSION_ID): string {
  return JSON.stringify({
    type: "step_start",
    timestamp: 1788465134147,
    sessionID: sessionId,
    part: { id: "prt_step", messageID: "msg_0", sessionID: sessionId, type: "step-start" },
  });
}

function textLine(text: string, partId = "prt_text_0"): string {
  return JSON.stringify({
    type: "text",
    timestamp: 1788465134667,
    sessionID: SESSION_ID,
    part: {
      id: partId,
      messageID: "msg_0",
      sessionID: SESSION_ID,
      type: "text",
      text,
      time: { start: 1788465134632, end: 1788465134664 },
    },
  });
}

function stepFinish(tokens?: {
  input: number;
  output: number;
  reasoning: number;
  cache: { write: number; read: number };
}): string {
  return JSON.stringify({
    type: "step_finish",
    timestamp: 1788465134684,
    sessionID: SESSION_ID,
    part: {
      id: "prt_finish",
      reason: "stop",
      messageID: "msg_0",
      sessionID: SESSION_ID,
      type: "step-finish",
      ...(tokens ? { tokens } : {}),
    },
  });
}

function errorLine(name: string, message: string): string {
  return JSON.stringify({
    type: "error",
    timestamp: 1788465275341,
    sessionID: SESSION_ID,
    error: { name, data: { message, ref: "err_test" } },
  });
}

// ---------------------------------------------------------------------------
// Fake child process and spawner (same shape as the codex adapter's tests)
// ---------------------------------------------------------------------------

interface FakeChildSpec {
  lines?: string[];
  stderr?: string;
  exit?: CodexExitStatus;
  stayOpen?: boolean;
  spawnError?: Error;
}

class FakeOpenCodeChild implements CodexChildProcess {
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

  pushLine(line: string): void {
    this.queuedLines.push(line);
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
      while (this.queuedLines.length > 0) {
        const line = this.queuedLines.shift() as string;
        yield `${line}\n`;
      }
      if (this.closed) {
        return;
      }
      if (!this.spec.stayOpen) {
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
  child: FakeOpenCodeChild;
  requests: CodexSpawnRequest[];
} {
  const child = new FakeOpenCodeChild(spec);
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
  overrides: Partial<OpenCodeRunOptions> = {},
): {
  run: CodexRun;
  child: FakeOpenCodeChild;
  requests: CodexSpawnRequest[];
} {
  const fake = makeFakeSpawner(spec);
  const run = runOpencode({
    prompt: PROMPT,
    workDir: WORK_DIR,
    spawner: fake.spawner,
    command: "/usr/bin/opencode",
    ...overrides,
  });
  return { run, child: fake.child, requests: fake.requests };
}

afterEach(() => {
  // Nothing global to clean, but kept for symmetry with the codex suite.
});

// ---------------------------------------------------------------------------
// Argument construction and prompt delivery
// ---------------------------------------------------------------------------

describe("runOpencode arguments", () => {
  it("spawns opencode run --format json with no model flags and the prompt on stdin", async () => {
    const { run, child, requests } = runWith({
      lines: [stepStart(), textLine("OK"), stepFinish()],
    });
    const { error } = await drainEvents(run);
    await run.completed;
    expect(error).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(requests[0].command).toBe("/usr/bin/opencode");
    expect(requests[0].args).toEqual(["run", "--format", "json"]);
    expect(requests[0].cwd).toBe(WORK_DIR);
    expect(child.stdinWrites).toEqual([PROMPT]);
    expect(child.stdinEnded).toBe(true);
  });

  it("resumes with --session when a session id is given", async () => {
    const { run, requests } = runWith(
      { lines: [textLine("again"), stepFinish()] },
      { resumeSessionId: SESSION_ID },
    );
    await drainEvents(run);
    await run.completed;
    expect(requests[0].args).toEqual(["run", "--format", "json", "--session", SESSION_ID]);
  });

  it("passes a provider-qualified model and its reasoning variant", async () => {
    const { run, requests } = runWith(
      { lines: [textLine("deep"), stepFinish()] },
      { model: "opencode-go/deepseek-v4-pro", reasoningEffort: "max" },
    );
    await drainEvents(run);
    await run.completed;
    expect(requests[0].args).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "opencode-go/deepseek-v4-pro",
      "--variant",
      "max",
    ]);
  });

  it("omits the variant flag when a model uses the provider default", async () => {
    const { run, requests } = runWith(
      { lines: [textLine("default"), stepFinish()] },
      { model: "opencode-go/glm-5.1" },
    );
    await drainEvents(run);
    await run.completed;
    expect(requests[0].args).toEqual(["run", "--format", "json", "--model", "opencode-go/glm-5.1"]);
  });
});

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

describe("runOpencode events", () => {
  it("maps text parts and step_finish into deltas, a completed message, and usage", async () => {
    const { run } = runWith({
      lines: [
        stepStart(),
        textLine("Hel"),
        textLine("Hello", "prt_text_0"),
        stepFinish({ input: 100, output: 20, reasoning: 5, cache: { write: 3, read: 10 } }),
      ],
    });
    const { events, error } = await drainEvents(run);
    const result = await run.completed;

    expect(error).toBeUndefined();
    expect(events.some((event) => event.type === "session_started")).toBe(true);
    expect(
      events.filter((event) => event.type === "text_delta").map((event) => event.text),
    ).toEqual(["Hel", "lo"]);
    expect(
      events.filter((event) => event.type === "message_completed").map((event) => event.text),
    ).toEqual(["Hello"]);
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
    expect(result.finalMessage).toBe("Hello");
    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 3,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: null,
    });
  });

  it("keeps the newest text part as the final message across steps", async () => {
    const { run } = runWith({
      lines: [
        stepStart(),
        textLine("first draft", "prt_a"),
        stepFinish(),
        stepStart(),
        textLine("final answer", "prt_b"),
        stepFinish(),
      ],
    });
    const { events } = await drainEvents(run);
    const result = await run.completed;
    const completed = events
      .filter((event) => event.type === "message_completed")
      .map((event) => event.text);
    expect(completed).toEqual(["first draft", "final answer"]);
    expect(result.finalMessage).toBe("final answer");
  });

  it("tolerates non-JSON noise on stdout", async () => {
    const { run } = runWith({
      lines: ["opencode booting…", textLine("done"), "", stepFinish()],
    });
    const { error } = await drainEvents(run);
    const result = await run.completed;
    expect(error).toBeUndefined();
    expect(result.finalMessage).toBe("done");
  });

  it("reports a null usage when step_finish carries no tokens", async () => {
    const { run } = runWith({ lines: [textLine("hi"), stepFinish()] });
    await drainEvents(run);
    const result = await run.completed;
    expect(result.usage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

describe("runOpencode failures", () => {
  it("classifies a ProviderAuthError event as not_authenticated", async () => {
    const { run } = runWith({
      lines: [errorLine("ProviderAuthError", "No credentials found for provider openai")],
      exit: { exitCode: 1, signal: null },
    });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexNotAuthenticatedError);
  });

  it("classifies quota-shaped failures as quota_exceeded even alongside auth words", async () => {
    const { run } = runWith({
      lines: [errorLine("UnknownError", "request failed: 429 usage limit reached")],
      exit: { exitCode: 1, signal: null },
    });
    const { error } = await drainEvents(run);
    expect(error).toBeInstanceOf(CodexQuotaExceededError);
  });

  it("classifies other error events as nonzero_exit", async () => {
    const { run } = runWith({
      lines: [errorLine("ModelNotFoundError", "model nope/missing does not exist")],
      exit: { exitCode: 1, signal: null },
    });
    const { error } = await drainEvents(run);
    expect(error).not.toBeInstanceOf(CodexNotAuthenticatedError);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("model nope/missing does not exist");
  });

  it("maps spawn failure to binary_not_found", async () => {
    const { run } = runWith({
      spawnError: Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }),
    });
    await expect(run.completed).rejects.toBeInstanceOf(CodexBinaryNotFoundError);
  });

  it("maps abort to CodexAbortedError and kills the child", async () => {
    const controller = new AbortController();
    const { run, child } = runWith(
      { lines: [stepStart()], stayOpen: true },
      {
        signal: controller.signal,
      },
    );
    const iterator = run.events[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await drainEvents(run);
    await expect(run.completed).rejects.toBeInstanceOf(CodexAbortedError);
    expect(child.killCalls).toContain("SIGTERM");
  });
});
