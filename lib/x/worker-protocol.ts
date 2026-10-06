import type { XConnectionStatus } from "./model";
/**
 * Scope's X read-worker protocol, spoken by every bundled or external X
 * worker (see docs/x-worker-protocol.md). The worker is a separate,
 * app-owned process: Scope writes one JSON request to its stdin and reads one
 * JSON response from its stdout. It never exposes arbitrary commands, and
 * credentials, when the host supplies them, travel over the private pipe —
 * never argv, the general environment, SQLite, or analysis files.
 *
 * Requests:
 *   { protocol: 1, operation, params?, credentials? }
 * Responses:
 *   { ok: true, schema_version: 1, data: … }
 *   { ok: false, error: { code, message?, retryAfterSeconds? } }
 */
import { isXErrorCode, type XErrorCode } from "./model";

export const X_WORKER_PROTOCOL_VERSION = 1;
export const X_WORKER_SCHEMA_VERSION = 1;

export type XWorkerOperation =
  "status" | "connect" | "cancel" | "focus" | "disconnect" | "user" | "user_posts" | "tweet";

/**
 * Operations the desktop broker accepts. `retry-storage` is broker-only: the
 * frozen read worker never receives it.
 */
export type XBrokerOperation = XWorkerOperation | "retry-storage";

export interface XWorkerRequest {
  protocol: typeof X_WORKER_PROTOCOL_VERSION;
  operation: XWorkerOperation;
  params?: Record<string, unknown>;
  /**
   * Session data supplied by the host for this call only. The desktop broker
   * passes an X cookie header here; web mode never does.
   */
  credentials?: { cookieHeader?: string };
}

export interface XWorkerSuccessEnvelope {
  ok: true;
  schema_version: number;
  data: unknown;
}

export interface XWorkerErrorEnvelope {
  ok: false;
  error: { code: string; message?: unknown; retryAfterSeconds?: unknown };
}

export type XWorkerEnvelope = XWorkerSuccessEnvelope | XWorkerErrorEnvelope;

export function isWorkerEnvelope(value: unknown): value is XWorkerEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    (value as { ok?: unknown }).ok !== undefined &&
    typeof (value as { ok?: unknown }).ok === "boolean"
  );
}

export interface WorkerStatusData {
  connected: boolean;
  phase?: XConnectionStatus["phase"];
  attemptId?: string;
  errorCode?: XErrorCode;
  canConnect?: boolean;
  sessionOnly?: boolean;
  storage?: unknown;
  restoring?: boolean;
  user?: unknown;
}

export interface WorkerErrorDetail {
  code: XErrorCode;
  message?: string;
  retryAfterSeconds?: number | null;
}

export function toWorkerErrorDetail(value: unknown): WorkerErrorDetail {
  if (typeof value !== "object" || value === null) {
    return { code: "invalid_response" };
  }
  const record = value as Record<string, unknown>;
  const code = isXErrorCode(record.code) ? record.code : "invalid_response";
  const retryAfterSeconds =
    typeof record.retryAfterSeconds === "number" && Number.isFinite(record.retryAfterSeconds)
      ? Math.max(0, Math.floor(record.retryAfterSeconds))
      : null;
  return {
    code,
    message: typeof record.message === "string" ? record.message : undefined,
    retryAfterSeconds,
  };
}
