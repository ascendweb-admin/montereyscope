/**
 * Worker-backed X provider. The worker is a separate, app-owned executable
 * that speaks the Scope protocol (lib/x/worker-protocol.ts): fixed
 * operations, JSON on stdin/stdout, credentials only over the pipe. Nothing
 * here knows what the worker is built from — the bundled twitter-cli adapter,
 * a future official-API adapter, or the deterministic test worker all fit.
 * Server-only.
 */
import {
  isXStorageStatus,
  XProviderError,
  X_UNAVAILABLE_STATUS,
  type XConnectionStatus,
  type XProvider,
  type XTweetDraft,
  type XTimelinePage,
  type XUserLookup,
  type XUserSearchResult,
} from "../model";
import { mapXTweet, mapXTimelinePage, mapXUser, mapXUserLookup, mapXUserSearch } from "../mapper";
import {
  isWorkerEnvelope,
  toWorkerErrorDetail,
  X_WORKER_PROTOCOL_VERSION,
  X_WORKER_SCHEMA_VERSION,
  type WorkerStatusData,
  type XBrokerOperation,
  type XWorkerRequest,
} from "../worker-protocol";
import { runXWorker } from "./worker-process";

/** Fixed per-operation runtime bounds. Overridable for tests and dev. */
const OPERATION_TIMEOUTS: Record<XBrokerOperation, number> = {
  status: 20_000,
  connect: 180_000,
  disconnect: 20_000,
  cancel: 20_000,
  focus: 20_000,
  "retry-storage": 30_000,
  user: 30_000,
  user_search: 30_000,
  user_posts: 45_000,
  tweet: 30_000,
};

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function resolveTimeout(operation: XBrokerOperation): number {
  const raw = Number(process.env.SCOPE_X_WORKER_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1_000 && raw <= 600_000) {
    return Math.floor(raw);
  }
  return OPERATION_TIMEOUTS[operation];
}

export function xWorkerExecutablePath(): string | null {
  const configured =
    process.env.SCOPE_X_WORKER?.trim() ?? process.env.LOCAL_SCOPE_X_WORKER?.trim() ?? "";
  return configured.length > 0 ? configured : null;
}

function parseEnvelope(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new XProviderError("invalid_response");
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Workers may log diagnostics before the envelope; the envelope is the
    // last JSON object on stdout. Try the final non-empty line.
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1];
    try {
      return JSON.parse(last) as unknown;
    } catch {
      throw new XProviderError("invalid_response");
    }
  }
}

function failureToXError(kind: string, operation: string): XProviderError {
  if (kind === "missing_executable") {
    return new XProviderError("unsupported_runtime");
  }
  if (kind === "timeout") {
    return new XProviderError("timeout");
  }
  if (kind === "cancelled") {
    return new XProviderError("cancelled");
  }
  // Untrusted diagnostics can contain credentials. Log only fixed metadata.
  console.error(`[x/worker] ${operation} failed (${kind})`);
  return new XProviderError("invalid_response");
}

export interface WorkerXProviderOptions {
  executable?: string;
  /** Fixed arguments for interpreter-launched workers (e.g. node worker.cjs). */
  args?: readonly string[];
  /**
   * Supplies session credentials for one call. The desktop broker plugs in
   * here; web mode has none, so the worker must own its own session.
   */
  getCredentials?: () => Promise<{ cookieHeader: string } | null>;
}

class WorkerXProvider implements XProvider {
  readonly id = process.env.SCOPE_X_BROKER_ORIGIN ? "desktop" : "worker";
  private canConnectFlag = false;
  private readonly executable: string | null;
  private readonly args: readonly string[];
  private readonly getCredentials: (() => Promise<{ cookieHeader: string } | null>) | undefined;

  constructor(options: WorkerXProviderOptions = {}) {
    this.executable = options.executable ?? xWorkerExecutablePath();
    this.args = options.args ?? [];
    this.getCredentials = options.getCredentials;
  }

  get canConnect(): boolean {
    return this.id === "desktop" || this.canConnectFlag;
  }

  private async call(
    operation: XBrokerOperation,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.id === "desktop") {
      const origin = process.env.SCOPE_X_BROKER_ORIGIN!;
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !process.env.SCOPE_X_BROKER_TOKEN)
        throw new XProviderError("unsupported_runtime");
      try {
        const response = await fetch(`${origin}/`, {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json",
            "x-scope-x-broker": process.env.SCOPE_X_BROKER_TOKEN,
          },
          body: JSON.stringify({ protocol: 1, operation, params }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(resolveTimeout(operation))])
            : AbortSignal.timeout(resolveTimeout(operation)),
        });
        if (!response.ok) throw new XProviderError("unsupported_runtime");
        const envelope: unknown = await response.json();
        if (!isWorkerEnvelope(envelope)) throw new XProviderError("invalid_response");
        if (!envelope.ok) {
          const detail = toWorkerErrorDetail(envelope.error);
          throw new XProviderError(detail.code, undefined, detail.retryAfterSeconds);
        }
        if (envelope.schema_version !== 1) throw new XProviderError("invalid_response");
        return envelope.data;
      } catch (error) {
        if (error instanceof XProviderError) throw error;
        throw new XProviderError(signal?.aborted ? "cancelled" : "network");
      }
    }
    if (this.executable === null) {
      throw new XProviderError("unsupported_runtime");
    }
    if (operation === "retry-storage") {
      throw new XProviderError("unsupported_runtime");
    }
    const credentials = this.getCredentials ? await this.getCredentials() : null;
    const request: XWorkerRequest = {
      protocol: X_WORKER_PROTOCOL_VERSION,
      operation,
      ...(params ? { params } : {}),
      ...(credentials ? { credentials } : {}),
    };

    const result = await runXWorker(this.executable, request, {
      timeoutMs: resolveTimeout(operation),
      maxOutputBytes: MAX_OUTPUT_BYTES,
      args: this.args,
      signal,
    });
    if (!result.ok) {
      throw failureToXError(result.kind, operation);
    }

    const envelope = parseEnvelope(result.stdout);
    if (!isWorkerEnvelope(envelope)) {
      throw new XProviderError("invalid_response");
    }
    if (!envelope.ok) {
      const detail = toWorkerErrorDetail(envelope.error);
      throw new XProviderError(detail.code, undefined, detail.retryAfterSeconds);
    }
    if (envelope.schema_version !== X_WORKER_SCHEMA_VERSION) {
      throw new XProviderError("invalid_response");
    }
    return envelope.data;
  }

  private toStatus(data: unknown): XConnectionStatus {
    if (typeof data !== "object" || data === null) {
      throw new XProviderError("invalid_response");
    }
    const record = data as WorkerStatusData;
    const storage = isXStorageStatus(record.storage)
      ? {
          state: record.storage.state,
          reason: record.storage.reason ?? null,
          backend: typeof record.storage.backend === "string" ? record.storage.backend : null,
        }
      : null;
    const lifecycle = {
      phase: record.phase,
      attemptId: record.attemptId,
      storage,
      restoring: record.restoring === true,
    };
    this.canConnectFlag = record.canConnect === true;
    const user = mapXUser(record.user);
    if (record.connected === true && user !== null) {
      return {
        ...lifecycle,
        capability: "connected",
        providerId: this.id,
        user,
        errorCode: null,
        sessionOnly: record.sessionOnly === true,
      };
    }
    // Cookie presence is not connection success: connected without a
    // resolvable identity is reported as disconnected.
    if (record.connected === true) {
      return {
        ...lifecycle,
        capability: "disconnected",
        providerId: this.id,
        user: null,
        errorCode: "session_expired",
        sessionOnly: record.sessionOnly === true,
      };
    }
    if (this.canConnectFlag) {
      return {
        ...lifecycle,
        capability: "disconnected",
        providerId: this.id,
        user: null,
        errorCode: record.errorCode ?? null,
        sessionOnly: record.sessionOnly === true,
      };
    }
    return {
      capability: "unavailable",
      providerId: this.id,
      user: null,
      errorCode: "not_connected",
      sessionOnly: false,
    };
  }

  async status(signal?: AbortSignal): Promise<XConnectionStatus> {
    if (this.executable === null && this.id !== "desktop") {
      return X_UNAVAILABLE_STATUS;
    }
    try {
      return this.toStatus(await this.call("status", undefined, signal));
    } catch (error) {
      if (error instanceof XProviderError) {
        if (error.code === "unsupported_runtime") {
          return X_UNAVAILABLE_STATUS;
        }
        return {
          capability: "disconnected",
          providerId: this.id,
          user: null,
          errorCode: error.code,
          sessionOnly: false,
        };
      }
      return {
        capability: "disconnected",
        providerId: this.id,
        user: null,
        errorCode: "network",
        sessionOnly: false,
      };
    }
  }

  async connect(signal?: AbortSignal): Promise<XConnectionStatus> {
    if ((this.executable === null && this.id !== "desktop") || !this.canConnect) {
      throw new XProviderError("not_connected");
    }
    return this.toStatus(await this.call("connect", undefined, signal));
  }

  async disconnect(): Promise<void> {
    if (this.executable === null && this.id !== "desktop") return;
    await this.call("disconnect");
  }

  async cancel(): Promise<void> {
    await this.call("cancel");
  }
  async focus(): Promise<void> {
    await this.call("focus");
  }

  async retryStorage(): Promise<XConnectionStatus> {
    if (this.id !== "desktop") throw new XProviderError("unsupported_runtime");
    return this.toStatus(await this.call("retry-storage"));
  }

  async resolveUser(handle: string, signal?: AbortSignal): Promise<XUserLookup> {
    return mapXUserLookup(await this.call("user", { handle }, signal));
  }

  async searchUsers(query: string, signal?: AbortSignal): Promise<XUserSearchResult[]> {
    return mapXUserSearch(await this.call("user_search", { query }, signal));
  }

  async listUserTweets(
    input: { userId: string; handle: string; cursor?: string | null; limit: number },
    signal?: AbortSignal,
  ): Promise<XTimelinePage> {
    const data = await this.call(
      "user_posts",
      {
        userId: input.userId,
        handle: input.handle,
        cursor: input.cursor ?? null,
        limit: input.limit,
      },
      signal,
    );
    return mapXTimelinePage(data, { complete: false });
  }

  async getTweet(
    tweetId: string,
    authorHandle?: string | null,
    signal?: AbortSignal,
  ): Promise<XTweetDraft | null> {
    const data = await this.call("tweet", { tweetId, handle: authorHandle ?? null }, signal);
    if (typeof data === "object" && data !== null && "found" in data) {
      if ((data as { found?: unknown }).found === false) {
        return null;
      }
      return mapXTweet((data as { tweet?: unknown }).tweet, { complete: true });
    }
    return mapXTweet(data, { complete: true });
  }
}

export function createWorkerXProvider(options?: WorkerXProviderOptions): XProvider {
  return new WorkerXProvider(options);
}
