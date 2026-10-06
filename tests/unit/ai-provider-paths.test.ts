/*
 * Provider executable-path overrides (desktop release stage 1): validation,
 * persistence, cache resets, and the route contract. The same resolvers that
 * status, sign-in, discovery, and inference use are exercised directly, so a
 * saved path provably reaches every consumer.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DELETE as DELETE_PATH, POST as POST_PATH } from "@/app/api/ai/auth/[provider]/path/route";
import { AuthManager, setAuthManagerForTests } from "@/lib/ai/auth/manager";
import { CodexAccountError } from "@/lib/ai/auth/codex-account-client";
import type { AiAuthSnapshot, ProviderAuthSnapshot } from "@/lib/ai/auth-types";
import { resetClaudeCommandCache, resolveClaudeLaunch } from "@/lib/ai/claude";
import { resolveCodexLaunch } from "@/lib/ai/codex";
import { resetOpencodeCommandCache, resolveOpencodeLaunch } from "@/lib/ai/opencode";
import {
  getProviderPathOverride,
  loadProviderPathOverrides,
  parseProviderPathOverrides,
  resetProviderPathOverrides,
  setProviderPathOverride,
  validateProviderPath,
} from "@/lib/ai/provider-paths";
import { closeDatabase, getDb } from "@/lib/db/connection";

const tempDirs: string[] = [];
const savedDbPath = process.env.SCOPE_DB_PATH;
const savedEnvOverrides = {
  SCOPE_CODEX_PATH: process.env.SCOPE_CODEX_PATH,
  SCOPE_CLAUDE_PATH: process.env.SCOPE_CLAUDE_PATH,
  SCOPE_OPENCODE_BIN: process.env.SCOPE_OPENCODE_BIN,
};
const providerPath = (name: string) =>
  process.platform === "win32" ? `C:\\Tools\\${name}.exe` : `/opt/tools/${name}`;

function snapshotFixture(): AiAuthSnapshot {
  const provider: ProviderAuthSnapshot = {
    installed: true,
    compatible: true,
    authenticated: false,
    subscription: false,
    method: "none",
    detail: null,
    keySaved: false,
    otherCredentialCount: 0,
    deviceCodeAvailable: true,
    attempt: null,
    signingOut: false,
    statusError: null,
    resolvedCommand: "codex",
    commandSource: "auto",
  };
  return {
    instanceId: "test-instance",
    revision: 3,
    checkedAt: "2026-09-19T12:00:00.000Z",
    backend: "codex",
    codex: { ...provider },
    opencode: { ...provider },
    claude: { ...provider },
  };
}

class FixtureManager extends AuthManager {
  constructor(private readonly fixture: AiAuthSnapshot) {
    super();
  }

  override async getSnapshot(): Promise<AiAuthSnapshot> {
    return this.fixture;
  }
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3000${url}`, init);
}

function params(provider: string): { params: Promise<{ provider: string }> } {
  return { params: Promise.resolve({ provider }) };
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-provider-paths-"));
  tempDirs.push(dir);
  process.env.SCOPE_DB_PATH = path.join(dir, "test.db");
  closeDatabase();
  resetProviderPathOverrides();
  resetClaudeCommandCache();
  resetOpencodeCommandCache();
  delete process.env.SCOPE_CODEX_PATH;
  delete process.env.SCOPE_CLAUDE_PATH;
  delete process.env.SCOPE_OPENCODE_BIN;
});

afterEach(() => {
  setAuthManagerForTests(null);
  closeDatabase();
  resetProviderPathOverrides();
  resetClaudeCommandCache();
  resetOpencodeCommandCache();
  if (savedDbPath === undefined) {
    delete process.env.SCOPE_DB_PATH;
  } else {
    process.env.SCOPE_DB_PATH = savedDbPath;
  }
  for (const [key, value] of Object.entries(savedEnvOverrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("provider path validation", () => {
  it("accepts trimmed paths and command names", () => {
    expect(validateProviderPath("  /opt/tools/codex  ", "linux")).toBe("/opt/tools/codex");
    expect(validateProviderPath("codex")).toBe("codex");
    expect(validateProviderPath("C:\\Tools\\codex.exe", "win32")).toBe("C:\\Tools\\codex.exe");
  });

  it("rejects paths that depend on the working directory or drive", () => {
    for (const value of ["./codex", "../bin/codex", "bin/codex", "~/bin/codex", ".", ".."]) {
      expect(validateProviderPath(value)).toBeNull();
    }
    for (const value of ["C:codex.exe", "C:bin\\codex.exe", "\\bin\\codex.exe", "/bin/codex.exe"]) {
      expect(validateProviderPath(value, "win32")).toBeNull();
    }
    expect(parseProviderPathOverrides({ codex: "./old-provider" })).toEqual({});
  });

  it("rejects empty, oversized, and control-character values", () => {
    expect(validateProviderPath("")).toBeNull();
    expect(validateProviderPath("   ")).toBeNull();
    expect(validateProviderPath(null)).toBeNull();
    expect(validateProviderPath(42)).toBeNull();
    expect(validateProviderPath("a".repeat(4097))).toBeNull();
    expect(validateProviderPath("/opt/tools/co\u0000dex")).toBeNull();
    expect(validateProviderPath("/opt/tools/co\ndex")).toBeNull();
  });

  it("parses stored maps without trusting keys or values", () => {
    expect(parseProviderPathOverrides(null)).toEqual({});
    expect(parseProviderPathOverrides([])).toEqual({});
    expect(
      parseProviderPathOverrides({
        codex: ` ${providerPath("codex")} `,
        claude: "",
        unknown: "/tmp/x",
        opencode: 5,
      }),
    ).toEqual({ codex: providerPath("codex") });
  });
});

describe("provider path persistence and resolution", () => {
  it("drives codex, claude, and opencode through the same stored override", async () => {
    const db = getDb();
    expect(resolveCodexLaunch().resolvedCommand).toBe("codex");

    setProviderPathOverride(db, "codex", providerPath("codex"));
    setProviderPathOverride(db, "claude", providerPath("claude"));
    setProviderPathOverride(db, "opencode", providerPath("opencode"));
    resetClaudeCommandCache();
    resetOpencodeCommandCache();

    expect(resolveCodexLaunch().resolvedCommand).toBe(providerPath("codex"));
    expect((await resolveClaudeLaunch()).resolvedCommand).toBe(providerPath("claude"));
    expect((await resolveOpencodeLaunch()).resolvedCommand).toBe(providerPath("opencode"));

    // A fresh process reads the same map back from the settings table.
    resetProviderPathOverrides();
    loadProviderPathOverrides(db);
    expect(resolveCodexLaunch().resolvedCommand).toBe(providerPath("codex"));
    expect(getProviderPathOverride("claude")).toBe(providerPath("claude"));

    setProviderPathOverride(db, "codex", null);
    resetClaudeCommandCache();
    resetOpencodeCommandCache();
    expect(resolveCodexLaunch().resolvedCommand).toBe("codex");
  });

  it("keeps the development environment override ahead of the stored path", () => {
    setProviderPathOverride(getDb(), "codex", providerPath("codex"));
    process.env.SCOPE_CODEX_PATH = providerPath("env-codex");
    expect(resolveCodexLaunch().resolvedCommand).toBe(providerPath("env-codex"));
  });

  it("reports the override and source in the manager snapshot", async () => {
    const manager = new AuthManager({
      connectCodex: () => {
        throw new CodexAccountError("spawn", "codex is not available");
      },
    });
    setProviderPathOverride(getDb(), "codex", providerPath("codex"));
    const overridden = await manager.getProviderSnapshot("codex");
    expect(overridden.resolvedCommand).toBe(providerPath("codex"));
    expect(overridden.commandSource).toBe("override");
    expect(overridden.installed).toBe(false);

    setProviderPathOverride(getDb(), "codex", null);
    manager.invalidateProviderResolution("codex");
    const automatic = await manager.getProviderSnapshot("codex");
    expect(automatic.resolvedCommand).toBe("codex");
    expect(automatic.commandSource).toBe("auto");
  });
});

describe("provider path route", () => {
  beforeEach(() => {
    setAuthManagerForTests(new FixtureManager(snapshotFixture()));
  });

  it("saves a valid executable path and returns a fresh snapshot", async () => {
    const executable = path.join(tempDirs[0], "fake-codex");
    writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
    const response = await POST_PATH(
      request("/api/ai/auth/codex/path", {
        method: "POST",
        body: JSON.stringify({ path: `  ${executable}  ` }),
      }),
      params("codex"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { ok: boolean; snapshot?: AiAuthSnapshot };
    expect(body.ok).toBe(true);
    expect(body.snapshot?.revision).toBe(3);
    expect(getProviderPathOverride("codex")).toBe(executable);
  });

  it("refuses a relative executable instead of saving a cwd-dependent path", async () => {
    const response = await POST_PATH(
      request("/api/ai/auth/codex/path", {
        method: "POST",
        body: JSON.stringify({ path: path.join("tools", "fake-codex") }),
      }),
      params("codex"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_path", message: expect.stringContaining("absolute") },
    });
    expect(getProviderPathOverride("codex")).toBeUndefined();
  });

  it("accepts a bare command name without a filesystem check", async () => {
    const response = await POST_PATH(
      request("/api/ai/auth/opencode/path", {
        method: "POST",
        body: JSON.stringify({ path: "opencode-custom" }),
      }),
      params("opencode"),
    );
    expect(response.status).toBe(200);
    expect(getProviderPathOverride("opencode")).toBe("opencode-custom");
  });

  it("refuses missing, oversized, and non-existent absolute paths", async () => {
    const missing = await POST_PATH(
      request("/api/ai/auth/codex/path", { method: "POST", body: JSON.stringify({}) }),
      params("codex"),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, error: { code: "invalid_path" } });

    const oversized = await POST_PATH(
      request("/api/ai/auth/codex/path", {
        method: "POST",
        body: JSON.stringify({ path: "x".repeat(5000) }),
      }),
      params("codex"),
    );
    expect(oversized.status).toBe(400);

    const nonexistent = await POST_PATH(
      request("/api/ai/auth/codex/path", {
        method: "POST",
        body: JSON.stringify({ path: "/nonexistent/scope-test/provider" }),
      }),
      params("codex"),
    );
    expect(nonexistent.status).toBe(400);
    expect(getProviderPathOverride("codex")).toBeUndefined();
  });

  it("refuses unknown providers and cross-origin writes", async () => {
    const unknown = await POST_PATH(
      request("/api/ai/auth/nope/path", {
        method: "POST",
        body: JSON.stringify({ path: "codex" }),
      }),
      params("nope"),
    );
    expect(unknown.status).toBe(404);

    const crossOrigin = await POST_PATH(
      new Request("http://127.0.0.1:3000/api/ai/auth/codex/path", {
        method: "POST",
        headers: { origin: "https://evil.example.com" },
        body: JSON.stringify({ path: "codex" }),
      }),
      params("codex"),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("clears an override and returns to automatic discovery", async () => {
    setProviderPathOverride(getDb(), "claude", providerPath("claude"));
    const response = await DELETE_PATH(
      request("/api/ai/auth/claude/path", { method: "DELETE" }),
      params("claude"),
    );
    expect(response.status).toBe(200);
    expect(getProviderPathOverride("claude")).toBeUndefined();
  });
});
