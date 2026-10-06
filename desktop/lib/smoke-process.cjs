"use strict";

const { spawn } = require("node:child_process");

/** Run a packaged app with a bounded process tree and streamed diagnostics. */
function runSmokeProcess(executable, env, timeoutMs = 90_000, args = []) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error;
    let settled = false;
    let fallback;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(fallback);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve({ status, signal, stdout, stderr, error });
    };
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-4_000_000);
      process.stdout.write(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4_000_000);
      process.stderr.write(text);
    });
    child.once("error", (cause) => {
      error = cause;
      finish(null, null);
    });
    child.once("close", finish);
    const timeout = setTimeout(() => {
      error = Object.assign(new Error(`Packaged app exceeded ${timeoutMs}ms`), {
        code: "ETIMEDOUT",
      });
      if (process.platform === "win32") {
        spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      fallback = setTimeout(() => finish(null, "SIGKILL"), 5_000);
    }, timeoutMs);
  });
}

module.exports = { runSmokeProcess };
