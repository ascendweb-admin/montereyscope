/**
 * Spawns the X read worker: one fixed executable, one JSON request over
 * stdin, one JSON response over stdout. No shell, no argv data, bounded
 * output, hard timeout, cancellation, and process-tree cleanup. Server-only.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { XWorkerRequest } from "../worker-protocol";

export interface XWorkerRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Fixed argument array for workers launched through an interpreter. */
  args?: readonly string[];
  signal?: AbortSignal;
}

export type XWorkerRunFailureKind =
  | "missing_executable"
  | "timeout"
  | "output_limit"
  | "nonzero_exit"
  | "spawn_failed"
  | "cancelled";

export type XWorkerRunResult =
  | { ok: true; stdout: string }
  | { ok: false; kind: XWorkerRunFailureKind; stderrTail: string; exitCode?: number };

const STDERR_TAIL_BYTES = 4_000;

/** Kills the worker and, on POSIX, its whole process group. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.killed === true) {
    return;
  }
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, "SIGKILL");
      return;
    }
  } catch {
    // Fall through to the direct kill below.
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The process already exited.
  }
}

/**
 * Runs one worker operation. Resolves a discriminated result instead of
 * throwing so callers map failures to typed X errors deterministically.
 */
export function runXWorker(
  executable: string,
  request: XWorkerRequest,
  options: XWorkerRunOptions,
): Promise<XWorkerRunResult> {
  return new Promise<XWorkerRunResult>((resolve) => {
    if (options.signal?.aborted) {
      resolve({ ok: false, kind: "cancelled", stderrTail: "" });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(executable, [...(options.args ?? [])], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
      });
    } catch {
      resolve({ ok: false, kind: "spawn_failed", stderrTail: "" });
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputLimited = false;

    const finish = (result: XWorkerRunResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = (): void => {
      cancelled = true;
      killTree(child);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > options.maxOutputBytes) {
        outputLimited = true;
        killTree(child);
        return;
      }
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > STDERR_TAIL_BYTES * 4) {
        stderr = stderr.slice(-STDERR_TAIL_BYTES);
      }
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      const missing =
        error.code === "ENOENT" ||
        error.code === "EACCES" ||
        error.code === "ENOTDIR" ||
        error.code === "EISDIR";
      finish({
        ok: false,
        kind: missing ? "missing_executable" : "spawn_failed",
        stderrTail: stderr.slice(-STDERR_TAIL_BYTES),
      });
    });

    child.once("close", (code) => {
      const stderrTail = stderr.slice(-STDERR_TAIL_BYTES);
      if (cancelled) {
        finish({ ok: false, kind: "cancelled", stderrTail });
        return;
      }
      if (timedOut) {
        finish({ ok: false, kind: "timeout", stderrTail });
        return;
      }
      if (outputLimited) {
        finish({ ok: false, kind: "output_limit", stderrTail });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, kind: "nonzero_exit", stderrTail, exitCode: code ?? undefined });
        return;
      }
      finish({ ok: true, stdout });
    });

    child.stdin?.on("error", () => {
      // The worker exited before reading its request; the close handler
      // reports the nonzero exit.
    });
    child.stdin?.end(`${JSON.stringify(request)}\n`, "utf8");
  });
}
