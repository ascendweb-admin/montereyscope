/**
 * Client-safe selection validation and sizing for AI chat scopes (stage 5).
 * Pure functions — no database, no server imports — so channel feeds, tweet
 * timelines, and the chat source picker can all validate a selection before
 * opening the chat panel.
 *
 * This is the pre-flight mirror of the server's resolveSourceScope: posts
 * without complete text are excluded from the scope and reported back so the
 * UI can say exactly what was skipped. Videos are always analyzable — the
 * server reads their captions in the background when the analysis starts.
 * The server re-validates on POST.
 *
 * A selection is measured by how much text it holds, not by how many sources
 * it has: a three-hour livestream carries as much as a thousand posts. The
 * estimates below come from the library itself (captions run ~15 bytes per
 * second of speech; a post renders to ~400–650 bytes), and the reading
 * budgets from measured runs — how much one answer actually reads closely.
 */
import { sourceKey, type ContentKind, type SourceRef } from "@/lib/content/model";

/** The parts of a video scope candidate that selection validation looks at. */
export type ScopeCandidate = { id: string; title: string };

/** The parts of a mixed-source candidate that validation looks at. */
export interface SourceCandidate {
  kind: ContentKind;
  id: string;
  title: string;
  /** Video: always true (captions are fetched on demand). Tweet: complete cached text. */
  readyForAnalysis: boolean;
}

// ---------------------------------------------------------------------------
// Limits and reading budgets
// ---------------------------------------------------------------------------

/** Most videos one analysis takes. Enforced while picking and by the routes. */
export const MAX_SCOPE_VIDEOS = 25;

/** Most posts one analysis takes; bigger post sets belong in X research. */
export const MAX_SCOPE_POSTS = 500;

/** Most hours of video one analysis takes, summed over the selected videos. */
export const MAX_SCOPE_VIDEO_HOURS = 50;

/** Captions hold ~14k tokens per hour of speech (≈15 bytes a second). */
export const TOKENS_PER_VIDEO_HOUR = 14_000;

/** One bundled post — header, text, quoted text — is ~120 tokens on average. */
export const TOKENS_PER_POST = 120;

/** Videos with no known length (upcoming, live) count as an hour. */
const UNKNOWN_VIDEO_SECONDS = 3_600;

/**
 * How much source text one answer reads closely in every mode: Balanced runs
 * measured 45–65k tokens of reading regardless of the selection's size.
 */
export const FULL_READ_TOKENS = 60_000;

/** How much Deep reads closely: it read ~135k tokens (10 hours) end to end. */
export const DEEP_READ_TOKENS = 150_000;

/** Where a selection's size lands: what an answer can actually read. */
export type ScopeReading =
  /** Every mode reads all of it. */
  | "full"
  /** Deep reads it in full; other modes summarize the long videos first. */
  | "deep"
  /** Too long for one pass in any mode: long videos are summarized first. */
  | "summarized";

/** The size of a selection, as the meter and the routes measure it. */
export interface ScopeLoad {
  videos: number;
  posts: number;
  /** Summed video length; unknown lengths count as an hour. */
  videoSeconds: number;
  /** Estimated reading size in tokens. */
  tokens: number;
}

/** What sizing needs from a source: its kind and, for videos, its length. */
export interface LoadItem {
  kind: ContentKind;
  durationSeconds?: number | null;
}

export const EMPTY_SCOPE_LOAD: ScopeLoad = { videos: 0, posts: 0, videoSeconds: 0, tokens: 0 };

function videoSeconds(durationSeconds: number | null | undefined): number {
  return typeof durationSeconds === "number" && durationSeconds > 0
    ? durationSeconds
    : UNKNOWN_VIDEO_SECONDS;
}

/** Estimated reading size of one video's transcript. */
export function videoTokens(durationSeconds: number | null | undefined): number {
  return Math.round((videoSeconds(durationSeconds) / 3_600) * TOKENS_PER_VIDEO_HOUR);
}

/** The load with one more source counted in. */
export function addToScopeLoad(load: ScopeLoad, item: LoadItem): ScopeLoad {
  if (item.kind === "video") {
    return {
      ...load,
      videos: load.videos + 1,
      videoSeconds: load.videoSeconds + videoSeconds(item.durationSeconds),
      tokens: load.tokens + videoTokens(item.durationSeconds),
    };
  }
  return { ...load, posts: load.posts + 1, tokens: load.tokens + TOKENS_PER_POST };
}

/** Measures a selection. */
export function estimateScopeLoad(items: readonly LoadItem[]): ScopeLoad {
  return items.reduce(addToScopeLoad, EMPTY_SCOPE_LOAD);
}

/** What an answer can read of a selection this size. */
export function scopeReading(load: ScopeLoad): ScopeReading {
  if (load.tokens <= FULL_READ_TOKENS) return "full";
  return load.tokens <= DEEP_READ_TOKENS ? "deep" : "summarized";
}

/**
 * How much a run in this mode reads closely. Deep chats and Deep reports read
 * the most; Quick, Balanced, and the Brief and Balanced report profiles share
 * the everyday budget.
 */
export function readingBudgetTokens(mode: string): number {
  return mode === "deep" ? DEEP_READ_TOKENS : FULL_READ_TOKENS;
}

/** The limit a load is past — "Analyses take up to 25 videos at once." — or null. */
export function scopeLimitProblem(load: ScopeLoad): string | null {
  if (load.videos > MAX_SCOPE_VIDEOS) {
    return `Analyses take up to ${MAX_SCOPE_VIDEOS} videos at once.`;
  }
  if (load.posts > MAX_SCOPE_POSTS) {
    return `Analyses take up to ${MAX_SCOPE_POSTS} posts at once.`;
  }
  if (load.videoSeconds > MAX_SCOPE_VIDEO_HOURS * 3_600) {
    return `Analyses take up to ${MAX_SCOPE_VIDEO_HOURS} hours of video at once.`;
  }
  return null;
}

/** Why `item` cannot join a selection of this load, as the pickers say it, or null. */
export function scopeAdditionProblem(load: ScopeLoad, item: LoadItem): string | null {
  const problem = scopeLimitProblem(addToScopeLoad(load, item));
  return problem === null ? null : `${problem} Deselect some to add others.`;
}

/**
 * The leading run of `items` that fits next to `load`, in order — what a
 * "Select all" can take before the next source would cross a limit.
 */
export function takeWhileFits<T extends LoadItem>(load: ScopeLoad, items: readonly T[]): T[] {
  const taken: T[] = [];
  let current = load;
  for (const item of items) {
    const next = addToScopeLoad(current, item);
    if (scopeLimitProblem(next) !== null) break;
    taken.push(item);
    current = next;
  }
  return taken;
}

/** "45 min", "7.5 h", "12 h". */
export function formatVideoHours(seconds: number): string {
  if (seconds < 3_600) {
    return `${Math.max(1, Math.round(seconds / 60))} min`;
  }
  const hours = seconds / 3_600;
  return `${hours < 10 ? Math.round(hours * 10) / 10 : Math.round(hours)} h`;
}

/** "3 videos · 7.5 h · 120 posts" — what a selection holds. */
export function describeScopeLoad(load: ScopeLoad): string {
  const parts: string[] = [];
  if (load.videos > 0) {
    parts.push(`${load.videos} ${load.videos === 1 ? "video" : "videos"}`);
    parts.push(formatVideoHours(load.videoSeconds));
  }
  if (load.posts > 0) {
    parts.push(`${load.posts} ${load.posts === 1 ? "post" : "posts"}`);
  }
  return parts.join(" · ");
}

/** The meter's wording per reading zone. */
export const SCOPE_READING_COPY: Record<ScopeReading, { label: string; hint: string }> = {
  full: {
    label: "Read in full",
    hint: "Every mode reads all of it.",
  },
  deep: {
    label: "Full transcripts in Deep",
    hint: "Quick and Balanced use summaries for longer videos.",
  },
  summarized: {
    label: "Long videos summarized first",
    hint: "Too long to read in one go: Scope summarizes the longest videos, then reads every summary.",
  },
};

export interface ScopePlan {
  /** Selected videos, in selection order. */
  included: ScopeCandidate[];
  /** Convenience: the ids of {@link included}, ready for the chat panel. */
  videoIds: string[];
}

/**
 * Collapses a video selection into a chat scope. Repeated ids collapse to
 * their first occurrence, mirroring the server's resolveSourceScope.
 */
export function planChatScope(selected: readonly ScopeCandidate[]): ScopePlan {
  const seen = new Set<string>();
  const included: ScopeCandidate[] = [];
  for (const candidate of selected) {
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    included.push(candidate);
  }
  return { included, videoIds: included.map((video) => video.id) };
}

export interface SourcePlan {
  /** Selected sources ready for analysis, in selection order. */
  included: SourceCandidate[];
  /** Selected sources without content yet, in selection order. */
  skippedNotReady: SourceCandidate[];
  /** Ready references, ready for the API request. */
  sources: SourceRef[];
  /** The included video ids only, for legacy video-only panels. */
  videoIds: string[];
}

/**
 * Mixed-source counterpart of {@link planChatScope}: partitions a selection
 * of videos and tweets by readiness. Duplicates collapse to their first
 * occurrence; kinds are never conflated.
 */
export function planSourceScope(selected: readonly SourceCandidate[]): SourcePlan {
  const seen = new Set<string>();
  const included: SourceCandidate[] = [];
  const skippedNotReady: SourceCandidate[] = [];
  for (const candidate of selected) {
    const key = sourceKey(candidate);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (candidate.readyForAnalysis) {
      included.push(candidate);
    } else {
      skippedNotReady.push(candidate);
    }
  }
  return {
    included,
    skippedNotReady,
    sources: included.map((candidate) => ({ kind: candidate.kind, id: candidate.id })),
    videoIds: included.filter((candidate) => candidate.kind === "video").map((c) => c.id),
  };
}

/** Mixed-source variant: names how many videos/posts have no cached content. */
export function formatSkippedSources(skipped: readonly SourceCandidate[]): string {
  const count = skipped.length;
  if (count === 0) {
    return "";
  }
  const titles = skipped.map((source) => `“${source.title}”`).join(", ");
  return `Skipped ${count} ${count === 1 ? "source" : "sources"} without cached content: ${titles}.`;
}
