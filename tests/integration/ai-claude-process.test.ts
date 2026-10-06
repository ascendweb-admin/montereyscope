/**
 * Claude adapter process integration (offline).
 *
 * Unlike tests/unit/ai-claude.test.ts (which injects a fake spawner), this
 * suite spawns a real child process: a tiny fake `claude` executable written
 * to a temp directory. It verifies the full Node spawn path — argv delivery,
 * stdin prompt, environment stripping, NDJSON streaming, resume, cancellation,
 * failures, and a report-style write into the working directory — without the
 * installed CLI or any subscription.
 */
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  CodexAbortedError,
  CodexNonZeroExitError,
  CodexNotAuthenticatedError,
} from "@/lib/ai/codex";
import { buildClaudeArgs, createNodeClaudeSpawner, runClaude } from "@/lib/ai/claude";
import { findReportFile, REPORT_FILE_NAME } from "@/lib/ai/reports";

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const scenario = process.env.FAKE_CLAUDE_SCENARIO || "success";
const recordFile = process.env.FAKE_CLAUDE_RECORD;
const session = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const emit = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeIndex = args.indexOf("--resume");
  const activeSession = resumeIndex === -1 ? session : args[resumeIndex + 1];
  if (recordFile) {
    fs.writeFileSync(recordFile, JSON.stringify({
      args,
      cwd: process.cwd(),
      prompt,
      apiKey: process.env.ANTHROPIC_API_KEY ?? null,
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
      configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    }));
  }
  if (scenario === "hang") {
    setTimeout(() => process.exit(0), 60_000);
    return;
  }
  emit({ type: "system", subtype: "init", session_id: activeSession, tools: ["Read"] });
  if (scenario === "auth-error") {
    emit({ type: "result", subtype: "success", is_error: true, session_id: activeSession,
      result: "Not logged in \\u00b7 Please run /login", api_error_status: null, usage: {} });
    return;
  }
  if (scenario === "no-result") {
    emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }, session_id: activeSession });
    return;
  }
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Grounded " } }, session_id: activeSession });
  emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "answer." } }, session_id: activeSession });
  emit({ type: "assistant", parent_tool_use_id: null, session_id: activeSession,
    message: { id: "msg_1", content: [{ type: "text", text: "Grounded answer." }] } });
  if (scenario === "report") {
    fs.writeFileSync(process.cwd() + "/" + ${JSON.stringify(REPORT_FILE_NAME)},
      "<!doctype html><html><head><title>Report</title></head><body><h1>Grounded report</h1></body></html>");
  }
  emit({ type: "result", subtype: "success", is_error: false, session_id: activeSession,
    result: "Grounded answer.",
    usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 3 } });
});
process.on("SIGTERM", () => process.exit(143));
`;

const dirs: string[] = [];
const posixOnly = process.platform === "win32" ? it.skip : it;

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function createFakeClaude(): string {
  const dir = makeDir("scope-claude-bin-");
  const file = path.join(dir, "claude");
  writeFileSync(file, FAKE_CLAUDE_SOURCE, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function makeRecordFile(): string {
  return path.join(makeDir("scope-claude-record-"), "record.json");
}

interface RecordedRun {
  args: string[];
  cwd: string;
  prompt: string;
  apiKey: string | null;
  baseUrl: string | null;
  configDir: string | null;
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<RecordedRun> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, "utf8")) as RecordedRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

beforeEach(() => {
  delete process.env.FAKE_CLAUDE_RECORD;
  process.env.FAKE_CLAUDE_SCENARIO = "success";
  // Ambient credentials that must never reach the child.
  process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
  process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com";
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.FAKE_CLAUDE_RECORD;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runClaude over a real child process", () => {
  posixOnly("streams a grounded turn and records the isolated spawn", async () => {
    const command = createFakeClaude();
    const recordFile = makeRecordFile();
    process.env.FAKE_CLAUDE_RECORD = recordFile;
    const workDir = makeDir("scope-claude-work-");
    process.env.CLAUDE_CONFIG_DIR = "/tmp/scope-claude-config";

    const run = runClaude({
      prompt: "Summarize transcripts/abc.txt",
      workDir,
      model: "sonnet",
      reasoningEffort: "medium",
      spawner: createNodeClaudeSpawner(),
      command,
    });
    const deltas: string[] = [];
    for await (const event of run.events) {
      if (event.type === "text_delta") {
        deltas.push(event.text);
      }
    }
    const result = await run.completed;

    expect(deltas.join("")).toBe("Grounded answer.");
    expect(result.finalMessage).toBe("Grounded answer.");
    expect(result.sessionId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(result.usage?.totalTokens).toBe(20);

    const recorded = await waitForFile(recordFile);
    expect(realpathSync(recorded.cwd)).toBe(realpathSync(workDir));
    expect(recorded.prompt).toBe("Summarize transcripts/abc.txt");
    expect(recorded.args).toEqual(
      buildClaudeArgs({ model: "sonnet", reasoningEffort: "medium", sandbox: "read-only" }),
    );
    // Ambient credentials are stripped; the native login location is kept.
    expect(recorded.apiKey).toBeNull();
    expect(recorded.baseUrl).toBeNull();
    expect(recorded.configDir).toBe("/tmp/scope-claude-config");
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  posixOnly("resumes the requested session id and writes a report deliverable", async () => {
    const command = createFakeClaude();
    const recordFile = makeRecordFile();
    process.env.FAKE_CLAUDE_RECORD = recordFile;
    process.env.FAKE_CLAUDE_SCENARIO = "report";
    const jobDir = makeDir("scope-claude-job-");

    const run = runClaude({
      prompt: "Write report.html",
      workDir: jobDir,
      sandbox: "workspace-write",
      model: "opus",
      reasoningEffort: "xhigh",
      resumeSessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      spawner: createNodeClaudeSpawner(),
      command,
    });
    await run.completed;

    const recorded = await waitForFile(recordFile);
    expect(recorded.args).toEqual(
      expect.arrayContaining(["--resume", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"]),
    );
    expect(recorded.args).toEqual(expect.arrayContaining(["--tools", "Read,Grep,Glob,Write"]));
    expect(findReportFile(jobDir)).toBe(path.join(jobDir, REPORT_FILE_NAME));
  });

  posixOnly("classifies an auth error result even though the process exits zero", async () => {
    const command = createFakeClaude();
    process.env.FAKE_CLAUDE_SCENARIO = "auth-error";
    const run = runClaude({
      prompt: "hello",
      workDir: makeDir("scope-claude-work-"),
      spawner: createNodeClaudeSpawner(),
      command,
    });
    await expect(run.completed).rejects.toBeInstanceOf(CodexNotAuthenticatedError);
  });

  posixOnly("fails a zero-exit run that never reports a terminal result", async () => {
    const command = createFakeClaude();
    process.env.FAKE_CLAUDE_SCENARIO = "no-result";
    const run = runClaude({
      prompt: "hello",
      workDir: makeDir("scope-claude-work-"),
      spawner: createNodeClaudeSpawner(),
      command,
    });
    await expect(run.completed).rejects.toBeInstanceOf(CodexNonZeroExitError);
  });

  posixOnly("kills the child when the turn is aborted", async () => {
    const command = createFakeClaude();
    process.env.FAKE_CLAUDE_SCENARIO = "hang";
    const controller = new AbortController();
    const run = runClaude({
      prompt: "hello",
      workDir: makeDir("scope-claude-work-"),
      spawner: createNodeClaudeSpawner(),
      command,
      signal: controller.signal,
    });
    const iterator = run.events[Symbol.asyncIterator]();
    const first = iterator.next();
    setTimeout(() => controller.abort(), 150);
    await first.catch(() => {});
    await expect(run.completed).rejects.toBeInstanceOf(CodexAbortedError);
  });

  posixOnly("maps a missing executable to binary_not_found", async () => {
    const run = runClaude({
      prompt: "hello",
      workDir: makeDir("scope-claude-work-"),
      spawner: createNodeClaudeSpawner(),
      command: path.join(tmpdir(), "definitely-missing-claude-binary"),
    });
    await expect(run.completed).rejects.toMatchObject({ kind: "binary_not_found" });
  });
});
