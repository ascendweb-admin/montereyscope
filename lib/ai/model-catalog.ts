/**
 * Provider model capabilities used by the chat mode picker.
 *
 * This is deliberately a pure data module so Settings can render the same
 * model/effort vocabulary on the client that the server uses to validate and
 * run a chat turn. The public model id is what we persist and show in the
 * UI; `runtimeId` is the provider-specific id a CLI needs at execution time.
 */
import type { AiBackendId } from "./backend-id";
import type { ChatModeId } from "./chat-modes";

export const REASONING_EFFORT_IDS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "thinking",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_IDS)[number];

export interface ReasoningEffortOption {
  id: ReasoningEffort;
  label: string;
  description: string;
}

/** Display metadata for every effort the model explicitly exposes. */
export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffortOption[] = [
  { id: "none", label: "None", description: "Answer without deliberate reasoning" },
  { id: "minimal", label: "Minimal", description: "Use the lightest reasoning available" },
  { id: "low", label: "Low", description: "Fast responses with lighter reasoning" },
  {
    id: "medium",
    label: "Medium",
    description: "Balance response speed and reasoning depth",
  },
  { id: "high", label: "High", description: "Spend more time on complex questions" },
  { id: "xhigh", label: "Extra high", description: "Use extra-high reasoning depth" },
  { id: "max", label: "Maximum", description: "Use the deepest reasoning available" },
  { id: "ultra", label: "Ultra", description: "Maximum reasoning with task delegation" },
  { id: "thinking", label: "Thinking", description: "Use the model's thinking variant" },
];

export interface ProviderModelOption {
  /** Stable model id shown and persisted by scope. */
  id: string;
  /** Exact model id expected by the provider's CLI, when it differs. */
  runtimeId: string;
  label: string;
  description: string;
  /** Efforts reported for this model by this provider. */
  reasoningEfforts: readonly ReasoningEffort[];
  /** Null means the provider exposes no selectable reasoning variant. */
  defaultReasoningEffort: ReasoningEffort | null;
}

const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CODEX_EXTENDED_EFFORTS = [...CODEX_EFFORTS, "ultra"] as const;

const OPENCODE_LUNA_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Effort levels the Claude models expose. Haiku does not support effort at
 * all (the Claude Code docs list only Fable/Opus/Sonnet as effort-capable),
 * so its entry stays empty and the picker shows "Provider default".
 */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * Every model currently exposed by the OpenCode Go catalog is included here.
 * Models without variants keep an empty effort list and use the provider's
 * default; the picker must never invent a generic effort for those models.
 */
export const AI_MODEL_OPTIONS: Record<AiBackendId, readonly ProviderModelOption[]> = {
  codex: [
    {
      id: "gpt-6-luna",
      runtimeId: "gpt-6-luna",
      label: "GPT-6 Luna",
      description: "Fast and economical for everyday questions",
      reasoningEfforts: CODEX_EFFORTS,
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-6.1-sol",
      runtimeId: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      description: "Thorough reasoning for analysis and complex work",
      reasoningEfforts: CODEX_EXTENDED_EFFORTS,
      defaultReasoningEffort: "low",
    },
    {
      id: "gpt-5.6-luna",
      runtimeId: "gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      description: "Fast and economical for everyday questions",
      reasoningEfforts: CODEX_EFFORTS,
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.6-terra",
      runtimeId: "gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      description: "A balanced model for regular analysis",
      reasoningEfforts: CODEX_EXTENDED_EFFORTS,
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.6-sol",
      runtimeId: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      description: "The most thorough Codex model",
      reasoningEfforts: CODEX_EXTENDED_EFFORTS,
      defaultReasoningEffort: "xhigh",
    },
    {
      id: "gpt-5.5",
      runtimeId: "gpt-5.5",
      label: "GPT-5.5",
      description: "Previous-generation general-purpose model",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.4",
      runtimeId: "gpt-5.4",
      label: "GPT-5.4",
      description: "Capable general-purpose model",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.4-mini",
      runtimeId: "gpt-5.4-mini",
      label: "GPT-5.4 Mini",
      description: "A smaller, quicker general-purpose model",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
  ],
  opencode: [
    {
      id: "gpt-5.6-luna",
      runtimeId: "opencode-go/gpt-5.6-luna",
      label: "GPT-5.6 Luna",
      description: "OpenCode Go's fast GPT model",
      reasoningEfforts: OPENCODE_LUNA_EFFORTS,
      defaultReasoningEffort: "medium",
    },
    {
      id: "deepseek-v4-flash",
      runtimeId: "opencode-go/deepseek-v4-flash",
      label: "DeepSeek V4 Flash",
      description: "Fast DeepSeek reasoning for lighter turns",
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    },
    {
      id: "deepseek-v4-flash-vision-exp",
      runtimeId: "opencode-go/deepseek-v4-flash-vision-exp",
      label: "DeepSeek V4 Flash Vision Exp",
      description: "DeepSeek Flash with experimental vision support",
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    },
    {
      id: "deepseek-v4-pro",
      runtimeId: "opencode-go/deepseek-v4-pro",
      label: "DeepSeek V4 Pro",
      description: "DeepSeek's most capable reasoning model",
      reasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "max",
    },
    {
      id: "glm-5.1",
      runtimeId: "opencode-go/glm-5.1",
      label: "GLM-5.1",
      description: "Zhipu's GLM model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "glm-5.2",
      runtimeId: "opencode-go/glm-5.2",
      label: "GLM-5.2",
      description: "Zhipu's GLM reasoning model",
      reasoningEfforts: ["high", "max"],
      defaultReasoningEffort: "high",
    },
    {
      id: "glm-5.3",
      runtimeId: "opencode-go/glm-5.3",
      label: "GLM-5.3",
      description: "Zhipu's latest general-purpose GLM model",
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    },
    {
      id: "glm-5.3-flash",
      runtimeId: "opencode-go/glm-5.3-flash",
      label: "GLM-5.3 Flash",
      description: "A faster GLM model with flexible reasoning",
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
    },
    {
      id: "grok-4.6",
      runtimeId: "opencode-go/grok-4.6",
      label: "Grok 4.6",
      description: "Strong general-purpose reasoning",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "hy3",
      runtimeId: "opencode-go/hy3",
      label: "Hy3",
      description: "A Hy model with selectable reasoning depth",
      reasoningEfforts: ["none", "low", "high"],
      defaultReasoningEffort: "low",
    },
    {
      id: "hy4-preview",
      runtimeId: "opencode-go/hy4-preview",
      label: "Hy4 Preview",
      description: "Preview Hy model for deeper analysis",
      reasoningEfforts: ["none", "high"],
      defaultReasoningEffort: "high",
    },
    {
      id: "kimi-k2.6",
      runtimeId: "opencode-go/kimi-k2.6",
      label: "Kimi K2.6",
      description: "Moonshot's Kimi model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "kimi-k2.7-code",
      runtimeId: "opencode-go/kimi-k2.7-code",
      label: "Kimi K2.7 Code",
      description: "Kimi's code-focused model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "kimi-k3",
      runtimeId: "opencode-go/kimi-k3",
      label: "Kimi K3",
      description: "Kimi's maximum reasoning model",
      reasoningEfforts: ["max"],
      defaultReasoningEffort: "max",
    },
    {
      id: "longcat-2.0",
      runtimeId: "opencode-go/longcat-2.0",
      label: "LongCat 2.0",
      description: "Flexible reasoning for everyday analysis",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "mimo-v2.5",
      runtimeId: "opencode-go/mimo-v2.5",
      label: "MiMo V2.5",
      description: "Xiaomi's MiMo model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "mimo-v2.5-pro",
      runtimeId: "opencode-go/mimo-v2.5-pro",
      label: "MiMo V2.5 Pro",
      description: "Xiaomi's higher-capacity MiMo model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "minimax-m2.7",
      runtimeId: "opencode-go/minimax-m2.7",
      label: "MiniMax M2.7",
      description: "MiniMax's general-purpose model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "minimax-m3",
      runtimeId: "opencode-go/minimax-m3",
      label: "MiniMax M3",
      description: "MiniMax model with standard and thinking variants",
      reasoningEfforts: ["none", "thinking"],
      defaultReasoningEffort: "none",
    },
    {
      id: "muse-spark-1.2-contributor",
      runtimeId: "opencode-go/muse-spark-1.2-contributor",
      label: "Muse Spark 1.2 Contributor",
      description: "Muse Spark with a broad range of variants",
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "muse-spark-1.3-contributor",
      runtimeId: "opencode-go/muse-spark-1.3-contributor",
      label: "Muse Spark 1.3 Contributor",
      description: "A broad range of lighter-to-deeper variants",
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "omen-alpha",
      runtimeId: "opencode-go/omen-alpha",
      label: "Omen Alpha",
      description: "A focused model for concise analysis",
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "low",
    },
    {
      id: "qwen3.6-plus",
      runtimeId: "opencode-go/qwen3.6-plus",
      label: "Qwen3.6 Plus",
      description: "Qwen's general-purpose Plus model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "qwen3.7-max",
      runtimeId: "opencode-go/qwen3.7-max",
      label: "Qwen3.7 Max",
      description: "Qwen's high-capacity Max model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "qwen3.7-plus",
      runtimeId: "opencode-go/qwen3.7-plus",
      label: "Qwen3.7 Plus",
      description: "Qwen's general-purpose Plus model",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "qwen3.8-flash",
      runtimeId: "opencode-go/qwen3.8-flash",
      label: "Qwen 3.8 Flash",
      description: "Quick responses with selectable depth",
      reasoningEfforts: ["low", "medium", "xhigh"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "qwen3.8-max",
      runtimeId: "opencode-go/qwen3.8-max",
      label: "Qwen 3.8 Max",
      description: "High-capacity Qwen reasoning",
      reasoningEfforts: ["low", "medium", "xhigh"],
      defaultReasoningEffort: "high",
    },
  ],
  claude: [
    {
      id: "claude-haiku",
      // Claude Code resolves its documented model aliases to the current
      // model of that family (haiku → latest Haiku on this machine).
      runtimeId: "haiku",
      label: "Claude Haiku",
      description: "Fast and economical for everyday questions",
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "claude-sonnet",
      runtimeId: "sonnet",
      label: "Claude Sonnet",
      description: "The balanced model for regular analysis",
      reasoningEfforts: CLAUDE_EFFORTS,
      defaultReasoningEffort: "high",
    },
    {
      id: "claude-opus",
      runtimeId: "opus",
      label: "Claude Opus",
      description: "The deepest Claude reasoning",
      reasoningEfforts: CLAUDE_EFFORTS,
      defaultReasoningEffort: "high",
    },
  ],
};

export type ChatModeSelection = {
  model: string;
  /**
   * Provider-reported effort id, a bounded string rather than a closed enum:
   * discovered catalogs may expose variants this build has never heard of.
   * Null means the provider's own default (no explicit argument).
   */
  reasoningEffort: string | null;
};

export type AiChatModeSettings = {
  [backend in AiBackendId]: {
    [mode in ChatModeId]: ChatModeSelection;
  };
};

/** Defaults are intentionally explicit: they are also the product's first-run experience. */
export const DEFAULT_AI_CHAT_MODE_SETTINGS = {
  codex: {
    quick: { model: "gpt-6-luna", reasoningEffort: "low" },
    balanced: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
    deep: { model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
  },
  opencode: {
    quick: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    balanced: { model: "deepseek-v4-flash", reasoningEffort: "high" },
    deep: { model: "deepseek-v4-pro", reasoningEffort: "max" },
  },
  claude: {
    quick: { model: "claude-haiku", reasoningEffort: null },
    balanced: { model: "claude-sonnet", reasoningEffort: "medium" },
    deep: { model: "claude-opus", reasoningEffort: "xhigh" },
  },
} as const satisfies AiChatModeSettings;

/** Returns the provider's model metadata for a persisted/public model id. */
export function getProviderModel(backend: AiBackendId, model: string): ProviderModelOption | null {
  return AI_MODEL_OPTIONS[backend].find((option) => option.id === model) ?? null;
}

/** Maps a public model id to the exact id expected by the provider's CLI. */
export function getRuntimeModel(backend: AiBackendId, model: string): string {
  return getProviderModel(backend, model)?.runtimeId ?? model;
}

/** Clones defaults so callers can safely update their local state. */
export function getDefaultAiChatModeSettings(): AiChatModeSettings {
  return {
    codex: {
      quick: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.codex.quick },
      balanced: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.codex.balanced },
      deep: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.codex.deep },
    },
    opencode: {
      quick: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.opencode.quick },
      balanced: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.opencode.balanced },
      deep: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.opencode.deep },
    },
    claude: {
      quick: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.claude.quick },
      balanced: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.claude.balanced },
      deep: { ...DEFAULT_AI_CHAT_MODE_SETTINGS.claude.deep },
    },
  };
}
