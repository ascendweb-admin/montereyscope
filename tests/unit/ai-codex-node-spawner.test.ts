import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexBinaryNotFoundError, createNodeCodexSpawner, runCodex } from "@/lib/ai/codex";

// Fixture JSONL matching the codex 0.150.1 event schema.
const SESSION_ID = "0f1e2d3c-4b5a-4678-8796-a5b4c3d2e1f0";
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

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

class MockNodeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((): boolean => true);
}

// The real spawner's Node-specific behavior, verified against a mocked
// child_process. This file is kept separate from ai-codex.test.ts so the
// file-wide mock cannot interfere with the live smoke test's real spawn.
describe("createNodeCodexSpawner", () => {
  afterEach(() => {
    spawnMock.mockReset();
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
  });

  it("spawns without a shell, strips API keys from the environment, and pipes the prompt", async () => {
    process.env.OPENAI_API_KEY = "sk-must-never-leak";
    process.env.CODEX_API_KEY = "also-never";
    const child = new MockNodeChild();
    spawnMock.mockReturnValue(child);
    let stdinText = "";
    let stdinEnded = false;
    child.stdin.on("data", (chunk) => {
      stdinText += String(chunk);
    });
    child.stdin.on("end", () => {
      stdinEnded = true;
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner: createNodeCodexSpawner() });
    child.stdout.write(`${SESSION_LINE}\n`);
    child.stdout.write(`${AGENT_MESSAGE_LINE}\n`);
    child.stdout.write(`${TURN_COMPLETED_LINE}\n`);
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await run.completed;

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.finalMessage).toBe("Hello from codex.");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe("codex");
    // Argument arrays only — the shell is never involved.
    expect(args).toEqual([
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
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.cwd).toBe(WORK_DIR);
    const env = options.env as Record<string, string | undefined>;
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(stdinText).toBe(PROMPT);
    expect(stdinEnded).toBe(true);
  });

  it("maps a spawn ENOENT to CodexBinaryNotFoundError", async () => {
    spawnMock.mockImplementation(() => {
      const child = new MockNodeChild();
      queueMicrotask(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
      });
      return child;
    });

    const run = runCodex({ prompt: PROMPT, workDir: WORK_DIR, spawner: createNodeCodexSpawner() });

    await expect(run.completed).rejects.toBeInstanceOf(CodexBinaryNotFoundError);
  });
});
