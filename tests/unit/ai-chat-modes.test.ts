import { describe, expect, it } from "vitest";

import {
  CHAT_MODE_OPTIONS,
  DEFAULT_CHAT_MODE,
  chatModeOption,
  isChatModeId,
} from "@/components/ai/chat-modes";
import {
  buildFirstTurnPrompt,
  buildModeSwitchInstruction,
  buildModeSwitchPrompt,
  buildSystemInstruction,
  SYSTEM_INSTRUCTION,
} from "@/lib/ai/chat";
import { CHAT_MODES, getChatMode } from "@/lib/ai/chat-modes";

/**
 * The chat intelligence modes: their configuration, the prompt composition,
 * and the client mirror that the panel renders from. The client must never
 * import the server-only AI layer, so these tests are the drift guard.
 */
describe("chat mode configuration", () => {
  it("offers quick, balanced, and deep with distinct shared behavior", () => {
    expect(CHAT_MODES.map((mode) => mode.id)).toEqual(["quick", "balanced", "deep"]);

    const quick = getChatMode("quick");
    expect(quick.timeoutMs).toBe(5 * 60_000);

    const balanced = getChatMode("balanced");
    expect(balanced.timeoutMs).toBe(10 * 60_000);

    const deep = getChatMode("deep");
    expect(deep.timeoutMs).toBe(15 * 60_000);
  });

  it("defaults to the deep mode", () => {
    expect(DEFAULT_CHAT_MODE).toBe("deep");
  });

  it("validates untrusted mode ids", () => {
    expect(isChatModeId("quick")).toBe(true);
    expect(isChatModeId("deep")).toBe(true);
    expect(isChatModeId("ultra")).toBe(false);
    expect(isChatModeId(undefined)).toBe(false);
    expect(isChatModeId(42)).toBe(false);
  });

  it("gives every mode a grounding-plus-directive instruction with citation rules", () => {
    for (const mode of CHAT_MODES) {
      const instruction = buildSystemInstruction(mode.id);
      expect(instruction).toContain("scope analysis job directory");
      expect(instruction).toContain("transcripts/dQw4w9WgXcQ.txt");
      expect(instruction).toContain("never wrapped in parentheses");
      expect(instruction).toContain(mode.directive);
    }
  });

  it("keeps the exported SYSTEM_INSTRUCTION as the deep seed", () => {
    expect(SYSTEM_INSTRUCTION).toBe(buildSystemInstruction("deep"));
    expect(SYSTEM_INSTRUCTION).toContain("deep-research mode");
    // Quick's conversational directive must not leak into the deep seed.
    expect(SYSTEM_INSTRUCTION).not.toContain("Stay conversational");
  });

  it("composes mode-switch prompts ahead of the user message", () => {
    const instruction = buildModeSwitchInstruction("quick");
    expect(instruction).toContain("Mode switched to Quick");
    expect(instruction).toContain(getChatMode("quick").directive);

    const prompt = buildModeSwitchPrompt("quick", "Follow-up?");
    expect(prompt).toContain(instruction);
    expect(prompt.endsWith("---\n\nFollow-up?")).toBe(true);
  });

  it("composes the seeded first-turn prompt as instruction, separator, request", () => {
    const prompt = buildFirstTurnPrompt("INSTRUCTION", "Question?");
    expect(prompt).toBe("INSTRUCTION\n\n---\n\nAnalyst request:\n\nQuestion?");
  });
});

describe("chat mode client mirror", () => {
  it("matches the server configuration field for field", () => {
    expect(CHAT_MODE_OPTIONS).toHaveLength(CHAT_MODES.length);
    for (const [index, serverMode] of CHAT_MODES.entries()) {
      const clientOption = CHAT_MODE_OPTIONS[index];
      expect(clientOption).toBeDefined();
      expect(clientOption?.id).toBe(serverMode.id);
      expect(clientOption?.label).toBe(serverMode.label);
      expect(clientOption?.tagline).toBe(serverMode.tagline);
      expect(clientOption?.workingLabel).toBe(serverMode.workingLabel);
    }
  });

  it("falls back to the default mode for unknown ids", () => {
    // chatModeOption's parameter is a validated ChatModeId; the fallback
    // guards summary rows from older servers, exercised through the cast.
    const option = chatModeOption("nonexistent" as never);
    expect(option.id).toBe(DEFAULT_CHAT_MODE);
  });
});
