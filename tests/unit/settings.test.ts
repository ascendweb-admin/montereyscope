import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import {
  DEFAULT_AI_CHAT_MODE_SETTINGS,
  getDefaultAiChatModeSettings,
  type AiChatModeSettings,
} from "@/lib/ai/model-catalog";
import { INITIAL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import {
  DEFAULT_PREFERRED_CAPTION_LANGUAGES,
  DEFAULT_RECENT_ITEMS_PER_TAB,
  MAX_RECENT_ITEMS_PER_TAB,
  MIN_RECENT_ITEMS_PER_TAB,
  getCacheTranscriptsEnabled,
  getAiChatModeSettings,
  getPreferredCaptionLanguages,
  getRecentItemsPerTab,
  setCacheTranscriptsEnabled,
  setAiChatModeSettings,
  setPreferredCaptionLanguages,
  setRecentItemsPerTab,
  validateCacheTranscriptsEnabled,
  validateAiChatModeSettings,
  validatePreferredCaptionLanguages,
  validateRecentItemsPerTab,
} from "@/lib/settings/settings";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function createTempDb(): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-settings-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  return database;
}

afterAll(() => {
  if (db?.open) db.close();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  if (db) {
    db.close();
  }
  db = createTempDb();
  runMigrations(db, INITIAL_MIGRATIONS);
});

describe("getRecentItemsPerTab", () => {
  it("defaults to 30 when unset", () => {
    expect(getRecentItemsPerTab(db)).toBe(DEFAULT_RECENT_ITEMS_PER_TAB);
    expect(DEFAULT_RECENT_ITEMS_PER_TAB).toBe(30);
  });

  it("round-trips a saved value", () => {
    setRecentItemsPerTab(db, 55);
    expect(getRecentItemsPerTab(db)).toBe(55);
  });

  it.each([
    ["12 bananas", 30], // parseInt prefix — stored garbage falls back
    ["0", 30],
    ["999", 30],
    ["4", 30],
  ] as const)("falls back to the default on malformed stored value %j", (stored, expected) => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('recent_items_per_tab', ?)").run(stored);
    expect(getRecentItemsPerTab(db)).toBe(expected);
  });
});

describe("setRecentItemsPerTab clamping", () => {
  it("clamps into the safe 5–300 range", () => {
    expect(setRecentItemsPerTab(db, MIN_RECENT_ITEMS_PER_TAB - 1)).toBe(MIN_RECENT_ITEMS_PER_TAB);
    expect(setRecentItemsPerTab(db, MAX_RECENT_ITEMS_PER_TAB + 1)).toBe(MAX_RECENT_ITEMS_PER_TAB);
    expect(setRecentItemsPerTab(db, 42.6)).toBe(43);
    expect(getRecentItemsPerTab(db)).toBe(43);
  });
});

describe("validateRecentItemsPerTab (untrusted client input)", () => {
  it("accepts whole numbers inside the range", () => {
    expect(validateRecentItemsPerTab(30)).toEqual({ ok: true, value: 30, adjusted: false });
    expect(validateRecentItemsPerTab("75")).toEqual({ ok: true, value: 75, adjusted: false });
  });

  it("rejects non-integers and out-of-range values with friendly messages", () => {
    expect(validateRecentItemsPerTab("abc").ok).toBe(false);
    expect(validateRecentItemsPerTab(null).ok).toBe(false);
    expect(validateRecentItemsPerTab("").ok).toBe(false);

    const tooHigh = validateRecentItemsPerTab(301);
    if (!tooHigh.ok) {
      expect(tooHigh.message).toMatch(/between 5 and 300/i);
    }

    const fractional = validateRecentItemsPerTab(10.5);
    expect(fractional.ok).toBe(false);
  });
});

describe("English-only captions", () => {
  it("always reports English, including with legacy non-English preferences", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES('preferred_caption_languages', ?)").run(
      '["pt-br","de"]',
    );
    expect(getPreferredCaptionLanguages()).toEqual(["en"]);
    expect(DEFAULT_PREFERRED_CAPTION_LANGUAGES).toEqual(["en"]);
  });

  it("normalizes supported English variants to the fixed English setting", () => {
    expect(validatePreferredCaptionLanguages(["EN-us"])).toEqual({
      ok: true,
      value: ["en"],
      adjusted: true,
    });
    expect(setPreferredCaptionLanguages(db, ["en-orig"])).toEqual(["en"]);
    expect(getPreferredCaptionLanguages()).toEqual(["en"]);
  });

  it("rejects non-English languages and invalid input", () => {
    for (const value of ["en,pt-br", ["de"], [], "", 42, ["en", 3], "en.*"]) {
      expect(validatePreferredCaptionLanguages(value)).toEqual({
        ok: false,
        message: "Scope currently supports English captions only.",
      });
    }
    expect(() => setPreferredCaptionLanguages(db, ["pt-br"])).toThrow(/English captions only/);
  });
});

describe("cache transcripts toggle", () => {
  it("defaults to enabled when unset", () => {
    expect(getCacheTranscriptsEnabled(db)).toBe(true);
  });

  it("round-trips both states", () => {
    setCacheTranscriptsEnabled(db, false);
    expect(getCacheTranscriptsEnabled(db)).toBe(false);
    setCacheTranscriptsEnabled(db, true);
    expect(getCacheTranscriptsEnabled(db)).toBe(true);
  });

  it("falls back to the default on corrupted stored values", () => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('cache_transcripts', 'yes-please')",
    ).run();
    expect(getCacheTranscriptsEnabled(db)).toBe(true);
  });

  it("validates untrusted input permissively but not sloppily", () => {
    expect(validateCacheTranscriptsEnabled(true)).toEqual({
      ok: true,
      value: true,
      adjusted: false,
    });
    expect(validateCacheTranscriptsEnabled("false")).toEqual({
      ok: true,
      value: false,
      adjusted: false,
    });
    expect(validateCacheTranscriptsEnabled("on")).toEqual({
      ok: true,
      value: true,
      adjusted: true,
    });
    expect(validateCacheTranscriptsEnabled(0)).toEqual({
      ok: true,
      value: false,
      adjusted: true,
    });
    expect(validateCacheTranscriptsEnabled("maybe").ok).toBe(false);
  });
});

describe("provider-specific chat mode settings", () => {
  it("defaults each provider to the requested model ladder", () => {
    expect(getAiChatModeSettings(db)).toEqual(DEFAULT_AI_CHAT_MODE_SETTINGS);
  });

  it("round-trips independent provider choices", () => {
    const next: AiChatModeSettings = {
      codex: {
        quick: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        balanced: { model: "gpt-5.6-luna", reasoningEffort: "high" },
        deep: { model: "gpt-5.6-terra", reasoningEffort: "ultra" },
      },
      opencode: {
        quick: { model: "deepseek-v4-flash", reasoningEffort: "low" },
        balanced: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" },
        deep: { model: "deepseek-v4-pro", reasoningEffort: "high" },
      },
      claude: {
        quick: { model: "claude-sonnet", reasoningEffort: "low" },
        balanced: { model: "claude-opus", reasoningEffort: "high" },
        deep: { model: "claude-opus", reasoningEffort: "max" },
      },
    };

    expect(setAiChatModeSettings(db, next)).toEqual(next);
    expect(getAiChatModeSettings(db)).toEqual(next);
  });

  it("fills an absent provider block with defaults without touching the rest", () => {
    // A two-provider payload from before Claude existed must stay acceptable:
    // the missing block backfills, customized values are preserved.
    const twoProvider = {
      codex: {
        quick: { model: "gpt-5.6-sol", reasoningEffort: "max" },
        balanced: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        deep: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      },
      opencode: {
        quick: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        balanced: { model: "deepseek-v4-flash", reasoningEffort: "high" },
        deep: { model: "deepseek-v4-pro", reasoningEffort: "max" },
      },
    };
    const result = validateAiChatModeSettings(twoProvider);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.codex.quick).toEqual({ model: "gpt-5.6-sol", reasoningEffort: "max" });
      expect(result.value.claude).toEqual(DEFAULT_AI_CHAT_MODE_SETTINGS.claude);
      expect(result.adjusted).toBe(true);
    }

    // A supplied but malformed block is still rejected.
    const malformed = { ...twoProvider, claude: { quick: { model: "nope" } } };
    expect(validateAiChatModeSettings(malformed).ok).toBe(false);
  });

  it("rejects an effort the selected model does not expose", () => {
    const invalid = getDefaultAiChatModeSettings();
    invalid.opencode.deep = { model: "deepseek-v4-pro", reasoningEffort: "low" };
    const result = validateAiChatModeSettings(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/does not support low reasoning/i);
    }
  });

  it("allows provider-default for models without selectable variants", () => {
    const settings = getDefaultAiChatModeSettings();
    settings.opencode.quick = { model: "glm-5.1", reasoningEffort: null };
    expect(validateAiChatModeSettings(settings)).toMatchObject({ ok: true });

    settings.opencode.quick = { model: "glm-5.1", reasoningEffort: "low" };
    const invalid = validateAiChatModeSettings(settings);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.message).toMatch(/does not expose selectable reasoning variants/i);
    }
  });

  it("preserves an unknown saved model instead of overwriting it with a default", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_chat_mode_settings', ?)").run(
      JSON.stringify({
        codex: {
          quick: { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
          // Unknown to the bundled catalog: still a plausible provider id and
          // currently unavailable, so reading must keep it for the user.
          balanced: { model: "gpt-6-astra", reasoningEffort: null },
        },
        opencode: {
          balanced: { model: "deepseek-v4-flash", reasoningEffort: "max" },
        },
      }),
    );
    expect(getAiChatModeSettings(db)).toEqual({
      codex: {
        quick: { model: "gpt-5.6-sol", reasoningEffort: "ultra" },
        balanced: { model: "gpt-6-astra", reasoningEffort: null },
        deep: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
      },
      opencode: {
        quick: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        balanced: { model: "deepseek-v4-flash", reasoningEffort: "max" },
        deep: { model: "deepseek-v4-pro", reasoningEffort: "max" },
      },
      claude: {
        quick: { model: "claude-haiku", reasoningEffort: null },
        balanced: { model: "claude-sonnet", reasoningEffort: "medium" },
        deep: { model: "claude-opus", reasoningEffort: "xhigh" },
      },
    });
  });

  it("repairs structurally invalid stored entries", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_chat_mode_settings', ?)").run(
      JSON.stringify({
        codex: {
          quick: { model: "has spaces and ../../traversal", reasoningEffort: "low" },
          balanced: { model: "", reasoningEffort: "high" },
        },
      }),
    );
    const stored = getAiChatModeSettings(db);
    // Badly shaped ids fall back to the default entry; valid rows survive.
    expect(stored.codex.quick).toEqual(DEFAULT_AI_CHAT_MODE_SETTINGS.codex.quick);
    expect(stored.codex.balanced).toEqual(DEFAULT_AI_CHAT_MODE_SETTINGS.codex.balanced);
  });
});
