import { execFile } from "node:child_process";

import { createExecutionGate, type ExecutionGate } from "./gate";

export interface ExecFileOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ExecFileSuccess {
  ok: true;
  stdout: string;
  /** Full stderr text (may be empty). Never surfaced to the UI directly. */
  stderr: string;
}

export type CommandFailureKind =
  "missing_executable" | "timeout" | "output_limit" | "nonzero_exit" | "spawn_failed";

export interface CommandFailure {
  kind: CommandFailureKind;
  /**
   * Bounded tail of stderr for diagnostics and failure classification.
   * Server logs only — this must never be shown in the UI.
   */
  stderrTail: string;
  exitCode?: number;
  signal?: string;
}

export type ExecFileResult = ExecFileSuccess | ({ ok: false } & CommandFailure);

/** How many yt-dlp processes may run simultaneously (env-overridable). */
function resolveMaxConcurrent(): number {
  const parsed = Number.parseInt(
    process.env.SCOPE_YTDLP_MAX_CONCURRENT ?? process.env.LOCALTUBE_YTDLP_MAX_CONCURRENT ?? "",
    10,
  );
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 8) {
    return parsed;
  }
  return 2;
}

let executionGate: ExecutionGate | null = null;

function getGate(): ExecutionGate {
  if (!executionGate) {
    executionGate = createExecutionGate(resolveMaxConcurrent());
  }
  return executionGate;
}

/** Test seam: replace the process-wide concurrency gate. */
export function setCommandExecutionGate(gate: ExecutionGate | null): void {
  executionGate = gate;
}

const STDERR_TAIL_BYTES = 4_000;

function stderrTailOf(stderr: string): string {
  return stderr.length > STDERR_TAIL_BYTES ? stderr.slice(-STDERR_TAIL_BYTES) : stderr;
}

/**
 * Thin promise wrapper around execFile with a hard timeout, output limit,
 * captured stderr, and a global concurrency cap. Argument arrays only —
 * never a shell command string (AGENTS.md rule).
 *
 * Returns a discriminated result instead of throwing so callers can map
 * failures to application errors deterministically.
 */
export function runCommand(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<ExecFileResult> {
  return getGate().run(
    () =>
      new Promise<ExecFileResult>((resolve) => {
        execFile(
          file,
          [...args],
          {
            // Argument arrays only — the shell is never involved.
            timeout: options.timeoutMs,
            maxBuffer: options.maxOutputBytes,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ ok: true, stdout, stderr });
              return;
            }

            const stderrTail = stderrTailOf(typeof stderr === "string" ? stderr : "");
            // Node signals our timeout by killing the child (SIGTERM by default).
            if (error.killed === true) {
              resolve({
                ok: false,
                kind: "timeout",
                stderrTail,
                signal: error.signal ?? undefined,
              });
              return;
            }

            // Node ≥22 reports maxBuffer overflow as
            // ERR_CHILD_PROCESS_STDIO_MAXBUFFER; older releases used ENOBUFS.
            if (error.code === "ENOBUFS" || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              resolve({ ok: false, kind: "output_limit", stderrTail });
              return;
            }

            if (
              error.code === "ENOENT" ||
              error.code === "EACCES" ||
              error.code === "ENOTDIR" ||
              error.code === "EISDIR"
            ) {
              resolve({ ok: false, kind: "missing_executable", stderrTail });
              return;
            }

            if (typeof error.code === "number") {
              resolve({
                ok: false,
                kind: "nonzero_exit",
                stderrTail,
                exitCode: error.code,
                signal: error.signal ?? undefined,
              });
              return;
            }

            resolve({
              ok: false,
              kind: "spawn_failed",
              stderrTail,
            });
          },
        );
      }),
  );
}
