/**
 * Claude Code adapter (stage 10). Server-only.
 *
 * The third AI CLI driver, next to codex.ts and opencode.ts: it spawns the
 * `claude` CLI in print mode (`claude -p --output-format stream-json
 * --verbose --include-partial-messages`) with the prompt on stdin, and parses
 * the newline-delimited JSON event stream into the same CodexStreamEvent
 * shape the chat and report layers already consume. The session id the CLI
 * reports feeds `--resume <session-id>` on later turns.
 *
 * Authentication always comes from the machine's Claude subscription
 * (`claude auth login`, credentials in the CLI's own store). The child
 * environment strips API keys, bearer tokens, alternate-provider routing,
 * endpoint overrides, and model/effort overrides so an ambient credential
 * can never silently take over the selected billing source; the CLI's own
 * config locations (`CLAUDE_CONFIG_DIR`, home) are preserved.
 *
 * Native user configuration is isolated with `--safe-mode`,
 * `--setting-sources ""` (no user/project/local settings files), an explicit
 * empty strict MCP config, and `--tools` allowlists; the CLI's documented
 * `dontAsk` permission mode denies anything that would otherwise prompt, so
 * chat gets read tools only and reports can write their deliverable inside
 * the job directory but nowhere else. `--bare` is deliberately not used:
 * it skips OAuth/keychain reads and would break subscription sign-in.
 *
 * The binary is resolved per machine: an explicit SCOPE_CLAUDE_PATH override,
 * then a mise-managed install (via `mise where`, which never installs), then
 * a bare "claude" from PATH. The spawner is injectable, so unit tests never
 * touch the real CLI.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
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
  type CodexSandboxMode,
  type CodexSpawner,
  type CodexStreamEvent,
  type CodexUsage,
} from "./codex";

/** Model pinned when a caller names none: the fast Haiku family. */
export const DEFAULT_CLAUDE_MODEL = "haiku";

/** Hard ceiling for one claude run; agentic turns can be slow. */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 15 * 60_000;

/**
 * Oldest CLI this adapter supports. `--safe-mode` (the configuration
 * isolation the adapter relies on) landed in v2.1.169.
 */
export const MIN_SUPPORTED_CLAUDE_VERSION = "2.1.169";

/** Read-only tools chat may use; no shell, web, MCP, write, or delegation. */
export const CLAUDE_CHAT_TOOLS = ["Read", "Grep", "Glob"] as const;

/** Report runs add exactly one write-capable tool for the HTML deliverable. */
export const CLAUDE_REPORT_TOOLS = ["Read", "Grep", "Glob", "Write"] as const;

/**
 * Allow rule that pre-approves file writes under the job directory (the
 * run's cwd). Claude Code evaluates file permissions through its `Edit`
 * rules, which cover the Write tool.
 */
export const CLAUDE_REPORT_WRITE_RULE = "Edit(./**)";

/** Transcript inputs and the materialization manifest stay untouched. */
export const CLAUDE_REPORT_PROTECTED_RULES = "Edit(transcripts/**),Edit(manifest.json)";

/** How long a SIGTERM'd claude gets to exit before escalating to SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** Bounded tail of stderr kept for failure classification and error messages. */
const STDERR_TAIL_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ClaudeRunOptions {
  /** Prompt sent to claude on stdin. */
  prompt: string;
  /** Working directory for the run. */
  workDir: string;
  /** Shared sandbox intent: read-only chat, workspace-write reports. */
  sandbox?: CodexSandboxMode;
  /** Model alias or full id; defaults to DEFAULT_CLAUDE_MODEL. */
  model?: string;
  /** Effort level (low/medium/high/xhigh/max) when the model supports it. */
  reasoningEffort?: string;
  /** Continue an earlier session (spawns `claude -p --resume <sessionId>`). */
  resumeSessionId?: string;
  /** Abort to kill the child and fail the run with CodexAbortedError. */
  signal?: AbortSignal | undefined;
  /** Hard ceiling for the run. Defaults to DEFAULT_CLAUDE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Injectable process spawner; defaults to the real Node spawner. */
  spawner?: CodexSpawner;
  /** claude binary; defaults to resolveClaudeLaunch()'s answer. */
  command?: string;
  /** Arguments prepended to the claude argv (script path for wrapper launches). */
  commandArgs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

let cachedResolvedLaunch: ProviderLaunch | null = null;

/** Drops the cached binary resolution; intended for tests and settings saves. */
export function resetClaudeCommandCache(): void {
  cachedResolvedLaunch = null;
}

/**
 * Resolves the claude launch for this machine. SCOPE_CLAUDE_PATH wins, then
 * the Settings executable-path override; then, outside Windows, a mise-managed
 * install is resolved to its real binary (the PATH shim runs `mise use -g
 * claude`, which can try to install the tool — `mise where` only reports an
 * existing install); then platform discovery (native install locations,
 * PATH, and npm command wrappers on Windows). Status, login, discovery, and
 * inference all call this one resolver.
 */
export async function resolveClaudeLaunch(): Promise<ProviderLaunch> {
  const override = process.env.SCOPE_CLAUDE_PATH?.trim();
  if (override) {
    return resolveProviderLaunch("claude", override, { configured: true });
  }
  const storedOverride = getProviderPathOverride("claude");
  if (storedOverride) {
    return resolveProviderLaunch("claude", storedOverride, { configured: true });
  }
  if (cachedResolvedLaunch) {
    return cachedResolvedLaunch;
  }
  if (process.platform !== "win32") {
    try {
      const installDir = await new Promise<string>((resolve, reject) => {
        execFile(
          "mise",
          ["where", "claude"],
          { timeout: 5_000, windowsHide: true },
          (error, stdout) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(stdout.trim());
          },
        );
      });
      if (installDir) {
        for (const name of ["claude", "claude.exe"]) {
          // The mise install directory is a runtime value outside the project;
          // without the ignore comment Turbopack traces the whole project (and
          // any build output under it) into the standalone server bundle.
          const candidate = path.join(/* turbopackIgnore: true */ installDir, name);
          if (existsSync(/* turbopackIgnore: true */ candidate)) {
            cachedResolvedLaunch = resolveProviderLaunch("claude", candidate, {
              configured: true,
            });
            return cachedResolvedLaunch;
          }
        }
      }
    } catch {
      // No mise (or it failed fast): fall through to platform discovery.
    }
  }
  return resolveProviderLaunch("claude", "claude");
}

// ---------------------------------------------------------------------------
// Child environment policy
// ---------------------------------------------------------------------------

/**
 * Environment variables that would silently change which account, provider,
 * or model a claude run uses. Credential precedence (documented): cloud
 * provider switches, bearer token, API key, apiKeyHelper (disabled through
 * settings isolation), OAuth token env, profiles/federation, then the native
 * /login subscription credential. Everything in front of the subscription
 * credential is removed here; `CLAUDE_CONFIG_DIR` and the home directory are
 * preserved so the native login still resolves.
 */
const EXCLUDED_CLAUDE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "CLAUDE_CODE_EFFORT_LEVEL",
] as const;

/** Shared env policy for claude status, login, and inference children. */
export function claudeChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of EXCLUDED_CLAUDE_ENV_VARS) {
    delete copy[key];
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Real spawner
// ---------------------------------------------------------------------------

async function* readUtf8Stream(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const readable = stream as Readable;
  readable.setEncoding("utf8");
  for await (const chunk of readable) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
}

/** Real spawner: argument arrays only — the shell is never involved. */
export function createNodeClaudeSpawner(): CodexSpawner {
  return (request) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      shell: false,
      windowsHide: true,
      env: claudeChildEnvironment(),
    });
    // EPIPE when claude exits before/while the prompt is written surfaces
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
  /usage credits/i,
];

const AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /login required/i,
  /not authenticated/i,
  /authentication failed/i,
  /authentication_error/i,
  /unauthorized/i,
  /\b401\b/,
  /\b403\b/,
  /invalid api key/i,
  /oauth token (expired|revoked|invalid)/i,
  /login expired/i,
];

const PERMISSION_PATTERNS = [
  /permission to use/i,
  /permission denied/i,
  /permission_denied/i,
  /not allowed to use/i,
  /denied by (the )?permission/i,
];

export interface ClaudeFailureInput {
  exitCode: number | null;
  signal: string | null;
  stderrTail: string;
  failureMessage: string | null;
  /** HTTP status the CLI reported for a failed API request, when known. */
  apiStatus?: number | null;
}

function detectClaudeFailure(input: ClaudeFailureInput): CodexError {
  const details = {
    exitCode: input.exitCode,
    signal: input.signal,
    stderrTail: input.stderrTail,
  };
  const text = (input.failureMessage ?? input.stderrTail).trim();
  const diagnostic = text.length > 400 ? `${text.slice(0, 400)}…` : text || "(no diagnostics)";
  const exitDescription =
    input.exitCode !== null ? `exit code ${input.exitCode}` : `signal ${input.signal ?? "unknown"}`;

  // Quota before auth: a message can legitimately contain both "unauthorized"
  // and "usage limit", and the limit is the actionable cause.
  if (input.apiStatus === 429 || QUOTA_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
    return new CodexQuotaExceededError(`Claude hit a usage or rate limit: ${diagnostic}`, details);
  }
  if (
    input.apiStatus === 401 ||
    input.apiStatus === 403 ||
    AUTH_PATTERNS.some((pattern) => pattern.test(diagnostic))
  ) {
    return new CodexNotAuthenticatedError(
      `Claude is not signed in to a subscription: ${diagnostic}`,
      details,
    );
  }
  if (PERMISSION_PATTERNS.some((pattern) => pattern.test(diagnostic))) {
    return new CodexNonZeroExitError(
      `Claude could not use a tool it needed (permission denied): ${diagnostic}`,
      details,
    );
  }
  if (input.failureMessage !== null) {
    return new CodexNonZeroExitError(`Claude turn failed: ${diagnostic}`, details);
  }
  return new CodexNonZeroExitError(`claude exited with ${exitDescription}: ${diagnostic}`, details);
}

function toSpawnFailure(error: unknown, stderrTail: string): CodexError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : null;
  const message = error instanceof Error ? error.message : String(error);
  return new CodexBinaryNotFoundError(
    `Could not spawn claude${typeof code === "string" ? ` (${code})` : ""}: ${message}`,
    { exitCode: null, signal: null, stderrTail },
  );
}

// ---------------------------------------------------------------------------
// Argument construction
// ---------------------------------------------------------------------------

interface ClaudeArgsInput {
  model: string;
  reasoningEffort?: string;
  sandbox: CodexSandboxMode;
  resumeSessionId?: string;
}

/**
 * Builds the argv for a claude print-mode run. The prompt itself rides on
 * stdin, so even very large prompts stay away from the argv size limit.
 * `--safe-mode`, the empty settings-source list, and the strict empty MCP
 * config keep the user's hooks, plugins, agents, skills, memory, and MCP
 * servers out of scope's runs; `--tools` narrows the toolset and
 * `dontAsk` denies anything that would otherwise prompt (a prompt
 * instruction is not access enforcement).
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const reportRun = input.sandbox === "workspace-write";
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    input.model,
    "--setting-sources",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--tools",
    (reportRun ? CLAUDE_REPORT_TOOLS : CLAUDE_CHAT_TOOLS).join(","),
    "--permission-mode",
    "dontAsk",
  ];
  if (input.reasoningEffort) {
    args.push("--effort", input.reasoningEffort);
  }
  if (reportRun) {
    // Reports may create/overwrite files under their job directory only;
    // the protected rules keep the materialized transcripts intact.
    args.push("--allowedTools", CLAUDE_REPORT_WRITE_RULE);
    args.push("--disallowedTools", CLAUDE_REPORT_PROTECTED_RULES);
  }
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId);
  }
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

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalizes the CLI's result usage. Claude reports fresh input, cache
 * reads, and cache writes as separate counters; each maps to its own field
 * and totalTokens adds each source once. Unavailable fields stay null.
 */
function toUsage(raw: unknown): CodexUsage | null {
  if (!isRecord(raw)) {
    return null;
  }
  const inputTokens = asNumber(raw.input_tokens);
  const cachedInputTokens = asNumber(raw.cache_read_input_tokens);
  const cacheWriteInputTokens = asNumber(raw.cache_creation_input_tokens);
  const outputTokens = asNumber(raw.output_tokens);
  const details = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : null;
  const reasoningOutputTokens = details ? asNumber(details.thinking_tokens) : null;
  const known = [inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens].filter(
    (value): value is number => value !== null,
  );
  if (known.length === 0) {
    return null;
  }
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: known.reduce((sum, value) => sum + value, 0),
  };
}

/** Concatenates the text blocks of one assistant message; [] when none. */
function assistantText(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of message.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
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
// runClaude
// ---------------------------------------------------------------------------

export function runClaude(options: ClaudeRunOptions): CodexRun {
  const sandbox = options.sandbox ?? "read-only";
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
  const spawner = options.spawner ?? createNodeClaudeSpawner();
  const command = options.command ?? "claude";
  const commandArgs = [...(options.commandArgs ?? [])];

  const child = spawner({
    command,
    args: [
      ...commandArgs,
      ...buildClaudeArgs({
        model,
        reasoningEffort: options.reasoningEffort,
        sandbox,
        resumeSessionId: options.resumeSessionId,
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
  const emittedTextByMessage = new Map<string, string>();
  const stderrChunks: string[] = [];

  let sessionId: string | null = options.resumeSessionId ?? null;
  let finalMessage = "";
  let resultText: string | null = null;
  let failureMessage: string | null = null;
  let failureStatus: number | null = null;
  let sawTerminalResult = false;
  let usage: CodexUsage | null = null;
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

  function recordSession(id: string | null): void {
    if (id !== null && id !== sessionId) {
      sessionId = id;
      queue.push({ type: "session_started", sessionId: id });
    }
  }

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
        // Tolerate non-JSON noise on stdout (mise shim banners, warnings).
        continue;
      }
      if (!isRecord(event)) {
        continue;
      }
      handleEvent(event);
    }
  }

  function handleEvent(event: Record<string, unknown>): void {
    const type = asString(event.type);
    switch (type) {
      case "system": {
        if (event.subtype === "init") {
          recordSession(asString(event.session_id));
        }
        // Other system events (status, hooks, retries) carry nothing the
        // chat or report layers need.
        return;
      }
      case "stream_event": {
        handleStreamEvent(event);
        return;
      }
      case "assistant": {
        handleAssistantMessage(event);
        return;
      }
      case "result": {
        handleResult(event);
        return;
      }
      default:
        // Unknown event types are ignored for forward compatibility.
        return;
    }
  }

  /** Extracts text deltas from the wrapped Anthropic stream events. */
  function handleStreamEvent(event: Record<string, unknown>): void {
    const inner = isRecord(event.event) ? event.event : null;
    const delta = inner !== null && isRecord(inner.delta) ? inner.delta : null;
    if (delta === null || delta.type !== "text_delta") {
      return;
    }
    const text = asString(delta.text);
    if (text !== null && text.length > 0) {
      queue.push({ type: "text_delta", text });
    }
  }

  /**
   * Completed assistant messages are authoritative: they replace whatever
   * the matching deltas streamed. Thinking, tool inputs/results, and nested
   * agent text are never exposed; repeated identical messages are deduped.
   */
  function handleAssistantMessage(event: Record<string, unknown>): void {
    if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) {
      return;
    }
    const message = isRecord(event.message) ? event.message : null;
    if (message === null) {
      return;
    }
    const text = assistantText(message);
    if (text.length === 0) {
      return;
    }
    const messageId = asString(message.id) ?? `anonymous-${emittedTextByMessage.size}`;
    if (emittedTextByMessage.get(messageId) === text) {
      return;
    }
    emittedTextByMessage.set(messageId, text);
    finalMessage = text;
    queue.push({ type: "message_completed", text });
  }

  function handleResult(event: Record<string, unknown>): void {
    sawTerminalResult = true;
    recordSession(asString(event.session_id));
    resultText = asString(event.result);
    const rawUsage = event.usage;
    usage = toUsage(rawUsage) ?? usage;
    queue.push({ type: "turn_completed", usage });
    failureStatus = asNumber(event.api_error_status);
    const subtype = asString(event.subtype);
    const isError = event.is_error === true || (subtype !== null && subtype !== "success");
    if (isError) {
      failureMessage =
        resultText ?? `Claude reported a ${subtype ?? "failed"} result without a message.`.trim();
    }
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
      throw new CodexAbortedError("Claude run aborted before completion.", details);
    }
    if (timedOut) {
      throw new CodexTimeoutError(`Claude run exceeded its ${timeoutMs} ms timeout.`, details);
    }
    if (failureMessage !== null || failureStatus !== null) {
      throw detectClaudeFailure({
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrTail: stderrTail(),
        failureMessage,
        apiStatus: failureStatus,
      });
    }
    if (exit.exitCode !== 0 || exit.signal !== null) {
      throw detectClaudeFailure({
        exitCode: exit.exitCode,
        signal: exit.signal,
        stderrTail: stderrTail(),
        failureMessage: null,
      });
    }
    // A zero exit without a terminal result message is a protocol failure:
    // accepting it would report a truncated stream as a successful answer.
    if (!sawTerminalResult) {
      throw new CodexNonZeroExitError(
        "Claude finished without reporting a terminal result; the output stream was incomplete.",
        details,
      );
    }
    // The result text repeats the final assistant message; it is only a
    // fallback for runs that produced no textual assistant message.
    const message = finalMessage.length > 0 ? finalMessage : (resultText ?? "");
    return { sessionId, finalMessage: message, usage };
  })();

  void completed.then(
    () => queue.close(),
    (error: unknown) => queue.fail(error),
  );

  return { events: queue.iterator(), completed };
}
