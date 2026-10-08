import { describe, expect, it } from "vitest";

import { planChatScope, type ScopeCandidate } from "@/lib/ai/scope-selection";

/**
 * Scope selection validation (stage 5): the client-side mirror of the
 * server's resolveScope. Selections keep their order, and every video can
 * ground a chat — captions are read in the background when it starts.
 */

const video = (id: string, title = `Video ${id}`): ScopeCandidate => ({ id, title });

describe("planChatScope", () => {
  it("keeps every selected video in selection order", () => {
    const plan = planChatScope([video("b"), video("a"), video("c")]);
    expect(plan.videoIds).toEqual(["b", "a", "c"]);
    expect(plan.included.map((candidate) => candidate.id)).toEqual(["b", "a", "c"]);
  });

  it("collapses repeated ids to their first occurrence, like resolveScope", () => {
    const first = video("a", "First copy");
    const plan = planChatScope([first, video("a", "Second copy"), video("b")]);
    expect(plan.videoIds).toEqual(["a", "b"]);
    expect(plan.included[0]).toBe(first);
  });

  it("produces an empty plan for an empty selection", () => {
    const plan = planChatScope([]);
    expect(plan.videoIds).toEqual([]);
    expect(plan.included).toEqual([]);
  });
});
