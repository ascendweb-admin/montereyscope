"use strict";

// Runs the backend from the actual app bundle with Electron's own Node.js.
// This avoids depending on interactive GUI and Keychain access on the
// hosted runner. Every database and fixture is temporary.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { allocateLoopbackPort, DESKTOP_AUTH_HEADER, waitForBackend } = require("../lib/runtime.cjs");

async function main() {
  const appPath = path.resolve(process.argv[2] || "desktop/dist/mac/scope.app");
  const executable = path.join(appPath, "Contents", "MacOS", "scope");
  const resources = path.join(appPath, "Contents", "Resources");
  const serverRoot = path.join(resources, "app-server");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scope-monterey-backend-"));
  const claude = path.join(scratch, "claude");
  const claudeStatus = path.join(scratch, "claude-status");
  fs.writeFileSync(
    claude,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '2.1.241 (Claude Code)'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  if [ "$(cat "$(dirname "$0")/claude-status")" = "unavailable" ]; then
    printf '%s\\n' 'Test fixture: Keychain temporarily unavailable' >&2
    exit 1
  fi
  printf '%s\\n' '{"loggedIn":true,"authMethod":"oauth"}'
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );
  const slowTool = path.join(scratch, "slow-ytdlp");
  fs.writeFileSync(slowTool, "#!/bin/sh\n/bin/sleep 4\nprintf '2026.08.19\\n'\n", { mode: 0o755 });
  for (const [name, tool] of [
    ["bundled downloader", path.join(resources, "bin", "yt-dlp")],
    ["slow downloader", slowTool],
  ]) {
    fs.writeFileSync(claudeStatus, "unavailable");
    const port = await allocateLoopbackPort();
    const token = crypto.randomBytes(32).toString("hex");
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: scratch,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      NEXT_TELEMETRY_DISABLED: "1",
      SCOPE_DESKTOP: "1",
      SCOPE_DESKTOP_TOKEN: token,
      SCOPE_DB_PATH: path.join(scratch, "library.db"),
      SCOPE_AI_JOBS_ROOT: path.join(scratch, "ai-jobs"),
      SCOPE_YTDLP_PATH: tool,
      SCOPE_CLAUDE_PATH: claude,
      SCOPE_CODEX_PATH: path.join(scratch, "no-codex"),
      SCOPE_OPENCODE_BIN: path.join(scratch, "no-opencode"),
      XDG_DATA_HOME: path.join(scratch, "xdg-data"),
      XDG_CONFIG_HOME: path.join(scratch, "xdg-config"),
    };
    const child = spawn(executable, [path.join(serverRoot, "server.js")], {
      cwd: serverRoot,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let alive = true;
    let output = "";
    let childError;
    child.on("error", (error) => {
      childError = error;
      alive = false;
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        output = (output + chunk).slice(-100_000);
      });
    }
    const closed = new Promise((resolve) =>
      child.once("close", () => {
        alive = false;
        resolve();
      }),
    );
    const get = (url) =>
      fetch(origin + url, {
        headers: { [DESKTOP_AUTH_HEADER]: token },
        signal: AbortSignal.timeout(15_000),
      });
    try {
      await waitForBackend({ origin, token, timeoutMs: 45_000, isAlive: () => alive });
      if (childError) throw childError;
      const started = Date.now();
      const ready = await get("/api/ready");
      assert.equal(ready.status, 200);
      assert.equal((await ready.json()).database.connected, true);
      assert(Date.now() - started < 2_000, "Readiness must fit the desktop probe deadline");
      const unauthorized = await fetch(origin + "/api/ready", {
        signal: AbortSignal.timeout(5_000),
      });
      assert.equal(unauthorized.status, 404, "Startup endpoint must require the desktop token");
      const page = await get("/");
      assert.equal(page.status, 200);
      assert((await page.text()).includes("Creator library"), "Packaged library page must render");
      const healthStarted = Date.now();
      const health = await get("/api/health");
      assert.equal(health.status, 200);
      const report = await health.json();
      assert.equal(report.database.connected, true);
      assert.equal(report.ytdlp.available, true);
      if (name === "slow downloader") {
        assert(
          Date.now() - healthStarted >= 3_000,
          "Slow-tool regression fixture must exercise the timeout mismatch",
        );
      }
      const failedClaude = await (await get("/api/ai/auth")).json();
      assert.equal(failedClaude.claude.statusError?.code, "status_unavailable");
      fs.writeFileSync(claudeStatus, "signed-in");
      // Let the two-second status cache expire before simulating Check again.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      const recoveredClaude = await (await get("/api/ai/auth")).json();
      assert.equal(recoveredClaude.claude.authenticated, true);
      assert.equal(recoveredClaude.claude.subscription, true);
      assert.equal(recoveredClaude.claude.statusError, null);
      console.log(
        `PASS: ${name}; packaged backend, database, authenticated readiness, library page, downloader health, and Claude status recovery.`,
      );
    } catch (error) {
      console.error(output);
      throw error;
    } finally {
      if (alive) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      let timer;
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            if (alive) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
            resolve();
          }, 5_000);
        }),
      ]);
      clearTimeout(timer);
    }
  }
  assert(fs.statSync(path.join(scratch, "library.db")).size > 0);
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("Packaged Monterey backend verification passed on the hosted Mac.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
