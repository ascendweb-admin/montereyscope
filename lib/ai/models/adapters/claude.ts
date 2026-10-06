/**
 * Claude model discovery (dynamic catalog stage). Server-only.
 *
 * Uses the official Agent SDK's control session with
 * `pathToClaudeCodeExecutable` pointed at Scope's resolved claude binary and
 * Scope's child-environment policy. The session is initialized with a prompt
 * source that never yields, so the control channel answers `supportedModels()`
 * without ever submitting a user turn; the process is closed immediately
 * after. Discovery works with the machine's existing subscription login — no
 * API key is read or sent.
 *
 * Public ids preserve the bundled vocabulary (`claude-haiku`, `claude-sonnet`,
 * `claude-opus`) by mapping provider family aliases, while newly returned
 * families and explicit model ids become catalog entries without a hardcoded
 * enum. The runtime id is always the exact provider value.
 *
 * supportedModels() can return runtime metadata even when signed out. The
 * catalog service gates discovery on a verified connection; individual model
 * entitlement remains unknown.
 */
import { claudeChildEnvironment, resolveClaudeLaunch } from "../../claude";
import { catalogReasoningOption, labelFromModelId } from "../labels";
import { MAX_EFFORT_ID_LENGTH, sanitizeCatalogText } from "../types";
import type { CatalogModelDraft } from "../repository";
import {
  DiscoveryError,
  type DiscoveryContext,
  type DiscoveryOutcome,
  type ModelDiscoveryAdapter,
} from "./types";

/** Family aliases that keep the existing public ids stable. */
const FAMILY_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

/** The SDK surface the adapter depends on (a seam for tests). */
export interface ClaudeDiscoveryModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

export type ClaudeModelLister = (signal: AbortSignal) => Promise<ClaudeDiscoveryModel[]>;

/**
 * Maps the SDK's `ModelInfo` rows onto catalog drafts. Exported so parser
 * tests run without spawning the CLI.
 */
export function normalizeClaudeModels(rows: readonly ClaudeDiscoveryModel[]): CatalogModelDraft[] {
  const models: CatalogModelDraft[] = [];
  const usedIds = new Set<string>();
  for (const row of rows) {
    const value = sanitizeCatalogText(row.value);
    if (value.length === 0) {
      continue;
    }
    const publicId = claudePublicId(value, usedIds);
    const levels = Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.filter(
          (level): level is string =>
            typeof level === "string" &&
            level.length > 0 &&
            level.length <= MAX_EFFORT_ID_LENGTH &&
            /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(level),
        )
      : [];
    const effortsKnown = Array.isArray(row.supportedEffortLevels) || row.supportsEffort === false;
    const resolved = sanitizeCatalogText(row.resolvedModel);
    models.push({
      id: publicId,
      runtimeId: value,
      label: sanitizeCatalogText(row.displayName, 120) || labelFromModelId(value),
      description: sanitizeCatalogText(row.description, 400),
      reasoningOptions: levels.map((level) => catalogReasoningOption(level)),
      defaultReasoningEffort: null,
      effortsKnown,
      runtimeCompatibility: "supported",
      access: "unknown",
      aliasTarget: resolved.length > 0 && resolved !== value ? resolved : null,
      recommended: value === "default",
      upgrade: null,
    });
  }
  return models;
}

/**
 * Builds a stable, safe public id. Family aliases keep the documented
 * `claude-<family>` form; everything else is a slug of the provider value so
 * bracket-qualified aliases (`opus[1m]`) never become raw persisted ids.
 */
function claudePublicId(value: string, used: Set<string>): string {
  const slug = slugify(value);
  const base =
    value === "default"
      ? "claude-default"
      : FAMILY_ALIASES.has(value)
        ? `claude-${value}`
        : slug.startsWith("claude-")
          ? slug
          : `claude-${slug}`;
  let candidate = base.slice(0, 160);
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${base.slice(0, 150)}-${counter}`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "model";
}

/** Lazily loads the Agent SDK so the route bundle only pulls it when needed. */
async function loadSdkModelLister(): Promise<ClaudeModelLister> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const launch = await resolveClaudeLaunch();
  if (launch.kind === "unresolved") {
    throw new Error(
      launch.detail ?? "The claude executable could not be resolved on this machine.",
    );
  }
  // A script launch (npm command wrapper) points at a JavaScript entry the
  // SDK runs through its `executable` runner; a native launch is the binary
  // itself.
  const scriptEntry = launch.kind === "script" ? launch.argsPrefix[0] : null;
  return async (signal) => {
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    if (signal.aborted) {
      abort.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const query = sdk.query({
      // A never-yielding source initializes the control session without ever
      // creating a user turn.
      prompt: (async function* () {
        await new Promise<void>((resolve) => {
          abort.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })(),
      options: {
        pathToClaudeCodeExecutable: scriptEntry ?? launch.command,
        // The SDK only types `executable` as a known runner name, but passes
        // it straight to spawn; the resolved node path keeps model discovery
        // on the same installation status and login use.
        ...(scriptEntry !== null ? { executable: launch.command as "node" } : {}),
        env: claudeChildEnvironment(),
        settingSources: [],
        extraArgs: { "safe-mode": null },
        tools: [],
        strictMcpConfig: true,
        mcpServers: {},
        permissionMode: "dontAsk",
        maxTurns: 1,
        persistSession: false,
        abortController: abort,
      },
    });
    try {
      return await query.supportedModels();
    } finally {
      signal.removeEventListener("abort", onAbort);
      abort.abort();
      try {
        query.close();
      } catch {
        // Already closed.
      }
    }
  };
}

export class ClaudeModelDiscoveryAdapter implements ModelDiscoveryAdapter {
  readonly provider = "claude" as const;
  private readonly listModels: (() => Promise<ClaudeModelLister>) | undefined;

  constructor(listModels?: () => Promise<ClaudeModelLister>) {
    this.listModels = listModels;
  }

  async discover(context: DiscoveryContext): Promise<DiscoveryOutcome> {
    let list: ClaudeModelLister;
    try {
      list = this.listModels ? await this.listModels() : await loadSdkModelLister();
    } catch {
      throw new DiscoveryError(
        "The Claude model catalog needs the Claude Agent SDK and a working claude CLI.",
      );
    }
    if (context.signal.aborted) {
      throw new DiscoveryError("Claude model discovery was cancelled.");
    }
    try {
      const rows = await list(context.signal);
      if (
        !Array.isArray(rows) ||
        rows.some((row) => !row || typeof row.value !== "string" || !row.value.trim())
      ) {
        throw new DiscoveryError("The claude CLI returned a malformed model list.");
      }
      const models = normalizeClaudeModels(rows);

      return {
        models,
        runtimeVersion: null,
        source: "Claude Agent SDK supportedModels()",
      };
    } catch (error) {
      if (error instanceof DiscoveryError) {
        throw error;
      }
      throw new DiscoveryError("The claude CLI could not report its model list.");
    }
  }
}
