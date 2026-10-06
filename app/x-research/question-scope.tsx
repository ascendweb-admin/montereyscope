"use client";

import { CalendarRange, TriangleAlert, Users } from "lucide-react";

import type { ExactSearch, ResearchPostType } from "@/lib/x/research/model";

/** A deliberate question-scope draft, not an executed corpus or evidence snapshot. */
export interface QuestionScopeDraft {
  kind: "list" | "results" | "selected";
  listId: number | null;
  start: string;
  end: string;
  period: string;
  question?: string;
  label: string;
  creatorIds: number[];
  bounds: { since: string; until: string };
  timezone: string;
  types: ResearchPostType[];
  search?: ExactSearch;
  tweetIds?: string[];
  count: number;
  browsingKey: string;
}

/** Compact banner describing the prepared scope that the next scan will freeze. */
export function QuestionScope({ scope, changed }: { scope: QuestionScopeDraft; changed: boolean }) {
  const date = (value: string) =>
    new Date(value).toLocaleString(undefined, {
      timeZone: scope.timezone,
      dateStyle: "medium",
      timeStyle: "short",
    });
  return (
    <div
      aria-label="Prepared question scope"
      className="space-y-2 rounded-xl border border-ring/30 bg-primary/5 p-3.5"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-semibold">Prepared scope</span>
        <span className="rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
          {scope.label}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Users aria-hidden="true" className="size-3.5" />
          {scope.count.toLocaleString()}{" "}
          {scope.kind === "selected" ? "selected posts" : "cached posts"} ·{" "}
          {scope.creatorIds.length} creator{scope.creatorIds.length === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <CalendarRange aria-hidden="true" className="size-3.5" />
          {date(scope.bounds.since)} → {date(scope.bounds.until)} (end exclusive) ·{" "}
          {scope.timezone}
        </span>
        <span>{scope.types.join(", ")}</span>
      </div>
      {scope.search ? (
        <p className="break-words text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Search constraints:</span>{" "}
          required — {scope.search.terms.join("; ") || "none"} · aliases —{" "}
          {scope.search.aliases.join("; ") || "none"} · excluded —{" "}
          {scope.search.exclusions.join("; ") || "none"}.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Topic search does not constrain this question scope.
        </p>
      )}
      {scope.tweetIds && (
        <p className="text-xs text-muted-foreground">
          Only the selected tweets are included, including picks from other pages.
        </p>
      )}
      {changed && (
        <p role="status" className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />
          Browsing filters have changed. Choose an Ask action to replace this question scope.
        </p>
      )}
    </div>
  );
}
