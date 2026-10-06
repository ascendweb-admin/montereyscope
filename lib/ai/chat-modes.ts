/**
 * Chat intelligence modes — the one place that defines the shared mode
 * metadata and working directives for Ask-AI (stage 8). Provider-specific
 * model and reasoning choices live in model-catalog.ts so Codex and OpenCode
 * can be configured independently.
 *
 * This module is pure data — no Node imports — so the client panel can keep
 * its own mirror of the user-facing fields (ids, labels, taglines, working
 * labels) without importing the server-only AI layer; a unit test pins the
 * two sides together.
 */

/** The chat modes offered by the Ask-AI panel, in display order. */
export type ChatModeId = "quick" | "balanced" | "deep";

/** The chat mode ids in the same order the UI presents them. */
export const CHAT_MODE_IDS: readonly ChatModeId[] = ["quick", "balanced", "deep"];

/** The mode new conversations start in (and old threads backfill as). */
export const DEFAULT_CHAT_MODE: ChatModeId = "deep";

/** One mode's shared configuration: user-facing text and working behavior. */
export interface ChatModeConfig {
  id: ChatModeId;
  /** Short label on the panel's mode switcher. */
  label: string;
  /** One-line description surfaced as the switcher tooltip. */
  tagline: string;
  /** Status line shown while the turn is still reasoning. */
  workingLabel: string;
  /** Hard ceiling for one turn in this mode; faster modes fail sooner. */
  timeoutMs: number;
  /**
   * The mode-specific working directive appended to the shared grounding
   * instruction: how the model should spend its effort in this mode.
   */
  directive: string;
}

/** Reasoning silence is bounded per mode; deep keeps the pre-mode 15 minutes. */
const MINUTE_MS = 60_000;

export const CHAT_MODES: readonly ChatModeConfig[] = [
  {
    id: "quick",
    label: "Quick",
    tagline: "Fast, conversational answers",
    workingLabel: "Thinking…",
    timeoutMs: 5 * MINUTE_MS,
    directive:
      "Stay conversational: answer like a knowledgeable colleague you can chat with — short, direct replies of a few sentences unless more is genuinely needed, no long lists or exhaustive write-ups unless asked. Still ground every claim in the transcripts and cite it as usual. If a question clearly calls for deeper analysis, answer what you can and suggest switching to the deep mode.",
  },
  {
    id: "balanced",
    label: "Balanced",
    tagline: "Grounded answers at everyday depth",
    workingLabel: "Reviewing the transcripts…",
    timeoutMs: 10 * MINUTE_MS,
    directive:
      "Work at everyday analyst depth: read enough of the transcripts to answer confidently, cover the main findings clearly and concisely, and skip exhaustive cross-referencing unless the user asks for it.",
  },
  {
    id: "deep",
    label: "Deep",
    tagline: "Thorough analysis that takes its time",
    workingLabel: "Reading the transcripts…",
    timeoutMs: 15 * MINUTE_MS,
    directive:
      "You are a senior analyst in deep-research mode: take the time to read every transcript in scope, cross-reference them, and deliver a complete, rigorous answer that surfaces every relevant finding, theme, and contradiction. Depth beats speed — do not stop at a first pass.",
  },
];

/** Type guard for untrusted mode values (request bodies, storage). */
export function isChatModeId(value: unknown): value is ChatModeId {
  return CHAT_MODE_IDS.some((mode) => mode === value);
}

/** Resolves a validated mode id to its full configuration. */
export function getChatMode(id: ChatModeId): ChatModeConfig {
  const mode = CHAT_MODES.find((mode) => mode.id === id);
  if (!mode) {
    throw new RangeError(`Unknown chat mode: ${String(id)}`);
  }
  return mode;
}
