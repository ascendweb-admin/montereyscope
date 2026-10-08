/** Client-safe retrieval summaries. Opaque provider cursors never leave the server. */
export type RetrievalKind = "refresh" | "history";
export type RetrievalStatus =
  "running" | "complete" | "partial" | "failed" | "cancelled" | "interrupted";
export interface RetrievalRequest {
  kind: RetrievalKind;
  listId: number | null;
  label: string;
  creatorIds: number[];
  since: string;
  until: string;
  initialDays: number;
  /** Pages per creator per attempt; null scales the budget to each creator's window. */
  maxPages: number | null;
}
export const MAX_PAGE_BUDGET = 300;
/**
 * Busy accounts fill a ~20-post page per day, often more with reposts; the margin covers the
 * two older pages that qualify a date boundary.
 */
export function autoPageBudget(days: number): number {
  const pages = Number.isFinite(days) ? Math.ceil(Math.max(0, days) * 1.5) + 4 : 10;
  return Math.min(MAX_PAGE_BUDGET, Math.max(10, pages));
}
export interface RetrievalCreatorProgress {
  creatorId: number;
  name: string;
  mode: "initial" | "catchup" | "history";
  status: RetrievalStatus;
  pages: number;
  newPosts: number;
  updatedPosts: number;
  oldest: string | null;
  newest: string | null;
  reason: string | null;
  error: string | null;
  /** Provider failure code behind `error`, when known. */
  errorCode?: string | null;
  retryAt: string | null;
}
export interface RetrievalJob {
  id: string;
  request: RetrievalRequest;
  status: RetrievalStatus;
  createdAt: string;
  finishedAt: string | null;
  creators: RetrievalCreatorProgress[];
}
export interface RetrievalCoverage {
  creatorId: number;
  initialized: boolean;
  lastSuccessfulRefresh: string | null;
  newestObserved: string | null;
  pendingHead: boolean;
  historySince: string | null;
  historyUntil: string | null;
  historyStatus: string | null;
}
export const RETRIEVAL_REASONS: Record<string, string> = {
  overlap: "Caught up to the saved overlap; upstream completeness unverified",
  boundary: "Requested boundary reached; upstream completeness unverified",
  provider_end: "Provider returned no more pages; exhaustive history unverified",
  page_budget: "Page budget reached; resume manually",
  time_budget: "Time budget reached; resume manually",
  cursor_stall: "Pagination stalled; resume restarts the bounded traversal",
  cursor_reset: "Saved cursor was rejected; traversal restarted with deduplication",
  gap: "Prior overlap was not recovered; partially caught up",
  skipped: "Some provider entries were unreadable; coverage remains partial",
  cancelled: "Cancelled; committed pages are preserved",
  interrupted: "Interrupted by application restart; resume manually",
  configuration: "Provider configuration changed; start a new retrieval",
  waiting: "Waiting for X before continuing automatically",
};
