import { describe, expect, it } from "vitest";

import {
  DEEP_READ_TOKENS,
  describeScopeLoad,
  estimateScopeLoad,
  formatVideoHours,
  FULL_READ_TOKENS,
  MAX_SCOPE_POSTS,
  MAX_SCOPE_VIDEO_HOURS,
  MAX_SCOPE_VIDEOS,
  planChatScope,
  readingBudgetTokens,
  scopeAdditionProblem,
  scopeReading,
  takeWhileFits,
  TOKENS_PER_POST,
  TOKENS_PER_VIDEO_HOUR,
  type ScopeCandidate,
} from "@/lib/ai/scope-selection";

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

/**
 * Selection sizing: a selection is measured by how much text it holds, not
 * how many sources it has, and the limits apply per kind and in hours.
 */
describe("scope load", () => {
  const hours = (count: number) => count * 3_600;

  it("weighs videos by length and posts by count", () => {
    const load = estimateScopeLoad([
      { kind: "video", durationSeconds: hours(3) },
      { kind: "video", durationSeconds: 30 * 60 },
      { kind: "tweet" },
      { kind: "tweet" },
    ]);
    expect(load).toEqual({
      videos: 2,
      posts: 2,
      videoSeconds: hours(3.5),
      tokens: 3.5 * TOKENS_PER_VIDEO_HOUR + 2 * TOKENS_PER_POST,
    });
    expect(describeScopeLoad(load)).toBe("2 videos · 3.5 h · 2 posts");
  });

  it("counts a video of unknown length as an hour", () => {
    const load = estimateScopeLoad([{ kind: "video", durationSeconds: null }]);
    expect(load.videoSeconds).toBe(hours(1));
    expect(load.tokens).toBe(TOKENS_PER_VIDEO_HOUR);
  });

  it("places a selection in the zone an answer can actually read", () => {
    const video = (h: number) => ({ kind: "video" as const, durationSeconds: hours(h) });
    expect(scopeReading(estimateScopeLoad([video(4)]))).toBe("full");
    expect(scopeReading(estimateScopeLoad([video(8)]))).toBe("deep");
    expect(scopeReading(estimateScopeLoad([video(12)]))).toBe("summarized");
    // 500 posts are still read in full.
    expect(
      scopeReading(
        estimateScopeLoad(Array.from({ length: 500 }, () => ({ kind: "tweet" as const }))),
      ),
    ).toBe("full");
    expect(readingBudgetTokens("deep")).toBe(DEEP_READ_TOKENS);
    expect(readingBudgetTokens("balanced")).toBe(FULL_READ_TOKENS);
    expect(readingBudgetTokens("brief")).toBe(FULL_READ_TOKENS);
  });

  it("refuses the next source past each limit, by kind and in hours", () => {
    const posts = estimateScopeLoad(
      Array.from({ length: MAX_SCOPE_POSTS }, () => ({ kind: "tweet" as const })),
    );
    expect(scopeAdditionProblem(posts, { kind: "tweet" })).toContain("up to 500 posts");
    // A full post selection still takes a video.
    expect(scopeAdditionProblem(posts, { kind: "video", durationSeconds: 600 })).toBeNull();

    const videos = estimateScopeLoad(
      Array.from({ length: MAX_SCOPE_VIDEOS }, () => ({
        kind: "video" as const,
        durationSeconds: 60,
      })),
    );
    expect(scopeAdditionProblem(videos, { kind: "video", durationSeconds: 60 })).toContain(
      "up to 25 videos",
    );

    const long = estimateScopeLoad([{ kind: "video", durationSeconds: hours(48) }]);
    expect(scopeAdditionProblem(long, { kind: "video", durationSeconds: hours(3) })).toContain(
      `up to ${MAX_SCOPE_VIDEO_HOURS} hours`,
    );
    expect(scopeAdditionProblem(long, { kind: "video", durationSeconds: hours(2) })).toBeNull();
  });

  it("takes the leading run of sources that fits", () => {
    const base = estimateScopeLoad([{ kind: "video", durationSeconds: hours(45) }]);
    const candidates = [
      { kind: "video" as const, durationSeconds: hours(2), id: "a" },
      { kind: "video" as const, durationSeconds: hours(2), id: "b" },
      { kind: "video" as const, durationSeconds: hours(2), id: "c" },
      { kind: "video" as const, durationSeconds: 60, id: "d" },
    ];
    // "c" would cross 50 hours, so the run stops there — "Select newest 2".
    expect(takeWhileFits(base, candidates).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("formats hours compactly", () => {
    expect(formatVideoHours(45 * 60)).toBe("45 min");
    expect(formatVideoHours(hours(7.54))).toBe("7.5 h");
    expect(formatVideoHours(hours(12.4))).toBe("12 h");
  });
});

describe("chat preparing label", () => {
  it("names the summaries step apart from caption fetching", async () => {
    const { preparingLabel } = await import("@/components/ai/chat-engine");
    expect(preparingLabel({ done: 1, total: 3 })).toBe("Reading the videos — 1 of 3 ready…");
    expect(preparingLabel({ done: 1, total: 3, step: "summaries" })).toBe(
      "Summarizing the long videos first — 1 of 3 done…",
    );
    expect(preparingLabel({ done: 0, total: 1, step: "summaries" })).toBe(
      "Summarizing the long video first…",
    );
  });
});
