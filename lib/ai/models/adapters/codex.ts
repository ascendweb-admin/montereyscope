/**
 * Codex model discovery (dynamic catalog stage). Server-only.
 *
 * Uses the same executable, authentication source, and environment policy as
 * inference: `resolveCodexLaunch()` plus the ambient-API-key strip. It opens
 * a fresh app-server, calls `model/list` with `includeHidden: false`, follows
 * pagination, and closes the child. The RPC is read-only and never submits a
 * prompt.
 *
 * Compatibility is deliberately separate from authentication: a CLI that
 * cannot answer `model/list` fails discovery without marking a valid login as
 * broken.
 */
import { CodexAccountClient } from "../../auth/codex-account-client";
import { resolveCodexLaunch } from "../../codex";
import { catalogReasoningOption } from "../labels";
import { sanitizeCatalogText } from "../types";
import {
  DiscoveryError,
  type DiscoveryContext,
  type DiscoveryOutcome,
  type ModelDiscoveryAdapter,
} from "./types";

/** Environment policy shared with inference: ambient keys never apply. */
function codexDiscoveryEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

export class CodexModelDiscoveryAdapter implements ModelDiscoveryAdapter {
  readonly provider = "codex" as const;

  async discover(context: DiscoveryContext): Promise<DiscoveryOutcome> {
    let client: CodexAccountClient;
    const launch = resolveCodexLaunch();
    if (launch.kind === "unresolved") {
      throw new DiscoveryError(
        launch.detail ?? "The codex executable could not be resolved on this machine.",
      );
    }
    try {
      client = await CodexAccountClient.connect({
        command: launch.command,
        argsPrefix: launch.argsPrefix,
        env: codexDiscoveryEnvironment(),
      });
    } catch (error) {
      throw new DiscoveryError(
        error instanceof Error && /ENOENT|not found/i.test(error.message)
          ? "The codex CLI is not available on this machine."
          : "The codex CLI did not start for model discovery.",
      );
    }

    const abort = (): void => {
      void client.close().catch(() => {});
    };
    if (context.signal.aborted) {
      abort();
      throw new DiscoveryError("Codex model discovery was cancelled.");
    }
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      const entries = await client.listModels();
      const models = entries.map((entry) => ({
        id: entry.runtimeId,
        runtimeId: entry.runtimeId,
        label: entry.label,
        description: entry.description,
        reasoningOptions: entry.reasoningOptions.map((option) =>
          catalogReasoningOption(option.id, option.description),
        ),
        defaultReasoningEffort: entry.defaultReasoningEffort,
        effortsKnown: entry.effortsKnown,
        // The listing comes from the same app-server that runs inference, so
        // the runtime can resolve every returned id. Listing alone does not
        // establish per-model subscription entitlement.
        runtimeCompatibility: "supported" as const,
        access: "unknown" as const,
        aliasTarget: null,
        recommended: entry.recommended,
        upgrade: entry.upgrade
          ? {
              modelId: sanitizeCatalogText(entry.upgrade.modelId),
              message: sanitizeCatalogText(entry.upgrade.message, 400) || null,
            }
          : null,
      }));
      return {
        models,
        runtimeVersion: null,
        source: "codex app-server model/list",
      };
    } catch (error) {
      throw new DiscoveryError(
        error instanceof Error
          ? "The codex CLI could not report its model list."
          : "Codex model discovery failed.",
      );
    } finally {
      context.signal.removeEventListener("abort", abort);
      await client.close().catch(() => {});
    }
  }
}
