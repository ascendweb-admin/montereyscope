import { describe, expect, it } from "vitest";

import {
  formatSkippedTranscripts,
  planChatScope,
  type ScopeCandidate,
} from "@/lib/ai/scope-selection";

/**
 * Scope selection validation (stage 5): the client-side mirror of the
 * server's resolveScope. Selections keep their order; videos without a
 * cached transcript are excluded from the chat scope and reported.
 */

const withTranscript = (id: string, title = `Video ${id}`): ScopeCandidate => ({
  id,
  title,
  hasTranscript: true,
});

const withoutTranscript = (id: string, title = `Video ${id}`): ScopeCandidate => ({
  id,
  title,
  hasTranscript: false,
});

describe("planChatScope", () => {
  it("keeps every transcripted video in selection order", () => {
    const plan = planChatScope([withTranscript("b"), withTranscript("a"), withTranscript("c")]);
    expect(plan.videoIds).toEqual(["b", "a", "c"]);
    expect(plan.skippedNoTranscript).toEqual([]);
    expect(plan.included.map((video) => video.id)).toEqual(["b", "a", "c"]);
  });

  it("excludes videos without transcripts from the scope and reports them", () => {
    const skipped = withoutTranscript("n1", "No captions here");
    const plan = planChatScope([withTranscript("a"), skipped, withTranscript("b")]);
    expect(plan.videoIds).toEqual(["a", "b"]);
    expect(plan.skippedNoTranscript).toEqual([skipped]);
  });

  it("collapses repeated ids to their first occurrence, like resolveScope", () => {
    const plan = planChatScope([withTranscript("a"), withoutTranscript("a"), withTranscript("b")]);
    expect(plan.videoIds).toEqual(["a", "b"]);
    expect(plan.skippedNoTranscript).toEqual([]);
  });

  it("produces an empty plan for an empty selection", () => {
    const plan = planChatScope([]);
    expect(plan.videoIds).toEqual([]);
    expect(plan.included).toEqual([]);
    expect(plan.skippedNoTranscript).toEqual([]);
  });

  it("reports an all-untranscribed selection as entirely skipped", () => {
    const plan = planChatScope([withoutTranscript("n1"), withoutTranscript("n2")]);
    expect(plan.videoIds).toEqual([]);
    expect(plan.included).toEqual([]);
    expect(plan.skippedNoTranscript.map((video) => video.id)).toEqual(["n1", "n2"]);
  });
});

describe("formatSkippedTranscripts", () => {
  it("returns an empty string when nothing was skipped", () => {
    expect(formatSkippedTranscripts([])).toBe("");
  });

  it("uses the singular for one skipped video and names it", () => {
    const note = formatSkippedTranscripts([withoutTranscript("n1", "No captions here")]);
    expect(note).toBe("Skipped 1 video without a cached transcript: “No captions here”.");
  });

  it("uses the plural and lists every skipped title", () => {
    const note = formatSkippedTranscripts([
      withoutTranscript("n1", "First"),
      withoutTranscript("n2", "Second"),
    ]);
    expect(note).toBe("Skipped 2 videos without a cached transcript: “First”, “Second”.");
  });
});
