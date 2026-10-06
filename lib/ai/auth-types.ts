/**
 * AI provider authentication contract (provider-auth stage). Browser-safe —
 * no Node imports.
 *
 * The Settings UI and the /api/ai/auth routes share these types so the
 * response shape is never duplicated on the client. The contract separates
 * four concerns that used to be one boolean:
 *
 * - installation/compatibility (can the provider's CLI be driven?),
 * - account method (which credential the provider reports),
 * - credential availability (an OpenCode Go key is structurally present),
 * - operation state (a browser sign-in or sign-out in flight).
 *
 * Connecting an account and selecting the provider for AI work stay
 * separate actions; a saved OpenCode key says "access is checked on use",
 * not "subscription verified".
 */
import type { AiBackendId } from "./backend-id";

/** Providers scope can sign into. */
export type AuthProviderId = AiBackendId;

/** Provider credential shapes the status layer can name. */
export type AuthAccountMethod =
  "chatgpt" | "subscription" | "api_key" | "bedrock" | "other" | "none" | "unknown";

/** Terminal and in-flight phases of a sign-in attempt. */
export type AuthAttemptPhase =
  | "starting"
  | "waiting_for_browser"
  | "verifying"
  | "succeeded"
  | "cancelled"
  | "timed_out"
  | "failed";

/** Phases an attempt never comes back from. */
export const AUTH_ATTEMPT_TERMINAL_PHASES: readonly AuthAttemptPhase[] = [
  "succeeded",
  "cancelled",
  "timed_out",
  "failed",
];

export function isTerminalAuthPhase(phase: AuthAttemptPhase): boolean {
  return AUTH_ATTEMPT_TERMINAL_PHASES.includes(phase);
}

/** Client-safe error: a stable code plus a message that never holds secrets. */
export interface AuthErrorInfo {
  code: string;
  message: string;
}

/** Snapshot of one provider sign-in attempt (never holds a code or token). */
export interface AuthAttemptSnapshot {
  /** Opaque id; cancels and code submissions must echo it. */
  id: string;
  phase: AuthAttemptPhase;
  startedAt: string;
  /** When the attempt gives up; null for operations without a deadline. */
  expiresAt: string | null;
  /** Validated provider authorization URL while the attempt is active. */
  authorizationUrl: string | null;
  /** Device-code verification URL when that flow is in use. */
  verificationUrl: string | null;
  /** Device-code one-time code when that flow is in use. */
  userCode: string | null;
  /** Present once the attempt reaches a terminal failure phase. */
  error: AuthErrorInfo | null;
}

/** Where the executable scope will run came from. */
export type ProviderCommandSource = "override" | "auto";

/** Everything Settings needs to render one provider card. */
export interface ProviderAuthSnapshot {
  /** False when the provider's CLI cannot be run at all. */
  installed: boolean;
  /** False when the CLI is installed but too old / lacks a required protocol. */
  compatible: boolean;
  /** True when the credential method scope expects for this provider exists. */
  authenticated: boolean;
  /** True when the credential is subscription-backed (never guessed). */
  subscription: boolean;
  method: AuthAccountMethod;
  /** Human-readable status line; null when there is no detail worth showing. */
  detail: string | null;
  /** OpenCode Go only: a structurally valid Go key is saved. */
  keySaved: boolean;
  /** OpenCode Go only: unrelated credentials that a save/remove preserves. */
  otherCredentialCount: number;
  /** Codex only: the app-server offered the device-code login variant. */
  deviceCodeAvailable: boolean;
  /** Non-null until a start/cancel/sign-out clears or replaces it. */
  attempt: AuthAttemptSnapshot | null;
  /** True while a sign-out for this provider is settling. */
  signingOut: boolean;
  /** Status could not be established; the card shows retry, not signed out. */
  statusError: AuthErrorInfo | null;
  /**
   * The executable scope resolves for this provider: a configured override or
   * the automatic discovery result (a bare command still resolved via PATH).
   */
  resolvedCommand: string | null;
  /** Where resolvedCommand came from; null when nothing is resolvable. */
  commandSource: ProviderCommandSource | null;
}

/** One status snapshot for the whole Settings AI section. */
export interface AiAuthSnapshot {
  /** Identifies the manager lifetime; revisions restart with a new instance. */
  instanceId: string;
  /** Monotonic revision; the client uses it to drop stale responses. */
  revision: number;
  checkedAt: string;
  backend: AiBackendId;
  codex: ProviderAuthSnapshot;
  opencode: ProviderAuthSnapshot;
  claude: ProviderAuthSnapshot;
}

/** Result of starting/cancelling a login, saving a key, or signing out. */
export interface AuthOperationResult {
  ok: boolean;
  /** Present on failures: a stable code plus client-safe message. */
  error?: AuthErrorInfo;
  /** Present on success: fresh snapshot so no transition is lost to polling. */
  snapshot?: AiAuthSnapshot;
}

// ---------------------------------------------------------------------------
// Operation results
// ---------------------------------------------------------------------------

/** Provider id guard shared by the routes. */
export function isAuthProviderId(value: unknown): value is AuthProviderId {
  return value === "codex" || value === "opencode" || value === "claude";
}
