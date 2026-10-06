/**
 * OpenCode adapter (stage 9). Server-only.
 *
 * The second AI CLI driver, next to codex.ts: it spawns `opencode run
 * --format json` and parses the JSONL event stream on stdout into the same
 * CodexStreamEvent shape the chat and report layers already consume, so the
 * backend choice stays invisible above the adapters. The prompt travels on
 * stdin (opencode reads it when no message argument is given) and the
 * session id surfaced by the events feeds `--session <id>` on later turns.
 *
 * Chat mode settings pass an OpenCode provider-qualified model and its
 * provider-specific variant (reasoning effort). Other AI features can omit
 * these fields and continue using OpenCode's configured default.
 *
 * The binary is resolved per machine: an explicit SCOPE_OPENCODE_BIN
 * override, then `mise which opencode` (mise's PATH shim is a TUI-oriented
 * wrapper that can hang in headless contexts), then a bare "opencode" from
 * PATH. Authentication always comes from the machine's opencode credentials
 * via `opencode auth login` — the default spawner strips API-key environment
 * variables so an ambient key can never silently take over a provider. The
 * spawner is injectable, so unit tests never touch the real CLI.
 */
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

import { getProviderPathOverride } from "./provider-paths";
import { resolveProviderLaunch, type ProviderLaunch } from "./provider-command";

import {
  CodexAbortedError,
  CodexBinaryNotFoundError,
  CodexError,
  CodexNonZeroExitError,
  CodexNotAuthenticatedError,
  CodexQuotaExceededError,
  CodexTimeoutError,
  type CodexExitStatus,
  type CodexRun,
  type CodexRunResult,
  type CodexSpawner,
  type CodexStreamEvent,
  type CodexUsage,
} from "./codex";

/** Hard ceiling for one opencode run; agentic turns can be slow. */
export const DEFAULT_OPENCODE_TIMEOUT_MS = 15 * 60_000;

/** How long a SIGTERM'd opencode gets to exit before escalating to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Bounded tail of stderr kept for failure classification and error messages. */
const STDERR_TAIL_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface OpenCodeRunOptions {
  /** Prompt sent to opencode on stdin. */
  prompt: string;
  /** Working directory for the run. */
  workDir: string;
  /** Continue an earlier session (spawns `opencode run --session <id>`). */
  resumeSessionId?: string;
  /** Abort to kill the child and fail the run with CodexAbortedError. */
  signal?: AbortSignal | undefined;
  /** Hard ceiling for the run. Defaults to DEFAULT_OPENCODE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable process spawner; defaults to the real Node spawner. */
  spawner?: CodexSpawner;
  /** opencode binary; defaults to resolveOpencodeLaunch()'s answer. */
  command?: string;
  /** Arguments prepended to the opencode argv (script path for wrapper launches). */
  commandArgs?: readonly string[];
  /** Provider-qualified model id, for example opencode-go/deepseek-v4-pro. */
  model?: string;
  /** Provider-specific reasoning variant exposed by the selected model. */
  reasoningEffort?: string;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

let cachedResolvedLaunch: ProviderLaunch | null = null;

/** Drops the cached binary resolution; intended for tests and settings saves. */
export function resetOpencodeCommandCache(): void {
  cachedResolvedLaunch = null;
}

/**
 * Resolves the opencode launch for this machine. SCOPE_OPENCODE_BIN wins,
 * then the Settings executable-path override; outside Windows, mise's PATH
 * shim (a bash wrapper around `mise x`) is meant for interactive shells and
 * can hang when spawned headless, so a mise-managed install is resolved
 * straight to its real binary path; then platform discovery (native install
 * locations, PATH, and npm command wrappers on Windows). Status, credential
 * handling, discovery, and inference all call this one resolver.
 */
export async function resolveOpencodeLaunch(): Promise<ProviderLaunch> {
  const override = process.env.SCOPE_OPENCODE_BIN?.trim();
  if (override) {
    return resolveProviderLaunch("opencode", override, { configured: true });
  }
  const storedOverride = getProviderPathOverride("opencode");
  if (storedOverride) {
    return resolveProviderLaunch("opencode", storedOverride, { configured: true });
  }
  if (cachedResolvedLaunch) {
    return cachedResolvedLaunch;
  }
  if (process.platform !== "win32") {
    try {
      const resolved = await new Promise<string>((resolve, reject) => {
        execFile("mise", ["which", "opencode"], { timeout: 5_000 }, (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout.trim());
        });
      });
      if (resolved && existsSync(resolved)) {
        cachedResolvedLaunch = resolveProviderLaunch("opencode", resolved, { configured: true });
        return cachedResolvedLaunch;
      }
    } catch {
      // No mise (or it failed fast): fall through to platform discovery, which
      // is correct for npm/global installs.
    }
  }
  return resolveProviderLaunch("opencode", "opencode");
}

// ---------------------------------------------------------------------------
// Real spawner
// ---------------------------------------------------------------------------

const API_KEY_ENV_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENCODE_API_KEY"] as const;

function withoutApiKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of API_KEY_ENV_VARS) {
    delete copy[key];
  }
  return copy;
}

async function* readUtf8Stream(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const readable = stream as Readable;
  readable.setEncoding("utf8");
  for await (const chunk of readable) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
}

/** Real spawner: argument arrays only — the shell is never involved. */
export function createNodeOpenCodeSpawner(): CodexSpawner {
  return (request) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      // opencode must authenticate from the machine's opencode credentials
      // (~/.local/share/opencode/auth.json); an ambient API key must never
      // silently choose a provider for the user.
      env: withoutApiKeys(process.env),
    });
    // EPIPE when opencode exits before/while the prompt is written surfaces
    // through wait(); swallow it here so it cannot crash the process.
    child.stdin.on("error", () => {});
    return {
      stdin: {
        write: (chunk) => {
          child.stdin.write(chunk);
        },
        end: () => {
          child.stdin.end();
        },
      },
      stdout: readUtf8Stream(child.stdout),
      stderr: readUtf8Stream(child.stderr),
      wait: () =>
        new Promise<CodexExitStatus>((resolve, reject) => {
          let settled = false;
          child.once("error", (error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
          child.once("close", (code, signal) => {
            if (!settled) {
              settled = true;
              resolve({ exitCode: code, signal: signal ?? null });
            }
          });
        }),
      kill: (signal) => {
        child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /too many requests/i,
  /\b429\b/,
  /limit reached/i,
  /out of credits/i,
  /exceeded.{0,30}(credit|balance)/i,
];

const AUTH_PATTERNS = [
  /not logged in/i,
  /not authenticated/i,
  /no credentials/i,
  /log ?in required/i,
  /please (log ?in|sign ?in)/i,
  /auth login/i,
  /unauthorized/i,
  /\b401\b/,
  /invalid api key/i,
  /missing api key/i,
  /api key (is )?(required|not set|missing)/i,
  /authentication (failed|required)/i,
  /providerautherror/i,
];

function diagnosticOf(name: string | null, message: string | null, stderrTail: string): string {
  const text = (message ?? name ?? stderrTail).trim();
  const bounded = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return bounded.length > 0 ? bounded : "(no diagnostics)";
}

/** Maps an opencode failure to the shared error family by kind. */
function classifyOpenCodeFailure(input: {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  errorName: string | null;
  failureMessage: string | null;
}): CodexError {
  const details = {
    exitCode: input.exitCode,
    signal: input.signal,
    stderrTail: input.stderrTail,
  };
  const diagnostic = diagnosticOf(input.errorName, input.failureMessage, input.stderrTail);
  const exitDescription =
    input.exitCode !== null ? `exit code ${input.exitCode}` : `signal ${input.signal ?? "unknown"}`;
  const suffix = `: ${diagnostic}`;
  const classifier = `${input.errorName ?? ""} ${diagnostic}`;

  // Quota before auth: a message can legitimately contain both "unauthorized"
  // and "usage limit", and the limit is the actionable cause.
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(classifier))) {
    return new CodexQuotaExceededError(`OpenCode hit a usage or rate limit${suffix}`, details);
  }
  if (
    input.errorName === "ProviderAuthError" ||
    input.errorName === "AuthError" ||
    AUTH_PATTERNS.some((pattern) => pattern.test(classifier))
  ) {
    return new CodexNotAuthenticatedError(
      `opencode is not authenticated for the selected provider${suffix}`,
      details,
    );
  }
  if (input.failureMessage !== null || input.errorName !== null) {
    return new CodexNonZeroExitError(`OpenCode turn failed${suffix}`, details);
  }
  return new CodexNonZeroExitError(`opencode exited with ${exitDescription}${suffix}`, details);
}

function toSpawnFailure(error: unknown, stderrTail: string): CodexError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  const message = error instanceof Error ? error.message : String(error);
  return new CodexBinaryNotFoundError(
    `Could not spawn opencode${typeof code === "string" ? ` (${code})` : ""}: ${message}`,
    { exitCode: null, signal: null, stderrTail },
  );
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

interface OpenCodeArgsInput {
  resumeSessionId?: string;
  model?: string;
  reasoningEffort?: string;
}

/**
 * Builds the argv for opencode run. `--format json` emits one JSON event per
 * line on stdout; the prompt itself rides on stdin (opencode reads it when
 * no message argument is given), which keeps even very large prompts away
 * from the argv size limit.
 */
function buildOpenCodeArgs(input: OpenCodeArgsInput): string[] {
  const args = ["run", "--format", "json"];
  if (input.resumeSessionId) {
    args.push("--session", input.resumeSessionId);
  }
  if (input.model?.includes("/")) {
    args.push("--model", input.model);
    if (input.reasoningEffort) {
      args.push("--variant", input.reasoningEffort);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Event stream parsing
// ---------------------------------------------------------------------------

interface OpenCodeEvent {
  type?: unknown;
  sessionID?: unknown;
  part?: unknown;
  error?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toUsage(raw: unknown): CodexUsage | null {
  if (!isRecord(raw)) {
    return null;
  }
  const num = (key: string): number | null => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const cache = isRecord(raw.cache) ? raw.cache : {};
  return {
    inputTokens: num("input"),
    cachedInputTokens: cacheRead(cache),
    cacheWriteInputTokens: cacheWrite(cache),
    outputTokens: num("output"),
    reasoningOutputTokens: num("reasoning"),
    totalTokens: num("total"),
  };
}

function cacheRead(cache: Record<string, unknown>): number | null {
  return typeof cache.read === "number" && Number.isFinite(cache.read) ? cache.read : null;
}

function cacheWrite(cache: Record<string, unknown>): number | null {
  return typeof cache.write === "number" && Number.isFinite(cache.write) ? cache.write : null;
}

/** Splits an utf-8 chunk stream into lines, tolerating CRLF and a final
 * unterminated line. */
async function* toLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      yield buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  }
  if (buffer.trim().length > 0) {
    yield buffer;
  }
}

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

type QueueItem<T> = { value: T } | { error: unknown } | { closed: true };

/** Minimal single-consumer async queue connecting the pump to the iterator. */
function createEventQueue<T>(): {
  push(value: T): void;
  fail(error: unknown): void;
  close(): void;
  iterator(): AsyncGenerator<T, void, void>;
} {
  const items: QueueItem<T>[] = [];
  let notify: (() => void) | null = null;

  function wake(): void {
    const pending = notify;
    notify = null;
    pending?.();
  }

  return {
    push(value: T): void {
      items.push({ value });
      wake();
    },
    fail(error: unknown): void {
      items.push({ error });
      wake();
    },
    close(): void {
      items.push({ closed: true });
      wake();
    },
    iterator(): AsyncGenerator<T, void, void> {
      return (async function* () {
        for (;;) {
          const item = items.shift();
          if (!item) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            continue;
          }
          if ("closed" in item) {
            return;
          }
          if ("error" in item) {
            throw item.error;
          }
          yield item.value;
        }
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// runOpencode
// ---------------------------------------------------------------------------

export function runOpencode(options: OpenCodeRunOptions): CodexRun {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENCODE_TIMEOUT_MS;
  const spawner = options.spawner ?? createNodeOpenCodeSpawner();
  const command = options.command ?? "opencode";
  const commandArgs = [...(options.commandArgs ?? [])];

  const child = spawner({
    command,
    args: [
      ...commandArgs,
      ...buildOpenCodeArgs({
        resumeSessionId: options.resumeSessionId,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      }),
    ],
    cwd: options.workDir,
  });

  // The prompt travels on stdin; a write against an already-dead child must
  // not crash the run — wait() reports the real failure.
  try {
    child.stdin.write(options.prompt);
    child.stdin.end();
  } catch {
    // wait() decides the outcome.
  }

  const queue = createEventQueue<CodexStreamEvent>();
  const emittedTextByPart = new Map<string, string>();
  const stderrChunks: string[] = [];

  let sessionId: string | null = options.resumeSessionId ?? null;
  let currentTextPartId: string | null = null;
  let finalMessage = "";
  let failureMessage: string | null = null;
  let failureName: string | null = null;
  let lastUsage: CodexUsage | null = null;
  let aborted = options.signal?.aborted === true;
  let timedOut = false;
  let killEscalation: ReturnType<typeof setTimeout> | null = null;

  function stderrTail(): string {
    return stderrChunks.join("").slice(-STDERR_TAIL_CHARS);
  }

  function killChild(): void {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already dead.
    }
    if (!killEscalation) {
      killEscalation = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }, KILL_GRACE_MS);
    }
  }

  const onAbort = (): void => {
    aborted = true;
    killChild();
  };
  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
  }
  if (aborted) {
    killChild();
  }

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    killChild();
  }, timeoutMs);

  async function pumpStdout(): Promise<void> {
    for await (const line of toLines(child.stdout)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        // Tolerate non-JSON noise on stdout.
        continue;
      }
      if (!isRecord(event)) {
        continue;
      }
      const ocEvent = event as OpenCodeEvent;
      const eventSessionId = asString(ocEvent.sessionID);
      if (eventSessionId !== null) {
        sessionId = eventSessionId;
        queue.push({ type: "session_started", sessionId: eventSessionId });
      }
      if (ocEvent.type === "text") {
        handleTextPart(ocEvent.part);
      } else if (ocEvent.type === "step_finish") {
        handleStepFinish(ocEvent.part);
      } else if (ocEvent.type === "error") {
        recordError(ocEvent.error);
      }
      // step_start and unknown event types carry nothing the layers need.
    }
  }

  /** Diffs growing text parts into deltas; opencode re-emits the full part
   * text as it streams, keyed by part id. */
  function handleTextPart(part: unknown): void {
    if (!isRecord(part) || part.type !== "text") {
      return;
    }
    const id = asString(part.id);
    const text = asString(part.text);
    if (id === null || text === null) {
      return;
    }
    currentTextPartId = id;
    const previous = emittedTextByPart.get(id) ?? "";
    if (text.length > previous.length && text.startsWith(previous)) {
      emittedTextByPart.set(id, text);
      queue.push({ type: "text_delta", text: text.slice(previous.length) });
    } else if (!emittedTextByPart.has(id)) {
      // A first chunk that replaces nothing still opens the stream.
      emittedTextByPart.set(id, text);
      if (text.length > 0) {
        queue.push({ type: "text_delta", text });
      }
    }
  }

  /** A finished step closes its newest text part as one completed message. */
  function handleStepFinish(part: unknown): void {
    if (isRecord(part)) {
      const tokens = isRecord(part.tokens) ? part.tokens : null;
      if (tokens) {
        lastUsage = toUsage(tokens);
        queue.push({ type: "turn_completed", usage: lastUsage });
      }
    }
    if (currentTextPartId !== null) {
      const text = emittedTextByPart.get(currentTextPartId) ?? "";
      finalMessage = text;
      queue.push({ type: "message_completed", text });
      currentTextPartId = null;
    }
  }

  function recordError(raw: unknown): void {
    if (!isRecord(raw)) {
      return;
    }
    failureName = asString(raw.name);
    const data = isRecord(raw.data) ? raw.data : null;
    const message = data !== null ? asString(data.message) : null;
    failureMessage = message ?? failureMessage ?? "OpenCode turn failed without an error message.";
  }

  async function pumpStderr(): Promise<void> {
    for await (const chunk of child.stderr) {
      stderrChunks.push(chunk);
    }
  }

  const completed = (async (): Promise<CodexRunResult> => {
    let exit: CodexExitStatus = { exitCode: null, signal: null };
    let readingStdout: Promise<void> | null = null;
    let readingStderr: Promise<void> | null = null;
    try {
      readingStdout = pumpStdout();
      readingStderr = pumpStderr();
      exit = await child.wait();
    } catch (error) {
      // wait() only rejects when the process could not be spawned at all.
      await Promise.allSettled([readingStdout, readingStderr]);
      throw toSpawnFailure(error, stderrTail());
    } finally {
      clearTimeout(timeoutTimer);
      if (killEscalation !== null) {
        clearTimeout(killEscalation);
      }
      if (options.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }
    }
    await Promise.allSettled([readingStdout, readingStderr]);

    const details = {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stderrTail: stderrTail(),
    };
    if (aborted) {
      throw new CodexAbortedError("OpenCode run aborted before completion.", details);
    }
    if (timedOut) {
      throw new CodexTimeoutError(`OpenCode run exceeded its ${timeoutMs} ms timeout.`, details);
    }
    if (exit.exitCode !== 0 || exit.signal !== null || failureMessage !== null) {
      throw classifyOpenCodeFailure({
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrTail: stderrTail(),
        errorName: failureName,
        failureMessage,
      });
    }
    return { sessionId, finalMessage, usage: lastUsage };
  })();

  void completed.then(
    () => queue.close(),
    (error: unknown) => queue.fail(error),
  );

  return { events: queue.iterator(), completed };
}
