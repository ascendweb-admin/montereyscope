import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cancelClaudeLogin,
  extractClaudeLoginUrl,
  getClaudeAuthStatus,
  getClaudeLoginState,
  isClaudeSubscriptionMethod,
  isSupportedClaudeVersion,
  logoutProvider,
  parseClaudeVersion,
  startClaudeLogin,
  submitClaudeLoginCode,
} from "@/lib/ai/auth";
import { ClaudeLoginSession } from "@/lib/ai/auth/claude-login";
import { setAuthManagerForTests } from "@/lib/ai/auth/manager";
import {
  claudeChildEnvironment,
  MIN_SUPPORTED_CLAUDE_VERSION,
  resetClaudeCommandCache,
} from "@/lib/ai/claude";

// ---------------------------------------------------------------------------
// Pure helpers (run on every platform)
// ---------------------------------------------------------------------------

describe("claude version and auth helpers", () => {
  it("parses the version line and compares against the supported floor", () => {
    expect(parseClaudeVersion("2.1.241 (Claude Code)")).toBe("2.1.241");
    expect(parseClaudeVersion("no version here")).toBeNull();
    expect(isSupportedClaudeVersion("2.1.241")).toBe(true);
    expect(isSupportedClaudeVersion(MIN_SUPPORTED_CLAUDE_VERSION)).toBe(true);
    expect(isSupportedClaudeVersion("2.1.100")).toBe(false);
    expect(isSupportedClaudeVersion("2.0.99")).toBe(false);
    expect(isSupportedClaudeVersion("3.0.0")).toBe(true);
    expect(isSupportedClaudeVersion(null)).toBe(false);
  });

  it("recognizes only subscription-shaped auth methods", () => {
    expect(isClaudeSubscriptionMethod("oauth")).toBe(true);
    expect(isClaudeSubscriptionMethod("claudeai")).toBe(true);
    expect(isClaudeSubscriptionMethod("Pro")).toBe(true);
    expect(isClaudeSubscriptionMethod("console")).toBe(false);
    expect(isClaudeSubscriptionMethod("api_key")).toBe(false);
    expect(isClaudeSubscriptionMethod("bedrock")).toBe(false);
    expect(isClaudeSubscriptionMethod("user_oauth")).toBe(false);
    expect(isClaudeSubscriptionMethod(null)).toBe(false);
  });

  it("extracts only official https login URLs, even inside OSC-8 hyperlinks", () => {
    const wrapped =
      "\u001b]8;;https://claude.com/cai/oauth/authorize?code=true&x=1\u001b\\" +
      "https://claude.com/cai/oauth/authorize?code=true&x=1\u001b]8;;\u001b\\";
    expect(extractClaudeLoginUrl(`visit: ${wrapped}`)).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&x=1",
    );
    expect(extractClaudeLoginUrl("visit: https://claude.com/cai/oauth/au")).toBeNull();
    expect(extractClaudeLoginUrl("visit: https://claude.com/cai/oauth/authorize?code=true\n")).toBe(
      "https://claude.com/cai/oauth/authorize?code=true",
    );
    expect(extractClaudeLoginUrl("https://evil.example.com/login")).toBeNull();
    expect(extractClaudeLoginUrl("http://claude.com/insecure")).toBeNull();
    expect(extractClaudeLoginUrl("no url at all")).toBeNull();
  });

  it("strips ambient credentials from the claude child environment", () => {
    const env = claudeChildEnvironment({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude-alt",
      ANTHROPIC_API_KEY: "sk-no",
      ANTHROPIC_AUTH_TOKEN: "bearer-no",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-no",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      ANTHROPIC_MODEL: "claude-fable-5",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    // Locations the native login needs are preserved.
    expect(env.HOME).toBe("/home/tester");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/tester/.claude-alt");
    expect(env.PATH).toBe("/usr/bin");
  });
});

// ---------------------------------------------------------------------------
// Status and login against a fake claude executable
//
// The fake is a tiny Node script (POSIX only); it lets the real execFile and
// spawn paths run without touching the installed CLI or any subscription.
// ---------------------------------------------------------------------------

const FAKE_CLAUDE_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || "logged-in";

if (args.includes("--version")) {
  process.stdout.write(mode === "old" ? "2.1.100 (Claude Code)\\n" : "2.1.241 (Claude Code)\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (mode === "noise") process.stdout.write("mise ~/.config/mise/config.toml tools: claude@2.1.241\\n");
  const payload = mode === "console"
    ? { loggedIn: true, authMethod: "console", apiProvider: "firstParty" }
    : mode === "signed-out"
      ? { loggedIn: false, authMethod: "none", apiProvider: "firstParty" }
      : { loggedIn: true, authMethod: "oauth", apiProvider: "firstParty", email: "analyst@example.com" };
  process.stdout.write(JSON.stringify(payload) + "\\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "logout") {
  if (process.env.FAKE_CLAUDE_LOGOUT_FILE) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_LOGOUT_FILE, "logged out");
  }
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "login") {
  if (process.env.FAKE_CLAUDE_LOGIN_SLEEP === "1") {
    process.on("SIGTERM", () => process.exit(143));
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write("Opening browser to sign in\\u2026\\n");
  const url = "https://claude.com/cai/oauth/authorize?code=true&client_id=test";
  if (process.env.FAKE_CLAUDE_SPLIT_URL === "1") {
    process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/au");
    setTimeout(() => {
      process.stdout.write("thorize?code=true&client_id=test\\n");
      process.stdout.write("Paste code here if prompted > ");
    }, 25);
  } else {
    process.stdout.write("If the browser didn't open, visit: " + url + "\\n");
    process.stdout.write("Paste code here if prompted > ");
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const code = String(chunk).trim();
    if (process.env.FAKE_CLAUDE_CODE_FILE) {
      fs.writeFileSync(process.env.FAKE_CLAUDE_CODE_FILE, code);
    }
    if (code === "bad-code") {
      process.stdout.write("Invalid code. Please make sure the full code was copied.\\n");
      return;
    }
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(143));
  return;
}

process.stderr.write("unexpected args: " + args.join(" ") + "\\n");
process.exit(1);
`;

const tempDirs: string[] = [];
const posixOnly = process.platform === "win32" ? it.skip : it;

function createFakeClaude(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-fake-claude-"));
  tempDirs.push(dir);
  const file = path.join(dir, "claude");
  writeFileSync(file, FAKE_CLAUDE_SOURCE, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function writeCodeFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-fake-code-"));
  tempDirs.push(dir);
  return path.join(dir, "code.txt");
}

function writeMarkerFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-fake-marker-"));
  tempDirs.push(dir);
  return path.join(dir, "marker.txt");
}

const savedEnv: Record<string, string | undefined> = {};

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

beforeEach(() => {
  for (const key of [
    "SCOPE_CLAUDE_PATH",
    "SCOPE_CODEX_PATH",
    "SCOPE_OPENCODE_BIN",
    "FAKE_CLAUDE_MODE",
    "FAKE_CLAUDE_CODE_FILE",
    "FAKE_CLAUDE_LOGOUT_FILE",
    "FAKE_CLAUDE_SPLIT_URL",
    "FAKE_CLAUDE_LOGIN_SLEEP",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env.SCOPE_CLAUDE_PATH = createFakeClaude();
  // The facade's snapshot probes all providers; keep codex/opencode probes
  // away from the developer's real CLIs and account.
  process.env.SCOPE_CODEX_PATH = path.join(tmpdir(), "scope-no-such-codex");
  process.env.SCOPE_OPENCODE_BIN = path.join(tmpdir(), "scope-no-such-opencode");
  process.env.FAKE_CLAUDE_MODE = "logged-in";
  delete process.env.FAKE_CLAUDE_CODE_FILE;
  delete process.env.FAKE_CLAUDE_LOGOUT_FILE;
  delete process.env.FAKE_CLAUDE_SPLIT_URL;
  delete process.env.FAKE_CLAUDE_LOGIN_SLEEP;
  resetClaudeCommandCache();
  setAuthManagerForTests(null);
});

afterEach(async () => {
  await cancelClaudeLogin();
  setAuthManagerForTests(null);
  await waitFor(() => getClaudeLoginState().inProgress === false).catch(() => {});
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetClaudeCommandCache();
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("getClaudeAuthStatus", () => {
  posixOnly("reports an installed subscription login with its version", async () => {
    const status = await getClaudeAuthStatus();
    expect(status).toMatchObject({
      installed: true,
      authenticated: true,
      subscription: true,
      authMethod: "oauth",
      version: "2.1.241",
      compatible: true,
    });
    expect(status.detail).toContain("v2.1.241");
    expect(status.detail).not.toContain("@");
    expect(JSON.stringify(status)).not.toContain("sk-");
  });

  posixOnly("marks a Console credential as connected but not subscription", async () => {
    process.env.FAKE_CLAUDE_MODE = "console";
    const status = await getClaudeAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.subscription).toBe(false);
    expect(status.authMethod).toBe("console");
  });

  posixOnly("reports a signed-out CLI", async () => {
    process.env.FAKE_CLAUDE_MODE = "signed-out";
    const status = await getClaudeAuthStatus();
    expect(status.installed).toBe(true);
    expect(status.authenticated).toBe(false);
    expect(status.subscription).toBe(false);
    expect(status.authMethod).toBe("none");
  });

  posixOnly("flags a CLI older than the supported floor", async () => {
    process.env.FAKE_CLAUDE_MODE = "old";
    const status = await getClaudeAuthStatus();
    expect(status.version).toBe("2.1.100");
    expect(status.compatible).toBe(false);
  });

  posixOnly("parses the status JSON out of shim banner noise", async () => {
    process.env.FAKE_CLAUDE_MODE = "noise";
    const status = await getClaudeAuthStatus();
    expect(status.authenticated).toBe(true);
    expect(status.subscription).toBe(true);
  });

  posixOnly("reports unavailable when the executable cannot be spawned", async () => {
    process.env.SCOPE_CLAUDE_PATH = path.join(tmpdir(), "definitely-not-a-claude-binary");
    resetClaudeCommandCache();
    const status = await getClaudeAuthStatus();
    expect(status).toMatchObject({ installed: false, authenticated: false, subscription: false });
  });
});

describe("claude login tracking", () => {
  posixOnly("captures the official URL, forwards the code, and reaches exit 0", async () => {
    const codeFile = writeCodeFile();
    process.env.FAKE_CLAUDE_CODE_FILE = codeFile;

    const started = await startClaudeLogin();
    expect(started.ok).toBe(true);
    expect(getClaudeLoginState().inProgress).toBe(true);
    const attemptId = getClaudeLoginState().attemptId;
    expect(attemptId).toBeTruthy();

    await waitFor(() => getClaudeLoginState().lastUrl !== null);
    const url = getClaudeLoginState().lastUrl;
    expect(url).not.toBeNull();
    expect(new URL(url as string).hostname).toBe("claude.com");

    const submitted = await submitClaudeLoginCode("good-code-123", attemptId ?? undefined);
    expect(submitted.ok).toBe(true);
    await waitFor(() => {
      try {
        return readFileSync(codeFile, "utf8") === "good-code-123";
      } catch {
        return false;
      }
    });

    await waitFor(() => {
      const state = getClaudeLoginState();
      return state.inProgress === false && state.lastExitCode === 0;
    });
    expect(getClaudeLoginState().lastError).toBeNull();
  });

  posixOnly("reassembles a login URL split across output writes", async () => {
    process.env.FAKE_CLAUDE_SPLIT_URL = "1";
    const started = await startClaudeLogin();
    expect(started.ok).toBe(true);
    await waitFor(() => getClaudeLoginState().lastUrl !== null);
    expect(getClaudeLoginState().lastUrl).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=test",
    );
    cancelClaudeLogin();
    await waitFor(() => getClaudeLoginState().inProgress === false);
  });

  posixOnly("reports an unaccepted code without ending the login", async () => {
    process.env.FAKE_CLAUDE_CODE_FILE = writeCodeFile();
    await startClaudeLogin();
    await waitFor(() => getClaudeLoginState().lastUrl !== null);

    const submitted = await submitClaudeLoginCode(
      "bad-code",
      getClaudeLoginState().attemptId ?? undefined,
    );
    expect(submitted.ok).toBe(true);
    await waitFor(() => getClaudeLoginState().lastError !== null);
    expect(getClaudeLoginState().lastError).toMatch(/wasn't accepted/i);
    expect(getClaudeLoginState().inProgress).toBe(true);
  });

  posixOnly("serializes simultaneous starts so only one wins", async () => {
    const [first, second] = await Promise.all([startClaudeLogin(), startClaudeLogin()]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const rejected = first.ok ? second : first;
    expect(rejected.error?.code).toBe("in_progress");
  });

  posixOnly("refuses a code bound to a stale attempt", async () => {
    await startClaudeLogin();
    const staleAttemptId = getClaudeLoginState().attemptId ?? undefined;
    expect(staleAttemptId).toBeTruthy();
    cancelClaudeLogin(staleAttemptId);
    await waitFor(() => getClaudeLoginState().inProgress === false);
    await startClaudeLogin();

    const result = await submitClaudeLoginCode("good-code-123", staleAttemptId);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("stale_attempt");
    cancelClaudeLogin();
    await waitFor(() => getClaudeLoginState().inProgress === false);
  });

  posixOnly("validates the submitted code shape", async () => {
    await startClaudeLogin();
    const attemptId = getClaudeLoginState().attemptId ?? undefined;
    const tooShort = await submitClaudeLoginCode("x", attemptId);
    expect(tooShort.ok).toBe(false);
    expect(tooShort.error?.message).toMatch(/does not look like the code/i);
    const multiline = await submitClaudeLoginCode("line1\nline2", attemptId);
    expect(multiline.ok).toBe(false);
    cancelClaudeLogin();
    await waitFor(() => getClaudeLoginState().inProgress === false);
  });

  posixOnly("cancels a waiting login and keeps cancellation out of errors", async () => {
    await startClaudeLogin();
    const attemptId = getClaudeLoginState().attemptId ?? undefined;
    const cancelled = await cancelClaudeLogin(attemptId);
    expect(cancelled.ok).toBe(true);
    await waitFor(() => getClaudeLoginState().inProgress === false);
    expect(getClaudeLoginState().lastError).toBeNull();
  });

  posixOnly("holds the login lock until a cancelled child exits", async () => {
    await startClaudeLogin();
    await waitFor(() => getClaudeLoginState().lastUrl !== null);
    const cancellation = cancelClaudeLogin();
    const retry = await startClaudeLogin();
    expect(retry.ok).toBe(false);
    expect(retry.error?.code).toBe("in_progress");
    await cancellation;
    expect((await startClaudeLogin()).ok).toBe(true);
  });

  posixOnly("kills a login that ignores the deadline", async () => {
    process.env.FAKE_CLAUDE_LOGIN_SLEEP = "1";
    const outcomes: string[] = [];
    const session = new ClaudeLoginSession(
      process.env.SCOPE_CLAUDE_PATH as string,
      {
        onSpawned: () => {},
        onSpawnError: () => outcomes.push("spawn_error"),
        onUrl: () => {},
        onOutputError: () => {},
        onExit: () => outcomes.push("exit"),
        onTimeout: () => outcomes.push("timeout"),
        onStdinError: () => {},
      },
      { timeoutMs: 150, killGraceMs: 250 },
    );
    session.start();
    await waitFor(() => outcomes.includes("timeout"));
    await waitFor(() => outcomes.includes("exit"));
    expect(session.isRunning).toBe(false);
  });

  it("refuses a code when no login is running", async () => {
    const result = await submitClaudeLoginCode("good-code-123");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/no claude sign-in/i);
  });
});

describe("claude logout", () => {
  posixOnly("runs the native logout and re-probes status", async () => {
    const marker = writeMarkerFile();
    process.env.FAKE_CLAUDE_LOGOUT_FILE = marker;
    // The post-logout status probe sees this mode.
    process.env.FAKE_CLAUDE_MODE = "signed-out";

    const result = await logoutProvider("claude");
    expect(result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });

  posixOnly("refuses to sign out while a chat run is active", async () => {
    const { beginAiRun } = await import("@/lib/ai/active-runs");
    const release = beginAiRun("claude");
    try {
      const result = await logoutProvider("claude");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("provider_busy");
    } finally {
      release();
    }
  });
});
