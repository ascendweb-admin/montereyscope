/**
 * App-level settings stored in the `settings` key/value table. Server-only.
 *
 * - recent_items_per_tab: feed window used by channel refreshes (stage 3).
 * - preferred_caption_languages: legacy setting; transcript extraction now supports English only.
 * - cache_transcripts: whether successful transcripts are stored locally.
 * - ai_backend: which AI CLI (codex, opencode, or claude) runs every AI feature.
 * - ai_chat_mode_settings: provider-specific model and reasoning choices for
 *   the Quick, Balanced, and Deep chat modes.
 *
 * YouTube cookie settings still do not exist by design.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  AI_BACKEND_IDS,
  DEFAULT_AI_BACKEND,
  isAiBackendId,
  type AiBackendId,
} from "@/lib/ai/backend-id";
import { CHAT_MODE_IDS, type ChatModeId } from "@/lib/ai/chat-modes";
import {
  REASONING_EFFORT_IDS,
  getDefaultAiChatModeSettings,
  getProviderModel,
  type AiChatModeSettings,
  type ChatModeSelection,
  type ReasoningEffort,
} from "@/lib/ai/model-catalog";
import {
  findCatalogModel,
  isCatalogModelUsable,
  validateEffortForModel,
  type ModelCatalogSnapshot,
} from "@/lib/ai/models/types";

export const RECENT_ITEMS_PER_TAB_KEY = "recent_items_per_tab";

export const DEFAULT_RECENT_ITEMS_PER_TAB = 30;
export const MIN_RECENT_ITEMS_PER_TAB = 5;
export const MAX_RECENT_ITEMS_PER_TAB = 300;

export const PREFERRED_CAPTION_LANGUAGES_KEY = "preferred_caption_languages";
export const CACHE_TRANSCRIPTS_KEY = "cache_transcripts";
export const AI_BACKEND_KEY = "ai_backend";
export const AI_CHAT_MODE_SETTINGS_KEY = "ai_chat_mode_settings";

/** Compatibility value for the retired language preference setting. */
export const DEFAULT_PREFERRED_CAPTION_LANGUAGES: readonly string[] = ["en"];
export const MIN_CAPTION_LANGUAGES = 1;
export const MAX_CAPTION_LANGUAGES = 1;

/** Supported English track tags, including regional and original variants. */
const CAPTION_LANGUAGE_PATTERN = /^en(?:-[a-z0-9]{2,8})*$/i;

interface SettingsRow {
  value: string;
}

function clampToRange(value: number): number {
  return Math.min(MAX_RECENT_ITEMS_PER_TAB, Math.max(MIN_RECENT_ITEMS_PER_TAB, Math.round(value)));
}

/**
 * Reads the configured recent-items-per-tab limit, falling back to the
 * default when unset, malformed, or out of the safe range. Never throws
 * on bad stored data — the default wins instead.
 */
export function getRecentItemsPerTab(db: ScopeDatabase): number {
  const row = db
    .prepare<[string], SettingsRow>("SELECT value FROM settings WHERE key = ?")
    .get(RECENT_ITEMS_PER_TAB_KEY);
  if (!row) {
    return DEFAULT_RECENT_ITEMS_PER_TAB;
  }
  // Strict numeric parse: our own writer always stores clean integers, so
  // anything else in the table is corruption — the default wins instead.
  const parsed = Number(row.value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_RECENT_ITEMS_PER_TAB ||
    parsed > MAX_RECENT_ITEMS_PER_TAB
  ) {
    return DEFAULT_RECENT_ITEMS_PER_TAB;
  }
  return parsed;
}

/**
 * Persists the limit after clamping into the safe 5–300 range.
 * Non-finite input falls back to the default rather than throwing.
 */
export function setRecentItemsPerTab(db: ScopeDatabase, value: number): number {
  const safe =
    typeof value === "number" && Number.isFinite(value)
      ? clampToRange(value)
      : DEFAULT_RECENT_ITEMS_PER_TAB;
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(RECENT_ITEMS_PER_TAB_KEY, String(safe));
  return safe;
}

/**
 * Validates an untrusted value (client input) for the limit.
 * Returns the clamped value plus whether it was adjusted, so the UI can
 * confirm what actually got saved.
 */
export function validateRecentItemsPerTab(value: unknown):
  | {
      ok: true;
      value: number;
      adjusted: boolean;
    }
  | { ok: false; message: string } {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return {
      ok: false,
      message: `Enter a whole number between ${MIN_RECENT_ITEMS_PER_TAB} and ${MAX_RECENT_ITEMS_PER_TAB}.`,
    };
  }
  const rounded = Math.round(parsed);
  if (
    rounded < MIN_RECENT_ITEMS_PER_TAB ||
    rounded > MAX_RECENT_ITEMS_PER_TAB ||
    !Number.isInteger(parsed)
  ) {
    return {
      ok: false,
      message: `Recent items per tab must be a whole number between ${MIN_RECENT_ITEMS_PER_TAB} and ${MAX_RECENT_ITEMS_PER_TAB}.`,
    };
  }
  return { ok: true, value: rounded, adjusted: false };
}

// ---------------------------------------------------------------------------
// Preferred caption languages (stage 4)
// ---------------------------------------------------------------------------

/** English is fixed; legacy non-English preferences no longer affect extraction. */
export function getPreferredCaptionLanguages(): string[] {
  return [...DEFAULT_PREFERRED_CAPTION_LANGUAGES];
}

function persistSetting(db: ScopeDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** Compatibility entry point for clients using the previous language setting. */
export function setPreferredCaptionLanguages(
  db: ScopeDatabase,
  languages: readonly string[],
): string[] {
  const validated = validatePreferredCaptionLanguages(languages);
  if (!validated.ok) throw new TypeError(validated.message);
  persistSetting(db, PREFERRED_CAPTION_LANGUAGES_KEY, JSON.stringify(validated.value));
  return validated.value;
}

/** English variants normalize to the single supported language. */
export function validatePreferredCaptionLanguages(
  value: unknown,
): { ok: true; value: string[]; adjusted: boolean } | { ok: false; message: string } {
  const entries = typeof value === "string" ? value.split(/[\n,]+/) : value;
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.some(
      (entry) => typeof entry !== "string" || !CAPTION_LANGUAGE_PATTERN.test(entry.trim()),
    )
  ) {
    return { ok: false, message: "Scope currently supports English captions only." };
  }
  return {
    ok: true,
    value: ["en"],
    adjusted: entries.length !== 1 || entries[0] !== "en",
  };
}

// ---------------------------------------------------------------------------
// Transcript caching toggle (stage 4)
// ---------------------------------------------------------------------------

/**
 * Reads whether successful transcripts are cached. Anything other than a
 * clean "true"/"false" row falls back to the default (enabled).
 */
export function getCacheTranscriptsEnabled(db: ScopeDatabase): boolean {
  const row = db
    .prepare<[string], SettingsRow>("SELECT value FROM settings WHERE key = ?")
    .get(CACHE_TRANSCRIPTS_KEY);
  if (!row) {
    return true;
  }
  if (row.value === "true") {
    return true;
  }
  if (row.value === "false") {
    return false;
  }
  return true;
}

/** Persists the caching toggle. */
export function setCacheTranscriptsEnabled(db: ScopeDatabase, enabled: boolean): boolean {
  persistSetting(db, CACHE_TRANSCRIPTS_KEY, enabled ? "true" : "false");
  return enabled;
}

/** Validates untrusted input for the caching toggle. */
export function validateCacheTranscriptsEnabled(
  value: unknown,
): { ok: true; value: boolean; adjusted: boolean } | { ok: false; message: string } {
  if (typeof value === "boolean") {
    return { ok: true, value, adjusted: false };
  }
  if (value === "true") {
    return { ok: true, value: true, adjusted: false };
  }
  if (value === "false") {
    return { ok: true, value: false, adjusted: false };
  }
  if (value === "on" || value === "1" || value === 1) {
    return { ok: true, value: true, adjusted: true };
  }
  if (value === "off" || value === "0" || value === 0) {
    return { ok: true, value: false, adjusted: true };
  }
  return {
    ok: false,
    message: "Transcript caching must be either on or off.",
  };
}

// ---------------------------------------------------------------------------
// AI backend choice (stage 9)
// ---------------------------------------------------------------------------

/**
 * Reads which AI CLI runs the AI features. Anything other than a clean
 * backend id falls back to the default — bad rows never throw.
 */
export function getAiBackend(db: ScopeDatabase): AiBackendId {
  const row = db
    .prepare<[string], SettingsRow>("SELECT value FROM settings WHERE key = ?")
    .get(AI_BACKEND_KEY);
  if (!row) {
    return DEFAULT_AI_BACKEND;
  }
  return isAiBackendId(row.value) ? row.value : DEFAULT_AI_BACKEND;
}

/** Persists the AI backend choice and returns the value as stored. */
export function setAiBackend(db: ScopeDatabase, backend: AiBackendId): AiBackendId {
  persistSetting(db, AI_BACKEND_KEY, backend);
  return backend;
}

/** Validates untrusted input for the AI backend choice. */
export function validateAiBackend(
  value: unknown,
): { ok: true; value: AiBackendId; adjusted: boolean } | { ok: false; message: string } {
  if (isAiBackendId(value)) {
    return { ok: true, value, adjusted: false };
  }
  return {
    ok: false,
    message: "AI backend must be one of: codex, opencode, claude.",
  };
}

// ---------------------------------------------------------------------------
// Provider-specific chat mode defaults
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Model ids may be provider-qualified or family-alias based; reads stay
 * structural so an unknown or temporarily unavailable model is preserved
 * rather than overwritten with a default. Newly selected ids are validated
 * against the discovered catalog by the settings action, so this parser is
 * only a sanity bound against corrupt rows.
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]+\-]{0,159}$/;

/** Effort ids are provider-reported bounded strings, not a closed enum. */
const EFFORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isBoundedModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID_PATTERN.test(value);
}

function isBoundedEffort(value: unknown): value is string {
  return typeof value === "string" && EFFORT_ID_PATTERN.test(value);
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORT_IDS.some((effort) => effort === value);
}

function cloneSelection(selection: ChatModeSelection): ChatModeSelection {
  return { model: selection.model, reasoningEffort: selection.reasoningEffort };
}

/**
 * Reads the complete provider/model matrix. Missing, malformed, or
 * structurally invalid entries fall back to defaults, but a well-formed model
 * that is merely unknown or currently unavailable is preserved exactly as
 * saved — reading settings must never silently replace a user's choice.
 */
export function getAiChatModeSettings(db: ScopeDatabase): AiChatModeSettings {
  const fallback = getDefaultAiChatModeSettings();
  const row = db
    .prepare<[string], SettingsRow>("SELECT value FROM settings WHERE key = ?")
    .get(AI_CHAT_MODE_SETTINGS_KEY);
  if (!row) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return fallback;
  }
  if (!isRecord(parsed)) {
    return fallback;
  }

  for (const backend of AI_BACKEND_IDS) {
    const rawBackend = parsed[backend];
    if (!isRecord(rawBackend)) {
      continue;
    }
    for (const mode of CHAT_MODE_IDS) {
      const rawSelection = rawBackend[mode];
      if (!isRecord(rawSelection) || !isBoundedModelId(rawSelection.model)) {
        continue;
      }
      const rawEffort = rawSelection.reasoningEffort;
      const effort = rawEffort === null ? null : isBoundedEffort(rawEffort) ? rawEffort : null;
      fallback[backend][mode] = { model: rawSelection.model, reasoningEffort: effort };
    }
  }
  return fallback;
}

/** Catalog context a caller may pass to validate real availability. */
export interface ChatModeValidationOptions {
  /** Discovered catalog snapshots; absent means bundled-only validation. */
  catalogs?: ModelCatalogSnapshot;
  /** Currently persisted selections; unchanged unavailable ones are kept. */
  previous?: AiChatModeSettings;
}

/**
 * Validates a complete or partially supplied client-submitted matrix.
 *
 * Without `catalogs` the bundled catalog is the authority (used by direct
 * persistence callers and tests). With `catalogs`, a newly selected model must
 * exist in the discovered catalog and be runtime-compatible; the only
 * exception is a selection that is unchanged from `previous`, which is
 * preserved so an unavailable choice never blocks editing other settings and
 * can be replaced deliberately.
 */
export function validateAiChatModeSettings(
  value: unknown,
  options: ChatModeValidationOptions = {},
): { ok: true; value: AiChatModeSettings; adjusted: boolean } | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: "Chat mode settings must be an object." };
  }

  const normalized = getDefaultAiChatModeSettings();
  for (const backend of AI_BACKEND_IDS) {
    const rawBackend = value[backend];
    // Settings submitted before a provider existed omit its block entirely;
    // those fill in with defaults (a missing Claude matrix must not wipe
    // customized Codex/OpenCode choices). A block that is present but
    // malformed is still rejected.
    if (rawBackend === undefined) {
      continue;
    }
    if (!isRecord(rawBackend)) {
      return { ok: false, message: `Add model settings for ${backend}.` };
    }
    for (const mode of CHAT_MODE_IDS) {
      const rawSelection = rawBackend[mode];
      if (!isRecord(rawSelection)) {
        return { ok: false, message: `Add a model for ${backend} ${mode}.` };
      }
      if (typeof rawSelection.model !== "string" || rawSelection.model.length === 0) {
        return { ok: false, message: `Choose a model for ${backend} ${mode}.` };
      }
      const rawEffort = rawSelection.reasoningEffort;
      if (rawEffort !== null && typeof rawEffort !== "string") {
        return { ok: false, message: `Choose a reasoning effort for ${backend} ${mode}.` };
      }

      const previousSelection = options.previous?.[backend][mode];
      const unchanged =
        previousSelection?.model === rawSelection.model &&
        previousSelection.reasoningEffort === rawEffort;
      const catalogSnapshot = options.catalogs?.providers[backend];
      const catalogModel = catalogSnapshot
        ? findCatalogModel(catalogSnapshot.models, rawSelection.model)
        : null;

      if (options.catalogs) {
        // Discovered availability is authoritative for new selections.
        if (catalogModel === null) {
          if (!unchanged) {
            return {
              ok: false,
              message: `That model is not available for ${backend}. Refresh the model list and choose one.`,
            };
          }
          normalized[backend][mode] = {
            model: rawSelection.model,
            reasoningEffort: rawEffort !== null && isBoundedEffort(rawEffort) ? rawEffort : null,
          };
          continue;
        }
        if (!isCatalogModelUsable(catalogModel)) {
          if (!unchanged) {
            return {
              ok: false,
              message: `${catalogModel.label} is not available with the installed ${providerLabel(backend)} build yet. Choose another model.`,
            };
          }
          normalized[backend][mode] = {
            model: catalogModel.id,
            reasoningEffort: rawEffort !== null && isBoundedEffort(rawEffort) ? rawEffort : null,
          };
          continue;
        }
        if (catalogModel.effortsKnown && catalogModel.reasoningOptions.length === 0) {
          if (rawEffort !== null && !unchanged) {
            return {
              ok: false,
              message: `${catalogModel.label} does not expose selectable reasoning variants on ${backend}.`,
            };
          }
        } else if (rawEffort !== null) {
          if (isBoundedEffort(rawEffort)) {
            if (
              catalogModel.effortsKnown &&
              !validateEffortForModel(catalogModel, rawEffort) &&
              !unchanged
            ) {
              return {
                ok: false,
                message: `${catalogModel.label} does not support ${rawEffort} reasoning on ${backend}.`,
              };
            }
          } else if (!unchanged) {
            return { ok: false, message: `Choose a reasoning effort for ${backend} ${mode}.` };
          }
        }
        normalized[backend][mode] = {
          model: catalogModel.id,
          reasoningEffort: rawEffort !== null && isBoundedEffort(rawEffort) ? rawEffort : null,
        };
        continue;
      }

      // Bundled-only validation: the shipped catalog is the authority.
      const model = getProviderModel(backend, rawSelection.model);
      if (!model) {
        return {
          ok: false,
          message: `That model is not available for ${backend}. Choose one from the list.`,
        };
      }
      if (model.reasoningEfforts.length === 0) {
        if (rawEffort !== null) {
          return {
            ok: false,
            message: `${model.label} does not expose selectable reasoning variants on ${backend}.`,
          };
        }
      } else {
        if (rawEffort === null || !isReasoningEffort(rawEffort)) {
          return { ok: false, message: `Choose a reasoning effort for ${backend} ${mode}.` };
        }
        if (!model.reasoningEfforts.includes(rawEffort)) {
          return {
            ok: false,
            message: `${model.label} does not support ${rawEffort} reasoning on ${backend}.`,
          };
        }
      }
      normalized[backend][mode] = {
        model: model.id,
        reasoningEffort: model.reasoningEfforts.length === 0 ? null : rawEffort,
      };
    }
  }

  const adjusted = JSON.stringify(normalized) !== JSON.stringify(value);
  return { ok: true, value: normalized, adjusted };
}

function providerLabel(backend: AiBackendId): string {
  return backend === "codex" ? "codex" : backend === "opencode" ? "opencode" : "claude";
}

/** Persists the validated provider/model matrix and returns the normalized value. */
export function setAiChatModeSettings(
  db: ScopeDatabase,
  value: AiChatModeSettings,
  options: ChatModeValidationOptions = {},
): AiChatModeSettings {
  const validated = validateAiChatModeSettings(value, options);
  if (!validated.ok) {
    throw new Error(validated.message);
  }
  persistSetting(db, AI_CHAT_MODE_SETTINGS_KEY, JSON.stringify(validated.value));
  return validated.value;
}

/** Returns one provider/mode selection from the complete persisted matrix. */
export function getAiChatModeSelection(
  db: ScopeDatabase,
  backend: AiBackendId,
  mode: ChatModeId,
): ChatModeSelection {
  return cloneSelection(getAiChatModeSettings(db)[backend][mode]);
}
