/**
 * Client-side mirror of the server's chat intelligence modes
 * (lib/ai/chat-modes.ts). The AI layer is server-only — client components
 * never import it — so the panel renders from this copy instead; a unit test
 * pins the two sides together field for field.
 *
 * Also hosts the tiny external stores around localStorage that remember the
 * selected mode across visits (same pattern as the theme setting), so the
 * panels sync without setState-in-effect.
 */
import { useSyncExternalStore } from "react";

export type ChatModeId = "quick" | "balanced" | "deep";

/** The mode conversations start in before the user picks one. */
export const DEFAULT_CHAT_MODE: ChatModeId = "deep";

export interface ChatModeOption {
  id: ChatModeId;
  /** Short label on the mode switcher. */
  label: string;
  /** One-line description shown next to the switcher and in its tooltip. */
  tagline: string;
  /** Status line shown while a turn in this mode is still reasoning. */
  workingLabel: string;
}

export const CHAT_MODE_OPTIONS: readonly ChatModeOption[] = [
  {
    id: "quick",
    label: "Quick",
    tagline: "Fast, conversational answers",
    workingLabel: "Thinking…",
  },
  {
    id: "balanced",
    label: "Balanced",
    tagline: "Grounded answers at everyday depth",
    workingLabel: "Reviewing the transcripts…",
  },
  {
    id: "deep",
    label: "Deep",
    tagline: "Thorough analysis that takes its time",
    workingLabel: "Reading the transcripts…",
  },
];

export function isChatModeId(value: unknown): value is ChatModeId {
  return CHAT_MODE_OPTIONS.some((option) => option.id === value);
}

/** Resolves a mode id to its display metadata, falling back to the default. */
export function chatModeOption(id: ChatModeId): ChatModeOption {
  return CHAT_MODE_OPTIONS.find((option) => option.id === id) ?? CHAT_MODE_OPTIONS[2];
}

/** localStorage key the panel remembers the selected mode under. */
export const CHAT_MODE_STORAGE_KEY = "localtube.chat-mode";

// ---------------------------------------------------------------------------
// External store around localStorage (server snapshot is always the default)
// ---------------------------------------------------------------------------

/**
 * A remembered mode choice under one localStorage key. AI Chat and the X
 * Dashboard each keep their own, so picking Deep for chat leaves insights alone.
 */
export function createModeStore(storageKey: string, fallback: ChatModeId) {
  const listeners = new Set<() => void>();

  function subscribe(callback: () => void): () => void {
    listeners.add(callback);
    const onStorage = (event: StorageEvent): void => {
      if (event.key === storageKey || event.key === null) {
        callback();
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(callback);
      window.removeEventListener("storage", onStorage);
    };
  }

  function getSnapshot(): ChatModeId {
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (isChatModeId(stored)) {
        return stored;
      }
    } catch {
      // Private-mode storage failures just mean the default.
    }
    return fallback;
  }

  const getServerSnapshot = (): ChatModeId => fallback;

  /** Applies a mode selection and remembers it across visits. */
  function select(next: ChatModeId): void {
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {
      // The choice still applies for this session even if it cannot persist.
    }
    for (const listener of listeners) {
      listener();
    }
  }

  /** The remembered mode plus its setter. */
  function useMode(): readonly [ChatModeId, (next: ChatModeId) => void] {
    const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
    return [mode, select] as const;
  }

  return { select, useMode };
}

const chatModeStore = createModeStore(CHAT_MODE_STORAGE_KEY, DEFAULT_CHAT_MODE);

/** Applies a chat mode selection and remembers it across visits. */
export const selectChatMode = chatModeStore.select;

/** The remembered chat mode plus its setter, for the panel's switcher. */
export function useChatMode(): readonly [ChatModeId, (next: ChatModeId) => void] {
  return chatModeStore.useMode();
}
