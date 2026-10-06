/**
 * OpenCode Go model discovery (dynamic catalog stage). Server-only.
 *
 * Two independent sources are reconciled:
 *
 * - the documented Go catalog endpoint (`https://opencode.ai/zen/go/v1/models`)
 *   establishes which models the plan currently lists,
 * - `opencode models opencode-go --refresh --verbose` refreshes and reports
 *   what the installed runtime can actually resolve, including reasoning
 *   variants.
 *
 * A model listed by the endpoint but absent from the runtime is stored as
 * `runtimeCompatibility: "unsupported"` — visible with a precise status but
 * never advertised as ready. A runtime model absent from the endpoint is not
 * offered. Neither source proves the saved key has access.
 */
import { spawn } from "node:child_process";

import { getOpenCodeGoCredentialState } from "../../auth/opencode-credentials";
import { resolveOpencodeLaunch } from "../../opencode";
import type { ProviderLaunch } from "../../provider-command";
import { catalogReasoningOption, labelFromModelId } from "../labels";
import { MAX_EFFORT_ID_LENGTH, sanitizeCatalogText } from "../types";
import type { CatalogModelDraft } from "../repository";
import {
  DiscoveryError,
  type DiscoveryContext,
  type DiscoveryOutcome,
  type ModelDiscoveryAdapter,
} from "./types";

const GO_CATALOG_URL = "https://opencode.ai/zen/go/v1/models";

/** Runtime metadata refresh gets its own bound inside the shared timeout. */
const RUNTIME_REFRESH_TIMEOUT_MS = 12_000;

/** Version probes are best-effort and short. */
const VERSION_TIMEOUT_MS = 5_000;

/** Bounded CLI output kept for parsing; a runaway stream is a failure. */
const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

const API_KEY_ENV_VARS = ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENCODE_API_KEY"] as const;

/** Runtime model metadata parsed from `opencode models --verbose`. */
export interface RuntimeModel {
  id: string;
  name: string | null;
  variants: string[];
  reasoningCapable: boolean | null;
}

function withoutApiKeys(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of API_KEY_ENV_VARS) {
    delete copy[key];
  }
  return copy;
}

/**
 * Extracts every balanced JSON object from CLI output and keeps the
 * `providerID: "opencode-go"` entries. Scanning balanced objects instead of
 * pairing id lines with payloads tolerates banners, pager prompts, and
 * reordered output.
 */
export function parseOpenCodeModelsOutput(text: string): Map<string, RuntimeModel> {
  const models = new Map<string, RuntimeModel>();
  for (const raw of extractJsonObjects(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    if (record.providerID !== "opencode-go") {
      continue;
    }
    const id = sanitizeCatalogText(record.id);
    if (id.length === 0) {
      continue;
    }
    const variantsRaw =
      typeof record.variants === "object" && record.variants !== null
        ? (record.variants as Record<string, unknown>)
        : null;
    const variants = variantsRaw
      ? Object.keys(variantsRaw)
          .filter((key) => key.length > 0 && key.length <= MAX_EFFORT_ID_LENGTH)
          .sort()
      : [];
    const capabilities =
      typeof record.capabilities === "object" && record.capabilities !== null
        ? (record.capabilities as Record<string, unknown>)
        : null;
    const reasoningCapable =
      capabilities === null
        ? null
        : capabilities.reasoning === true
          ? true
          : capabilities.reasoning === false
            ? false
            : null;
    models.set(id, {
      id,
      name: sanitizeCatalogText(record.name, 120) || null,
      variants,
      reasoningCapable,
    });
  }
  return models;
}

/** Yields balanced `{...}` substrings, respecting strings and escapes. */
function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

/** Parses the Go membership endpoint's `{ data: [{ id }] }` payload. */
export function parseGoCatalogMembership(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    throw new DiscoveryError("The OpenCode Go catalog response was not an object.");
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new DiscoveryError("The OpenCode Go catalog response had no model list.");
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      throw new DiscoveryError("The OpenCode Go catalog contained a malformed model.");
    }
    const rawId = (entry as Record<string, unknown>).id;
    const id = sanitizeCatalogText(rawId);
    if (!id || id !== rawId)
      throw new DiscoveryError("The OpenCode Go catalog contained an invalid model ID.");
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns one bounded read-only CLI probe; resolves on close, never rejects. */
export function runOpenCodeProbe(
  command: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
  argsPrefix: readonly string[] = [],
): Promise<CommandResult> {
  if (signal.aborted) return Promise.resolve({ exitCode: null, stdout: "", stderr: "" });
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...argsPrefix, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: withoutApiKeys(),
      });
    } catch {
      resolve({ exitCode: null, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      resolve(result);
    };
    const kill = (): void => {
      if (stopped) return;
      stopped = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2_000);
      killTimer.unref?.();
    };
    const onAbort = (): void => kill();
    if (signal.aborted) {
      kill();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      kill();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_CHARS) {
        kill();
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length + chunk.length > MAX_OUTPUT_CHARS) {
        kill();
        return;
      }
      stderr += chunk.toString("utf8");
    });
    child.once("error", () => finish({ exitCode: null, stdout, stderr }));
    child.once("close", (code) => finish({ exitCode: stopped ? null : code, stdout, stderr }));
  });
}

/** Reads the runtime's model metadata, refreshing go's cache first. */
export async function readOpenCodeRuntimeModels(
  launch: ProviderLaunch,
  signal: AbortSignal,
): Promise<{ models: Map<string, RuntimeModel>; refreshed: boolean }> {
  const first = await runOpenCodeProbe(
    launch.command,
    ["models", "opencode-go", "--refresh", "--verbose"],
    signal,
    RUNTIME_REFRESH_TIMEOUT_MS,
    launch.argsPrefix,
  );
  const firstParsed = parseOpenCodeModelsOutput(first.stdout);
  if (first.exitCode === 0 && firstParsed.size > 0) {
    return { models: firstParsed, refreshed: true };
  }
  // The refresh path failed (often offline); the cached metadata may still be
  // usable, and the Go membership request already supplied live membership.
  const second = await runOpenCodeProbe(
    launch.command,
    ["models", "opencode-go", "--verbose"],
    signal,
    RUNTIME_REFRESH_TIMEOUT_MS,
    launch.argsPrefix,
  );
  const secondParsed = parseOpenCodeModelsOutput(second.stdout);
  if (second.exitCode === 0 && secondParsed.size > 0) {
    return { models: secondParsed, refreshed: false };
  }
  throw new DiscoveryError("The installed opencode CLI could not report its model metadata.");
}

/** Best-effort runtime version, safe to omit. */
async function readRuntimeVersion(
  launch: ProviderLaunch,
  signal: AbortSignal,
): Promise<string | null> {
  const result = await runOpenCodeProbe(
    launch.command,
    ["--version"],
    signal,
    VERSION_TIMEOUT_MS,
    launch.argsPrefix,
  );
  const firstLine = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? sanitizeCatalogText(firstLine, 40) : null;
}

/**
 * Reconciles live Go membership order with installed-runtime capabilities.
 * Exported for deterministic tests: the adapter supplies the two sources and
 * this function decides what can actually run. A model the runtime does not
 * know is kept visible but marked unsupported; a runtime model absent from the
 * live catalog is not offered.
 */
export function reconcileOpenCodeCatalog(
  membership: readonly string[],
  runtimeModels: ReadonlyMap<string, RuntimeModel>,
  access: "credential" | "unknown",
): CatalogModelDraft[] {
  const models: CatalogModelDraft[] = [];
  for (const id of membership) {
    const runtimeId = `opencode-go/${id}`;
    const runtime = runtimeModels.get(id);
    if (runtime === undefined) {
      // Listed publicly but not resolvable by the installed runtime yet.
      models.push({
        id,
        runtimeId,
        label: labelFromModelId(id),
        description: "Listed by OpenCode Go but not yet available in the installed opencode build.",
        reasoningOptions: [],
        defaultReasoningEffort: null,
        effortsKnown: false,
        runtimeCompatibility: "unsupported",
        access: "catalog",
        aliasTarget: null,
        recommended: false,
        upgrade: null,
      });
      continue;
    }
    const hasVariants = runtime.variants.length > 0;
    const effortsKnown = hasVariants || runtime.reasoningCapable !== null;
    const reasoningOptions = hasVariants
      ? runtime.variants.map((variant) => catalogReasoningOption(variant))
      : [];
    models.push({
      id,
      runtimeId,
      label: runtime.name ?? labelFromModelId(id),
      description: "",
      reasoningOptions,
      // opencode exposes no provider default; omitting the variant argument
      // is the model's own default, which is what null means here.
      defaultReasoningEffort: null,
      effortsKnown,
      runtimeCompatibility: "supported",
      access,
      aliasTarget: null,
      recommended: false,
      upgrade: null,
    });
  }
  return models;
}

export class OpenCodeModelDiscoveryAdapter implements ModelDiscoveryAdapter {
  readonly provider = "opencode" as const;

  async discover(context: DiscoveryContext): Promise<DiscoveryOutcome> {
    let response: Response;
    try {
      response = await fetch(GO_CATALOG_URL, {
        signal: context.signal,
        headers: { accept: "application/json" },
      });
    } catch {
      throw new DiscoveryError("The OpenCode Go model catalog could not be reached.");
    }
    if (!response.ok) {
      throw new DiscoveryError("The OpenCode Go model catalog did not answer successfully.");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DiscoveryError("The OpenCode Go model catalog response was not valid JSON.");
    }
    const membership = parseGoCatalogMembership(payload);
    if (membership.length === 0) {
      return { models: [], runtimeVersion: null, source: "opencode Go catalog" };
    }

    const launch = await resolveOpencodeLaunch();
    if (launch.kind === "unresolved") {
      throw new DiscoveryError(
        launch.detail ?? "The opencode executable could not be resolved on this machine.",
      );
    }
    const { models: runtimeModels, refreshed } = await readOpenCodeRuntimeModels(
      launch,
      context.signal,
    );
    const credential = await getOpenCodeGoCredentialState();
    const access = credential.keySaved ? ("credential" as const) : ("unknown" as const);

    return {
      models: reconcileOpenCodeCatalog(membership, runtimeModels, access),
      runtimeVersion: await readRuntimeVersion(launch, context.signal),
      source: refreshed
        ? "opencode Go catalog + refreshed runtime metadata"
        : "opencode Go catalog + cached runtime metadata",
    };
  }
}
