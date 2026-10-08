/**
 * Shared process helpers for the auth modules (provider-auth stage).
 * Server-only. Small on purpose: status probes and logouts for every
 * provider run the CLI with an argument array (never a shell) and need only
 * a bounded result plus predictable missing-binary/timeout handling.
 */
import { execFile } from "node:child_process";

export interface ExecStatusResult {
  /** False when the binary is missing or the probe timed out. */
  ran: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** macOS distinguishes an unreadable status from an explicit signed-out result. */
  failure?: "missing_executable" | "timeout" | "spawn_failed";
}

/**
 * Runs a short-lived CLI probe. ENOENT (missing binary) and ETIMEDOUT both
 * read as "not usable"; every other exit is a normal result the caller can
 * classify.
 */
export function execFileStatus(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExecStatusResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
        const code = error !== null ? (error as NodeJS.ErrnoException).code : null;
        // execFile usually reports a deadline as killed/SIGTERM, not ETIMEDOUT.
        // Keep other platforms' existing result shape and behavior unchanged.
        const failure: ExecStatusResult["failure"] =
          process.platform !== "darwin" || error === null
            ? undefined
            : code === "ENOENT"
              ? "missing_executable"
              : code === "ETIMEDOUT" || error.killed
                ? "timeout"
                : typeof code === "string"
                  ? "spawn_failed"
                  : undefined;
        if (error !== null && (code === "ENOENT" || code === "ETIMEDOUT")) {
          resolve({
            ran: false,
            exitCode: null,
            stdout: "",
            stderr: "",
            ...(failure ? { failure } : {}),
          });
          return;
        }
        resolve({
          ran: true,
          exitCode: error !== null ? 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          ...(failure ? { failure } : {}),
        });
      },
    );
  });
}

/**
 * Flattens untrusted process output into one bounded, control-character-free
 * line for a client-safe message. Never used for tokens or keys — those are
 * never read from process output at all.
 */
export function sanitizeProcessText(text: string, maxChars = 240): string {
  const cleaned = text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, maxChars - 1)}…`;
}
