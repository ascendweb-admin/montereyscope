/**
 * Bundled catalog fallback (dynamic catalog stage). Browser-safe.
 *
 * Converts the hand-authored catalog in `lib/ai/model-catalog.ts` into the
 * shared catalog shape so the picker, validator, and resolver speak one
 * vocabulary whether a snapshot is live or degraded. Bundled entries are
 * always usable and supported (they were authored against the shipped CLIs),
 * but their access evidence is unknown: being listed here is not proof the
 * connected account can use them.
 */
import { AI_MODEL_OPTIONS } from "../model-catalog";
import type { AiBackendId } from "../backend-id";
import { catalogReasoningOption } from "./labels";
import type { CatalogModel, ModelCatalogSnapshot, ProviderCatalogSnapshot } from "./types";

/** Maps one bundled provider catalog into catalog models. */
export function bundledCatalogModels(provider: AiBackendId): CatalogModel[] {
  return AI_MODEL_OPTIONS[provider].map((option) => ({
    provider,
    id: option.id,
    runtimeId: option.runtimeId,
    label: option.label,
    description: option.description,
    reasoningOptions: option.reasoningEfforts.map((effort) => catalogReasoningOption(effort)),
    defaultReasoningEffort: option.defaultReasoningEffort,
    // Bundled entries were authored per CLI; a confirmed empty list is real.
    effortsKnown: true,
    runtimeCompatibility: "supported",
    access: "unknown",
    aliasTarget: provider === "claude" ? option.runtimeId : null,
    recommended: false,
    upgrade: null,
    source: "bundled",
    firstSeenAt: null,
  }));
}

/** One provider's bundled fallback snapshot (usable before any fetch). */
export function bundledProviderSnapshot(provider: AiBackendId): ProviderCatalogSnapshot {
  return {
    provider,
    state: "bundled",
    connectionKey: "bundled",
    revision: 0,
    models: bundledCatalogModels(provider),
    lastAttemptAt: null,
    lastSuccessAt: null,
    baselineAt: null,
    error: null,
    fallback: true,
    refreshing: false,
  };
}

/** A complete bundled snapshot, used as the client's pre-fetch state. */
export function bundledCatalogSnapshot(): ModelCatalogSnapshot {
  return {
    checkedAt: new Date(0).toISOString(),
    providers: {
      codex: bundledProviderSnapshot("codex"),
      opencode: bundledProviderSnapshot("opencode"),
      claude: bundledProviderSnapshot("claude"),
    },
  };
}
