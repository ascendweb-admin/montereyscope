"use client";

/**
 * Renderer bridge to the Electron host's `scope:app` channel. The bridge only
 * exists in the packaged desktop app; in an ordinary browser it is absent and
 * desktop-only affordances are hidden rather than faked.
 */

export interface DesktopAppInfo {
  version: string;
  platform: string;
  arch: string;
  packaged: boolean;
  logsPath: string;
}

export type DesktopEntryState = "absent" | "managed" | "foreign";

export interface DesktopIntegrationStatus {
  supported: boolean;
  runningFromAppImage: boolean;
  appImagePath: string | null;
  integrated: boolean;
  managedExecutablePath: string;
  desktopEntryPath: string;
  desktopEntryState: DesktopEntryState;
  iconPath: string;
  removedEntry?: boolean;
}

export interface DesktopActionError {
  code?: string;
  message?: string;
}

export interface DesktopAppResponse<T> {
  ok: boolean;
  data?: T;
  error?: DesktopActionError;
}

declare global {
  interface Window {
    scopeApp?: {
      info: () => Promise<DesktopAppResponse<DesktopAppInfo>>;
      openLogs: () => Promise<DesktopAppResponse<{ opened: boolean }>>;
      integrationStatus?: () => Promise<DesktopAppResponse<DesktopIntegrationStatus>>;
      installMenuEntry?: () => Promise<DesktopAppResponse<DesktopIntegrationStatus>>;
      removeMenuEntry?: () => Promise<DesktopAppResponse<DesktopIntegrationStatus>>;
    };
  }
}

export function hasDesktopAppBridge(): boolean {
  return typeof window !== "undefined" && window.scopeApp !== undefined;
}

/** True only when the host exposes the Linux menu-integration channel. */
export function hasDesktopIntegrationBridge(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.scopeApp?.integrationStatus === "function" &&
    typeof window.scopeApp?.installMenuEntry === "function" &&
    typeof window.scopeApp?.removeMenuEntry === "function"
  );
}

export async function readDesktopAppInfo(): Promise<DesktopAppInfo | null> {
  if (!window.scopeApp) {
    return null;
  }
  try {
    const result = await window.scopeApp.info();
    if (!result.ok || !result.data) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

/** Current application-menu integration state, or null without a bridge. */
export async function readDesktopIntegrationStatus(): Promise<DesktopIntegrationStatus | null> {
  if (!window.scopeApp?.integrationStatus) {
    return null;
  }
  try {
    const result = await window.scopeApp.integrationStatus();
    return result.ok && result.data ? result.data : null;
  } catch {
    return null;
  }
}

/** Adds or replaces the managed AppImage and its menu entry. */
export async function installDesktopMenuEntry(): Promise<
  DesktopAppResponse<DesktopIntegrationStatus>
> {
  if (!window.scopeApp?.installMenuEntry) {
    return {
      ok: false,
      error: { code: "no_bridge", message: "Desktop integration is unavailable." },
    };
  }
  try {
    return await window.scopeApp.installMenuEntry();
  } catch (error) {
    return {
      ok: false,
      error: { code: "integration_failed", message: error instanceof Error ? error.message : "" },
    };
  }
}

/** Removes the managed AppImage and its menu entry; user data is retained. */
export async function removeDesktopMenuEntry(): Promise<
  DesktopAppResponse<DesktopIntegrationStatus>
> {
  if (!window.scopeApp?.removeMenuEntry) {
    return {
      ok: false,
      error: { code: "no_bridge", message: "Desktop integration is unavailable." },
    };
  }
  try {
    return await window.scopeApp.removeMenuEntry();
  } catch (error) {
    return {
      ok: false,
      error: { code: "integration_failed", message: error instanceof Error ? error.message : "" },
    };
  }
}

/** Opens the desktop log directory; false when no bridge or the open failed. */
export async function openDesktopLogsFolder(): Promise<boolean> {
  if (!window.scopeApp) {
    return false;
  }
  try {
    const result = await window.scopeApp.openLogs();
    return result.ok && result.data?.opened === true;
  } catch {
    return false;
  }
}

/** Human-readable platform name for the About line. */
export function platformLabel(platform: string): string {
  if (platform === "win32") {
    return "Windows";
  }
  if (platform === "darwin") {
    return "macOS";
  }
  if (platform === "linux") {
    return "Linux";
  }
  return platform;
}
