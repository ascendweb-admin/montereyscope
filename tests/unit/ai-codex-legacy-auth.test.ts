/*
 * Legacy codex fallback tests (provider-auth stage): a fake `codex` binary
 * that does not implement the app-server account protocol (initialize
 * answers method-not-found) but does support `codex login status`,
 * `codex login`, and `codex logout`. The manager must fall back to the legacy
 * flow with the same account-method distinction, login tracking, and
 * sign-out verification. No real CLI or account is touched.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAiAuthStatus,
  getCodexLoginState,
  logoutProvider,
  startCodexLogin,
} from "@/lib/ai/auth";
import { extractLegacyCodexUrl } from "@/lib/ai/auth/manager";
import { setAuthManagerForTests } from "@/lib/ai/auth/manager";

const FAKE_LEGACY_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CODEX_STATE_FILE;
function state() {
  try { return fs.readFileSync(stateFile, "utf8").trim(); } catch { return "signed-out"; }
}
function setState(value) { try { fs.writeFileSync(stateFile, value); } catch {} }

if (args[0] === "app-server") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not found" } }) + "\\n");
    }
  });
  rl.on("close", () => process.exit(0));
  return;
}
if (args[0] === "login" && args[1] === "status") {
  if (state() === "signed-in") {
    process.stderr.write("Logged in using ChatGPT\\n");
    process.exit(0);
  }
  if (state() === "api-key") {
    process.stderr.write("Logged in using an API key\\n");
    process.exit(0);
  }
  process.stderr.write("Not logged in\\n");
  process.exit(1);
}
if (args[0] === "login") {
  process.stderr.write("Starting local login server on http://localhost:1455\\n");
  process.stderr.write("If your browser did not open, navigate to: https://auth.openai.com/oauth/authorize?client_id=legacy\\n");
  setState("signed-in");
  setTimeout(() => process.exit(0), 150);
  return;
}
if (args[0] === "logout") {
  setState("signed-out");
  process.exit(0);
}
process.stderr.write("unexpected args: " + args.join(" ") + "\\n");
process.exit(1);
`;

const tempDirs: string[] = [];
const posixOnly = process.platform === "win32" ? it.skip : it;
const savedEnv: Record<string, string | undefined> = {};

function createFakeCodex(): { command: string; stateFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-fake-legacy-codex-"));
  tempDirs.push(dir);
  const command = path.join(dir, "codex");
  writeFileSync(command, FAKE_LEGACY_CODEX, "utf8");
  chmodSync(command, 0o755);
  return { command, stateFile: path.join(dir, "state.txt") };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

let fake: { command: string; stateFile: string };

beforeEach(() => {
  fake = createFakeCodex();
  writeFileSync(fake.stateFile, "signed-out", "utf8");
  for (const key of [
    "SCOPE_CODEX_PATH",
    "SCOPE_CLAUDE_PATH",
    "SCOPE_OPENCODE_BIN",
    "FAKE_CODEX_STATE_FILE",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.SCOPE_CODEX_PATH = fake.command;
  process.env.FAKE_CODEX_STATE_FILE = fake.stateFile;
  process.env.SCOPE_CLAUDE_PATH = path.join(tmpdir(), "scope-no-such-claude");
  process.env.SCOPE_OPENCODE_BIN = path.join(tmpdir(), "scope-no-such-opencode");
  setAuthManagerForTests(null);
});

afterEach(() => {
  setAuthManagerForTests(null);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("legacy codex URL extraction", () => {
  it("accepts only https URLs on official hosts", () => {
    expect(extractLegacyCodexUrl("visit https://auth.openai.com/oauth/authorize?x=1 now")).toBe(
      "https://auth.openai.com/oauth/authorize?x=1",
    );
    expect(extractLegacyCodexUrl("https://chatgpt.com/codex")).toBe("https://chatgpt.com/codex");
    expect(extractLegacyCodexUrl("https://evil.example.com/login")).toBeNull();
    expect(extractLegacyCodexUrl("http://auth.openai.com/x")).toBeNull();
  });
});

describe("legacy codex fallback", () => {
  posixOnly("reports a ChatGPT account from `codex login status`", async () => {
    writeFileSync(fake.stateFile, "signed-in", "utf8");
    const status = await getAiAuthStatus();
    expect(status.codex).toMatchObject({
      installed: true,
      compatible: true,
      authenticated: true,
      subscription: true,
      method: "chatgpt",
      statusError: null,
    });
    expect(status.codex.detail).toMatch(/logged in using chatgpt/i);
  });

  posixOnly("distinguishes an API-key account from a subscription", async () => {
    writeFileSync(fake.stateFile, "api-key", "utf8");
    const status = await getAiAuthStatus();
    expect(status.codex).toMatchObject({
      authenticated: true,
      subscription: false,
      method: "api_key",
    });
  });

  posixOnly("tracks the legacy login and proves success by re-probing status", async () => {
    const started = await startCodexLogin("browser");
    expect(started.ok).toBe(true);
    await waitFor(() => getCodexLoginState().inProgress === false);
    const state = getCodexLoginState();
    expect(state.lastExitCode).toBe(0);
    expect(state.lastError).toBeNull();
    expect(readFileSync(fake.stateFile, "utf8")).toBe("signed-in");
  });

  posixOnly("signs out through the native `codex logout` and verifies the result", async () => {
    writeFileSync(fake.stateFile, "signed-in", "utf8");
    const result = await logoutProvider("codex");
    expect(result.ok).toBe(true);
    expect(readFileSync(fake.stateFile, "utf8")).toBe("signed-out");
  });
});
