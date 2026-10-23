/**
 * The selection limits as the chat and report routes enforce them (see
 * scope-selection.ts for the limits themselves). The pickers refuse the next
 * source while picking; the routes re-check so a stale client or a
 * hand-written request gets the same readable refusal. Server-only.
 */
import { sourceKey, type SourceRef } from "@/lib/content/model";

import type { SourceScopeResolution } from "./scope";
import { estimateScopeLoad, scopeLimitProblem, type ScopeLoad } from "./scope-selection";

/**
 * A request's size: every distinct requested reference by kind, with the
 * lengths of the videos the cache knows. Without a resolution (before any
 * database work) videos count as an hour each, so only the count limits can
 * refuse at that point.
 */
export function scopeLoadOf(
  refs: readonly SourceRef[],
  resolution?: SourceScopeResolution,
): ScopeLoad {
  const durations = new Map(
    (resolution?.sources ?? [])
      .filter((source) => source.kind === "video")
      .map((source) => [source.id, source.durationSeconds ?? null]),
  );
  const unique = new Map(refs.map((ref) => [sourceKey(ref), ref]));
  return estimateScopeLoad(
    [...unique.values()].map((ref) => ({
      kind: ref.kind,
      durationSeconds: ref.kind === "video" ? durations.get(ref.id) : undefined,
    })),
  );
}

/** A 422 refusal for a selection past the limits, or null when it fits. */
export function scopeLimitResponse(load: ScopeLoad): Response | null {
  const problem = scopeLimitProblem(load);
  if (problem === null) {
    return null;
  }
  return Response.json(
    { error: { code: "scope_too_large", message: `${problem} Deselect a few and try again.` } },
    { status: 422, headers: { "Cache-Control": "no-store" } },
  );
}
