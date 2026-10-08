/**
 * AI provider auth manager (provider-auth stage). Server-only.
 *
 * One process-wide manager owns every provider sign-in attempt, sign-out,
 * and status probe. It lives on `globalThis` so route bundles and `next dev`
 * module reloads all talk to the same instance instead of spawning competing
 * login children.
 *
 * Lifecycle rules enforced here:
 * - a provider lock is acquired synchronously before any await, so two
 *   simultaneous starts cannot both win,
 * - every event is bound to the attempt id that created it; late output from
 *   an old child can never change a newer attempt,
 * - attempts have a finite deadline, bounded output, SIGTERM→SIGKILL
 *   escalation, and clear URL/code/timer/child references on terminal states,
 * - a restarted server reports a prior in-flight attempt as interrupted
 *   because state is in memory only.
 *
 * Sign-out semantics: a pending login is stopped and settled first, the
 * provider is flagged as signing out so no new AI run can start, and an
 * active run makes the logout fail with a wait/stop message.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import { isAiProviderBusy, setProviderSigningOut } from "../active-runs";
import type { AiBackendId } from "../backend-id";
import { hasProviderPathOverride } from "../provider-paths";
import { resolveClaudeLaunch } from "../claude";
import { resolveCodexLaunch } from "../codex";
import { resolveOpencodeLaunch } from "../opencode";
import type {
  AiAuthSnapshot,
  AuthAttemptPhase,
  AuthAttemptSnapshot,
  AuthErrorInfo,
  AuthOperationResult,
  AuthProviderId,
  ProviderAuthSnapshot,
  ProviderCommandSource,
} from "../auth-types";
import { isTerminalAuthPhase } from "../auth-types";
import {
  CLAUDE_LOGIN_TIMEOUT_MS,
  ClaudeLoginSession,
  claudeLoginFailureMessage,
  getClaudeAuthStatus,
  logoutClaude,
  type ClaudeAuthStatus,
  type ClaudeLoginCallbacks,
} from "./claude-login";
import {
  CodexAccountClient,
  isMissingCodexBinaryError,
  isUnsupportedCodexAccountError,
  parseLoginCompleted,
  sanitizeProviderError,
} from "./codex-account-client";
import { execFileStatus, sanitizeProcessText } from "./exec";
import {
  getOpenCodeGoCredentialState,
  removeOpenCodeGoKey,
  saveOpenCodeGoKey,
  validateOpenCodeKey,
} from "./opencode-credentials";

/** How long a started Codex sign-in may wait before it is cancelled. */
export const CODEX_LOGIN_TIMEOUT_MS = 10 * 60_000;

/** How long a status probe result stays fresh enough to reuse. */
const STATUS_CACHE_MS = 2_000;

/** During an active attempt, reuse status even longer to avoid CLI churn. */
const STATUS_CACHE_DURING_ATTEMPT_MS = 30_000;

/** How long a SIGTERM'd legacy codex login gets before SIGKILL. */
const LEGACY_KILL_GRACE_MS = 5_000;

/** Bounded output window kept for legacy login URL/error parsing. */
const OUTPUT_WINDOW_CHARS = 8_000;

// ---------------------------------------------------------------------------
// Shared attempt bookkeeping
// ---------------------------------------------------------------------------

/** Shared attempt bookkeeping. */
interface InternalAttempt {
  id: string;
  phase: AuthAttemptPhase;
  startedAt: string;
  expiresAt: string | null;
  authorizationUrl: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  error: AuthErrorInfo | null;
  cancelRequested: boolean;
  timedOut: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Codex app-server login id for cancelling the matching attempt. */
  loginId: string | null;
  /** Exit status of the provider process, when it reached one. */
  exitCode: number | null;
}

function newAttempt(expiresAt: string | null): InternalAttempt {
  return {
    id: randomUUID(),
    phase: "starting",
    startedAt: new Date().toISOString(),
    expiresAt,
    authorizationUrl: null,
    verificationUrl: null,
    userCode: null,
    error: null,
    cancelRequested: false,
    timedOut: false,
    timer: null,
    loginId: null,
    exitCode: null,
  };
}

/** Client-safe description of a tracked attempt (no codes or tokens). */
export interface AttemptDescription {
  inProgress: boolean;
  attemptId: string | null;
  startedAt: string | null;
  lastUrl: string | null;
  lastError: string | null;
  lastExitCode: number | null;
}

function describeAttempt(attempt: InternalAttempt | null): AttemptDescription {
  return {
    inProgress: isActiveAttempt(attempt),
    attemptId: attempt?.id ?? null,
    startedAt: attempt?.startedAt ?? null,
    lastUrl: attempt?.authorizationUrl ?? null,
    lastError: attempt?.error?.message ?? null,
    lastExitCode: attempt?.exitCode ?? null,
  };
}

function isActiveAttempt(attempt: InternalAttempt | null): attempt is InternalAttempt {
  return attempt !== null && !isTerminalAuthPhase(attempt.phase);
}

function publicAttempt(attempt: InternalAttempt | null): AuthAttemptSnapshot | null {
  if (attempt === null) {
    return null;
  }
  return {
    id: attempt.id,
    phase: attempt.phase,
    startedAt: attempt.startedAt,
    expiresAt: attempt.expiresAt,
    authorizationUrl: attempt.authorizationUrl,
    verificationUrl: attempt.verificationUrl,
    userCode: attempt.userCode,
    error: attempt.error,
  };
}

function clearAttemptTimer(attempt: InternalAttempt): void {
  if (attempt.timer !== null) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
}

function providerError(code: string, message: string): AuthErrorInfo {
  return { code, message };
}

function inProgressError(provider: string): AuthErrorInfo {
  return providerError("in_progress", `A ${provider} sign-in is already running.`);
}

function staleAttemptError(): AuthErrorInfo {
  return providerError(
    "stale_attempt",
    "That sign-in attempt has already finished. Start it again from the provider card.",
  );
}

function nothingToCancelError(provider: string): AuthErrorInfo {
  return providerError("nothing_to_cancel", `No ${provider} sign-in is running.`);
}

/** Shared child environment: ambient API keys must not change the account. */
function codexChildEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

/** Serializes an untrusted provider/process message for a client error. */
function safeMessage(text: string | null, fallback: string): string {
  const sanitized = text === null ? "" : sanitizeProcessText(text);
  return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Classifies how a provider executable was chosen: an environment override
 * or a persisted Settings override is "override"; anything discovered
 * automatically (mise, PATH) is "auto".
 */
function commandSourceFor(provider: AiBackendId, envKey: string): ProviderCommandSource {
  return process.env[envKey]?.trim() || hasProviderPathOverride(provider) ? "override" : "auto";
}

// ---------------------------------------------------------------------------
// Codex controller
// ---------------------------------------------------------------------------

interface CodexBaseStatus {
  /** Server-only account identity; omitted from browser snapshots. */
  accountKey?: string;
  installed: boolean;
  compatible: boolean;
  authenticated: boolean;
  subscription: boolean;
  method: ProviderAuthSnapshot["method"];
  detail: string | null;
  statusError: AuthErrorInfo | null;
}

const EMPTY_CODEX_BASE: CodexBaseStatus = {
  installed: false,
  compatible: false,
  authenticated: false,
  subscription: false,
  method: "unknown",
  detail: null,
  statusError: null,
};

interface CodexLegacyAttempt {
  child: ChildProcess;
  output: string;
  killTimer: ReturnType<typeof setTimeout> | null;
}

/** Lazily-installed factory seam: tests replace the app-server connection. */
export type CodexConnect = () => Promise<CodexAccountClient>;

class CodexLogoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexLogoutError";
  }
}

class CodexAuthController {
  private attempt: InternalAttempt | null = null;
  private client: CodexAccountClient | null = null;
  private legacy: CodexLegacyAttempt | null = null;
  private attemptCleanup: (() => void) | null = null;
  private signingOut = false;
  private deviceCodeAvailable = true;
  private base: CodexBaseStatus | null = null;
  private baseAt = 0;
  private probe: Promise<CodexBaseStatus> | null = null;
  private readonly connect: CodexConnect;
  private bump: () => void = () => {};
  /** Notifies the catalog that credentials may have changed. */
  private changed: () => void = () => {};

  constructor(connect: CodexConnect) {
    this.connect = connect;
  }

  setRevisionBumper(bump: () => void): void {
    this.bump = bump;
  }

  setChangeNotifier(notify: () => void): void {
    this.changed = notify;
  }

  private async probeBase(force = false): Promise<CodexBaseStatus> {
    const maxAge = isActiveAttempt(this.attempt) ? STATUS_CACHE_DURING_ATTEMPT_MS : STATUS_CACHE_MS;
    if (!force && this.base !== null && Date.now() - this.baseAt < maxAge) {
      return this.base;
    }
    if (this.probe === null) {
      const previous = this.base;
      this.probe = this.runProbe()
        .then((value) => {
          this.base = value;
          this.baseAt = Date.now();
          // An account change made outside scope (a manual `codex login`)
          // must invalidate the catalog belonging to the previous account.
          if (
            previous !== null &&
            !previous.statusError &&
            !value.statusError &&
            (previous.authenticated !== value.authenticated ||
              previous.method !== value.method ||
              previous.accountKey !== value.accountKey)
          ) {
            this.changed();
          }
          return value;
        })
        .finally(() => {
          this.probe = null;
        });
    }
    return this.probe;
  }

  private async runProbe(): Promise<CodexBaseStatus> {
    const launch = resolveCodexLaunch();
    if (launch.kind === "unresolved") {
      // A Windows command wrapper that cannot be resolved is a discovery
      // failure, not a missing provider: report it distinctly so the user
      // knows to point Scope at the real executable.
      return {
        ...EMPTY_CODEX_BASE,
        statusError: providerError(
          "discovery_failed",
          launch.detail ?? "The codex executable could not be resolved.",
        ),
      };
    }
    let client: CodexAccountClient;
    try {
      client = await this.connect();
    } catch (error) {
      if (isMissingCodexBinaryError(error)) {
        return { ...EMPTY_CODEX_BASE };
      }
      if (isUnsupportedCodexAccountError(error)) {
        return this.probeLegacy();
      }
      return {
        ...EMPTY_CODEX_BASE,
        installed: true,
        compatible: true,
        statusError: providerError(
          "status_failed",
          "The codex CLI did not answer. Check that it runs on this machine, then try again.",
        ),
      };
    }
    try {
      const state = await client.readAccount();
      return mapCodexAccountState(state);
    } catch (error) {
      if (isUnsupportedCodexAccountError(error)) {
        return this.probeLegacy();
      }
      return {
        ...EMPTY_CODEX_BASE,
        installed: true,
        compatible: true,
        statusError: providerError(
          "status_failed",
          "The codex CLI did not report an account. Try again in a moment.",
        ),
      };
    } finally {
      await client.close();
    }
  }

  /** Legacy `codex login status` fallback for CLIs without the account API. */
  private async probeLegacy(): Promise<CodexBaseStatus> {
    const launch = resolveCodexLaunch();
    const result = await execFileStatus(
      launch.command,
      [...launch.argsPrefix, "login", "status"],
      10_000,
      codexChildEnvironment(),
    );
    if (!result.ran) {
      return { ...EMPTY_CODEX_BASE };
    }
    const output = `${result.stdout}\n${result.stderr}`;
    const detailLine = output
      .split("\n")
      .map((line) => sanitizeProcessText(line))
      .find((line) => line.length > 0);
    const authenticated = result.exitCode === 0 && /logged in/i.test(output);
    const apiKey = /api key/i.test(output);
    const chatgpt = /chatgpt/i.test(output);
    const method: ProviderAuthSnapshot["method"] = !authenticated
      ? "none"
      : chatgpt
        ? "chatgpt"
        : apiKey
          ? "api_key"
          : "other";
    return {
      installed: true,
      compatible: true,
      authenticated,
      subscription: method === "chatgpt",
      method,
      detail: detailLine ?? null,
      statusError: null,
    };
  }

  async catalogConnection() {
    const base = await this.probeBase(true);
    if (base.statusError) throw new Error("Could not check Codex connection.");
    return {
      connected: base.authenticated && base.subscription,
      identity: base.accountKey ?? base.method,
    };
  }

  async snapshot(): Promise<ProviderAuthSnapshot> {
    const base = await this.probeBase();
    const publicBase = { ...base };
    delete publicBase.accountKey;
    return {
      ...publicBase,
      keySaved: false,
      otherCredentialCount: 0,
      deviceCodeAvailable: this.deviceCodeAvailable,
      attempt: publicAttempt(this.attempt),
      signingOut: this.signingOut,
      resolvedCommand: resolveCodexLaunch().resolvedCommand,
      commandSource: commandSourceFor("codex", "SCOPE_CODEX_PATH"),
    };
  }

  /** Client-safe description of the tracked attempt. */
  describe(): AttemptDescription {
    return describeAttempt(this.attempt);
  }

  /** True while the tracked attempt is active and not yet a device flow. */
  canReplaceWithDevice(): boolean {
    return isActiveAttempt(this.attempt) && this.attempt.verificationUrl === null;
  }

  async start(mode: "browser" | "device"): Promise<AuthOperationResult> {
    if (this.signingOut) {
      return { ok: false, error: providerError("signing_out", "Codex is signing out.") };
    }
    if (isActiveAttempt(this.attempt)) {
      return { ok: false, error: inProgressError("Codex") };
    }
    const attempt = newAttempt(new Date(Date.now() + CODEX_LOGIN_TIMEOUT_MS).toISOString());
    this.attempt = attempt;
    this.bump();

    let client: CodexAccountClient;
    try {
      client = await this.connect();
    } catch (error) {
      if (attempt.cancelRequested) {
        return { ok: true };
      }
      if (isUnsupportedCodexAccountError(error)) {
        return this.startLegacy(attempt);
      }
      return this.failAttempt(
        attempt,
        isMissingCodexBinaryError(error)
          ? providerError("not_installed", "The codex CLI is not available on this machine.")
          : providerError("start_failed", "The codex CLI could not be started. Try again."),
      );
    }
    if (attempt.cancelRequested || !isActiveAttempt(attempt)) {
      await client.close().catch(() => {});
      return { ok: true };
    }
    this.client = client;

    // Listeners are registered before any operation can finish.
    const unsubscribe = client.onNotification((method, params) => {
      if (method !== "account/login/completed") {
        return;
      }
      const completed = parseLoginCompleted(params);
      if (completed === null) {
        return;
      }
      if (this.attempt !== attempt) {
        return;
      }
      if (
        completed.loginId !== null &&
        attempt.loginId !== null &&
        completed.loginId !== attempt.loginId
      ) {
        return;
      }
      void this.settleVerified(attempt, completed.success, completed.error);
    });
    this.attemptCleanup = unsubscribe;
    client.onExit(() => {
      if (this.attempt === attempt && !isTerminalAuthPhase(attempt.phase)) {
        void this.failAttempt(
          attempt,
          providerError(
            "transport_exited",
            "The codex sign-in process stopped before finishing. Start it again.",
          ),
        );
      }
    });

    try {
      if (mode === "device") {
        const login = await client.startDeviceCodeLogin();
        if (attempt.cancelRequested) {
          await client.cancelLogin(login.loginId).catch(() => {});
          return { ok: true };
        }
        attempt.loginId = login.loginId;
        attempt.verificationUrl = login.verificationUrl;
        attempt.userCode = login.userCode;
      } else {
        const login = await client.startBrowserLogin();
        if (attempt.cancelRequested) {
          await client.cancelLogin(login.loginId).catch(() => {});
          return { ok: true };
        }
        attempt.loginId = login.loginId;
        attempt.authorizationUrl = login.authorizationUrl;
      }
    } catch {
      if (mode === "device") {
        this.deviceCodeAvailable = false;
      }
      return this.failAttempt(
        attempt,
        providerError(
          "start_failed",
          mode === "device"
            ? "This codex CLI does not offer device-code sign-in. Update it or use the browser sign-in."
            : "codex could not start a browser sign-in. Try again.",
        ),
      );
    }

    if (attempt.cancelRequested) {
      return { ok: true };
    }
    attempt.phase = "waiting_for_browser";
    attempt.timer = setTimeout(() => {
      if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
        return;
      }
      attempt.timedOut = true;
      void this.cancelAttempt(attempt, "timed_out");
    }, CODEX_LOGIN_TIMEOUT_MS);
    attempt.timer.unref?.();
    this.bump();
    return { ok: true };
  }

  /** Legacy `codex login` child for CLIs without the app-server account API. */
  private startLegacy(attempt: InternalAttempt): AuthOperationResult {
    if (attempt.cancelRequested) {
      this.finishAttempt(attempt, "cancelled", null);
      this.bump();
      return { ok: true };
    }
    let child: ChildProcess;
    try {
      const launch = resolveCodexLaunch();
      child = spawn(launch.command, [...launch.argsPrefix, "login"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        env: codexChildEnvironment(),
      });
    } catch {
      return this.failAttempt(
        attempt,
        providerError("start_failed", "The codex CLI could not be started. Try again."),
      );
    }
    const legacy: CodexLegacyAttempt = { child, output: "", killTimer: null };
    this.legacy = legacy;
    const append = (text: string): void => {
      legacy.output = (legacy.output + text).slice(-OUTPUT_WINDOW_CHARS);
      const url = extractLegacyCodexUrl(legacy.output);
      if (url !== null && this.attempt === attempt && isActiveAttempt(attempt)) {
        attempt.authorizationUrl = url;
        this.bump();
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk.toString()));
    child.once("error", () => {
      if (this.attempt === attempt && !isTerminalAuthPhase(attempt.phase)) {
        void this.failAttempt(
          attempt,
          providerError("not_installed", "The codex CLI is not available on this machine."),
        );
      }
    });
    child.once("close", (code) => {
      if (this.legacy === legacy) {
        this.legacy = null;
      }
      attempt.exitCode = code;
      if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
        return;
      }
      if (attempt.cancelRequested || attempt.timedOut) {
        this.finishAttempt(attempt, attempt.timedOut ? "timed_out" : "cancelled", null);
        this.bump();
        return;
      }
      void this.verifyLegacyOutcome(attempt, code, legacy.output);
    });
    attempt.phase = "waiting_for_browser";
    attempt.timer = setTimeout(() => {
      if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
        return;
      }
      attempt.timedOut = true;
      void this.cancelAttempt(attempt, "timed_out");
    }, CODEX_LOGIN_TIMEOUT_MS);
    attempt.timer.unref?.();
    this.bump();
    return { ok: true };
  }

  private async verifyLegacyOutcome(
    attempt: InternalAttempt,
    code: number | null,
    output: string,
  ): Promise<void> {
    attempt.phase = "verifying";
    this.bump();
    if (code !== 0) {
      const tail = output
        .split("\n")
        .map((line) => sanitizeProcessText(line))
        .filter((line) => line.length > 0)
        .slice(-1)[0];
      this.finishAttempt(
        attempt,
        "failed",
        providerError(
          "login_failed",
          tail !== undefined
            ? `codex login did not complete: ${tail}`
            : "codex login did not complete.",
        ),
      );
      this.bump();
      return;
    }
    const base = await this.probeLegacy();
    this.base = base;
    this.baseAt = Date.now();
    this.finishAttempt(
      attempt,
      base.authenticated ? "succeeded" : "failed",
      base.authenticated
        ? null
        : providerError("login_failed", "codex finished without signing an account in."),
    );
    if (base.authenticated) {
      this.changed();
    }
    this.bump();
  }

  private async settleVerified(
    attempt: InternalAttempt,
    success: boolean,
    providerMessage: string | null,
  ): Promise<void> {
    if (
      this.attempt !== attempt ||
      isTerminalAuthPhase(attempt.phase) ||
      attempt.phase === "verifying"
    ) {
      return;
    }
    attempt.phase = "verifying";
    clearAttemptTimer(attempt);
    this.bump();
    const client = this.client;
    let authenticated = false;
    if (success && client !== null) {
      try {
        const state = await client.readAccount();
        authenticated = state.account !== null;
      } catch {
        authenticated = false;
      }
      if (!authenticated && this.attempt === attempt && !isTerminalAuthPhase(attempt.phase)) {
        // The login process can still have its pre-login account cached when
        // it announces completion. Verify persisted credentials in a fresh
        // process, bypassing status probes that may have started before login.
        const fresh = await this.runProbe();
        authenticated = fresh.authenticated;
      }
    }
    if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
      return;
    }
    if (authenticated) {
      this.base = null;
      this.finishAttempt(attempt, "succeeded", null);
      this.changed();
    } else {
      this.finishAttempt(
        attempt,
        "failed",
        providerError(
          "login_failed",
          sanitizeProviderError(providerMessage) ??
            "codex reported the sign-in as unsuccessful. Try again.",
        ),
      );
    }
    this.bump();
  }

  private failAttempt(attempt: InternalAttempt, error: AuthErrorInfo): AuthOperationResult {
    this.finishAttempt(attempt, "failed", error);
    this.bump();
    return { ok: false, error };
  }

  private finishAttempt(
    attempt: InternalAttempt,
    phase: AuthAttemptPhase,
    error: AuthErrorInfo | null,
  ): void {
    if (this.attempt !== attempt) {
      return;
    }
    clearAttemptTimer(attempt);
    attempt.phase = phase;
    attempt.error = error;
    // Sensitive/transient fields never survive a terminal state.
    attempt.authorizationUrl = null;
    attempt.verificationUrl = null;
    attempt.userCode = null;
    attempt.cancelRequested = phase === "cancelled" ? true : attempt.cancelRequested;
    this.attemptCleanup?.();
    this.attemptCleanup = null;
    void this.closeClient();
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client !== null) {
      await client.close().catch(() => {});
    }
  }

  async cancel(attemptId?: string): Promise<AuthOperationResult> {
    const attempt = this.attempt;
    if (attempt === null || isTerminalAuthPhase(attempt.phase)) {
      return { ok: false, error: nothingToCancelError("Codex") };
    }
    if (attemptId !== undefined && attempt.id !== attemptId) {
      return { ok: false, error: staleAttemptError() };
    }
    await this.cancelAttempt(attempt, "cancelled");
    return { ok: true };
  }

  private async cancelAttempt(
    attempt: InternalAttempt,
    phase: "cancelled" | "timed_out",
  ): Promise<void> {
    if (this.attempt !== attempt) {
      return;
    }
    attempt.cancelRequested = true;
    clearAttemptTimer(attempt);
    if (phase === "timed_out") {
      attempt.error = providerError(
        "timed_out",
        "The Codex sign-in timed out. Start it again when you are ready.",
      );
    }
    // Mark terminal before the async provider cancel so the later
    // account/login/completed notification cannot flip the phase.
    attempt.phase = phase;
    attempt.authorizationUrl = null;
    attempt.verificationUrl = null;
    attempt.userCode = null;
    this.attemptCleanup?.();
    this.attemptCleanup = null;
    this.bump();

    const legacy = this.legacy;
    if (legacy !== null) {
      this.legacy = null;
      try {
        legacy.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      legacy.killTimer = setTimeout(() => {
        try {
          legacy.child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, LEGACY_KILL_GRACE_MS);
      legacy.killTimer.unref?.();
      return;
    }
    const client = this.client;
    this.client = null;
    if (client !== null && attempt.loginId !== null) {
      await client.cancelLogin(attempt.loginId).catch(() => {});
    }
    await client?.close().catch(() => {});
  }

  async logout(): Promise<AuthOperationResult> {
    if (this.signingOut) {
      return { ok: false, error: providerError("signing_out", "Codex is already signing out.") };
    }
    if (isAiProviderBusy("codex")) {
      return {
        ok: false,
        error: providerError(
          "provider_busy",
          "Codex is answering a request right now. Wait for it to finish (or stop it), then sign out.",
        ),
      };
    }
    this.signingOut = true;
    setProviderSigningOut("codex", true);
    this.bump();
    try {
      if (isActiveAttempt(this.attempt)) {
        await this.cancelAttempt(this.attempt, "cancelled");
      }
      await this.logoutInternal();
      this.base = null;
      this.changed();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof CodexLogoutError
            ? providerError("logout_failed", error.message)
            : providerError("logout_failed", "Codex could not be signed out. Try again."),
      };
    } finally {
      this.signingOut = false;
      setProviderSigningOut("codex", false);
      this.bump();
    }
  }

  private async logoutInternal(): Promise<void> {
    let client: CodexAccountClient;
    try {
      client = await this.connect();
    } catch (error) {
      if (isUnsupportedCodexAccountError(error)) {
        await this.legacyLogout();
        return;
      }
      throw new CodexLogoutError("The codex CLI could not be reached to sign out.");
    }
    try {
      await client.logout();
      const state = await client.readAccount();
      if (state.account !== null) {
        throw new CodexLogoutError(
          "codex still reports a signed-in account after signing out. Update the CLI and try again.",
        );
      }
    } catch (error) {
      if (error instanceof CodexLogoutError) {
        throw error;
      }
      if (isUnsupportedCodexAccountError(error)) {
        await this.legacyLogout();
        return;
      }
      throw new CodexLogoutError("codex could not complete the sign-out.");
    } finally {
      await client.close().catch(() => {});
    }
  }

  private async legacyLogout(): Promise<void> {
    const launch = resolveCodexLaunch();
    const result = await execFileStatus(
      launch.command,
      [...launch.argsPrefix, "logout"],
      20_000,
      codexChildEnvironment(),
    );
    if (!result.ran || result.exitCode !== 0) {
      throw new CodexLogoutError("The codex CLI could not sign out.");
    }
  }

  /** Drops cached status so the next probe uses a newly configured executable. */
  invalidateResolution(): void {
    this.base = null;
    this.baseAt = 0;
  }

  dispose(): void {
    const attempt = this.attempt;
    if (attempt !== null) {
      clearAttemptTimer(attempt);
    }
    if (this.legacy !== null) {
      try {
        this.legacy.child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      this.legacy = null;
    }
    void this.client?.close().catch(() => {});
    this.client = null;
  }
}

/** Maps the account protocol's account payload onto the provider snapshot. */
function mapCodexAccountState(state: {
  account:
    | { type: "chatgpt"; email: string | null; planType: string | null }
    | { type: "apiKey" }
    | { type: "amazonBedrock" }
    | { type: "unknown" }
    | null;
}): CodexBaseStatus {
  const account = state.account;
  if (account === null) {
    return { ...EMPTY_CODEX_BASE, installed: true, compatible: true, method: "none" };
  }
  if (account.type === "chatgpt") {
    // The signed-in email stays on this machine; the status line shows the
    // plan only so screenshots and shared windows never leak the address.
    const detail = account.planType ? `${account.planType} plan` : null;
    return {
      installed: true,
      compatible: true,
      authenticated: true,
      subscription: true,
      method: "chatgpt",
      detail,
      accountKey: createHash("sha256").update(JSON.stringify(account)).digest("hex"),
      statusError: null,
    };
  }
  return {
    installed: true,
    compatible: true,
    authenticated: true,
    subscription: false,
    method:
      account.type === "apiKey"
        ? "api_key"
        : account.type === "amazonBedrock"
          ? "bedrock"
          : "other",
    detail: null,
    statusError: null,
  };
}

const LEGACY_CODEX_AUTH_HOSTS = ["openai.com", "chatgpt.com"] as const;

/** Official-host https URL extraction used by the legacy login child. */
export function extractLegacyCodexUrl(text: string): string | null {
  const matches = text.match(/https:\/\/[^\s\x1b\x07\x00-\x1f"'<>]+/g);
  if (!matches) {
    return null;
  }
  for (const candidate of matches) {
    try {
      const url = new URL(candidate.replace(/[)\].,;]+$/, ""));
      const host = url.hostname.toLowerCase();
      const official = LEGACY_CODEX_AUTH_HOSTS.some(
        (suffix) => host === suffix || host.endsWith(`.${suffix}`),
      );
      if (url.protocol === "https:" && official) {
        return url.toString();
      }
    } catch {
      // Not a URL; keep looking.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude controller
// ---------------------------------------------------------------------------

interface ClaudeAttemptState extends InternalAttempt {
  session: ClaudeLoginSession | null;
}

class ClaudeAuthController {
  private attempt: ClaudeAttemptState | null = null;
  private signingOut = false;
  private statusBase: ClaudeAuthStatus | null = null;
  private statusAt = 0;
  private statusProbe: Promise<ClaudeAuthStatus> | null = null;
  private bump: () => void = () => {};
  /** Notifies the catalog that credentials may have changed. */
  private changed: () => void = () => {};

  setRevisionBumper(bump: () => void): void {
    this.bump = bump;
  }

  setChangeNotifier(notify: () => void): void {
    this.changed = notify;
  }

  private async probeBase(force = false): Promise<ClaudeAuthStatus> {
    const maxAge = isActiveAttempt(this.attempt) ? STATUS_CACHE_DURING_ATTEMPT_MS : STATUS_CACHE_MS;
    if (!force && this.statusBase !== null && Date.now() - this.statusAt < maxAge) {
      return this.statusBase;
    }
    if (this.statusProbe === null) {
      const previous = this.statusBase;
      this.statusProbe = getClaudeAuthStatus()
        .then((value) => {
          this.statusBase = value;
          this.statusAt = Date.now();
          if (
            previous !== null &&
            !previous.statusError &&
            !value.statusError &&
            (previous.authenticated !== value.authenticated ||
              previous.authMethod !== value.authMethod ||
              previous.accountKey !== value.accountKey)
          ) {
            this.changed();
          }
          return value;
        })
        .finally(() => {
          this.statusProbe = null;
        });
    }
    return this.statusProbe;
  }

  async catalogConnection() {
    const base = await this.probeBase(true);
    if (base.statusError) throw new Error("Could not check Claude connection.");
    return {
      connected: base.authenticated && base.subscription,
      identity: base.accountKey ?? base.authMethod ?? "none",
    };
  }

  async snapshot(): Promise<ProviderAuthSnapshot> {
    const launch = await resolveClaudeLaunch();
    if (launch.kind === "unresolved") {
      return {
        installed: false,
        compatible: false,
        authenticated: false,
        subscription: false,
        method: "none",
        detail: null,
        keySaved: false,
        otherCredentialCount: 0,
        deviceCodeAvailable: false,
        attempt: publicAttempt(this.attempt),
        signingOut: this.signingOut,
        statusError: providerError(
          "discovery_failed",
          launch.detail ?? "The claude executable could not be resolved.",
        ),
        resolvedCommand: launch.resolvedCommand,
        commandSource: commandSourceFor("claude", "SCOPE_CLAUDE_PATH"),
      };
    }
    const base = await this.probeBase();
    const method: ProviderAuthSnapshot["method"] = !base.authenticated
      ? "none"
      : base.subscription
        ? "subscription"
        : base.authMethod === "console"
          ? "api_key"
          : "other";
    return {
      installed: base.installed,
      compatible: base.compatible,
      authenticated: base.authenticated,
      subscription: base.subscription,
      method,
      detail: base.detail,
      keySaved: false,
      otherCredentialCount: 0,
      deviceCodeAvailable: false,
      attempt: publicAttempt(this.attempt),
      signingOut: this.signingOut,
      statusError:
        process.platform === "darwin" && base.statusError
          ? providerError(
              "status_unavailable",
              "Claude's sign-in status could not be checked. You may still be signed in. Check again.",
            )
          : null,
      resolvedCommand: launch.resolvedCommand,
      commandSource: commandSourceFor("claude", "SCOPE_CLAUDE_PATH"),
    };
  }

  /** Client-safe description of the tracked attempt. */
  describe(): AttemptDescription {
    return {
      ...describeAttempt(this.attempt),
      inProgress: this.attempt?.session?.isRunning === true || isActiveAttempt(this.attempt),
    };
  }

  async start(): Promise<AuthOperationResult> {
    if (this.signingOut) {
      return { ok: false, error: providerError("signing_out", "Claude is signing out.") };
    }
    if (this.attempt?.session?.isRunning || isActiveAttempt(this.attempt)) {
      return { ok: false, error: inProgressError("Claude") };
    }
    const attempt: ClaudeAttemptState = {
      ...newAttempt(new Date(Date.now() + CLAUDE_LOGIN_TIMEOUT_MS).toISOString()),
      session: null,
    };
    this.attempt = attempt;
    this.bump();

    // The lock is held before this await, so concurrent starts cannot race.
    const launch = await resolveClaudeLaunch();
    if (attempt.cancelRequested || !isActiveAttempt(attempt)) {
      return { ok: true };
    }
    if (launch.kind === "unresolved") {
      return this.failAttempt(
        attempt,
        providerError(
          "discovery_failed",
          launch.detail ?? "The claude executable could not be resolved.",
        ),
      );
    }

    const callbacks: ClaudeLoginCallbacks = {
      onSpawned: () => {
        if (this.attempt !== attempt || !isActiveAttempt(attempt)) {
          return;
        }
        attempt.phase = "waiting_for_browser";
        this.bump();
      },
      onSpawnError: (message) => {
        if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
          return;
        }
        this.failAttempt(attempt, providerError("start_failed", message));
      },
      onUrl: (url) => {
        if (this.attempt !== attempt || !isActiveAttempt(attempt)) {
          return;
        }
        attempt.authorizationUrl = url;
        attempt.error = null;
        this.bump();
      },
      onOutputError: (message) => {
        if (this.attempt !== attempt || !isActiveAttempt(attempt)) {
          return;
        }
        attempt.error = providerError("code_rejected", message);
        this.bump();
      },
      onExit: (code) => {
        void this.handleExit(attempt, code);
      },
      onTimeout: () => {
        if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
          return;
        }
        attempt.timedOut = true;
        attempt.phase = "timed_out";
        attempt.error = providerError(
          "timed_out",
          "The Claude sign-in timed out. Start it again when you are ready.",
        );
        attempt.authorizationUrl = null;
        this.bump();
      },
      onStdinError: () => {
        if (this.attempt !== attempt || !isActiveAttempt(attempt)) {
          return;
        }
        attempt.error = providerError(
          "stdin_failed",
          "The Claude sign-in process is no longer accepting input. Start the sign-in again.",
        );
        this.bump();
      },
    };

    const session = new ClaudeLoginSession(launch.command, callbacks, {
      argsPrefix: launch.argsPrefix,
    });
    attempt.session = session;
    session.start();
    if (this.attempt === attempt && attempt.phase === "starting") {
      attempt.phase = "waiting_for_browser";
      this.bump();
    }
    return { ok: true };
  }

  private async handleExit(attempt: ClaudeAttemptState, code: number | null): Promise<void> {
    attempt.exitCode = code;
    if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
      return;
    }
    if (attempt.cancelRequested) {
      this.finishAttempt(attempt, "cancelled", null);
      this.bump();
      return;
    }
    if (attempt.timedOut) {
      this.finishAttempt(
        attempt,
        "timed_out",
        providerError(
          "timed_out",
          "The Claude sign-in timed out. Start it again when you are ready.",
        ),
      );
      this.bump();
      return;
    }
    attempt.phase = "verifying";
    this.bump();
    if (code !== 0) {
      const message = claudeLoginFailureMessage(attempt.session?.outputTail ?? "", code);
      this.finishAttempt(attempt, "failed", providerError("login_failed", message));
      this.bump();
      return;
    }
    const status = await this.probeBase(true);
    if (this.attempt !== attempt || isTerminalAuthPhase(attempt.phase)) {
      return;
    }
    if (status.installed && status.authenticated) {
      this.finishAttempt(attempt, "succeeded", null);
      this.changed();
    } else {
      this.finishAttempt(
        attempt,
        "failed",
        providerError(
          "login_failed",
          "claude exited without a signed-in account. Try the sign-in again.",
        ),
      );
    }
    this.bump();
  }

  private failAttempt(attempt: ClaudeAttemptState, error: AuthErrorInfo): AuthOperationResult {
    this.finishAttempt(attempt, "failed", error);
    this.bump();
    return { ok: false, error };
  }

  private finishAttempt(
    attempt: ClaudeAttemptState,
    phase: AuthAttemptPhase,
    error: AuthErrorInfo | null,
  ): void {
    if (this.attempt !== attempt) {
      return;
    }
    clearAttemptTimer(attempt);
    attempt.phase = phase;
    attempt.error = error;
    attempt.authorizationUrl = null;
    attempt.session?.terminate();
    attempt.session = null;
    attempt.cancelRequested = phase === "cancelled" ? true : attempt.cancelRequested;
  }

  async cancel(attemptId?: string): Promise<AuthOperationResult> {
    const attempt = this.attempt;
    if (attempt === null || isTerminalAuthPhase(attempt.phase)) {
      return { ok: false, error: nothingToCancelError("Claude") };
    }
    if (attemptId !== undefined && attempt.id !== attemptId) {
      return { ok: false, error: staleAttemptError() };
    }
    attempt.cancelRequested = true;
    attempt.phase = "cancelled";
    attempt.authorizationUrl = null;
    clearAttemptTimer(attempt);
    const session = attempt.session;
    this.bump();
    await session?.stop();
    attempt.session = null;
    return { ok: true };
  }

  submitCode(attemptId: string | undefined, code: string): AuthOperationResult {
    const attempt = this.attempt;
    if (attempt === null || !isActiveAttempt(attempt)) {
      return {
        ok: false,
        error: providerError("nothing_to_submit", "No Claude sign-in is waiting for a code."),
      };
    }
    if (attemptId !== undefined && attempt.id !== attemptId) {
      return { ok: false, error: staleAttemptError() };
    }
    const session = attempt.session;
    if (session === null) {
      return {
        ok: false,
        error: providerError("not_ready", "The Claude sign-in is still starting. Try again."),
      };
    }
    const result = session.submitCode(code);
    if (!result.ok) {
      return { ok: false, error: providerError("code_rejected", result.reason) };
    }
    attempt.error = null;
    this.bump();
    return { ok: true };
  }

  async logout(): Promise<AuthOperationResult> {
    if (this.signingOut) {
      return { ok: false, error: providerError("signing_out", "Claude is already signing out.") };
    }
    if (isAiProviderBusy("claude")) {
      return {
        ok: false,
        error: providerError(
          "provider_busy",
          "Claude is answering a request right now. Wait for it to finish (or stop it), then sign out.",
        ),
      };
    }
    this.signingOut = true;
    setProviderSigningOut("claude", true);
    this.bump();
    try {
      if (isActiveAttempt(this.attempt)) {
        await this.cancel(this.attempt.id);
      }
      await this.attempt?.session?.stop();
      await logoutClaude();
      const status = await this.probeBase(true);
      if (status.installed && status.authenticated) {
        return {
          ok: false,
          error: providerError(
            "logout_failed",
            "claude still reports a signed-in account after signing out.",
          ),
        };
      }
      this.changed();
      return { ok: true };
    } catch {
      return {
        ok: false,
        error: providerError("logout_failed", "Claude could not be signed out. Try again."),
      };
    } finally {
      this.signingOut = false;
      setProviderSigningOut("claude", false);
      this.bump();
    }
  }

  /** Drops cached status so the next probe uses a newly configured executable. */
  invalidateResolution(): void {
    this.statusBase = null;
    this.statusAt = 0;
  }

  dispose(): void {
    const attempt = this.attempt;
    if (attempt !== null) {
      clearAttemptTimer(attempt);
      attempt.session?.terminate();
      attempt.session = null;
    }
  }
}

// ---------------------------------------------------------------------------
// OpenCode controller
// ---------------------------------------------------------------------------

class OpenCodeAuthController {
  private signingOut = false;
  private installed: boolean | null = null;
  private installedAt = 0;
  private probe: Promise<boolean> | null = null;
  private bump: () => void = () => {};
  /** Notifies the catalog that credentials may have changed. */
  private changed: () => void = () => {};
  private lastCredential: string | null = null;
  /** Client-safe resolution failure, distinct from a missing install. */
  private resolutionError: string | null = null;

  setRevisionBumper(bump: () => void): void {
    this.bump = bump;
  }

  setChangeNotifier(notify: () => void): void {
    this.changed = notify;
  }

  private async probeInstalled(): Promise<boolean> {
    if (this.installed !== null && Date.now() - this.installedAt < 30_000) {
      return this.installed;
    }
    if (this.probe === null) {
      this.probe = (async () => {
        const launch = await resolveOpencodeLaunch();
        if (launch.kind === "unresolved") {
          this.resolutionError = launch.detail;
          this.installed = false;
          this.installedAt = Date.now();
          return false;
        }
        this.resolutionError = null;
        // A resolved native/script launch is real; a bare PATH fallback may
        // be an interactive-only shim, so probe it.
        const probe =
          launch.command === "opencode"
            ? await execFileStatus(launch.command, [...launch.argsPrefix, "--version"], 4_000)
            : { ran: true };
        this.installed = probe.ran;
        this.installedAt = Date.now();
        return probe.ran;
      })().finally(() => {
        this.probe = null;
      });
    }
    return this.probe;
  }

  async snapshot(): Promise<ProviderAuthSnapshot> {
    const [installed, credential] = await Promise.all([
      this.probeInstalled(),
      getOpenCodeGoCredentialState(),
    ]);
    // A key changed outside scope (`opencode auth login`) invalidates the
    // catalog that was discovered for the previous credential.
    if (
      !credential.storeError &&
      this.lastCredential !== null &&
      this.lastCredential !== credential.fingerprint
    ) {
      this.changed();
    }
    if (!credential.storeError) this.lastCredential = credential.fingerprint ?? "none";
    const launch = await resolveOpencodeLaunch();
    return {
      installed,
      compatible: installed,
      authenticated: credential.keySaved,
      subscription: false,
      method: credential.keySaved ? "api_key" : "none",
      detail: credential.keySaved ? "Access is checked when you use it." : null,
      keySaved: credential.keySaved,
      otherCredentialCount: credential.otherCredentialCount,
      deviceCodeAvailable: false,
      attempt: null,
      signingOut: this.signingOut,
      statusError:
        credential.storeError !== null
          ? providerError("store_error", credential.storeError)
          : this.resolutionError !== null
            ? providerError("discovery_failed", this.resolutionError)
            : null,
      resolvedCommand: launch.resolvedCommand,
      commandSource: commandSourceFor("opencode", "SCOPE_OPENCODE_BIN"),
    };
  }

  async saveKey(key: string): Promise<AuthOperationResult> {
    try {
      validateOpenCodeKey(key);
    } catch (error) {
      return {
        ok: false,
        error: providerError(
          "invalid_key",
          error instanceof Error ? error.message : "That key could not be accepted.",
        ),
      };
    }
    try {
      await saveOpenCodeGoKey(key);
      this.bump();
      this.changed();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: providerError(
          "save_failed",
          safeMessage(
            error instanceof Error ? error.message : null,
            "The OpenCode credential could not be saved.",
          ),
        ),
      };
    }
  }

  async removeKey(): Promise<AuthOperationResult> {
    if (this.signingOut) {
      return {
        ok: false,
        error: providerError("signing_out", "The OpenCode key is already being removed."),
      };
    }
    if (isAiProviderBusy("opencode")) {
      return {
        ok: false,
        error: providerError(
          "provider_busy",
          "OpenCode is answering a request right now. Wait for it to finish (or stop it), then remove the key.",
        ),
      };
    }
    this.signingOut = true;
    setProviderSigningOut("opencode", true);
    this.bump();
    try {
      await removeOpenCodeGoKey();
      this.changed();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: providerError(
          "remove_failed",
          safeMessage(
            error instanceof Error ? error.message : null,
            "The OpenCode key could not be removed.",
          ),
        ),
      };
    } finally {
      this.signingOut = false;
      setProviderSigningOut("opencode", false);
      this.bump();
    }
  }

  /** Drops the cached installed probe after an executable-path change. */
  invalidateResolution(): void {
    this.installed = null;
    this.installedAt = 0;
  }

  dispose(): void {}
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface AuthManagerDeps {
  /** Replaces the app-server connection (tests only). */
  connectCodex?: CodexConnect;
}

export class AuthManager {
  readonly codex: CodexAuthController;
  readonly claude: ClaudeAuthController;
  readonly opencode: OpenCodeAuthController;
  private revision = 1;
  private readonly instanceId = randomUUID();
  private readonly changeListeners = new Set<(provider: AiBackendId) => void>();

  constructor(deps: AuthManagerDeps = {}) {
    const connectCodex = deps.connectCodex ?? (() => CodexAccountClient.connect());
    this.codex = new CodexAuthController(connectCodex);
    this.claude = new ClaudeAuthController();
    this.opencode = new OpenCodeAuthController();
    const bump = (): void => {
      this.revision += 1;
    };
    this.codex.setRevisionBumper(bump);
    this.claude.setRevisionBumper(bump);
    this.opencode.setRevisionBumper(bump);
    this.codex.setChangeNotifier(() => this.notifyProviderChanged("codex"));
    this.claude.setChangeNotifier(() => this.notifyProviderChanged("claude"));
    this.opencode.setChangeNotifier(() => this.notifyProviderChanged("opencode"));
  }

  /**
   * Notifies listeners that a provider's credentials may have changed on
   * login, logout, credential replacement, or a detected external account
   * switch. The catalog persists its own opaque credential generation; no
   * account identity crosses this boundary.
   */
  private notifyProviderChanged(provider: AiBackendId): void {
    for (const listener of this.changeListeners) {
      try {
        listener(provider);
      } catch (error) {
        console.error("[ai/auth] provider change listener failed:", error);
      }
    }
  }

  /** Registers a credential-change listener; returns the unsubscribe function. */
  onProviderAuthChanged(listener: (provider: AiBackendId) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Builds the full Settings snapshot; provider probes run in parallel. */
  async getSnapshot(backend: AiBackendId): Promise<AiAuthSnapshot> {
    const [codex, opencode, claude] = await Promise.all([
      this.codex.snapshot(),
      this.opencode.snapshot(),
      this.claude.snapshot(),
    ]);
    return {
      instanceId: this.instanceId,
      revision: this.revision,
      checkedAt: new Date().toISOString(),
      backend,
      codex,
      opencode,
      claude,
    };
  }

  /** Server-only connection evidence; never included in auth API responses. */
  async getCatalogConnection(
    provider: AuthProviderId,
  ): Promise<{ connected: boolean; identity: string }> {
    if (provider === "codex") return this.codex.catalogConnection();
    if (provider === "claude") return this.claude.catalogConnection();
    const credential = await getOpenCodeGoCredentialState();
    if (credential.storeError) throw new Error("Could not check OpenCode connection.");
    return { connected: credential.keySaved, identity: credential.fingerprint ?? "none" };
  }

  /**
   * Invalidates cached provider status after its executable path changed, so
   * the returned snapshot reflects the newly configured binary immediately.
   */
  invalidateProviderResolution(provider: AiBackendId): void {
    if (provider === "codex") {
      this.codex.invalidateResolution();
    } else if (provider === "claude") {
      this.claude.invalidateResolution();
    } else {
      this.opencode.invalidateResolution();
    }
    this.revision += 1;
  }

  async getProviderSnapshot(provider: AuthProviderId): Promise<ProviderAuthSnapshot> {
    switch (provider) {
      case "codex":
        return this.codex.snapshot();
      case "claude":
        return this.claude.snapshot();
      case "opencode":
        return this.opencode.snapshot();
    }
  }

  async startCodexLogin(
    mode: "browser" | "device",
    backend: AiBackendId,
  ): Promise<AuthOperationResult> {
    // Switching from browser trouble to device code cancels the old attempt
    // first so its late callback cannot restore a browser session.
    if (mode === "device" && this.codex.canReplaceWithDevice()) {
      await this.codex.cancel();
    }
    return this.withSnapshot(await this.codex.start(mode), backend);
  }

  async cancelCodexLogin(
    attemptId: string | undefined,
    backend: AiBackendId,
  ): Promise<AuthOperationResult> {
    return this.withSnapshot(await this.codex.cancel(attemptId), backend);
  }

  async startClaudeLogin(backend: AiBackendId): Promise<AuthOperationResult> {
    return this.withSnapshot(await this.claude.start(), backend);
  }

  async cancelClaudeLogin(
    attemptId: string | undefined,
    backend: AiBackendId,
  ): Promise<AuthOperationResult> {
    return this.withSnapshot(await this.claude.cancel(attemptId), backend);
  }

  async submitClaudeLoginCode(
    attemptId: string | undefined,
    code: string,
    backend: AiBackendId,
  ): Promise<AuthOperationResult> {
    return this.withSnapshot(this.claude.submitCode(attemptId, code), backend);
  }

  async saveOpenCodeKey(key: string, backend: AiBackendId): Promise<AuthOperationResult> {
    return this.withSnapshot(await this.opencode.saveKey(key), backend);
  }

  async logoutProvider(
    provider: AuthProviderId,
    backend: AiBackendId,
  ): Promise<AuthOperationResult> {
    const result =
      provider === "codex"
        ? await this.codex.logout()
        : provider === "claude"
          ? await this.claude.logout()
          : await this.opencode.removeKey();
    return this.withSnapshot(result, backend);
  }

  private async withSnapshot(
    result: AuthOperationResult,
    backend: AiBackendId,
  ): Promise<AuthOperationResult> {
    // Successful mutations carry a fresh snapshot so the card the user sees
    // always matches the server. Failures keep the existing snapshot and
    // report the error, avoiding an expensive probe for a refused action.
    if (!result.ok) {
      return result;
    }
    const snapshot = await this.getSnapshot(backend);
    return { ...result, snapshot };
  }

  /** Kills login children; safe to call from a shutdown hook. */
  dispose(): void {
    this.codex.dispose();
    this.claude.dispose();
    this.opencode.dispose();
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

const MANAGER_KEY = Symbol.for("scope.ai.auth.manager.v1");
const SHUTDOWN_KEY = Symbol.for("scope.ai.auth.shutdown-hooked.v1");

interface AuthGlobal {
  [MANAGER_KEY]?: AuthManager;
  [SHUTDOWN_KEY]?: boolean;
}

function installShutdownHook(): void {
  const globalState = globalThis as AuthGlobal;
  if (globalState[SHUTDOWN_KEY]) {
    return;
  }
  globalState[SHUTDOWN_KEY] = true;
  process.once("exit", () => {
    (globalThis as AuthGlobal)[MANAGER_KEY]?.dispose();
  });
}

/** The process-wide manager; every route bundle shares this instance. */
export function getAuthManager(): AuthManager {
  const globalState = globalThis as AuthGlobal;
  if (globalState[MANAGER_KEY] === undefined) {
    globalState[MANAGER_KEY] = new AuthManager();
    installShutdownHook();
  }
  return globalState[MANAGER_KEY];
}

/** Installs a manager (tests use an injected one); never used in production. */
export function setAuthManagerForTests(manager: AuthManager | null): void {
  const globalState = globalThis as AuthGlobal;
  if (manager === null) {
    delete globalState[MANAGER_KEY];
    return;
  }
  globalState[MANAGER_KEY] = manager;
}
