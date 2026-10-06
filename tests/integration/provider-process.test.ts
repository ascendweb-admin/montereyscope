/** Real child processes, offline accounts, and the real SDK on every host.
 * Windows goes through npm wrappers, including OpenCode's extensionless bin.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAiRunner } from "@/lib/ai/backend";
import { CodexAccountClient } from "@/lib/ai/auth/codex-account-client";
import { ClaudeLoginSession, getClaudeAuthStatus, logoutClaude } from "@/lib/ai/auth/claude-login";
import {
  getOpenCodeGoCredentialState,
  saveOpenCodeGoKey,
  removeOpenCodeGoKey,
} from "@/lib/ai/auth/opencode-credentials";
import { resolveClaudeLaunch } from "@/lib/ai/claude";
import { resolveCodexLaunch } from "@/lib/ai/codex";
import { resolveOpencodeLaunch } from "@/lib/ai/opencode";
import { CodexModelDiscoveryAdapter } from "@/lib/ai/models/adapters/codex";
import { ClaudeModelDiscoveryAdapter } from "@/lib/ai/models/adapters/claude";
import { OpenCodeModelDiscoveryAdapter } from "@/lib/ai/models/adapters/opencode";

let root: string;
const entries: Record<string, string> = {};
const providers = ["codex", "claude", "opencode"] as const;

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "scope provider Ana Pérez "));
  vi.stubEnv("XDG_DATA_HOME", path.join(root, "data"));
  vi.stubEnv("CODEX_HOME", path.join(root, "codex-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(root, "claude-home"));
  for (const provider of providers) {
    const directory = path.join(root, provider);
    mkdirSync(directory);
    const entry = path.join(directory, provider === "opencode" ? "opencode" : "cli.js");
    copyFileSync(path.resolve("tests/fixtures/provider-process.cjs"), entry);
    chmodSync(entry, 0o755);
    entries[provider] = entry;
    let command = entry;
    if (process.platform === "win32") {
      command = path.join(directory, `${provider}.cmd`);
      // The fallback is the exact Node executing this test, not a developer's provider.
      writeFileSync(
        command,
        `@echo off\r\nSET "_prog=${process.execPath}"\r\n"%_prog%" "%~dp0${path.basename(entry)}" %*\r\n`,
      );
    }
    vi.stubEnv(
      provider === "opencode" ? "SCOPE_OPENCODE_BIN" : `SCOPE_${provider.toUpperCase()}_PATH`,
      command,
    );
  }
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("shared provider launches over real processes", () => {
  it("uses the same Codex entry for account status, login, logout, and model discovery", async () => {
    const client = await CodexAccountClient.connect();
    try {
      expect((await client.readAccount()).account?.type).toBe("chatgpt");
      expect((await client.startBrowserLogin()).loginId).toBe("fixture-login");
      await client.logout();
    } finally {
      await client.close();
    }
    const result = await new CodexModelDiscoveryAdapter().discover({
      signal: AbortSignal.timeout(5000),
    });
    expect(result.models[0].id).toBe("fixture-model");
    expect(readFileSync(path.join(root, "codex", "calls.jsonl"), "utf8")).toContain(
      '"method":"model/list"',
    );
  });

  it("uses the Claude entry for status/login/logout and the real SDK's model listing", async () => {
    expect(await getClaudeAuthStatus()).toMatchObject({
      installed: true,
      authenticated: true,
      compatible: true,
    });
    const launch = await resolveClaudeLaunch();
    let loginUrl = "";
    await new Promise<void>((resolve, reject) => {
      const session = new ClaudeLoginSession(
        launch.command,
        {
          onSpawned: () => {},
          onSpawnError: (message) => reject(new Error(message)),
          onUrl: (url) => {
            loginUrl = url;
          },
          onOutputError: () => {},
          onExit: (code) => (code === 0 ? resolve() : reject(new Error(`Login exited ${code}`))),
          onTimeout: () => reject(new Error("Login timed out")),
          onStdinError: () => reject(new Error("stdin failed")),
        },
        { argsPrefix: launch.argsPrefix, timeoutMs: 5000 },
      );
      session.start();
    });
    expect(loginUrl).toContain("https://claude.ai/");
    await logoutClaude();
    const result = await new ClaudeModelDiscoveryAdapter().discover({
      signal: AbortSignal.timeout(5000),
    });
    expect(result.models[0].runtimeId).toBe("fixture-model");
    expect(readFileSync(path.join(root, "claude", "calls.jsonl"), "utf8")).toContain(
      '"method":"sdk-initialize"',
    );
  }, 15000);

  it("uses the OpenCode entry for model discovery and an isolated credential store", async () => {
    await saveOpenCodeGoKey("fixture-key-not-a-real-account");
    try {
      expect((await getOpenCodeGoCredentialState()).keySaved).toBe(true);
      // Only the public catalog HTTP response is faked; the runtime probe is real.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ data: [{ id: "fixture-model" }] })),
      );
      const result = await new OpenCodeModelDiscoveryAdapter().discover({
        signal: AbortSignal.timeout(5000),
      });
      expect(result.models[0]).toMatchObject({
        id: "fixture-model",
        runtimeCompatibility: "supported",
      });
      expect(readFileSync(path.join(root, "opencode", "calls.jsonl"), "utf8")).toContain(
        '"models","opencode-go"',
      );
    } finally {
      vi.unstubAllGlobals();
      await removeOpenCodeGoKey();
    }
    expect((await getOpenCodeGoCredentialState()).keySaved).toBe(false);
  });

  for (const provider of providers) {
    it(`${provider}: resolves one entry for chat and a report file with spaces and Unicode in paths`, async () => {
      const launch =
        provider === "codex"
          ? resolveCodexLaunch()
          : provider === "claude"
            ? await resolveClaudeLaunch()
            : await resolveOpencodeLaunch();
      expect(launch.kind).toBe(process.platform === "win32" ? "script" : "native");
      expect(launch.argsPrefix[0] ?? launch.command).toBe(entries[provider]);
      const runner = await createAiRunner(provider);
      const workDir = path.join(root, provider, "report space é");
      mkdirSync(workDir);
      const chat = await runner({ prompt: "Summarize offline", workDir, timeoutMs: 5000 })
        .completed;
      expect(chat.finalMessage).toBe("Offline answer");
      expect(existsSync(path.join(workDir, "report.html"))).toBe(false);
      await runner({ prompt: "Write report.html", workDir, timeoutMs: 5000 }).completed;
      expect(readFileSync(path.join(workDir, "report.html"), "utf8")).toContain("Offline report");
      const calls = readFileSync(path.join(root, provider, "calls.jsonl"), "utf8");
      expect(calls).toContain('"prompt":"Summarize offline');
      expect(calls).toContain('"prompt":"Write report.html');
    });
  }
});
