/**
 * AI backend dispatcher (stage 9; Claude stage 10). Server-only.
 *
 * One place chooses which CLI adapter runs an AI feature: the codex adapter
 * (ChatGPT subscription via ~/.codex/auth.json), the opencode adapter
 * (OpenCode credentials via ~/.local/share/opencode/auth.json), or the claude
 * adapter (Claude subscription via the claude CLI's native login). The choice
 * is the `ai_backend` setting; every adapter speaks the same
 * CodexStreamEvent shape, so callers bind a runner once and stay
 * backend-agnostic below this module.
 *
 * Every adapter authenticates only from its own machine-local credential
 * store — that is the whole point of "log in with <backend>" — so the
 * dispatcher never accepts API keys and never mixes the three. Dispatch is
 * exhaustive: an unknown backend throws instead of silently running codex.
 */
import type { CodexRun, CodexRunOptions } from "./codex";
import { runCodex } from "./codex";
import type { AiBackendId } from "./backend-id";
import { beginAiRun, isProviderSigningOut } from "./active-runs";
import { resolveClaudeLaunch, runClaude, type ClaudeRunOptions } from "./claude";
import { resolveOpencodeLaunch, runOpencode, type OpenCodeRunOptions } from "./opencode";

/** A bound backend runner: same surface the codex adapter has always had. */
export type AiRunner = (options: CodexRunOptions) => CodexRun;

/** Thrown when a run is requested while the provider is signing out. */
export class AiProviderSigningOutError extends Error {
  constructor(backend: AiBackendId) {
    super(
      `The ${backend} provider is signing out. Wait for the sign-out to finish, then try again.`,
    );
    this.name = "AiProviderSigningOutError";
  }
}

/**
 * Counts in-flight runs per provider and refuses new ones while a sign-out
 * is settling, so logout coordination and provider choice stay consistent.
 */
function withRunAccounting(backend: AiBackendId, runner: AiRunner): AiRunner {
  return (options) => {
    if (isProviderSigningOut(backend)) {
      throw new AiProviderSigningOutError(backend);
    }
    const release = beginAiRun(backend);
    let run: CodexRun;
    try {
      run = runner(options);
    } catch (error) {
      release();
      throw error;
    }
    void run.completed.then(
      () => release(),
      () => release(),
    );
    return run;
  };
}

/** Injectable runners, mirroring the seams the layers already expose. */
export interface AiRunnerDeps {
  /** Forces the codex adapter (tests; explicit override). */
  runCodex?: (options: CodexRunOptions) => CodexRun;
  /** Forces the opencode adapter (tests; explicit override). */
  runOpencode?: (options: OpenCodeRunOptions) => CodexRun;
  /** Forces the claude adapter (tests; explicit override). */
  runClaude?: (options: ClaudeRunOptions) => CodexRun;
}

/**
 * Binds the runner for a backend. The opencode and claude paths resolve the
 * real binary up front (mise-managed installs must bypass their PATH shim)
 * and project the shared run options onto the adapter's narrower surface:
 * models and reasoning efforts are projected when a chat mode supplies its
 * provider-qualified values; other callers may leave them out.
 */
export async function createAiRunner(
  backend: AiBackendId,
  deps: AiRunnerDeps = {},
): Promise<AiRunner> {
  switch (backend) {
    case "opencode": {
      if (deps.runOpencode) {
        return withRunAccounting(backend, (options) =>
          deps.runOpencode!({ ...options, reasoningEffort: options.reasoningEffort ?? undefined }),
        );
      }
      const launch = await resolveOpencodeLaunch();
      return withRunAccounting(backend, (options) =>
        runOpencode({
          prompt: options.prompt,
          workDir: options.workDir,
          resumeSessionId: options.resumeSessionId,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          spawner: options.spawner,
          command: launch.command,
          commandArgs: launch.argsPrefix,
          model: options.model,
          reasoningEffort: options.reasoningEffort ?? undefined,
        }),
      );
    }
    case "claude": {
      if (deps.runClaude) {
        return withRunAccounting(backend, (options) =>
          deps.runClaude!({ ...options, reasoningEffort: options.reasoningEffort ?? undefined }),
        );
      }
      const launch = await resolveClaudeLaunch();
      return withRunAccounting(backend, (options) =>
        runClaude({
          prompt: options.prompt,
          workDir: options.workDir,
          sandbox: options.sandbox,
          resumeSessionId: options.resumeSessionId,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          spawner: options.spawner,
          command: launch.command,
          commandArgs: launch.argsPrefix,
          model: options.model,
          reasoningEffort: options.reasoningEffort ?? undefined,
        }),
      );
    }
    case "codex":
      return withRunAccounting(backend, (options) => (deps.runCodex ?? runCodex)(options));
    default: {
      // Exhaustiveness: an unknown id must never silently run codex.
      const unknown: never = backend;
      throw new Error(`Unknown AI backend: ${String(unknown)}`);
    }
  }
}
