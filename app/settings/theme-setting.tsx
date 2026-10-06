"use client";

import { useCallback, useSyncExternalStore } from "react";

type ThemeChoice = "system" | "light" | "dark";

const STORAGE_KEY = "localtube.theme";
const CHOICES: readonly { value: ThemeChoice; label: string; hint: string }[] = [
  {
    value: "system",
    label: "System",
    hint: "Follow the light/dark preference set on this machine.",
  },
  { value: "light", label: "Light", hint: "Always use the light palette." },
  { value: "dark", label: "Dark", hint: "Always use the dark palette." },
];

// ---------------------------------------------------------------------------
// Tiny external store around localStorage so the radio group stays in sync
// without setState-in-effect patterns. Server snapshot is always "system";
// the root layout's inline script applies the stored choice pre-paint.
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY || event.key === null) {
      callback();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // Private-mode storage failures just mean the system default.
  }
  return "system";
}

const getServerSnapshot = (): ThemeChoice => "system";

function applyChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

/**
 * Appearance preference (Settings → Appearance). Stored only in this
 * browser's localStorage — the server never sees it. Changing it updates
 * the <html> data-theme attribute instantly.
 */
export function ThemeSetting() {
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const update = useCallback((next: ThemeChoice): void => {
    applyChoice(next);
    try {
      if (next === "system") {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
    } catch {
      // Choice still applies for this session even if it cannot persist.
    }
    for (const listener of listeners) {
      listener();
    }
  }, []);

  return (
    <fieldset className="mt-4 flex flex-col gap-2">
      <legend className="text-sm font-medium">Color scheme</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
        {CHOICES.map((option) => {
          const id = `theme-choice-${option.value}`;
          return (
            <label
              key={option.value}
              htmlFor={id}
              className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border bg-background px-3 py-2 text-sm has-checked:border-ring has-checked:bg-accent"
            >
              <input
                id={id}
                type="radio"
                name="theme-choice"
                value={option.value}
                checked={choice === option.value}
                onChange={() => update(option.value)}
                className="size-4 accent-current"
              />
              <span>
                {option.label}
                <span className="sr-only"> — {option.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        The choice is saved in this browser only and applies instantly.
      </p>
    </fieldset>
  );
}
