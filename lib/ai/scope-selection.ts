/**
 * Client-safe selection validation for AI chat scopes (stage 5). Pure
 * functions — no database, no server imports — so channel feeds, tweet
 * timelines, and the AI Research page can all validate a selection before
 * opening the chat panel.
 *
 * This is the pre-flight mirror of the server's resolveSourceScope: sources
 * without content are excluded from the scope and reported back so the UI can
 * say exactly what was skipped. The server re-validates on POST.
 */
import { sourceKey, type ContentKind, type SourceRef } from "@/lib/content/model";

/** The parts of a video scope candidate that selection validation looks at. */
export type ScopeCandidate = { id: string; title: string; hasTranscript: boolean };

/** The parts of a mixed-source candidate that validation looks at. */
export interface SourceCandidate {
  kind: ContentKind;
  id: string;
  title: string;
  /** Video: cached transcript exists. Tweet: complete cached text. */
  readyForAnalysis: boolean;
}

/**
 * Hard cap on one analysis: very large selections inflate every AI prompt
 * (token cost, latency) without adding signal. Enforced client-side — the
 * selection UI refuses the next source with a note — and server-side by the
 * chat and report routes. Applies across all source kinds.
 */
export const MAX_SCOPE_VIDEOS = 25;

/** Alias for mixed-source callers; the same cap under a clearer name. */
export const MAX_SCOPE_SOURCES = MAX_SCOPE_VIDEOS;

/** The refusal message shown when a selection would exceed the cap. */
export function formatScopeCapMessage(selected: number): string {
  return `Analyses are capped at ${MAX_SCOPE_VIDEOS} sources at once. This selection has ${selected} — deselect some to add others.`;
}

export interface ScopePlan {
  /** Selected videos that can ground a chat, in selection order. */
  included: ScopeCandidate[];
  /** Selected videos without a cached transcript, in selection order. */
  skippedNoTranscript: ScopeCandidate[];
  /** Convenience: the ids of {@link included}, ready for the chat panel. */
  videoIds: string[];
}

/**
 * Partitions a selection into videos that can ground a chat and videos
 * without a cached transcript. Repeated ids collapse to their first
 * occurrence, mirroring the server's resolveSourceScope.
 */
export function planChatScope(selected: readonly ScopeCandidate[]): ScopePlan {
  const seen = new Set<string>();
  const included: ScopeCandidate[] = [];
  const skippedNoTranscript: ScopeCandidate[] = [];
  for (const candidate of selected) {
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    if (candidate.hasTranscript) {
      included.push(candidate);
    } else {
      skippedNoTranscript.push(candidate);
    }
  }
  return { included, skippedNoTranscript, videoIds: included.map((video) => video.id) };
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

/**
 * One-line note naming what was skipped, e.g. "Skipped 2 videos without a
 * cached transcript: “A”, “B”." Empty string for nothing skipped.
 */
export function formatSkippedTranscripts(skipped: readonly ScopeCandidate[]): string {
  const count = skipped.length;
  if (count === 0) {
    return "";
  }
  const titles = skipped.map((video) => `“${video.title}”`).join(", ");
  return `Skipped ${count} ${count === 1 ? "video" : "videos"} without a cached transcript: ${titles}.`;
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
