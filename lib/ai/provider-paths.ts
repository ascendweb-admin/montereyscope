/**
 * Provider executable overrides (desktop release stage 1). Server-only.
 *
 * Automatic discovery (PATH, mise) works for ordinary installs, but a
 * packaged app launched from a desktop menu never sees an interactive shell's
 * PATH and can miss a provider installed somewhere unusual. The user can
 * therefore pin an explicit executable per provider in Settings; the value is
 * stored in the settings table and read by the same resolvers that status,
 * login, model discovery, inference, and reports all use.
 *
 * The in-memory copy is loaded once at server boot (instrumentation) and
 * updated on every save, so pure resolvers never touch SQLite themselves.
 */
import path from "node:path";

import type { ScopeDatabase } from "@/lib/db/connection";
import { isAiBackendId, type AiBackendId } from "./backend-id";

export const AI_PROVIDER_PATHS_KEY = "ai_provider_paths";

/** Longest accepted executable path or command name. */
export const MAX_PROVIDER_PATH_LENGTH = 4096;

export type ProviderPathOverrides = Partial<Record<AiBackendId, string>>;

interface SettingsRow {
  value: string;
}

/**
 * The state lives on globalThis because Next.js bundles route handlers,
 * server actions, and instrumentation as separate module graphs in
 * development; a module-local map would let the route that saves an override
 * and the resolver that reads it drift into different copies. The auth
 * manager uses the same pattern for the same reason.
 */
const STATE_KEY = Symbol.for("scope.ai.provider-paths.v1");

interface ProviderPathGlobal {
  [STATE_KEY]?: ProviderPathOverrides;
}

function state(): ProviderPathOverrides {
  const globalState = globalThis as ProviderPathGlobal;
  if (globalState[STATE_KEY] === undefined) {
    globalState[STATE_KEY] = {};
  }
  return globalState[STATE_KEY];
}

/**
 * Accepts an absolute path or a bare command name; rejects empty strings,
 * control characters, and unbounded input. Provider CLIs are the only thing
 * this value ever reaches, and it is passed as one spawn argument.
 */
export function validateProviderPath(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PROVIDER_PATH_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(trimmed)
  ) {
    return null;
  }
  const hasSeparator = trimmed.includes("/") || trimmed.includes("\\");
  // Relative paths resolve differently in status probes and AI job directories.
  // Windows rooted paths without a drive also depend on the current drive.
  const absolute =
    platform === "win32"
      ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(trimmed)
      : path.posix.isAbsolute(trimmed);
  if ((hasSeparator || trimmed.includes(":")) && !absolute) {
    return null;
  }
  if (trimmed === "." || trimmed === "..") {
    return null;
  }
  return trimmed;
}

/** Parses a stored settings row without ever throwing on bad data. */
export function parseProviderPathOverrides(raw: unknown): ProviderPathOverrides {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const parsed: ProviderPathOverrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAiBackendId(key)) {
      continue;
    }
    const normalized = validateProviderPath(value);
    if (normalized !== null) {
      parsed[key] = normalized;
    }
  }
  return parsed;
}

function readStoredOverrides(db: ScopeDatabase): ProviderPathOverrides {
  try {
    const row = db
      .prepare<[string], SettingsRow>("SELECT value FROM settings WHERE key = ?")
      .get(AI_PROVIDER_PATHS_KEY);
    if (!row) {
      return {};
    }
    return parseProviderPathOverrides(JSON.parse(row.value));
  } catch {
    return {};
  }
}

/**
 * Loads persisted overrides into memory. Called once from the server boot
 * hook; a failure leaves the empty set in place rather than blocking startup.
 */
export function loadProviderPathOverrides(db: ScopeDatabase): void {
  (globalThis as ProviderPathGlobal)[STATE_KEY] = readStoredOverrides(db);
}

/**
 * Persists the override map and updates the in-memory copy. Passing null
 * removes the provider's override and restores automatic discovery.
 */
export function setProviderPathOverride(
  db: ScopeDatabase,
  provider: AiBackendId,
  value: string | null,
): ProviderPathOverrides {
  const next: ProviderPathOverrides = { ...state() };
  if (value === null) {
    delete next[provider];
  } else {
    next[provider] = value;
  }
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(AI_PROVIDER_PATHS_KEY, JSON.stringify(next));
  (globalThis as ProviderPathGlobal)[STATE_KEY] = next;
  return next;
}

/** The configured override for one provider, or undefined for automatic. */
export function getProviderPathOverride(provider: AiBackendId): string | undefined {
  return state()[provider];
}

/** True when the provider runs from an explicit user-set executable. */
export function hasProviderPathOverride(provider: AiBackendId): boolean {
  return state()[provider] !== undefined;
}

/** Current in-memory overrides; server diagnostics and tests. */
export function getProviderPathOverrides(): ProviderPathOverrides {
  return { ...state() };
}

/** Clears the in-memory copy; tests only. */
export function resetProviderPathOverrides(): void {
  delete (globalThis as ProviderPathGlobal)[STATE_KEY];
}
