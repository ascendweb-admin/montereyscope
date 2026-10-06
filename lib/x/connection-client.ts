"use client";
import {
  isXStorageStatus,
  X_ERROR_MESSAGES,
  X_UNAVAILABLE_STATUS,
  type XConnectionStatus,
} from "./model";

type ConnectionOperation =
  "status" | "connect" | "cancel" | "disconnect" | "focus" | "retry-storage";
interface DesktopStatus {
  connected: boolean;
  canConnect: boolean;
  user: XConnectionStatus["user"];
  phase: XConnectionStatus["phase"];
  attemptId: string;
  errorCode: XConnectionStatus["errorCode"];
  sessionOnly: boolean;
  restoring?: boolean;
  storage?: unknown;
}
declare global {
  interface Window {
    scopeX?: Record<
      ConnectionOperation,
      () => Promise<{ ok: boolean; data?: DesktopStatus; error?: { code: string } }>
    >;
  }
}
export async function requestXConnection(
  operation: ConnectionOperation,
): Promise<XConnectionStatus> {
  if (window.scopeX) {
    const result = await window.scopeX[operation]();
    if (!result.ok || !result.data)
      throw new Error(
        X_ERROR_MESSAGES[result.error?.code as keyof typeof X_ERROR_MESSAGES] ??
          "The X connection could not be updated.",
      );
    const data = result.data;
    return {
      capability:
        data.connected && data.user
          ? "connected"
          : data.canConnect
            ? "disconnected"
            : "unavailable",
      providerId: "desktop",
      user: data.connected ? data.user : null,
      phase: data.phase,
      attemptId: data.attemptId,
      errorCode: data.canConnect ? data.errorCode : "unsupported_runtime",
      sessionOnly: data.sessionOnly === true,
      restoring: data.restoring === true,
      storage: isXStorageStatus(data.storage) ? data.storage : null,
    };
  }
  const response = await fetch(
    "/api/x/connection",
    operation === "status"
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: operation }),
        },
  );
  const result = await response.json();
  if (!response.ok || !result.status)
    throw new Error(result.error?.message ?? "The X connection could not be updated.");
  return result.status ?? X_UNAVAILABLE_STATUS;
}
export function xLoginPending(status: XConnectionStatus): boolean {
  return ["opening", "awaiting_login", "verifying"].includes(status.phase ?? "");
}
