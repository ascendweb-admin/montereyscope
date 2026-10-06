/**
 * Reasoning-option labels (dynamic catalog stage). Browser-safe.
 *
 * Provider option ids are open-ended, so labels are resolved in one place:
 * the shared vocabulary in `lib/ai/model-catalog.ts` keeps familiar labels
 * stable across the bundled and discovered catalogs, and an unknown provider
 * id falls back to a readable title-cased form instead of being dropped.
 */
import { REASONING_EFFORT_OPTIONS } from "../model-catalog";
import type { CatalogReasoningOption } from "./types";
import { MAX_EFFORT_ID_LENGTH } from "./types";

const KNOWN_LABELS = new Map<string, { label: string; description: string }>(
  REASONING_EFFORT_OPTIONS.map((option) => [
    option.id,
    { label: option.label, description: option.description },
  ]),
);

/** Title-cases a provider effort id for display ("xhigh" → "Xhigh"). */
export function titleCaseEffortId(id: string): string {
  if (id.length === 0) {
    return id;
  }
  return `${id[0].toUpperCase()}${id.slice(1)}`;
}

/**
 * Builds one display option for a provider-reported effort id. Familiar ids
 * keep their bundled labels; unknown ids stay visible with a derived label.
 */
export function catalogReasoningOption(
  id: string,
  description?: string | null,
): CatalogReasoningOption {
  const known = KNOWN_LABELS.get(id);
  const label = known?.label ?? titleCaseEffortId(id);
  const detail =
    typeof description === "string" && description.trim().length > 0
      ? description.trim()
      : (known?.description ?? "");
  return { id: id.slice(0, MAX_EFFORT_ID_LENGTH), label, description: detail };
}

/** Display forms for model-id tokens that are not plain words. */
const TOKEN_LABELS: Record<string, string> = {
  ai: "AI",
  gpt: "GPT",
  glm: "GLM",
  hy: "Hy",
  mimo: "MiMo",
  minimax: "MiniMax",
  longcat: "LongCat",
  qwen: "Qwen",
  llm: "LLM",
};

/**
 * Derives a readable label for a model the provider listed without display
 * metadata ("mimo-v2-pro" → "MiMo V2 Pro"). Purely presentational; the exact
 * runtime id is never altered.
 */
export function labelFromModelId(id: string): string {
  return id
    .split(/[-_./]+/)
    .filter((token) => token.length > 0)
    .map((token) => {
      const lower = token.toLowerCase();
      return TOKEN_LABELS[lower] ?? `${token[0].toUpperCase()}${token.slice(1)}`;
    })
    .join(" ");
}
