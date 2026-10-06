"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const {
  DESKTOP_AUTH_HEADER,
  allocateLoopbackPort,
  backendEnvironment,
  desktopUserDataPath,
  executablePath,
  isInternalUrl,
  isSafeExternalUrl,
  waitForBackend,
} = require("../lib/runtime.cjs");

test("desktop data stays in platform application-data directories", () => {
  assert.equal(
    desktopUserDataPath({
      env: { XDG_DATA_HOME: "/data-home" },
      platform: "linux",
      homeDir: "/home/alice",
      packaged: true,
    }),
    path.posix.join("/data-home", "scope"),
  );
  assert.equal(
    desktopUserDataPath({
      env: { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
      platform: "win32",
      homeDir: "C:\\Users\\Alice",
      packaged: true,
    }),
    path.win32.join("C:\\Users\\Alice\\AppData\\Local", "scope"),
  );
  assert.equal(
    desktopUserDataPath({
      env: { SCOPE_DESKTOP_USER_DATA: "/tmp/private-scope" },
      platform: "linux",
      homeDir: "/home/alice",
    }),
    "/tmp/private-scope",
  );
});

test("desktop PATH adds GUI-session tool locations without duplicates", () => {
  const value = executablePath({
    env: {
      PATH: "/home/alice/.local/share/mise/shims:/usr/bin:/custom/bin:/usr/local/share/mise/shims",
    },
    platform: "linux",
    homeDir: "/home/alice",
  });
  const entries = value.split(path.posix.delimiter);
  assert(entries.includes("/home/alice/.local/bin"));
  assert(entries.includes("/custom/bin"));
  assert.equal(entries.filter((entry) => entry === "/usr/bin").length, 1);
  // A shim invoked for an uninstalled tool makes mise download it, even when
  // mise's auto-install settings are disabled.
  assert(!entries.some((entry) => entry.endsWith("/mise/shims")));
});

test("macOS PATH includes both Homebrew prefixes for a Finder launch", () => {
  const value = executablePath({
    env: { PATH: "/usr/bin:/bin" },
    platform: "darwin",
    homeDir: "/Users/ana",
  });
  const entries = value.split(path.posix.delimiter);
  // Finder launches never source shell startup files, so provider discovery
  // must include the Apple Silicon and Intel Homebrew locations explicitly.
  assert(entries.includes("/opt/homebrew/bin"));
  assert(entries.includes("/usr/local/bin"));
  assert(entries.includes("/Users/ana/.local/bin"));
  assert(entries.includes("/usr/bin"));
  assert.equal(entries.filter((entry) => entry === "/usr/local/bin").length, 1);
});

test("desktop PATH drops Windows mise shim directories", () => {
  const value = executablePath({
    env: { Path: "C:\\Users\\Alice\\AppData\\Local\\mise\\shims;C:\\Tools" },
    platform: "win32",
    homeDir: "C:\\Users\\Alice",
  });
  const entries = value.split(path.win32.delimiter);
  assert(entries.includes("C:\\Tools"));
  assert(!entries.some((entry) => entry.toLowerCase().endsWith("mise\\shims")));
});

test("desktop PATH uses Windows syntax when launched outside a terminal", () => {
  const homeDir = "C:\\Users\\Ana Pérez";
  const value = executablePath({
    env: {
      Path: "C:\\Windows\\System32;C:\\Tools",
      APPDATA: `${homeDir}\\AppData\\Roaming`,
      LOCALAPPDATA: `${homeDir}\\AppData\\Local`,
      ProgramFiles: "C:\\Program Files",
    },
    platform: "win32",
    homeDir,
  });
  const entries = value.split(path.win32.delimiter);
  assert(entries.includes(`${homeDir}\\AppData\\Roaming\\npm`));
  assert(entries.includes(`${homeDir}\\AppData\\Local\\Microsoft\\WinGet\\Links`));
  // Native provider installers and Node.js locations the Start menu PATH may
  // not have picked up yet.
  assert(entries.includes(`${homeDir}\\.local\\bin`));
  assert(entries.includes(`${homeDir}\\.opencode\\bin`));
  assert(entries.includes(`${homeDir}\\.codex\\bin`));
  assert(entries.includes("C:\\Program Files\\nodejs"));
  assert(entries.includes(`${homeDir}\\AppData\\Local\\Programs\\nodejs`));
  assert(entries.includes("C:\\Tools"));
});

test("backend environment isolates writable data and pins loopback", () => {
  const token = "a".repeat(64);
  const dataRoot = path.resolve("private", "scope", "data");
  const env = backendEnvironment({
    baseEnv: { PATH: "/usr/bin" },
    dataRoot,
    token,
    port: 41_234,
    bundledYtDlpPath: "/opt/scope/yt-dlp",
  });
  assert.equal(env.HOSTNAME, "127.0.0.1");
  assert.equal(env.PORT, "41234");
  assert.equal(env.SCOPE_DESKTOP_TOKEN, token);
  assert.equal(env.SCOPE_DB_PATH, path.join(dataRoot, "localtube.db"));
  assert.equal(env.SCOPE_AI_JOBS_ROOT, path.join(dataRoot, "ai-jobs"));
  assert.equal(env.SCOPE_YTDLP_PATH, "/opt/scope/yt-dlp");
  // Mise must report missing tools instead of downloading them: auto_install
  // covers `mise where`, exec_auto_install covers shim execution, and the
  // not-found handler covers a shim invoked for an unconfigured tool.
  assert.equal(env.MISE_AUTO_INSTALL, "false");
  assert.equal(env.MISE_EXEC_AUTO_INSTALL, "false");
  assert.equal(env.MISE_NOT_FOUND_AUTO_INSTALL, "false");
});

test("URL guards distinguish the private app origin from external pages", () => {
  const origin = "http://127.0.0.1:41234";
  assert.equal(isInternalUrl(`${origin}/reports`, origin), true);
  assert.equal(isInternalUrl("http://127.0.0.1:41235/reports", origin), false);
  assert.equal(isInternalUrl("https://example.com", origin), false);
  assert.equal(isSafeExternalUrl("https://youtube.com/watch?v=1"), true);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("file:///etc/passwd"), false);
});

test("health polling authenticates and waits for the Scope database", async (context) => {
  const token = "b".repeat(64);
  const port = await allocateLoopbackPort();
  let attempts = 0;
  const server = http.createServer((request, response) => {
    attempts += 1;
    assert.equal(request.headers[DESKTOP_AUTH_HEADER], token);
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        status: "ok",
        app: { name: "scope", status: "ready" },
        database: { connected: attempts >= 2 },
        ytdlp: { available: true },
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await waitForBackend({
    origin: `http://127.0.0.1:${port}`,
    token,
    timeoutMs: 2_000,
  });
  assert(attempts >= 2);
});

test("health polling reports the last safe readiness result on timeout", async (context) => {
  const port = await allocateLoopbackPort();
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({ app: { name: "scope", status: "ready" }, database: { connected: false } }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await assert.rejects(
    waitForBackend({ origin: `http://127.0.0.1:${port}`, token: "b".repeat(64), timeoutMs: 200 }),
    /Last health: HTTP 200, app=ready, database=false/,
  );
});

test("desktop startup does not wait for slow external-tool health diagnostics", async (context) => {
  const token = "b".repeat(64);
  const port = await allocateLoopbackPort();
  const timers = [];
  const server = http.createServer((request, response) => {
    assert.equal(request.headers[DESKTOP_AUTH_HEADER], token);
    const reply = () => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          app: { name: "scope", status: "ready" },
          database: { connected: true },
        }),
      );
    };
    if (request.url === "/api/health") {
      timers.push(setTimeout(reply, 2_500));
    } else if (request.url === "/api/ready") {
      reply();
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  context.after(() => {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await waitForBackend({ origin: `http://127.0.0.1:${port}`, token, timeoutMs: 500 });
});

test("minimal smoke keeps system runtimes unavailable to backend subprocesses", (context) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "scope-empty-path-"));
  context.after(() => fs.rmSync(emptyBin, { recursive: true, force: true }));
  const baseEnv = {
    PATH: emptyBin,
    SCOPE_DESKTOP_SMOKE: "1",
    SCOPE_DESKTOP_SMOKE_MINIMAL_PATH: "1",
  };
  const options = { baseEnv, dataRoot: emptyBin, token: "a".repeat(64), port: 41234 };
  const env = backendEnvironment(options);
  assert.equal(env.PATH, emptyBin);
  // Run this probe in a child too: it sees the environment actually inherited
  // by backend subprocesses, not the test runner's PATH.
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const {spawnSync} = require('node:child_process');
    for (const command of ['node', 'python', 'python3', 'uv', 'yt-dlp']) {
      const result = spawnSync(command, ['--version']);
      if (result.error?.code !== 'ENOENT') process.exit(1);
    }
  `,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  assert.notEqual(
    backendEnvironment({ ...options, baseEnv: { ...baseEnv, SCOPE_DESKTOP_SMOKE: "0" } }).PATH,
    emptyBin,
  );
});
