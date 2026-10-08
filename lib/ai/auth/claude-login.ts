/**
 * Claude Code authentication (provider-auth stage). Server-only.
 *
 * Status comes from the CLI's own `claude auth status --json` (never from
 * credential files). The native subscription login (`claude auth login
 * --claudeai`) is tracked as a ClaudeLoginSession so Settings can wait for
 * the browser callback, hand over the browser's sign-in code on stdin, or
 * cancel — with a finite deadline, SIGTERM→SIGKILL escalation, buffered URL
 * extraction, and sanitized error text. `claude auth logout` uses the same
 * resolved binary and stripped environment.
 *
 * Everything here is stateless; the process-wide attempt lifecycle lives in
 * manager.ts. Tests inject the command through SCOPE_CLAUDE_PATH and drive
 * the real spawn path against a fake executable.
 */
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  claudeChildEnvironment,
  MIN_SUPPORTED_CLAUDE_VERSION,
  resolveClaudeLaunch,
} from "../claude";
import { execFileStatus, sanitizeProcessText } from "./exec";

export { MIN_SUPPORTED_CLAUDE_VERSION };

/** How long a started Claude sign-in may wait before it is cancelled. */
export const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** How long a SIGTERM'd login child gets before SIGKILL. */
export const CLAUDE_LOGIN_KILL_GRACE_MS = 5_000;

/** Bounded accumulated output used for URL extraction and error text. */
const OUTPUT_WINDOW_CHARS = 8_000;

export interface ClaudeAuthStatus {
  /** Server-only identity fingerprint. Never included in public auth snapshots. */
  accountKey?: string;
  statusError?: boolean;
  /** False when the claude CLI could not be run at all. */
  installed: boolean;
  /** True when `claude auth status` reports a logged-in account. */
  authenticated: boolean;
  /**
   * True when the active credential is a Claude subscription login. A
   * Console API key or cloud-provider credential reads as authenticated but
   * not subscription-backed; scope does not claim a subscription then.
   */
  subscription: boolean;
  /** Auth method reported by the CLI ("oauth", "none", …), sanitized. */
  authMethod: string | null;
  /** Parsed CLI version, e.g. "2.1.241"; null when it could not be read. */
  version: string | null;
  /** False when the CLI predates the flags scope relies on. */
  compatible: boolean;
  /** Human-readable detail (version, account email); never a token. */
  detail: string | null;
}

export const EMPTY_CLAUDE_STATUS: ClaudeAuthStatus = {
  installed: false,
  authenticated: false,
  subscription: false,
  authMethod: null,
  version: null,
  compatible: false,
  detail: null,
};

/** Parses "2.1.241 (Claude Code)" into { major, minor, patch }. */
export function parseClaudeVersion(text: string): string | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/** True when version >= MIN_SUPPORTED_CLAUDE_VERSION (numeric compare). */
export function isSupportedClaudeVersion(version: string | null): boolean {
  if (version === null) {
    return false;
  }
  const parse = (value: string): number[] =>
    value.split(".").map((part) => Number.parseInt(part, 10));
  const actual = parse(version);
  const minimum = parse(MIN_SUPPORTED_CLAUDE_VERSION);
  for (let index = 0; index < Math.max(actual.length, minimum.length); index += 1) {
    const a = actual[index] ?? 0;
    const b = minimum[index] ?? 0;
    if (a !== b) {
      return a > b;
    }
  }
  return true;
}

/**
 * Auth methods that mean "signed in with a Claude subscription". Scope is
 * conservative: anything unrecognized (Console keys, cloud providers,
 * profiles, future methods) reads as authenticated-but-not-subscription so
 * the UI never claims a plan that isn't paying for the run.
 */
export function isClaudeSubscriptionMethod(method: string | null): boolean {
  if (method === null) {
    return false;
  }
  return /^(oauth|claudeai|claude-ai|claude\.ai|subscription|pro|max|team|enterprise)$/i.test(
    method.trim(),
  );
}

/**
 * Pulls the first JSON object out of CLI output. The mise shim can print
 * banner lines around the JSON on stdout, so a plain JSON.parse of the whole
 * stream is not safe.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reads the claude CLI's native status. `claude auth status --json` is the
 * one source of truth (never credential files); `--version` doubles as the
 * installed probe and the compatibility check. Runs with the same stripped
 * environment inference uses, so the report matches what a chat turn sees.
 */
export async function getClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const macOS = process.platform === "darwin";
  try {
    const launch = await resolveClaudeLaunch();
    if (launch.kind === "unresolved") {
      return { ...EMPTY_CLAUDE_STATUS, statusError: true };
    }
    const env = claudeChildEnvironment();
    const versionProbe = await execFileStatus(
      launch.command,
      [...launch.argsPrefix, "--version"],
      macOS ? 15_000 : 4_000,
      env,
    );
    if (!versionProbe.ran) {
      return {
        ...EMPTY_CLAUDE_STATUS,
        ...(macOS && versionProbe.failure !== "missing_executable" ? { statusError: true } : {}),
      };
    }
    const version =
      parseClaudeVersion(versionProbe.stdout) ?? parseClaudeVersion(versionProbe.stderr);
    const compatible = isSupportedClaudeVersion(version);
    if (macOS && (versionProbe.failure || versionProbe.exitCode !== 0 || version === null)) {
      return { ...EMPTY_CLAUDE_STATUS, installed: true, version, compatible, statusError: true };
    }

    const statusProbe = await execFileStatus(
      launch.command,
      [...launch.argsPrefix, "auth", "status", "--json"],
      macOS ? 30_000 : 10_000,
      env,
    );
    const parsed = extractJsonObject(`${statusProbe.stdout}\n${statusProbe.stderr}`);
    if (
      !parsed ||
      typeof parsed.loggedIn !== "boolean" ||
      (macOS &&
        (!statusProbe.ran ||
          statusProbe.failure ||
          (statusProbe.exitCode !== 0 &&
            !(statusProbe.exitCode === 1 && parsed.loggedIn === false))))
    ) {
      return { ...EMPTY_CLAUDE_STATUS, installed: true, version, compatible, statusError: true };
    }
    const authenticated = parsed.loggedIn === true;
    const authMethod = firstString(parsed?.authMethod);
    // The signed-in email stays on this machine; the status line shows the
    // CLI version only so shared windows never leak the address.
    const detail = version !== null ? `v${version}` : null;
    return {
      installed: true,
      authenticated,
      subscription: authenticated && isClaudeSubscriptionMethod(authMethod),
      authMethod,
      accountKey: createHash("sha256")
        .update(
          JSON.stringify([
            parsed.email,
            parsed.accountId,
            parsed.orgId,
            parsed.orgName,
            parsed.subscriptionType,
            authMethod,
            authenticated,
          ]),
        )
        .digest("hex"),
      version,
      compatible,
      detail,
    };
  } catch (error) {
    // One provider's failure must never hide the others.
    console.error("[ai/auth] claude status failed:", error);
    return { ...EMPTY_CLAUDE_STATUS, ...(macOS ? { statusError: true } : {}) };
  }
}

/**
 * Extracts the first official Claude login URL from CLI output. The CLI
 * prints the URL inside OSC-8 hyperlink escapes, so control characters are
 * never part of a match, and only https URLs on claude.com/claude.ai are
 * accepted (never an arbitrary URL a hook or wrapper might print).
 */
export function extractClaudeLoginUrl(text: string): string | null {
  // Wait for a delimiter before accepting the URL. A child-process data event
  // can end in the middle of a URL, and opening that prefix breaks login.
  const matches = text.match(/https:\/\/[^\s\x1b\x07\x00-\x1f"'<>]+(?=[\s\x1b\x07\x00-\x1f"'<>])/g);
  if (!matches) {
    return null;
  }
  for (const candidate of matches) {
    try {
      const url = new URL(candidate.replace(/[)\].,;]+$/, ""));
      const host = url.hostname.toLowerCase();
      const official =
        host === "claude.com" ||
        host.endsWith(".claude.com") ||
        host === "claude.ai" ||
        host.endsWith(".claude.ai");
      if (url.protocol === "https:" && official) {
        return url.toString();
      }
    } catch {
      // Not a URL; keep looking.
    }
  }
  return null;
}

/** Validates the browser's sign-in code as a single bounded printable line. */
export function isValidClaudeLoginCode(code: string): boolean {
  const cleaned = code.trim();
  if (cleaned.length < 4 || cleaned.length > 4_096) {
    return false;
  }
  return !/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cleaned);
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

export class ClaudeLogoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeLogoutError";
  }
}

/**
 * Signs the shared claude CLI out (`claude auth logout`) with the same
 * resolved binary and stripped environment as status/login. The caller
 * re-probes status afterwards rather than trusting the exit code alone.
 */
export async function logoutClaude(): Promise<void> {
  const launch = await resolveClaudeLaunch();
  if (launch.kind === "unresolved") {
    throw new ClaudeLogoutError("The claude executable could not be resolved on this machine.");
  }
  const result = await execFileStatus(
    launch.command,
    [...launch.argsPrefix, "auth", "logout"],
    20_000,
    claudeChildEnvironment(),
  );
  if (!result.ran) {
    throw new ClaudeLogoutError("The claude CLI is not available on this machine.");
  }
  if (result.exitCode !== 0) {
    throw new ClaudeLogoutError(
      "The claude CLI could not sign out. Check the CLI on this machine and try again.",
    );
  }
}

// ---------------------------------------------------------------------------
// Login session
// ---------------------------------------------------------------------------

export interface ClaudeLoginCallbacks {
  /** The child process started successfully. */
  onSpawned: () => void;
  /** The child could not be started at all (e.g. ENOENT). */
  onSpawnError: (message: string) => void;
  /** An official login URL was seen in the accumulated output. */
  onUrl: (url: string) => void;
  /** Client-safe, non-terminal retry message (e.g. unaccepted code). */
  onOutputError: (message: string) => void;
  /** The child exited; the manager re-probes status before declaring success. */
  onExit: (code: number | null) => void;
  /** The login exceeded its deadline and is being terminated. */
  onTimeout: () => void;
  /** stdin failed asynchronously while a code was being written. */
  onStdinError: () => void;
}

export interface ClaudeLoginSessionOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  /** Arguments prepended to the login argv (script path for wrapper launches). */
  argsPrefix?: readonly string[];
}

/**
 * One `claude auth login --claudeai` process. The URL is extracted from the
 * accumulated output window (split writes cannot hide it), codes are written
 * to stdin with an async error path, and cancellation escalates from SIGTERM
 * to SIGKILL. The session never stores the code anywhere.
 */
export class ClaudeLoginSession {
  private readonly command: string;
  private readonly commandArgs: readonly string[];
  private readonly callbacks: ClaudeLoginCallbacks;
  private readonly timeoutMs: number;
  private readonly killGraceMs: number;
  private child: ChildProcessWithoutNullStreams | null = null;
  private output = "";
  private lastUrl: string | null = null;
  private exited = false;
  private started = false;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private stdinBroken = false;
  private resolveClosed!: () => void;
  private readonly closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });

  constructor(
    command: string,
    callbacks: ClaudeLoginCallbacks,
    options: ClaudeLoginSessionOptions = {},
  ) {
    this.command = command;
    this.commandArgs = [...(options.argsPrefix ?? [])];
    this.callbacks = callbacks;
    this.timeoutMs = options.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? CLAUDE_LOGIN_KILL_GRACE_MS;
  }

  /** Spawns the login child. Must be called exactly once. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.command, [...this.commandArgs, "auth", "login", "--claudeai"], {
        // stdin stays open so the browser's sign-in code can be submitted.
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: claudeChildEnvironment(),
      });
    } catch (error) {
      this.settle();
      this.callbacks.onSpawnError(
        error instanceof Error ? error.message : "The claude CLI could not be started.",
      );
      return;
    }
    this.child = child;

    child.stdin.on("error", () => {
      this.stdinBroken = true;
      this.callbacks.onStdinError();
    });
    child.stdout.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString()));
    child.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      this.settle();
      this.callbacks.onSpawnError(
        code === "ENOENT"
          ? "The claude CLI is not available on this machine."
          : "The claude sign-in process could not be started.",
      );
    });
    child.once("close", (code) => {
      this.settle();
      this.callbacks.onExit(code);
    });

    this.timeoutTimer = setTimeout(() => {
      this.callbacks.onTimeout();
      this.terminate();
    }, this.timeoutMs);
    this.timeoutTimer.unref?.();

    this.callbacks.onSpawned();
  }

  private handleOutput(text: string): void {
    this.output = (this.output + text).slice(-OUTPUT_WINDOW_CHARS);
    const url = extractClaudeLoginUrl(this.output);
    // Only report URL changes: re-reporting the same URL on every later
    // chunk would clear a non-terminal error such as a rejected code.
    if (url !== null && url !== this.lastUrl) {
      this.lastUrl = url;
      this.callbacks.onUrl(url);
    }
    if (/invalid code/i.test(text)) {
      this.callbacks.onOutputError(
        "That code wasn't accepted. Copy the full code from the browser and paste it again.",
      );
    }
  }

  /** True while the child is running and can accept a code on stdin. */
  get acceptsInput(): boolean {
    return (
      !this.exited &&
      !this.stdinBroken &&
      this.child !== null &&
      this.child.stdin.writable &&
      !this.child.stdin.destroyed
    );
  }

  /** True after the child was spawned and has not exited. */
  get isRunning(): boolean {
    return !this.exited && this.child !== null;
  }

  /** Bounded tail of the accumulated output for a failure message. */
  get outputTail(): string {
    return this.output;
  }

  /**
   * Writes the browser's sign-in code to stdin. The code is validated before
   * it is written and never retained. Asynchronous write failures surface
   * through the callbacks instead of an unhandled stream error.
   */
  submitCode(rawCode: string): { ok: true } | { ok: false; reason: string } {
    if (!this.acceptsInput) {
      return { ok: false, reason: "The Claude sign-in process is no longer accepting input." };
    }
    if (!isValidClaudeLoginCode(rawCode)) {
      return { ok: false, reason: "That does not look like the code the browser showed." };
    }
    const child = this.child;
    if (child === null) {
      return { ok: false, reason: "No Claude sign-in is waiting for a code." };
    }
    child.stdin.write(`${rawCode.trim()}\n`, (error) => {
      if (error) {
        this.stdinBroken = true;
        this.callbacks.onStdinError();
      }
    });
    return { ok: true };
  }

  /** SIGTERM now, SIGKILL after the grace period; safe to call repeatedly. */
  terminate(): void {
    const child = this.child;
    if (child === null || this.exited) {
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (this.killTimer === null) {
      this.killTimer = setTimeout(() => {
        try {
          this.child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, this.killGraceMs);
      this.killTimer.unref?.();
    }
  }

  /** Waits until the child has stopped before releasing credential ownership. */
  async stop(): Promise<void> {
    this.terminate();
    if (this.started) {
      await this.closed;
    }
  }

  private settle(): void {
    this.exited = true;
    this.resolveClosed();
    if (this.timeoutTimer !== null) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}

/** Bounded, sanitized tail of a failed login's output for a UI message. */
export function claudeLoginFailureMessage(output: string, exitCode: number | null): string {
  const tail = output
    .split("\n")
    .map((line) => sanitizeProcessText(line))
    .filter((line) => line.length > 0)
    .slice(-2)
    .join(" ");
  if (tail.length > 0) {
    return tail;
  }
  return exitCode !== null
    ? `claude auth login exited with code ${exitCode}.`
    : "claude auth login did not finish.";
}
