"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const OPERATIONS = new Set(["runtime", "status", "user", "user_search", "user_posts", "tweet"]);
const CODES = new Set([
  "not_connected",
  "session_expired",
  "verification_required",
  "rate_limited",
  "not_found",
  "protected_account",
  "network",
  "timeout",
  "cancelled",
  "unsupported_runtime",
  "invalid_response",
]);
const failure = (code) => Object.assign(new Error(code), { code });

// A request may carry the in-memory transaction seed (x.com homepage + ondemand bundle).
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/**
 * Runs one worker request. `onTransaction` receives transaction material the
 * worker had to fetch, so the caller can keep it in memory and send it back as
 * `request.transaction` next time instead of re-downloading x.com's homepage.
 */
function runWorker(executable, request, { cwd, signal, timeoutMs = 45_000, onTransaction } = {}) {
  if (!OPERATIONS.has(request.operation)) return Promise.reject(failure("invalid_response"));
  const input = JSON.stringify({ ...request, protocol: 1 });
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) return Promise.reject(failure("invalid_response"));
  if (!executable || !fs.existsSync(executable))
    return Promise.reject(failure("unsupported_runtime"));
  if (signal?.aborted) return Promise.reject(failure("cancelled"));
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  // Do not inherit AI credentials, Python configuration, or desktop/broker tokens.
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false,
      bytes = 0;
    const chunks = [];
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(data);
    };
    const stop = (code) => {
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn(
            path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
            ["/pid", String(child.pid), "/T", "/F"],
            { windowsHide: true, shell: false, stdio: "ignore" },
          );
          killer.on("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      finish(failure(code));
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) return stop("invalid_response");
      chunks.push(chunk);
    });
    child.on("error", () => finish(failure("unsupported_runtime")));
    child.on("close", (code) => {
      if (settled) return;
      try {
        if (code !== 0) throw failure("invalid_response");
        const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const seed = envelope?.transaction;
        if (
          onTransaction &&
          typeof seed?.homeHtml === "string" &&
          typeof seed?.ondemandText === "string"
        )
          onTransaction({ homeHtml: seed.homeHtml, ondemandText: seed.ondemandText });
        if (envelope?.ok === false) {
          const error = failure(
            CODES.has(envelope.error?.code) ? envelope.error.code : "invalid_response",
          );
          error.retryAfterSeconds = Number.isFinite(envelope.error?.retryAfterSeconds)
            ? Math.max(0, envelope.error.retryAfterSeconds)
            : null;
          // Stage, HTTP status and quota headers only; never credentials or payloads.
          const diagnostic = envelope.diagnostic;
          if (diagnostic && typeof diagnostic === "object")
            error.diagnostic = {
              stage: typeof diagnostic.stage === "string" ? diagnostic.stage.slice(0, 40) : null,
              httpStatus: Number.isInteger(diagnostic.httpStatus) ? diagnostic.httpStatus : null,
              rateLimit:
                diagnostic.rateLimit && typeof diagnostic.rateLimit === "object"
                  ? Object.fromEntries(
                      ["limit", "remaining", "reset"]
                        .filter((key) => Number.isInteger(diagnostic.rateLimit[key]))
                        .map((key) => [key, diagnostic.rateLimit[key]]),
                    )
                  : null,
            };
          throw error;
        }
        if (envelope?.ok !== true || envelope.schema_version !== 1)
          throw failure("invalid_response");
        finish(null, envelope.data);
      } catch (error) {
        finish(CODES.has(error.code) ? error : failure("invalid_response"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
module.exports = { runWorker, failure };
