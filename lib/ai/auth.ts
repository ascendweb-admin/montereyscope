/**
 * AI CLI authentication facade (stage 9; provider-auth stage). Server-only.
 *
 * The public surface every route and page uses. Implementation lives under
 * lib/ai/auth/: a process-wide manager (attempts, locks, deadlines), a
 * Codex app-server JSON-RPC client, a hardened Claude login session, and the
 * OpenCode credential store. All three backends own their own machine-local
 * logins, so this module never authenticates on their behalf — it reports
 * what each CLI can see and drives their native login commands:
 *
 * - codex authenticates from the ChatGPT subscription through the official
 *   app-server account protocol (`codex login`/`account/*`), with the legacy
 *   `codex login` flow as a fallback for older CLIs,
 * - claude authenticates from the Claude subscription (`claude auth login
 *   --claudeai`); the tracked process accepts the browser's sign-in code on
 *   stdin so the flow can finish without a terminal,
 * - opencode authenticates from its own credential store; the one flow scope
 *   writes itself is pasting an OpenCode Go API key.
 *
 * Tokens and keys never appear in anything this module returns, and every
 * mutation returns a fresh snapshot so the UI never loses a transition.
 */
import type { AiBackendId } from "./backend-id";
import { DEFAULT_AI_BACKEND } from "./backend-id";
import type { AiAuthSnapshot, AuthOperationResult, AuthProviderId } from "./auth-types";
import { getAuthManager } from "./auth/manager";
import type { ProviderAuthSnapshot } from "./auth-types";

// Status and login lifecycle.
export {
  CLAUDE_LOGIN_TIMEOUT_MS,
  EMPTY_CLAUDE_STATUS,
  extractClaudeLoginUrl,
  getClaudeAuthStatus,
  isClaudeSubscriptionMethod,
  isSupportedClaudeVersion,
  parseClaudeVersion,
  type ClaudeAuthStatus,
} from "./auth/claude-login";
export { CODEX_LOGIN_TIMEOUT_MS } from "./auth/manager";
export { validateCodexAuthorizationUrl, type CodexAccountState } from "./auth/codex-account-client";
export {
  OpenCodeKeyInvalidError,
  OpenCodeStoreError,
  openCodeAuthPath,
  type OpenCodeGoCredentialState,
} from "./auth/opencode-credentials";

/** Snapshot of a tracked sign-in attempt, shaped for the client. */
export interface LoginState {
  inProgress: boolean;
  attemptId: string | null;
  startedAt: string | null;
  lastUrl: string | null;
  lastError: string | null;
  lastExitCode: number | null;
}

/** Backwards-compatible alias for the Claude attempt state. */
export type ClaudeLoginState = LoginState;

/** Combined status snapshot used by Settings and its route. */
export async function getAiAuthStatus(
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AiAuthSnapshot> {
  return getAuthManager().getSnapshot(backend);
}

/** Status probe for a single provider. */
export async function getProviderAuthStatus(
  provider: AuthProviderId,
): Promise<ProviderAuthSnapshot> {
  return getAuthManager().getProviderSnapshot(provider);
}

/** Starts the Codex browser (or device-code) sign-in. */
export async function startCodexLogin(
  mode: "browser" | "device" = "browser",
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().startCodexLogin(mode, backend);
}

/** Cancels the matching Codex attempt (or the active one). */
export async function cancelCodexLogin(
  attemptId?: string,
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().cancelCodexLogin(attemptId, backend);
}

/** Starts `claude auth login --claudeai` as a tracked attempt. */
export async function startClaudeLogin(
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().startClaudeLogin(backend);
}

/** Cancels the matching Claude attempt (or the active one). */
export async function cancelClaudeLogin(
  attemptId?: string,
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().cancelClaudeLogin(attemptId, backend);
}

/** Hands the browser's sign-in code to the matching Claude attempt. */
export async function submitClaudeLoginCode(
  code: string,
  attemptId?: string,
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().submitClaudeLoginCode(attemptId, code, backend);
}

/** Saves (or replaces) the OpenCode Go API key. */
export async function saveOpenCodeApiKey(
  rawKey: string,
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().saveOpenCodeKey(rawKey, backend);
}

/** Removes only the OpenCode Go key. */
export async function removeOpenCodeApiKey(
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().logoutProvider("opencode", backend);
}

/** Explicit sign-out: codex account, claude account, or the Go key. */
export async function logoutProvider(
  provider: AuthProviderId,
  backend: AiBackendId = DEFAULT_AI_BACKEND,
): Promise<AuthOperationResult> {
  return getAuthManager().logoutProvider(provider, backend);
}

/** Tracked Claude sign-in state; kept for tests and diagnostics. */
export function getClaudeLoginState(): LoginState {
  return getAuthManager().claude.describe();
}

/** Tracked Codex sign-in state; kept for tests and diagnostics. */
export function getCodexLoginState(): LoginState {
  return getAuthManager().codex.describe();
}
