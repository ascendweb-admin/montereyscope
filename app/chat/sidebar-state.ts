/**
 * Whether the chat workspace's desktop history sidebar is collapsed. A tiny
 * external store around localStorage (same pattern as the chat mode
 * setting), so the workspace syncs without setState-in-effect and the
 * preference survives reloads. The server snapshot is always "expanded" so
 * the initial HTML matches hydration; a stored preference applies right
 * after hydration, like the mode switcher does.
 */
import { useSyncExternalStore } from "react";

/** localStorage key the workspace remembers the collapsed state under. */
export const CHAT_SIDEBAR_COLLAPSED_KEY = "localtube.chat-sidebar-collapsed";

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === CHAT_SIDEBAR_COLLAPSED_KEY || event.key === null) {
      callback();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): boolean {
  try {
    return window.localStorage.getItem(CHAT_SIDEBAR_COLLAPSED_KEY) === "true";
  } catch {
    // Private-mode storage failures just mean the expanded default.
    return false;
  }
}

const getServerSnapshot = (): boolean => false;

/** Applies the collapsed state and remembers it across visits. */
export function setChatSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(CHAT_SIDEBAR_COLLAPSED_KEY, String(collapsed));
  } catch {
    // The choice still applies for this session even if it cannot persist.
  }
  for (const listener of listeners) {
    listener();
  }
}

/** The remembered collapsed state plus its setter, for the workspace. */
export function useChatSidebarCollapsed(): readonly [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [collapsed, setChatSidebarCollapsed] as const;
}
