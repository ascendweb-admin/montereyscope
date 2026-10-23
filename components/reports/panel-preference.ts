"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the reader's side panel (outline and sources) starts open, and on
 * which tab. On screens wide enough for the panel to sit beside the report
 * (xl) the last choice is remembered per viewer; roomy screens (2xl) open
 * the outline until the viewer says otherwise. Narrower screens, where the
 * panel would cover the report, always start closed. Storage can be missing
 * or blocked; the page then simply starts closed.
 */

export type ReportPanelTab = "outline" | "sources";
export type ReportPanelState = ReportPanelTab | "closed";

const STORAGE_KEY = "scope:reports:panel";
/** The panel docks beside the reader from here (Tailwind's xl). */
const DOCKED_QUERY = "(min-width: 1280px)";
/** Roomy enough to open the outline by default (Tailwind's 2xl). */
const ROOMY_QUERY = "(min-width: 1536px)";

const listeners = new Set<() => void>();

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** True when the panel sits beside the reader rather than over it. */
export function isPanelDocked(): boolean {
  try {
    return matches(DOCKED_QUERY);
  } catch {
    return false;
  }
}

function readPreference(): ReportPanelState {
  try {
    if (!matches(DOCKED_QUERY)) {
      return "closed";
    }
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "outline" || stored === "sources" || stored === "closed") {
      return stored;
    }
    return matches(ROOMY_QUERY) ? "outline" : "closed";
  } catch {
    return "closed";
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const queries =
    typeof window.matchMedia === "function"
      ? [window.matchMedia(DOCKED_QUERY), window.matchMedia(ROOMY_QUERY)]
      : [];
  for (const query of queries) query.addEventListener?.("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    for (const query of queries) query.removeEventListener?.("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

const closedOnServer = (): ReportPanelState => "closed";

/** The remembered panel state for this viewport (closed on the server). */
export function useReportPanelPreference(): ReportPanelState {
  return useSyncExternalStore(subscribe, readPreference, closedOnServer);
}

/** Remembers a choice made while the panel is docked; overlays are transient. */
export function rememberReportPanel(state: ReportPanelState): void {
  if (!isPanelDocked()) {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, state);
  } catch {
    // Blocked storage: the choice lasts for this visit only.
  }
  for (const listener of listeners) listener();
}
