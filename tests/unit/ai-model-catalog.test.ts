import { describe, expect, it } from "vitest";

import {
  AI_MODEL_OPTIONS,
  DEFAULT_AI_CHAT_MODE_SETTINGS,
  getProviderModel,
  getRuntimeModel,
} from "@/lib/ai/model-catalog";

describe("AI model catalog", () => {
  it("keeps the requested first-run matrix explicit", () => {
    expect(DEFAULT_AI_CHAT_MODE_SETTINGS).toEqual({
      codex: {
        quick: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        balanced: { model: "gpt-5.6-terra", reasoningEffort: "medium" },
        deep: { model: "gpt-5.6-sol", reasoningEffort: "xhigh" },
      },
      opencode: {
        quick: { model: "gpt-5.6-luna", reasoningEffort: "low" },
        balanced: { model: "deepseek-v4-flash", reasoningEffort: "high" },
        deep: { model: "deepseek-v4-pro", reasoningEffort: "max" },
      },
      claude: {
        quick: { model: "claude-haiku", reasoningEffort: null },
        balanced: { model: "claude-sonnet", reasoningEffort: "medium" },
        deep: { model: "claude-opus", reasoningEffort: "xhigh" },
      },
    });
  });

  it("exposes only the variants supported by the selected model", () => {
    expect(getProviderModel("codex", "gpt-5.6-luna")?.reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getProviderModel("codex", "gpt-5.6-sol")?.reasoningEfforts).toContain("ultra");
    expect(getProviderModel("opencode", "deepseek-v4-flash")?.reasoningEfforts).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(getProviderModel("opencode", "deepseek-v4-pro")?.reasoningEfforts).toEqual([
      "high",
      "max",
    ]);
    expect(getProviderModel("opencode", "glm-5.1")?.reasoningEfforts).toEqual([]);
    expect(getProviderModel("opencode", "glm-5.1")?.defaultReasoningEffort).toBeNull();
    expect(getProviderModel("opencode", "minimax-m3")?.reasoningEfforts).toEqual([
      "none",
      "thinking",
    ]);
    // Haiku has no effort control; Sonnet and Opus expose the full ladder.
    expect(getProviderModel("claude", "claude-haiku")?.reasoningEfforts).toEqual([]);
    expect(getProviderModel("claude", "claude-haiku")?.defaultReasoningEffort).toBeNull();
    expect(getProviderModel("claude", "claude-sonnet")?.reasoningEfforts).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getProviderModel("claude", "claude-opus")?.reasoningEfforts).toContain("xhigh");
  });

  it("maps public model ids to provider-qualified runtime ids", () => {
    expect(getRuntimeModel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(getRuntimeModel("opencode", "deepseek-v4-pro")).toBe("opencode-go/deepseek-v4-pro");
    // Claude Code resolves its family aliases to the current model version.
    expect(getRuntimeModel("claude", "claude-haiku")).toBe("haiku");
    expect(getRuntimeModel("claude", "claude-sonnet")).toBe("sonnet");
    expect(getRuntimeModel("claude", "claude-opus")).toBe("opus");
    expect(AI_MODEL_OPTIONS.opencode).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gpt-5.6-luna",
          runtimeId: "opencode-go/gpt-5.6-luna",
        }),
      ]),
    );
  });

  it("includes every model currently exposed by OpenCode Go", () => {
    expect(AI_MODEL_OPTIONS.opencode.map((option) => option.id).sort()).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
      "glm-5.1",
      "glm-5.2",
      "glm-5.3",
      "glm-5.3-flash",
      "gpt-5.6-luna",
      "grok-4.6",
      "hy3",
      "hy4-preview",
      "kimi-k2.6",
      "kimi-k2.7-code",
      "kimi-k3",
      "longcat-2.0",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m2.7",
      "minimax-m3",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "omen-alpha",
      "qwen3.6-plus",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.8-flash",
      "qwen3.8-max",
    ]);
  });
});
