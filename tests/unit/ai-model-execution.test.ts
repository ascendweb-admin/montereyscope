/**
 * Catalog-aware execution resolution and settings validation tests (dynamic
 * catalog stage). They pin the user-facing contracts: saved choices survive
 * refresh, unavailable selections are preserved but not re-selectable, and a
 * browser cannot smuggle an arbitrary runtime id past validation.
 */
import { describe, expect, it } from "vitest";

import { getDefaultAiChatModeSettings, type AiChatModeSettings } from "@/lib/ai/model-catalog";
import { resolveCatalogExecution } from "@/lib/ai/models/resolve";
import type {
  CatalogModel,
  ModelCatalogSnapshot,
  ProviderCatalogSnapshot,
} from "@/lib/ai/models/types";
import { bundledCatalogSnapshot } from "@/lib/ai/models/bundled";
import { bundledCatalogModels } from "@/lib/ai/models/bundled";
import { validateAiChatModeSettings } from "@/lib/settings/settings";
import type { AiBackendId } from "@/lib/ai/backend-id";

const ALL: readonly AiBackendId[] = ["codex", "opencode", "claude"];

function discovered(overrides: Partial<CatalogModel>): CatalogModel {
  return {
    provider: "codex",
    id: "gpt-6-astra",
    runtimeId: "gpt-6-astra",
    label: "GPT-6 Astra",
    description: "",
    reasoningOptions: [],
    defaultReasoningEffort: null,
    effortsKnown: true,
    runtimeCompatibility: "supported",
    access: "account",
    aliasTarget: null,
    recommended: true,
    upgrade: null,
    source: "discovered",
    firstSeenAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function snapshotWith(provider: AiBackendId, models: CatalogModel[]): ModelCatalogSnapshot {
  const base = bundledCatalogSnapshot();
  const entry: ProviderCatalogSnapshot = {
    provider,
    state: models.length > 0 ? "live" : "empty",
    connectionKey: "test-connection",
    revision: 3,
    models,
    lastAttemptAt: "2026-09-18T00:00:00.000Z",
    lastSuccessAt: "2026-09-18T00:00:00.000Z",
    baselineAt: "2026-09-01T00:00:00.000Z",
    error: null,
    fallback: false,
    refreshing: false,
  };
  return {
    checkedAt: entry.lastAttemptAt ?? base.checkedAt,
    providers: { ...base.providers, [provider]: entry },
  };
}

describe("resolveCatalogExecution", () => {
  it("resolves bundled entries through the public-to-runtime mapping", () => {
    const snapshot = bundledCatalogSnapshot().providers.codex;
    expect(
      resolveCatalogExecution(snapshot, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" }),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      problem: null,
    });
    const opencode = bundledCatalogSnapshot().providers.opencode;
    expect(
      resolveCatalogExecution(opencode, {
        model: "deepseek-v4-pro",
        reasoningEffort: "max",
      }),
    ).toMatchObject({ model: "opencode-go/deepseek-v4-pro", reasoningEffort: "max" });
    const claude = bundledCatalogSnapshot().providers.claude;
    expect(
      resolveCatalogExecution(claude, { model: "claude-sonnet", reasoningEffort: "high" }),
    ).toMatchObject({ model: "sonnet", reasoningEffort: "high" });
  });

  it("reports an unavailable saved model as a specific recoverable problem", () => {
    const snapshot = snapshotWith("codex", [discovered({})]).providers.codex;
    const resolved = resolveCatalogExecution(snapshot, {
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });
    expect(resolved.problem?.code).toBe("model_unavailable");
    expect(resolved.problem?.message).toContain("gpt-5.4");
    expect(resolved.model).toBeUndefined();
  });

  it("refuses a catalog-only model before execution", () => {
    const snapshot = snapshotWith("opencode", [
      discovered({
        provider: "opencode",
        id: "brand-new",
        runtimeId: "opencode-go/brand-new",
        runtimeCompatibility: "unsupported",
        effortsKnown: false,
      }),
    ]).providers.opencode;
    const resolved = resolveCatalogExecution(snapshot, {
      model: "brand-new",
      reasoningEffort: null,
    });
    expect(resolved.problem?.code).toBe("model_not_supported");
  });

  it("surfaces an obsolete effort instead of silently dropping it", () => {
    const snapshot = snapshotWith("codex", [
      discovered({
        reasoningOptions: [{ id: "low", label: "Low", description: "" }],
        defaultReasoningEffort: "low",
      }),
    ]).providers.codex;
    const resolved = resolveCatalogExecution(snapshot, {
      model: "gpt-6-astra",
      reasoningEffort: "xhigh",
    });
    expect(resolved.problem?.code).toBe("effort_unavailable");
    expect(resolved.problem?.message).toContain("xhigh");
  });

  it("omits effort when capabilities are unknown and honors provider default", () => {
    const unknown = snapshotWith("codex", [
      discovered({ effortsKnown: false, reasoningOptions: [] }),
    ]).providers.codex;
    const unknownResolved = resolveCatalogExecution(unknown, {
      model: "gpt-6-astra",
      reasoningEffort: "high",
    });
    expect(unknownResolved).toMatchObject({ model: "gpt-6-astra", problem: null });
    expect(unknownResolved.reasoningEffort).toBeUndefined();

    const withOptions = snapshotWith("opencode", [
      discovered({
        provider: "opencode",
        id: "deepseek-v4-flash",
        runtimeId: "opencode-go/deepseek-v4-flash",
        reasoningOptions: [
          { id: "high", label: "High", description: "" },
          { id: "max", label: "Maximum", description: "" },
        ],
        defaultReasoningEffort: null,
      }),
    ]).providers.opencode;
    const defaultResolved = resolveCatalogExecution(withOptions, {
      model: "deepseek-v4-flash",
      reasoningEffort: null,
    });
    expect(defaultResolved).toMatchObject({
      model: "opencode-go/deepseek-v4-flash",
      problem: null,
    });
    expect(defaultResolved.reasoningEffort).toBeUndefined();
  });
});

describe("validateAiChatModeSettings with a discovered catalog", () => {
  const catalogs = snapshotWith("codex", [
    discovered({}),
    discovered({
      id: "gpt-6-sol",
      runtimeId: "gpt-6-sol",
      label: "GPT-6 Sol",
      reasoningOptions: [{ id: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
    }),
  ]);

  it("accepts a newly discovered model and persists it for resolution", () => {
    const next = getDefaultAiChatModeSettings();
    next.codex.deep = { model: "gpt-6-sol", reasoningEffort: "high" };
    const validated = validateAiChatModeSettings(next, {
      catalogs,
      previous: getDefaultAiChatModeSettings(),
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.codex.deep).toEqual({
        model: "gpt-6-sol",
        reasoningEffort: "high",
      });
      expect(
        resolveCatalogExecution(catalogs.providers.codex, validated.value.codex.deep),
      ).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "high" });
    }
  });

  it("rejects an arbitrary runtime id a browser might submit", () => {
    const next = getDefaultAiChatModeSettings();
    next.codex.deep = { model: "opencode-go/deepseek-v4-pro", reasoningEffort: null };
    const validated = validateAiChatModeSettings(next, { catalogs });
    expect(validated.ok).toBe(false);
    if (!validated.ok) {
      expect(validated.message).toMatch(/not available for codex/i);
    }
  });

  it("preserves an unchanged unavailable selection while other edits save", () => {
    const previous = getDefaultAiChatModeSettings();
    previous.codex.deep = { model: "gpt-5.4", reasoningEffort: "medium" };

    const submitted: AiChatModeSettings = {
      ...previous,
      codex: {
        ...previous.codex,
        quick: { model: "gpt-6-astra", reasoningEffort: null },
      },
    };
    const validated = validateAiChatModeSettings(submitted, { catalogs, previous });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.codex.deep).toEqual({
        model: "gpt-5.4",
        reasoningEffort: "medium",
      });
      expect(validated.value.codex.quick).toEqual({
        model: "gpt-6-astra",
        reasoningEffort: null,
      });
    }
  });

  it("preserves an obsolete effort on an unchanged selection but not a new one", () => {
    const previous = getDefaultAiChatModeSettings();
    previous.codex.deep = { model: "gpt-6-sol", reasoningEffort: "xhigh" };
    const catalogsForSol = snapshotWith("codex", [
      discovered({
        id: "gpt-6-sol",
        runtimeId: "gpt-6-sol",
        reasoningOptions: [{ id: "high", label: "High", description: "" }],
        defaultReasoningEffort: "high",
      }),
    ]);
    const unchanged = validateAiChatModeSettings(
      { ...previous },
      { catalogs: catalogsForSol, previous },
    );
    expect(unchanged.ok).toBe(true);
    if (unchanged.ok) {
      expect(unchanged.value.codex.deep.reasoningEffort).toBe("xhigh");
    }

    const swapped = getDefaultAiChatModeSettings();
    swapped.codex.deep = { model: "gpt-6-sol", reasoningEffort: "xhigh" };
    const asNew = validateAiChatModeSettings(
      { ...swapped },
      { catalogs: catalogsForSol, previous: getDefaultAiChatModeSettings() },
    );
    expect(asNew.ok).toBe(false);
    if (!asNew.ok) {
      expect(asNew.message).toMatch(/does not support xhigh/i);
    }
  });

  it("falls back to the bundled catalog when no live snapshot is supplied", () => {
    const next = getDefaultAiChatModeSettings();
    next.codex.quick = { model: "gpt-6-astra", reasoningEffort: null };
    expect(validateAiChatModeSettings(next).ok).toBe(false);
    expect(validateAiChatModeSettings(getDefaultAiChatModeSettings()).ok).toBe(true);
  });

  it("keeps every bundled provider valid for the catalog-aware path", () => {
    // The bundled catalog is a legitimate snapshot too: all shipped defaults
    // must resolve against it for all three providers.
    const settings = getDefaultAiChatModeSettings();
    const all: ModelCatalogSnapshot = bundledCatalogSnapshot();
    for (const provider of ALL) {
      const models = bundledCatalogModels(provider);
      const selection = settings[provider].balanced;
      expect(
        resolveCatalogExecution(all.providers[provider], selection),
        `${provider} balanced default`,
      ).toMatchObject({ problem: null });
      expect(models.length).toBeGreaterThan(0);
    }
  });
});

it("rejects a newly invalid effort even when the model has not changed", () => {
  const previous = getDefaultAiChatModeSettings();
  const next = structuredClone(previous);
  next.codex.quick.reasoningEffort = "nonexistent";
  expect(
    validateAiChatModeSettings(next, { previous, catalogs: bundledCatalogSnapshot() }).ok,
  ).toBe(false);
});
