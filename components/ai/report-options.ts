/**
 * Client-side mirror of the server's report options (lib/ai/report-profiles.ts
 * and lib/ai/report-styles.ts). The AI layer is server-only — client
 * components never import it — so the report dialog renders from this copy
 * instead; a unit test pins the two sides together field for field.
 *
 * Also hosts the tiny external store around localStorage that remembers the
 * selected profile and style across visits (same pattern as the chat mode),
 * so the dialog syncs without setState-in-effect.
 */
import { useSyncExternalStore } from "react";

export type ReportProfileId = "brief" | "balanced" | "deep";

/** The profile the dialog starts from before the user picks one. */
export const DEFAULT_REPORT_PROFILE: ReportProfileId = "balanced";

export interface ReportProfileOption {
  id: ReportProfileId;
  /** Short label on the profile picker. */
  label: string;
  /** One-line description shown under the picker. */
  tagline: string;
}

export const REPORT_PROFILE_OPTIONS: readonly ReportProfileOption[] = [
  {
    id: "brief",
    label: "Brief",
    tagline: "A relaxed overview to stay up to date",
  },
  {
    id: "balanced",
    label: "Balanced",
    tagline: "The everyday analyst report",
  },
  {
    id: "deep",
    label: "Deep",
    tagline: "Everything the material has to give",
  },
];

export function isReportProfileId(value: unknown): value is ReportProfileId {
  return REPORT_PROFILE_OPTIONS.some((option) => option.id === value);
}

/** Resolves a profile id to its display metadata, falling back to the default. */
export function reportProfileOption(id: ReportProfileId): ReportProfileOption {
  return REPORT_PROFILE_OPTIONS.find((option) => option.id === id) ?? REPORT_PROFILE_OPTIONS[1];
}

export type ReportStyleId = "editorial" | "terminal" | "swiss";

/** The style the dialog starts from before the user picks one. */
export const DEFAULT_REPORT_STYLE: ReportStyleId = "editorial";

export interface ReportStyleOption {
  id: ReportStyleId;
  /** Short label on the style picker. */
  label: string;
  /** One-line description shown under the picker. */
  tagline: string;
}

export const REPORT_STYLE_OPTIONS: readonly ReportStyleOption[] = [
  {
    id: "editorial",
    label: "Editorial",
    tagline: "Warm print-magazine feature",
  },
  {
    id: "terminal",
    label: "Terminal",
    tagline: "Dark technical briefing",
  },
  {
    id: "swiss",
    label: "Swiss",
    tagline: "Clean minimal memo",
  },
];

export function isReportStyleId(value: unknown): value is ReportStyleId {
  return REPORT_STYLE_OPTIONS.some((option) => option.id === value);
}

/** Resolves a style id to its display metadata, falling back to the default. */
export function reportStyleOption(id: ReportStyleId): ReportStyleOption {
  return REPORT_STYLE_OPTIONS.find((option) => option.id === id) ?? REPORT_STYLE_OPTIONS[0];
}

// ---------------------------------------------------------------------------
// External store around localStorage (server snapshot is always the default)
// ---------------------------------------------------------------------------

const PROFILE_STORAGE_KEY = "localtube.report-profile";
const STYLE_STORAGE_KEY = "localtube.report-style";

const listeners = new Set<() => void>();

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (event: StorageEvent): void => {
    if (
      event.key === PROFILE_STORAGE_KEY ||
      event.key === STYLE_STORAGE_KEY ||
      event.key === null
    ) {
      callback();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function readProfile(): ReportProfileId {
  try {
    const stored = window.localStorage.getItem(PROFILE_STORAGE_KEY);
    if (isReportProfileId(stored)) {
      return stored;
    }
  } catch {
    // Private-mode storage failures just mean the default.
  }
  return DEFAULT_REPORT_PROFILE;
}

function readStyle(): ReportStyleId {
  try {
    const stored = window.localStorage.getItem(STYLE_STORAGE_KEY);
    if (isReportStyleId(stored)) {
      return stored;
    }
  } catch {
    // Private-mode storage failures just mean the default.
  }
  return DEFAULT_REPORT_STYLE;
}

function getServerProfileSnapshot(): ReportProfileId {
  return DEFAULT_REPORT_PROFILE;
}

function getServerStyleSnapshot(): ReportStyleId {
  return DEFAULT_REPORT_STYLE;
}

/** Applies a profile selection and remembers it across visits. */
export function selectReportProfile(profile: ReportProfileId): void {
  try {
    window.localStorage.setItem(PROFILE_STORAGE_KEY, profile);
  } catch {
    // The choice still applies for this session even if it cannot persist.
  }
  notify();
}

/** Applies a style selection and remembers it across visits. */
export function selectReportStyle(style: ReportStyleId): void {
  try {
    window.localStorage.setItem(STYLE_STORAGE_KEY, style);
  } catch {
    // The choice still applies for this session even if it cannot persist.
  }
  notify();
}

/**
 * The remembered report profile and style plus their setters, for the
 * Generate-report dialog. The two stores are separate snapshots (both
 * primitives, as useSyncExternalStore requires) sharing one subscription.
 */
export function useReportOptions(): readonly [
  ReportProfileId,
  ReportStyleId,
  (profile: ReportProfileId) => void,
  (style: ReportStyleId) => void,
] {
  const profile = useSyncExternalStore(subscribe, readProfile, getServerProfileSnapshot);
  const style = useSyncExternalStore(subscribe, readStyle, getServerStyleSnapshot);
  return [profile, style, selectReportProfile, selectReportStyle] as const;
}
