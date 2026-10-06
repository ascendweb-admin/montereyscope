/**
 * Codex app-server account client (provider-auth stage). Server-only.
 *
 * A narrowly scoped stdio JSON-RPC client for the `account/*` subset of the
 * codex app-server protocol. It exists so Settings can read the real account
 * type, start/cancel the official browser and device-code logins, and sign
 * out without scraping console output:
 *
 * - the handshake is completed before any request (`initialize`, then the
 *   `initialized` notification),
 * - requests are correlated by id with per-request timeouts, chunked lines
 *   are reassembled, and every pending request is rejected when the process
 *   exits,
 * - provider URLs are validated as https on openai.com/chatgpt.com before
 *   they reach the UI,
 * - stderr is kept only as a bounded diagnostic tail for server logs; it is
 *   never returned to callers, and no method here logs credentials.
 *
 * Scope owns the child process and shuts it down when idle; it never dials an
 * unrelated user daemon. The transport is injectable, so tests never spawn
 * the real CLI.
 */
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { resolveCodexLaunch } from "../codex";

/** Scope's client identity for the app-server handshake. */
export const CODEX_CLIENT_INFO = {
  name: "scope",
  title: "Scope",
  version: "0.1.0",
} as const;

/** How long one request may wait for its response. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/** How long the handshake may take before the client gives up. */
export const DEFAULT_INITIALIZE_TIMEOUT_MS = 20_000;

/** Bounded stderr tail kept for server-side diagnostics only. */
const STDERR_TAIL_CHARS = 4_000;

/** Cap on a single protocol line; a runaway stream is a protocol failure. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

export interface CodexAccountTransportExit {
  exitCode: number | null;
  signal: string | null;
}

export interface CodexAccountTransport {
  stdin: { write(chunk: string): void; end(): void };
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  /** Resolves on exit; rejects only when the process could not spawn. */
  wait(): Promise<CodexAccountTransportExit>;
  kill(signal?: string): void;
}

export interface CodexAccountSpawnRequest {
  command: string;
  /** Arguments prepended to `app-server` (script path for wrapper launches). */
  argsPrefix?: readonly string[];
  env: NodeJS.ProcessEnv;
}

export type CodexAccountSpawner = (request: CodexAccountSpawnRequest) => CodexAccountTransport;

async function* readUtf8Stream(stream: NodeJS.ReadableStream): AsyncGenerator<string> {
  const readable = stream as Readable;
  readable.setEncoding("utf8");
  for await (const chunk of readable) {
    yield typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
}

/** Real spawner for `codex app-server`; ambient API keys are stripped. */
export function createNodeCodexAccountSpawner(): CodexAccountSpawner {
  return (request) => {
    const child = spawn(request.command, [...(request.argsPrefix ?? []), "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: request.env,
    });
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
        new Promise<CodexAccountTransportExit>((resolve, reject) => {
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
        try {
          child.kill((signal ?? "SIGTERM") as NodeJS.Signals);
        } catch {
          // Already gone.
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CodexAccountErrorKind =
  "unsupported" | "spawn" | "timeout" | "transport" | "protocol" | "rpc";

export class CodexAccountError extends Error {
  readonly kind: CodexAccountErrorKind;
  /** JSON-RPC error code when the server answered with an error. */
  readonly rpcCode: number | null;
  /** Bounded stderr tail; server logs only, never surfaced in the UI. */
  readonly stderrTail: string;

  constructor(
    kind: CodexAccountErrorKind,
    message: string,
    details: { rpcCode?: number | null; stderrTail?: string } = {},
  ) {
    super(message);
    this.name = "CodexAccountError";
    this.kind = kind;
    this.rpcCode = details.rpcCode ?? null;
    this.stderrTail = details.stderrTail ?? "";
  }
}

/** True when the local CLI does not implement the account protocol subset. */
export function isUnsupportedCodexAccountError(error: unknown): boolean {
  return error instanceof CodexAccountError && error.kind === "unsupported";
}

/** True when the codex binary could not be spawned at all. */
export function isMissingCodexBinaryError(error: unknown): boolean {
  return error instanceof CodexAccountError && error.kind === "spawn";
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

const CODEX_AUTH_HOSTS = ["openai.com", "chatgpt.com"] as const;

/**
 * Accepts only https URLs on an official OpenAI host. Returns the normalized
 * URL string, or null when the provider returned something scope will not
 * send a user to.
 */
export function validateCodexAuthorizationUrl(candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 4_096) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const official = CODEX_AUTH_HOSTS.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  return official ? url.toString() : null;
}

// ---------------------------------------------------------------------------
// Account shapes
// ---------------------------------------------------------------------------

export type CodexAccount =
  | { type: "chatgpt"; email: string | null; planType: string | null }
  | { type: "apiKey" }
  | { type: "amazonBedrock" }
  | { type: "unknown" };

export interface CodexAccountState {
  readonly account: CodexAccount | null;
  readonly requiresOpenaiAuth: boolean;
}

export interface CodexBrowserLogin {
  loginId: string;
  authorizationUrl: string;
}

export interface CodexDeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexLoginCompleted {
  loginId: string | null;
  success: boolean;
  /** Sanitized provider error text; null on success. */
  error: string | null;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

// ---------------------------------------------------------------------------
// Model discovery (`model/list`)
// ---------------------------------------------------------------------------

/** One reasoning option exactly as the provider named it. */
export interface CodexModelReasoningOption {
  id: string;
  description: string;
}

/** One normalized picker-visible entry from `model/list`. */
export interface CodexModelEntry {
  runtimeId: string;
  label: string;
  description: string;
  reasoningOptions: CodexModelReasoningOption[];
  defaultReasoningEffort: string | null;
  /** False when the provider omitted capability metadata entirely. */
  effortsKnown: boolean;
  hidden: boolean;
  recommended: boolean;
  /** Provider migration hint; null when the model is not being retired. */
  upgrade: { modelId: string; message: string | null } | null;
}

/** Bounded pagination: a runaway cursor loop is a protocol failure. */
export const MAX_CODEX_MODEL_PAGES = 20;

/** Cap on one provider-supplied effort id. */
const MAX_EFFORT_ID_CHARS = 64;

/** Cap on one provider-supplied model id or label. */
const MAX_MODEL_TEXT_CHARS = 160;

function boundedText(value: unknown, maxLength = MAX_MODEL_TEXT_CHARS): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function effortOption(value: unknown): CodexModelReasoningOption | null {
  const record = asRecord(value);
  const id = boundedText(record?.reasoningEffort, MAX_EFFORT_ID_CHARS);
  if (id.length === 0) {
    return null;
  }
  return { id, description: boundedText(record?.description, 240) };
}

/**
 * Parses one `model/list` page. Entries without a usable id are dropped;
 * `hidden` entries are retained so callers can decide, and the caller's
 * `includeHidden: false` request already filters most of them server-side.
 * Effort capabilities are only "known" when the provider actually returned
 * the array — an omitted field must stay unknown rather than become an empty
 * confirmed list.
 */
export function parseCodexModelListPage(result: unknown): {
  models: CodexModelEntry[];
  nextCursor: string | null;
} {
  const record = asRecord(result);
  if (record === null) {
    throw new CodexAccountError("protocol", "codex returned an unusable model list response.");
  }
  const data = record.data;
  if (!Array.isArray(data)) {
    throw new CodexAccountError("protocol", "codex model list response is missing its data array.");
  }
  const models: CodexModelEntry[] = [];
  for (const entry of data) {
    const model = asRecord(entry);
    if (model === null) {
      continue;
    }
    const runtimeId = boundedText(model.id ?? model.model);
    if (runtimeId.length === 0) {
      continue;
    }
    const effortsRaw = model.supportedReasoningEfforts;
    const effortsKnown = Array.isArray(effortsRaw);
    const reasoningOptions = effortsKnown
      ? (effortsRaw as unknown[]).flatMap((option) => {
          const parsed = effortOption(option);
          return parsed ? [parsed] : [];
        })
      : [];
    const defaultEffort = boundedText(model.defaultReasoningEffort, MAX_EFFORT_ID_CHARS);
    const upgradeInfo = asRecord(model.upgradeInfo);
    const upgradeId = boundedText(
      upgradeInfo?.model ?? (typeof model.upgrade === "string" ? model.upgrade : null),
    );
    const upgradeMessage = boundedText(upgradeInfo?.migrationMarkdown, 400);
    models.push({
      runtimeId,
      label: boundedText(model.displayName, 120) || runtimeId,
      description: boundedText(model.description, 400),
      reasoningOptions,
      defaultReasoningEffort: defaultEffort.length > 0 ? defaultEffort : null,
      effortsKnown,
      hidden: model.hidden === true,
      recommended: model.isDefault === true,
      upgrade:
        upgradeId.length > 0 ? { modelId: upgradeId, message: upgradeMessage || null } : null,
    });
  }
  const nextCursor =
    typeof record.nextCursor === "string" && record.nextCursor.length > 0
      ? record.nextCursor
      : null;
  return { models, nextCursor };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface CodexAccountClientOptions {
  command?: string;
  /** Arguments prepended to `app-server` when `command` is supplied. */
  argsPrefix?: readonly string[];
  env?: NodeJS.ProcessEnv;
  spawner?: CodexAccountSpawner;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  /** Called once when the transport exits, for attempt bookkeeping. */
  onExit?: (info: CodexAccountTransportExit) => void;
}

export class CodexAccountClient {
  private readonly transport: CodexAccountTransport;
  private readonly requestTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly exitCallback: ((info: CodexAccountTransportExit) => void) | undefined;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly exitHandlers = new Set<(info: CodexAccountTransportExit) => void>();
  private nextRequestId = 1;
  private exited = false;
  private closed = false;
  private stderrTail = "";
  private exitInfo: CodexAccountTransportExit | null = null;
  private pumpPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  private constructor(transport: CodexAccountTransport, options: CodexAccountClientOptions) {
    this.transport = transport;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initializeTimeoutMs = options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
    this.exitCallback = options.onExit;
  }

  /** Spawns and handshakes with a fresh app-server process. */
  static async connect(options: CodexAccountClientOptions = {}): Promise<CodexAccountClient> {
    const spawner = options.spawner ?? createNodeCodexAccountSpawner();
    const launch = options.command
      ? { command: options.command, argsPrefix: [...(options.argsPrefix ?? [])] }
      : resolveCodexLaunch();
    const env = { ...(options.env ?? process.env) };
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    let transport: CodexAccountTransport;
    try {
      transport = spawner({
        command: launch.command,
        ...(launch.argsPrefix.length > 0 ? { argsPrefix: launch.argsPrefix } : {}),
        env,
      });
    } catch (error) {
      throw new CodexAccountError(
        "spawn",
        `Could not start codex app-server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const client = new CodexAccountClient(transport, options);
    try {
      await client.handshake();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /** True once the transport has exited (or was closed). */
  get isExited(): boolean {
    return this.exited;
  }

  /** Bounded stderr tail for server-side diagnostics. */
  get diagnostics(): string {
    return this.stderrTail;
  }

  private async handshake(): Promise<void> {
    this.startPumps();
    await this.request(
      "initialize",
      { clientInfo: { ...CODEX_CLIENT_INFO } },
      this.initializeTimeoutMs,
    );
    this.notify("initialized", {});
  }

  private startPumps(): void {
    if (this.pumpPromise) {
      return;
    }
    this.pumpPromise = Promise.allSettled([
      this.pumpStdout(),
      this.pumpStderr(),
      this.watchExit(),
    ]).then(() => undefined);
  }

  private async pumpStdout(): Promise<void> {
    try {
      let buffer = "";
      for await (const chunk of this.transport.stdout) {
        buffer += chunk;
        if (buffer.length > MAX_LINE_CHARS) {
          this.failProtocol("codex app-server sent an oversized protocol line.");
          return;
        }
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line.trim().length > 0) {
            this.handleLine(line);
          }
          newline = buffer.indexOf("\n");
        }
      }
      if (buffer.trim().length > 0) {
        this.handleLine(buffer);
      }
    } catch {
      // Stream teardown on exit; the exit path reports the failure.
    }
  }

  private async pumpStderr(): Promise<void> {
    try {
      for await (const chunk of this.transport.stderr) {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
      }
    } catch {
      // Diagnostics only.
    }
  }

  private async watchExit(): Promise<void> {
    let info: CodexAccountTransportExit;
    try {
      info = await this.transport.wait();
    } catch (error) {
      info = { exitCode: null, signal: null };
      this.failTransport(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.markExited(info);
  }

  private errorFor(kind: CodexAccountErrorKind, message: string): CodexAccountError {
    return new CodexAccountError(kind, message, { stderrTail: this.stderrTail });
  }

  private failTransport(error: Error): void {
    const code = (error as NodeJS.ErrnoException).code;
    const kind: CodexAccountErrorKind =
      code === "ENOENT" || code === "EACCES" ? "spawn" : "transport";
    this.markExited({ exitCode: null, signal: null }, this.errorFor(kind, error.message));
  }

  private failProtocol(message: string): void {
    const error = this.errorFor("protocol", message);
    this.rejectAllPending(error);
    this.markExited({ exitCode: null, signal: null }, error);
    try {
      this.transport.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private markExited(info: CodexAccountTransportExit, override: Error | null = null): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    this.exitInfo = info;
    const reason =
      override ??
      this.errorFor(
        "transport",
        `codex app-server exited (${info.exitCode !== null ? `code ${info.exitCode}` : `signal ${info.signal ?? "unknown"}`}).`,
      );
    this.rejectAllPending(reason);
    this.exitCallback?.(info);
    for (const handler of this.exitHandlers) {
      handler(info);
    }
    this.exitHandlers.clear();
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Non-JSON noise on the protocol stream is ignored.
      return;
    }
    if (typeof message !== "object" || message === null) {
      return;
    }
    const record = message as Record<string, unknown>;
    const id = typeof record.id === "number" ? record.id : null;
    const method = typeof record.method === "string" ? record.method : null;

    if (id !== null && method === null) {
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (record.error !== undefined) {
        pending.reject(this.rpcError(record.error));
        return;
      }
      pending.resolve(record.result);
      return;
    }
    if (method !== null && id === null) {
      for (const handler of this.notificationHandlers) {
        handler(method, record.params);
      }
      return;
    }
    if (method !== null && id !== null) {
      // A server-to-client request. The account subset needs none, but an
      // unanswered request would stall the server, so decline it explicitly.
      this.transport.stdin.write(
        `${JSON.stringify({
          id,
          error: { code: -32601, message: "scope does not support this app-server request." },
        })}\n`,
      );
    }
  }

  private rpcError(raw: unknown): CodexAccountError {
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const code = typeof record.code === "number" ? record.code : null;
    const message = typeof record.message === "string" ? record.message : "Unknown JSON-RPC error.";
    const unsupported = code === -32601 || /method not found/i.test(message);
    return new CodexAccountError(
      unsupported ? "unsupported" : "rpc",
      unsupported ? "This codex CLI does not support the account protocol scope needs." : message,
      { rpcCode: code, stderrTail: this.stderrTail },
    );
  }

  private notify(method: string, params: unknown): void {
    this.transport.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(this.errorFor("transport", "codex app-server is no longer running."));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.errorFor("timeout", "codex app-server did not answer in time."));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          this.errorFor(
            "transport",
            `Could not write to codex app-server: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  }

  /** Subscribes to server notifications; returns the unsubscribe function. */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /**
   * Subscribes to transport exit; fires immediately when the process has
   * already exited. Returns the unsubscribe function.
   */
  onExit(handler: (info: CodexAccountTransportExit) => void): () => void {
    if (this.exited) {
      handler(this.exitInfo ?? { exitCode: null, signal: null });
      return () => {};
    }
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  /** Reads the current account; refresh is off for routine status checks. */
  async readAccount(options: { refreshToken?: boolean } = {}): Promise<CodexAccountState> {
    const result = await this.request("account/read", {
      refreshToken: options.refreshToken === true,
    });
    return parseAccountState(result);
  }

  /**
   * Reads every picker-visible model, following `nextCursor` to completion.
   * The request asks for `includeHidden: false` (picker-visible entries), the
   * page count is bounded, and duplicates from a misbehaving cursor are
   * dropped. This is a read-only RPC: it never submits a prompt.
   */
  async listModels(): Promise<CodexModelEntry[]> {
    const models: CodexModelEntry[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_CODEX_MODEL_PAGES; page += 1) {
      const params: Record<string, unknown> = { includeHidden: false };
      if (cursor !== null) {
        params.cursor = cursor;
      }
      const parsed = parseCodexModelListPage(await this.request("model/list", params));
      for (const model of parsed.models) {
        if (!model.hidden && !seen.has(model.runtimeId)) {
          seen.add(model.runtimeId);
          models.push(model);
        }
      }
      if (parsed.nextCursor === null || parsed.nextCursor === cursor) {
        return models;
      }
      cursor = parsed.nextCursor;
    }
    throw this.errorFor("protocol", "codex model list pagination did not finish within its bound.");
  }

  /** Starts the broker-managed ChatGPT browser login. */
  async startBrowserLogin(): Promise<CodexBrowserLogin> {
    const result = await this.request("account/login/start", { type: "chatgpt" });
    const record = asRecord(result);
    const loginId = typeof record?.loginId === "string" ? record.loginId : null;
    const authorizationUrl = validateCodexAuthorizationUrl(record?.authUrl);
    if (loginId === null || authorizationUrl === null) {
      throw this.errorFor("protocol", "codex returned an unusable browser login response.");
    }
    return { loginId, authorizationUrl };
  }

  /** Starts the device-code fallback login. */
  async startDeviceCodeLogin(): Promise<CodexDeviceLogin> {
    const result = await this.request("account/login/start", { type: "chatgptDeviceCode" });
    const record = asRecord(result);
    const loginId = typeof record?.loginId === "string" ? record.loginId : null;
    const verificationUrl = validateCodexAuthorizationUrl(record?.verificationUrl);
    const userCode = typeof record?.userCode === "string" ? record.userCode : null;
    if (loginId === null || verificationUrl === null || userCode === null) {
      throw this.errorFor("protocol", "codex returned an unusable device-code login response.");
    }
    return { loginId, verificationUrl, userCode };
  }

  /** Cancels one login by id. "notFound" means it already finished. */
  async cancelLogin(loginId: string): Promise<"canceled" | "notFound"> {
    const result = await this.request("account/login/cancel", { loginId });
    const status = asRecord(result)?.status;
    return status === "canceled" ? "canceled" : "notFound";
  }

  /** Signs the shared codex CLI out of its stored account. */
  async logout(): Promise<void> {
    await this.request("account/logout", {});
  }

  /**
   * Gracefully ends the transport, escalating to SIGTERM/SIGKILL when the
   * process ignores the stdin close. Safe to call repeatedly.
   */
  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      if (this.exited) {
        return;
      }
      try {
        this.transport.stdin.end();
      } catch {
        // Process already gone.
      }
      await this.waitForExit(1_000);
      if (!this.exited) {
        this.transport.kill("SIGTERM");
        await this.waitForExit(1_500);
      }
      if (!this.exited) {
        this.transport.kill("SIGKILL");
        await this.waitForExit(1_000);
      }
    })();
    return this.closePromise;
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.exited && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Exit info once the transport has exited; null while running. */
  get exit(): CodexAccountTransportExit | null {
    return this.exitInfo;
  }

  /** True after close() was requested (even if the exit is still settling). */
  get isClosing(): boolean {
    return this.closed;
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function firstString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Maps the untrusted account payload onto the safe discriminated union. */
export function parseAccountState(result: unknown): CodexAccountState {
  const record = asRecord(result);
  const accountRaw = asRecord(record?.account);
  const requiresOpenaiAuth = record?.requiresOpenaiAuth === true;
  if (accountRaw === null) {
    return { account: null, requiresOpenaiAuth };
  }
  switch (accountRaw.type) {
    case "chatgpt":
      return {
        account: {
          type: "chatgpt",
          email: firstString(accountRaw.email),
          planType: firstString(accountRaw.planType),
        },
        requiresOpenaiAuth,
      };
    case "apiKey":
      return { account: { type: "apiKey" }, requiresOpenaiAuth };
    case "amazonBedrock":
      return { account: { type: "amazonBedrock" }, requiresOpenaiAuth };
    default:
      return { account: { type: "unknown" }, requiresOpenaiAuth };
  }
}

/** Parses an `account/login/completed` notification payload. */
export function parseLoginCompleted(params: unknown): CodexLoginCompleted | null {
  const record = asRecord(params);
  if (record === null || typeof record.success !== "boolean") {
    return null;
  }
  return {
    loginId: firstString(record.loginId),
    success: record.success,
    error: sanitizeProviderError(firstString(record.error)),
  };
}

/**
 * Provider error text is untrusted: control characters and newlines are
 * flattened and the length is bounded before it can reach a UI message.
 */
export function sanitizeProviderError(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return null;
  }
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned;
}
