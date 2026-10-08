/**
 * Codex adapter (stage 2). Server-only.
 *
 * The only code in the app that spawns the codex CLI. Each run executes
 * `codex exec --json` with the prompt piped to stdin and a pinned model and
 * reasoning effort, then parses the JSONL event stream on stdout into a typed
 * async iterable: text deltas when the CLI streams partial text, completed
 * agent messages, retraction of codex's interim plan message, and per-turn
 * token usage. Every run surfaces the
 * session/thread id so later stages can continue a conversation with
 * `codex exec resume <sessionId>`.
 *
 * Authentication always comes from the machine's ChatGPT subscription via
 * ~/.codex/auth.json — the default spawner strips API-key environment
 * variables so codex can never fall back to a key. The spawner is injectable,
 * so unit tests never touch the real CLI; the only test that does is the
 * opt-in live smoke test (SCOPE_AI_LIVE_TEST=1).
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { getProviderPathOverride } from "./provider-paths";
import { resolveProviderLaunch, type ProviderLaunch } from "./provider-command";

/** Model used when a scope AI run does not specify one. */
export const DEFAULT_CODEX_MODEL = "gpt-6.1-sol";

/** Reasoning effort used when a scope AI run does not specify one. */
export const DEFAULT_CODEX_REASONING_EFFORT = "xhigh";

/** Sandbox policy for shell commands codex runs on its own behalf. */
export type CodexSandboxMode = "read-only" | "workspace-write";

/** Default sandbox: transcripts are inputs, never something codex may edit. */
export const DEFAULT_CODEX_SANDBOX: CodexSandboxMode = "read-only";

/** Hard ceiling for one codex run; xhigh reasoning turns can be slow. */
export const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60_000;

/** How long a SIGTERM'd codex gets to exit before escalating to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Bounded tail of stderr kept for failure classification and error messages. */
const STDERR_TAIL_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Resolves the codex launch for this machine: SCOPE_CODEX_PATH (development
 * override), then the Settings executable-path override, then automatic
 * discovery (native install locations, PATH, and npm command wrappers on
 * Windows). The auth account client, model discovery, inference, and reports
 * all share this resolver so status, login, and AI work always drive the same
 * installation.
 */
export function resolveCodexLaunch(env: NodeJS.ProcessEnv = process.env): ProviderLaunch {
  const envOverride = env.SCOPE_CODEX_PATH?.trim();
  if (envOverride && envOverride.length > 0) {
    return resolveProviderLaunch("codex", envOverride, { configured: true, env });
  }
  const storedOverride = getProviderPathOverride("codex");
  if (storedOverride) {
    return resolveProviderLaunch("codex", storedOverride, { configured: true, env });
  }
  return resolveProviderLaunch("codex", "codex", { env });
}

/** Token accounting from a completed turn; nulls for fields codex omitted. */
export interface CodexUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
}

/**
 * Events surfaced while a codex run is in flight. The CLI delivers text in
 * `item.completed` events; when it streams partial text through
 * `item.started`/`item.updated`, the diff is surfaced as `text_delta`.
 * Codex 0.150.1 emits an interim "plan" agent message before the real
 * answer; when a second agent message proves the previous one was that
 * plan, `message_superseded` retracts it before the answer streams.
 */
export type CodexStreamEvent =
  | { type: "session_started"; sessionId: string }
  | { type: "text_delta"; text: string }
  | { type: "message_completed"; text: string }
  | { type: "message_superseded" }
  | { type: "turn_completed"; usage: CodexUsage | null };

/** Final state of a successful codex run. */
export interface CodexRunResult {
  /**
   * Session/thread id for `codex exec resume <sessionId>`. Falls back to the
   * requested resumeSessionId when the CLI never announced a thread id.
   */
  sessionId: string | null;
  /** The last completed agent message ("" when the turn produced none). */
  finalMessage: string;
  /** Token usage of the last completed turn, when reported. */
  usage: CodexUsage | null;
}

/**
 * Handle to one in-flight run. `events` supports a single consumer; failures
 * are surfaced both by the iterator throwing and by `completed` rejecting
 * with the same CodexError instance.
 */
export interface CodexRun {
  readonly events: AsyncIterable<CodexStreamEvent>;
  readonly completed: Promise<CodexRunResult>;
}

export interface CodexRunOptions {
  /** Prompt sent to codex on stdin. */
  prompt: string;
  /** Working directory handed to codex via -C. */
  workDir: string;
  /** Sandbox for agent-run shell commands. Defaults to read-only. */
  sandbox?: CodexSandboxMode;
  /** Defaults to DEFAULT_CODEX_MODEL. */
  model?: string;
  /** Undefined uses Scope’s default; null omits the provider override. */
  reasoningEffort?: string | null;
  /** Continue an earlier session (spawns `codex exec resume <sessionId>`). */
  resumeSessionId?: string;
  /** Allow running outside a git repository (codex refuses otherwise). */
  skipGitRepoCheck?: boolean;
  /** Abort to kill the child and fail the run with CodexAbortedError. */
  signal?: AbortSignal | undefined;
  /** Hard ceiling for the run. Defaults to DEFAULT_CODEX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable process spawner; defaults to the real Node spawner. */
  spawner?: CodexSpawner;
  /** codex binary; defaults to resolveCodexLaunch()'s answer. */
  command?: string;
  /** Arguments prepended to the codex argv (script path for wrapper launches). */
  commandArgs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Spawner seam
// ---------------------------------------------------------------------------

export interface CodexSpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
}

export interface CodexExitStatus {
  exitCode: number | null;
  signal: string | null;
}

/**
 * Minimal process handle. stdout/stderr are plain async iterables of utf-8
 * text so tests can satisfy the whole interface with in-memory generators.
 */
export interface CodexChildProcess {
  stdin: {
    write(chunk: string): void;
    end(): void;
  };
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  /**
   * Resolves when the process exits and its output is fully flushed. Rejects
   * only when the process could not be spawned at all (e.g. ENOENT).
   */
  wait(): Promise<CodexExitStatus>;
  kill(signal?: string): void;
}

export type CodexSpawner = (request: CodexSpawnRequest) => CodexChildProcess;

const API_KEY_ENV_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

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
export function createNodeCodexSpawner(): CodexSpawner {
  return (request) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      // Codex must authenticate from the ChatGPT subscription
      // (~/.codex/auth.json); an ambient API key must never leak into it.
      env: withoutApiKeys(process.env),
    });
    // EPIPE when codex exits before/while the prompt is written surfaces
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
// Typed errors
// ---------------------------------------------------------------------------

export type CodexFailureKind =
  | "not_authenticated"
  | "binary_not_found"
  | "nonzero_exit"
  | "quota_exceeded"
  | "timeout"
  | "aborted";

export interface CodexErrorDetails {
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string;
}

export class CodexError extends Error {
  readonly kind: CodexFailureKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  /** Bounded stderr tail — server logs only, never shown in the UI. */
  readonly stderrTail: string;

  constructor(kind: CodexFailureKind, message: string, details: CodexErrorDetails = {}) {
    super(message);
    this.name = "CodexError";
    this.kind = kind;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
    this.stderrTail = details.stderrTail ?? "";
  }
}

export class CodexNotAuthenticatedError extends CodexError {
  constructor(message: string, details?: CodexErrorDetails) {
    super("not_authenticated", message, details);
    this.name = "CodexNotAuthenticatedError";
  }
}

export class CodexBinaryNotFoundError extends CodexError {
  constructor(message: string, details?: CodexErrorDetails) {
    super("binary_not_found", message, details);
    this.name = "CodexBinaryNotFoundError";
  }
}

export class CodexNonZeroExitError extends CodexError {
  constructor(message: string, details?: CodexErrorDetails) {
    super("nonzero_exit", message, details);
    this.name = "CodexNonZeroExitError";
  }
}

export class CodexQuotaExceededError extends CodexError {
  constructor(message: string, details?: CodexErrorDetails) {
    super("quota_exceeded", message, details);
    this.name = "CodexQuotaExceededError";
  }
}

export class CodexTimeoutError extends CodexError {
  constructor(message: string, details?: CodexErrorDetails) {
    super("timeout", message, details);
    this.name = "CodexTimeoutError";
  }
}

export class CodexAbortedError extends CodexError {
  constructor(message: string, details?: CodexErrorDetails) {
    super("aborted", message, details);
    this.name = "CodexAbortedError";
  }
}

const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /too many requests/i,
  /\b429\b/,
  /limit reached/i,
  /out of credits/i,
];

const AUTH_PATTERNS = [
  /not logged in/i,
  /not authenticated/i,
  /log ?in required/i,
  /please (log ?in|sign ?in)/i,
  /codex login/i,
  /unauthorized/i,
  /\b401\b/,
  /invalid api key/i,
  /missing api key/i,
  /api key (is )?(required|not set|missing)/i,
  /authentication (failed|required)/i,
];

function diagnosticOf(failureMessage: string | null, stderrTail: string): string {
  const text = (failureMessage ?? stderrTail).trim();
  const bounded = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  return bounded.length > 0 ? bounded : "(no diagnostics)";
}

function classifyCodexFailure(input: {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  failureMessage: string | null;
}): CodexError {
  const details: CodexErrorDetails = {
    exitCode: input.exitCode,
    signal: input.signal,
    stderrTail: input.stderrTail,
  };
  const diagnostic = diagnosticOf(input.failureMessage, input.stderrTail);
  const exitDescription =
    input.exitCode !== null ? `exit code ${input.exitCode}` : `signal ${input.signal ?? "unknown"}`;

  // Quota before auth: a message can legitimately contain both "unauthorized"
  // and "usage limit", and the limit is the actionable cause.
  if (QUOTA_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
    return new CodexQuotaExceededError(`Codex hit a usage or rate limit: ${diagnostic}`, details);
  }
  if (AUTH_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
    return new CodexNotAuthenticatedError(`codex is not authenticated: ${diagnostic}`, details);
  }
  if (input.failureMessage !== null) {
    return new CodexNonZeroExitError(`Codex turn failed: ${diagnostic}`, details);
  }
  return new CodexNonZeroExitError(`codex exited with ${exitDescription}: ${diagnostic}`, details);
}

function toSpawnFailure(error: unknown, stderrTail: string): CodexError {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);
  return new CodexBinaryNotFoundError(
    `Could not spawn codex${code ? ` (${code})` : ""}: ${message}`,
    { exitCode: null, signal: null, stderrTail },
  );
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

interface CodexArgsInput {
  model: string;
  reasoningEffort: string | null;
  sandbox: CodexSandboxMode;
  workDir: string;
  resumeSessionId?: string;
  skipGitRepoCheck?: boolean;
}

/**
 * Builds the argv for codex exec. Parent-level options (-m, -c, -s, -C,
 * --skip-git-repo-check) come before the resume subcommand token, because
 * `codex exec resume` does not accept the sandbox and cd flags itself. The
 * trailing "-" makes codex read the prompt from stdin.
 */
function buildCodexArgs(input: CodexArgsInput): string[] {
  const args = [
    "exec",
    "--json",
    "-m",
    input.model,
    ...(input.reasoningEffort === null
      ? []
      : ["-c", `model_reasoning_effort=${JSON.stringify(input.reasoningEffort)}`]),
    "-s",
    input.sandbox,
    "-C",
    input.workDir,
  ];
  if (input.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  if (input.resumeSessionId) {
    args.push("resume", input.resumeSessionId);
  }
  args.push("-");
  return args;
}

// ---------------------------------------------------------------------------
// Event stream parsing
// ---------------------------------------------------------------------------

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
  return {
    inputTokens: num("input_tokens"),
    cachedInputTokens: num("cached_input_tokens"),
    cacheWriteInputTokens: num("cache_write_input_tokens"),
    outputTokens: num("output_tokens"),
    reasoningOutputTokens: num("reasoning_output_tokens"),
    totalTokens: num("total_tokens"),
  };
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
// runCodex
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

export function runCodex(options: CodexRunOptions): CodexRun {
  const sandbox = options.sandbox ?? DEFAULT_CODEX_SANDBOX;
  const model = options.model ?? DEFAULT_CODEX_MODEL;
  const reasoningEffort =
    options.reasoningEffort === undefined
      ? DEFAULT_CODEX_REASONING_EFFORT
      : options.reasoningEffort;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;
  const spawner = options.spawner ?? createNodeCodexSpawner();
  const launch = options.command
    ? { command: options.command, argsPrefix: [...(options.commandArgs ?? [])] }
    : resolveCodexLaunch();

  const child = spawner({
    command: launch.command,
    args: [
      ...launch.argsPrefix,
      ...buildCodexArgs({
        model,
        reasoningEffort,
        sandbox,
        workDir: options.workDir,
        resumeSessionId: options.resumeSessionId,
        skipGitRepoCheck: options.skipGitRepoCheck,
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
  const emittedTextByItem = new Map<string, string>();
  /** Agent-message item ids seen this run, in first-appearance order. */
  const agentMessageItems = new Set<string>();
  const stderrChunks: string[] = [];

  let sessionId: string | null = options.resumeSessionId ?? null;
  let finalMessage = "";
  let usage: CodexUsage | null = null;
  let failureMessage: string | null = null;
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
      switch (event.type) {
        case "thread.started": {
          const id = asString(event.thread_id);
          if (id !== null) {
            sessionId = id;
            queue.push({ type: "session_started", sessionId: id });
          }
          break;
        }
        case "turn.completed": {
          usage = toUsage(event.usage);
          queue.push({ type: "turn_completed", usage });
          break;
        }
        case "turn.failed": {
          const message = isRecord(event.error) ? asString(event.error.message) : null;
          failureMessage = message ?? "Codex turn failed without an error message.";
          break;
        }
        case "item.started":
        case "item.updated": {
          supersedeInterimMessage(event.item);
          const delta = agentMessageDelta(event.item);
          if (delta !== null) {
            queue.push({ type: "text_delta", text: delta });
          }
          break;
        }
        case "item.completed": {
          const item = isRecord(event.item) ? event.item : null;
          if (item !== null && item.type === "agent_message") {
            supersedeInterimMessage(item);
            const text = asString(item.text) ?? "";
            finalMessage = text;
            if (typeof item.id === "string") {
              emittedTextByItem.set(item.id, text);
            }
            queue.push({ type: "message_completed", text });
          }
          break;
        }
        default:
          // Unknown event types are ignored for forward compatibility.
          break;
      }
    }
  }

  /** Diffs partial agent-message text out of item.started/item.updated
   * events; returns null when the event carries nothing new. */
  function agentMessageDelta(item: unknown): string | null {
    if (!isRecord(item) || item.type !== "agent_message") {
      return null;
    }
    const id = asString(item.id);
    const text = asString(item.text);
    if (id === null || !text) {
      return null;
    }
    const previous = emittedTextByItem.get(id) ?? "";
    if (!text.startsWith(previous) || text.length === previous.length) {
      return null;
    }
    emittedTextByItem.set(id, text);
    return text.slice(previous.length);
  }

  /**
   * Codex 0.150.1 opens many turns with a short "plan" agent message ("I'll
   * inspect the transcript headers, then…") before it does the work and
   * answers. The plan and the answer are indistinguishable while the plan
   * streams, but a second agent-message item in the same turn proves the
   * previous one was the plan: retract it before the real answer's text
   * arrives, so the model's plan never renders as (part of) the answer.
   */
  function supersedeInterimMessage(item: unknown): void {
    if (!isRecord(item) || item.type !== "agent_message") {
      return;
    }
    const id = asString(item.id);
    if (id === null || agentMessageItems.has(id)) {
      return;
    }
    if (agentMessageItems.size > 0) {
      queue.push({ type: "message_superseded" });
    }
    agentMessageItems.add(id);
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

    const details: CodexErrorDetails = {
      exitCode: exit.exitCode,
      signal: exit.signal,
      stderrTail: stderrTail(),
    };
    if (aborted) {
      throw new CodexAbortedError("Codex run aborted before completion.", details);
    }
    if (timedOut) {
      throw new CodexTimeoutError(`Codex run exceeded its ${timeoutMs} ms timeout.`, details);
    }
    if (exit.exitCode !== 0 || exit.signal !== null || failureMessage !== null) {
      throw classifyCodexFailure({
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrTail: stderrTail(),
        failureMessage,
      });
    }
    return { sessionId, finalMessage, usage };
  })();

  void completed.then(
    () => queue.close(),
    (error: unknown) => queue.fail(error),
  );

  return { events: queue.iterator(), completed };
}
