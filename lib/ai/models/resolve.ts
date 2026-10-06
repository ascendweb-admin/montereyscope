/**
 * Catalog → execution resolution (dynamic catalog stage). Browser-safe.
 *
 * Converts one saved selection plus one provider snapshot into the exact
 * runtime id and effort a CLI receives. The caller resolves once per turn or
 * job, so a background refresh can never change an active run. Failures are
 * specific and recoverable: an unavailable model asks for a replacement, an
 * obsolete effort asks for a new one, and neither is silently rewritten.
 */
import type { ChatModeSelection } from "../model-catalog";
import type { CatalogModel, ProviderCatalogSnapshot } from "./types";
import { findCatalogModel, isCatalogModelUsable } from "./types";

export type ExecutionProblemCode =
  "model_unavailable" | "model_not_supported" | "effort_unavailable";

export interface ExecutionProblem {
  code: ExecutionProblemCode;
  message: string;
}

export interface ResolvedModelExecution {
  /** Exact runtime id for the provider CLI; undefined on failure. */
  model?: string;
  /** Provider effort/variant; undefined means the provider's own default. */
  reasoningEffort?: string;
  catalogModel: CatalogModel | null;
  problem: ExecutionProblem | null;
}

function providerLabel(provider: ProviderCatalogSnapshot["provider"]): string {
  return provider === "opencode" ? "OpenCode Go" : provider === "claude" ? "Claude Code" : "Codex";
}

/**
 * Resolves a saved selection against the current snapshot. A catalog-only
 * model (runtimeCompatibility "unsupported") never runs, and an effort the
 * model no longer exposes produces a distinct recoverable error rather than
 * being dropped silently.
 */
export function resolveCatalogExecution(
  snapshot: ProviderCatalogSnapshot,
  selection: ChatModeSelection,
): ResolvedModelExecution {
  const label = providerLabel(snapshot.provider);
  const catalogModel = findCatalogModel(snapshot.models, selection.model);
  if (catalogModel === null) {
    return {
      catalogModel: null,
      problem: {
        code: "model_unavailable",
        message: `“${selection.model}” is not in the current ${label} model list. Choose a replacement in Settings → AI providers.`,
      },
    };
  }
  if (!isCatalogModelUsable(catalogModel)) {
    return {
      catalogModel,
      problem: {
        code: "model_not_supported",
        message: `${catalogModel.label} is not available with the installed ${label} build yet. Choose another model in Settings → AI providers.`,
      },
    };
  }
  const effort = selection.reasoningEffort;
  if (effort !== null && catalogModel.effortsKnown) {
    if (catalogModel.reasoningOptions.length === 0) {
      return {
        catalogModel,
        problem: {
          code: "effort_unavailable",
          message: `${catalogModel.label} no longer exposes selectable reasoning variants. Choose a provider default in Settings → AI providers.`,
        },
      };
    }
    if (!catalogModel.reasoningOptions.some((option) => option.id === effort)) {
      return {
        catalogModel,
        problem: {
          code: "effort_unavailable",
          message: `${catalogModel.label} no longer supports ${effort} reasoning. Choose a new depth in Settings → AI providers.`,
        },
      };
    }
    return { model: catalogModel.runtimeId, reasoningEffort: effort, catalogModel, problem: null };
  }
  // Unknown capabilities: omit the effort argument and use the provider's
  // own default rather than inventing one.
  return { model: catalogModel.runtimeId, catalogModel, problem: null };
}
