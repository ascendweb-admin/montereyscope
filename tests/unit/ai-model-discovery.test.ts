/**
 * Provider discovery parsing and reconciliation tests (dynamic catalog stage).
 *
 * These use recorded, sanitized fixtures rather than live provider calls:
 * Codex `model/list` pages, `opencode models --verbose` output, and Claude
 * Agent SDK `ModelInfo` rows. The live probes remain opt-in and account
 * scoped; nothing here submits a prompt or spends quota.
 */
import { describe, expect, it } from "vitest";

import {
  parseGoCatalogMembership,
  parseOpenCodeModelsOutput,
  reconcileOpenCodeCatalog,
} from "@/lib/ai/models/adapters/opencode";
import { normalizeClaudeModels } from "@/lib/ai/models/adapters/claude";
import { DiscoveryError } from "@/lib/ai/models/adapters/types";

/** Sanitized excerpt of `opencode models opencode-go --refresh --verbose`. */
const OPENCODE_FIXTURE = `
Models cache refreshed
opencode-go/deepseek-v4-flash
{
  "id": "deepseek-v4-flash",
  "providerID": "opencode-go",
  "name": "DeepSeek V4 Flash",
  "family": "deepseek-flash",
  "status": "active",
  "capabilities": {
    "reasoning": true,
    "toolcall": true
  },
  "variants": {
    "low": { "reasoningEffort": "low" },
    "high": { "reasoningEffort": "high" },
    "max": { "reasoningEffort": "max" }
  }
}
opencode-go/glm-5.1
{
  "id": "glm-5.1",
  "providerID": "opencode-go",
  "name": "GLM-5.1",
  "status": "active",
  "capabilities": { "reasoning": false },
  "variants": {}
}
opencode-go/other-provider
{
  "id": "other-provider",
  "providerID": "zen",
  "name": "Not Go",
  "variants": {}
}
`;

describe("OpenCode discovery parsing", () => {
  it("extracts only opencode-go entries with bounded variants", () => {
    const models = parseOpenCodeModelsOutput(OPENCODE_FIXTURE);
    expect([...models.keys()]).toEqual(["deepseek-v4-flash", "glm-5.1"]);
    const flash = models.get("deepseek-v4-flash");
    expect(flash).toMatchObject({
      name: "DeepSeek V4 Flash",
      reasoningCapable: true,
      variants: ["high", "low", "max"],
    });
    expect(models.get("glm-5.1")).toMatchObject({
      reasoningCapable: false,
      variants: [],
    });
  });

  it("tolerates banners and malformed JSON blocks", () => {
    const models = parseOpenCodeModelsOutput(
      `warning: something\n{"providerID":"opencode-go","id":"a","name":}\n{"providerID":"opencode-go","id":"b"}`,
    );
    expect([...models.keys()]).toEqual(["b"]);
  });

  it("parses Go membership and rejects unusable payloads", () => {
    expect(
      parseGoCatalogMembership({
        object: "list",
        data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-flash" }, { id: "glm-5.1" }],
      }),
    ).toEqual(["deepseek-v4-flash", "glm-5.1"]);
    expect(() => parseGoCatalogMembership("nope")).toThrow(DiscoveryError);
    expect(() => parseGoCatalogMembership({})).toThrow(DiscoveryError);
  });

  it("reconciles membership order with runtime capabilities", () => {
    const runtime = parseOpenCodeModelsOutput(OPENCODE_FIXTURE);
    const models = reconcileOpenCodeCatalog(
      ["glm-5.1", "deepseek-v4-flash", "brand-new-model"],
      runtime,
      "credential",
    );
    // Provider membership order is preserved.
    expect(models.map((model) => model.id)).toEqual([
      "glm-5.1",
      "deepseek-v4-flash",
      "brand-new-model",
    ]);
    expect(models[0]).toMatchObject({
      runtimeId: "opencode-go/glm-5.1",
      runtimeCompatibility: "supported",
      // reasoning: false is a confirmed lack, not unknown capabilities.
      effortsKnown: true,
      reasoningOptions: [],
      defaultReasoningEffort: null,
      access: "credential",
    });
    expect(models[1]).toMatchObject({
      runtimeCompatibility: "supported",
      effortsKnown: true,
      defaultReasoningEffort: null,
    });
    expect(models[1].reasoningOptions.map((option) => option.id)).toEqual(["high", "low", "max"]);
    // A catalog-only model stays visible but is never advertised as ready.
    expect(models[2]).toMatchObject({
      runtimeCompatibility: "unsupported",
      effortsKnown: false,
      access: "catalog",
      label: "Brand New Model",
    });
  });

  it("leaves runtime models without capability metadata unknown", () => {
    const runtime = parseOpenCodeModelsOutput(
      `{"providerID":"opencode-go","id":"mystery","name":"Mystery"}`,
    );
    const models = reconcileOpenCodeCatalog(["mystery"], runtime, "unknown");
    expect(models[0]).toMatchObject({
      runtimeCompatibility: "supported",
      effortsKnown: false,
      reasoningOptions: [],
      access: "unknown",
    });
  });
});

describe("Claude discovery normalization", () => {
  it("keeps the existing public ids for provider family aliases", () => {
    const models = normalizeClaudeModels([
      {
        value: "sonnet",
        resolvedModel: "claude-sonnet-5",
        displayName: "Sonnet",
        description: "Efficient for routine tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Haiku",
        description: "Fastest for quick answers",
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        description: "Deepest reasoning",
        supportsEffort: true,
        supportedEffortLevels: ["low", "ultra-not-real", "max"],
      },
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "claude-sonnet",
      "claude-haiku",
      "claude-opus",
    ]);
    expect(models[0]).toMatchObject({
      runtimeId: "sonnet",
      aliasTarget: "claude-sonnet-5",
      effortsKnown: true,
      runtimeCompatibility: "supported",
      access: "unknown",
    });
    expect(models[0].reasoningOptions.map((option) => option.label)).toEqual([
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Maximum",
    ]);
    // Omitted capability metadata stays unknown.
    expect(models[1]).toMatchObject({ runtimeId: "haiku", effortsKnown: false });
    expect(models[1].reasoningOptions).toEqual([]);
    // New runtime-reported levels remain selectable without a Scope release.
    expect(models[2].reasoningOptions.map((option) => option.id)).toEqual([
      "low",
      "ultra-not-real",
      "max",
    ]);
  });

  it("admits new families and pinned ids without hardcoding", () => {
    const models = normalizeClaudeModels([
      {
        value: "fable",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable",
        description: "Most capable",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        value: "claude-fable-5-1",
        resolvedModel: "claude-fable-5-1",
        displayName: "Fable 5.1 (pinned)",
        description: "Pinned build",
        supportsEffort: true,
        supportedEffortLevels: ["high"],
      },
      {
        value: "opus[1m]",
        resolvedModel: "claude-opus-5[1m]",
        displayName: "Opus (1M context)",
        description: "1M context",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
      {
        value: "default",
        resolvedModel: "claude-opus-5",
        displayName: "Default (recommended)",
        description: "Use the default model",
        supportsEffort: true,
        supportedEffortLevels: ["low"],
      },
    ]);
    expect(models.map((model) => model.id)).toEqual([
      "claude-fable",
      "claude-fable-5-1",
      "claude-opus-1m",
      "claude-default",
    ]);
    // Exact runtime ids are retained even when the public id is slugged.
    expect(models[2]).toMatchObject({
      runtimeId: "opus[1m]",
      aliasTarget: "claude-opus-5[1m]",
    });
    expect(models[3].recommended).toBe(true);
  });

  it("drops empty values and deduplicates colliding slugs", () => {
    const models = normalizeClaudeModels([
      { value: "", displayName: "", description: "" },
      { value: "some model!", displayName: "A", description: "" },
      { value: "some-model", displayName: "B", description: "" },
    ]);
    expect(models).toHaveLength(2);
    expect(new Set(models.map((model) => model.id)).size).toBe(2);
  });
});

it("accepts an authoritative empty Claude catalog", async () => {
  const { ClaudeModelDiscoveryAdapter } = await import("@/lib/ai/models/adapters/claude");
  const adapter = new ClaudeModelDiscoveryAdapter(async () => async () => []);
  expect((await adapter.discover({ signal: new AbortController().signal })).models).toEqual([]);
});

it("escalates to SIGKILL when an OpenCode probe ignores SIGTERM", async () => {
  if (process.platform === "win32") return;
  const { runOpenCodeProbe } = await import("@/lib/ai/models/adapters/opencode");
  const result = await runOpenCodeProbe(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM",()=>{}); process.stdout.write(String(process.pid)); setInterval(()=>{},1000);',
    ],
    new AbortController().signal,
    500,
  );
  expect(result.exitCode).toBeNull();
  const pid = Number(result.stdout);
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow();
}, 5000);
