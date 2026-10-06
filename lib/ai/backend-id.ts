/**
 * AI backend identity (stage 9; Claude stage 10). Pure data — no Node imports.
 *
 * scope drives three local AI CLIs and each one authenticates from its own
 * native login: the codex CLI uses the machine's ChatGPT subscription
 * (`codex login` → ~/.codex/auth.json), the opencode CLI uses OpenCode's own
 * credentials (`opencode auth login` → ~/.local/share/opencode/auth.json),
 * and the claude CLI uses the machine's Claude subscription (`claude auth
 * login` → ~/.claude/.credentials.json). This module only names the choice;
 * anything that spawns processes lives in backend.ts and the adapters.
 */

/** The AI backends scope can run every AI feature on. */
export type AiBackendId = "codex" | "opencode" | "claude";

/** Backend used until the user picks one in Settings. */
export const DEFAULT_AI_BACKEND: AiBackendId = "codex";

/** Every backend id, in the display order Settings offers them. */
export const AI_BACKEND_IDS: readonly AiBackendId[] = ["codex", "opencode", "claude"];

/** Coerces an untrusted value; anything unexpected reads as the default. */
export function toAiBackendId(value: unknown): AiBackendId {
  return isAiBackendId(value) ? value : DEFAULT_AI_BACKEND;
}

export function isAiBackendId(value: unknown): value is AiBackendId {
  return value === "codex" || value === "opencode" || value === "claude";
}
