"use client";
import { useEffect, useRef, useState } from "react";
import { CalendarClock, ChevronDown, RefreshCw, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import {
  RETRIEVAL_REASONS,
  type RetrievalCoverage,
  type RetrievalJob,
} from "@/lib/x/research/retrieval-model";
import { cn } from "@/lib/utils";

async function json<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "Retrieval could not be started. Please try again.",
    );
  return result;
}

const STATUS_DOT: Record<string, string> = {
  running: "bg-emerald-500",
  partial: "bg-amber-500",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground/50",
  complete: "bg-muted-foreground/40",
};

/**
 * The feed's sync strip: the two explicit retrieval actions (refresh the
 * list's feed, fetch the displayed date range for the selected creators),
 * their limits, live local progress for running or recent jobs, and the
 * durable archive coverage. Polling reads local status only — work never
 * resumes from a timer.
 */
export function RetrievalControls({
  listId,
  refreshIds,
  selected,
  start,
  end,
  timezone,
  period,
  onProgress,
  onViewNewDates,
}: {
  listId: number | null;
  refreshIds: number[];
  selected: number[];
  start: string;
  end: string;
  timezone: string;
  period: string;
  onProgress: () => void;
  onViewNewDates: () => void;
}) {
  const [jobs, setJobs] = useState<RetrievalJob[]>([]);
  const [coverage, setCoverage] = useState<RetrievalCoverage[]>([]);
  const [showAllJobs, setShowAllJobs] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialDays, setInitialDays] = useState(30);
  const [maxPages, setMaxPages] = useState(10);
  const [revision, setRevision] = useState(0);
  const progress = useRef(onProgress);
  useEffect(() => {
    progress.current = onProgress;
  }, [onProgress]);
  const fingerprint = useRef<string | null>(null);
  const limitsRef = useRef<HTMLDivElement>(null);
  const creatorsKey = selected.join(",");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const result = await json<{ jobs: RetrievalJob[]; coverage: RetrievalCoverage[] }>(
          `/api/x-research/retrieval?creators=${encodeURIComponent(creatorsKey)}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setJobs(result.jobs);
        setCoverage(result.coverage);
        const next = JSON.stringify(
          result.jobs.map((j) => [
            j.id,
            j.status,
            j.creators.map((c) => [c.pages, c.newPosts, c.updatedPosts]),
          ]),
        );
        if (fingerprint.current !== null && fingerprint.current !== next) progress.current();
        fingerprint.current = next;
        // Poll local progress only; this endpoint never resumes work or reads X.
        if (result.jobs.some((j) => j.status === "running")) timer = setTimeout(read, 1000);
      } catch (err) {
        if (!controller.signal.aborted)
          setError(err instanceof Error ? err.message : "Progress could not be loaded.");
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [creatorsKey, revision]);
  useEffect(() => {
    const futureRetries = jobs
      .flatMap((j) => j.creators)
      .map((c) => (c.retryAt ? Date.parse(c.retryAt) : 0))
      .filter((at) => at > Date.now());
    if (!futureRetries.length) return;
    // Refresh the local status when a provider wait ends; never resume retrieval on a timer.
    const timer = setTimeout(
      () => setRevision((r) => r + 1),
      Math.min(2_147_483_647, Math.min(...futureRetries) - Date.now() + 100),
    );
    return () => clearTimeout(timer);
  }, [jobs]);
  useEffect(() => {
    if (!showLimits) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (limitsRef.current && !limitsRef.current.contains(event.target as Node)) {
        setShowLimits(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showLimits]);
  const scopedJobs = jobs.filter((j) => showAllJobs || j.request.listId === listId);
  const recentCompleted = new Set(
    scopedJobs
      .filter((j) => j.status === "complete")
      .slice(0, 5)
      .map((j) => j.id),
  );
  const relevant = scopedJobs.filter((j) => j.status !== "complete" || recentCompleted.has(j.id));
  const refreshing = jobs
    .filter((j) => j.request.listId === listId)
    .some((j) => j.status === "running" && j.request.kind === "refresh");
  const fetching = jobs
    .filter((j) => j.request.listId === listId)
    .some((j) => j.status === "running" && j.request.kind === "history");
  async function action(url: string, body: unknown) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { job } = await json<{ job: RetrievalJob }>(url, body);
      setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)]);
      setRevision((r) => r + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update retrieval.");
    } finally {
      setBusy(false);
    }
  }
  const stamp = (date: string) => new Date(date).toLocaleString(undefined, { timeZone: timezone });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy || refreshing || !refreshIds.length}
          onClick={() =>
            void action("/api/x-research/retrieval", {
              kind: "refresh",
              listId,
              creatorIds: refreshIds,
              initialDays,
              maxPages,
            })
          }
        >
          {refreshing ? (
            <>
              <Spinner />
              Refreshing…
            </>
          ) : (
            <>
              <RefreshCw aria-hidden="true" />
              Refresh feed
            </>
          )}
        </Button>
        <Button
          variant="outline"
          disabled={busy || fetching || !selected.length || !start || !end}
          onClick={() =>
            void action("/api/x-research/retrieval", {
              kind: "history",
              listId,
              creatorIds: selected,
              start,
              end,
              timezone,
              period,
              maxPages,
            })
          }
        >
          <CalendarClock aria-hidden="true" />
          Fetch dates
        </Button>
        <div ref={limitsRef} className="relative">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showLimits}
            onClick={() => setShowLimits((current) => !current)}
            className="text-muted-foreground"
          >
            <Settings2 aria-hidden="true" />
            Limits
          </Button>
          {showLimits ? (
            <div className="absolute left-0 top-full z-30 mt-1.5 w-72 space-y-3 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg">
              <label className="block space-y-1 text-xs font-medium">
                Initial history target (days)
                <input
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="number"
                  min={1}
                  max={365}
                  value={initialDays}
                  onChange={(e) => setInitialDays(Number(e.target.value))}
                />
              </label>
              <label className="block space-y-1 text-xs font-medium">
                Pages per creator per attempt
                <input
                  className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="number"
                  min={1}
                  max={100}
                  value={maxPages}
                  onChange={(e) => setMaxPages(Number(e.target.value))}
                />
              </label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Default initial target: 30 days. Each attempt runs for at most 3 minutes per
                creator with up to 2 retries per read. Actual page sizes and accessible history
                vary. Resume continues committed work with the saved limits.
              </p>
            </div>
          ) : null}
        </div>
        <p className="ml-auto hidden text-xs text-muted-foreground lg:block">
          Refresh covers{" "}
          <span className="font-medium text-foreground">
            {refreshIds.length} creator{refreshIds.length === 1 ? "" : "s"}
          </span>
          {listId !== null ? " (entire list)" : ""} · Fetch dates uses the selected creators and the
          displayed dates
        </p>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <p className="min-w-0 flex-1">{error}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setError(null);
              setRevision((r) => r + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}

      {jobs.some((j) => j.request.listId !== listId) && (
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => setShowAllJobs((current) => !current)}
        >
          {showAllJobs ? "Show this scope's jobs only" : `Show all retrieval jobs (${jobs.length})`}
        </Button>
      )}

      <div aria-live="polite" className="space-y-2.5">
        {relevant.map((job) => {
          const completed = job.creators.filter((c) => c.status === "complete").length;
          const newPosts = job.creators.reduce((n, c) => n + c.newPosts, 0);
          const updated = job.creators.reduce((n, c) => n + c.updatedPosts, 0);
          const fraction =
            job.request.creatorIds.length > 0 ? completed / job.request.creatorIds.length : 0;
          const waiting =
            job.status !== "running" &&
            job.creators.some((c) => c.retryAt && Date.parse(c.retryAt) > Date.now());
          return (
            <div
              key={job.id}
              className="space-y-2 rounded-xl border bg-card p-3.5 text-sm shadow-sm"
            >
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    STATUS_DOT[job.status] ?? "bg-muted-foreground/40",
                    job.status === "running" && "animate-pulse motion-reduce:animate-none",
                  )}
                />
                <p className="min-w-0 flex-1 font-medium">
                  {job.request.kind === "refresh" ? "Feed refresh" : "Historical fetch"} ·{" "}
                  {job.request.label}
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    ·{" "}
                    {job.status === "partial" && job.creators.some((c) => c.mode === "catchup")
                      ? "Partially caught up"
                      : job.status}
                    {waiting ? " · waiting to retry" : ""}
                  </span>
                </p>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {completed}/{job.request.creatorIds.length} creators · {newPosts} new · {updated}{" "}
                  updated
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`${job.request.kind === "refresh" ? "Feed refresh" : "Historical fetch"} progress`}
                aria-valuemin={0}
                aria-valuemax={job.request.creatorIds.length}
                aria-valuenow={completed}
                className="h-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500 motion-reduce:transition-none",
                    job.status === "failed" ? "bg-destructive/70" : "bg-emerald-500/80",
                  )}
                  style={{ width: `${Math.round(fraction * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Started {stamp(job.createdAt)}
                {job.finishedAt ? ` · Finished ${stamp(job.finishedAt)}` : ""}
                {job.request.kind === "history"
                  ? ` · Requested ${stamp(job.request.since)} – ${stamp(job.request.until)} (end exclusive)`
                  : ""}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {job.status === "running" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void action(`/api/x-research/retrieval/${job.id}`, { action: "cancel" })
                    }
                  >
                    Cancel retrieval
                  </Button>
                ) : (
                  job.status !== "complete" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || waiting}
                      onClick={() =>
                        void action(`/api/x-research/retrieval/${job.id}`, { action: "resume" })
                      }
                    >
                      Resume
                    </Button>
                  )
                )}
                {!["running", "complete", "cancelled"].includes(job.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void action(`/api/x-research/retrieval/${job.id}`, { action: "cancel" })
                    }
                  >
                    Cancel retrieval
                  </Button>
                )}
                {job.request.kind === "refresh" && newPosts > 0 && (
                  <Button size="sm" variant="ghost" onClick={onViewNewDates}>
                    View recent dates
                  </Button>
                )}
              </div>
              <details className="group/creators text-xs">
                <summary className="flex w-fit cursor-pointer items-center gap-1 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 transition-transform group-open/creators:rotate-180 motion-reduce:transition-none"
                  />
                  Creator progress and coverage
                </summary>
                <ul className="mt-2 space-y-2 border-t pt-2.5">
                  {job.creators.map((c) => (
                    <li key={c.creatorId} className="break-words">
                      <p>
                        <span className="font-medium">{c.name}</span>{" "}
                        <span className="text-muted-foreground">
                          ·{" "}
                          {c.mode === "initial"
                            ? "Initial import"
                            : c.mode === "catchup"
                              ? "Catch-up"
                              : "History"}{" "}
                          · {c.status} · {c.pages} pages · {c.newPosts} new posts
                        </span>
                      </p>
                      <p className="text-muted-foreground">
                        {c.error ||
                          (c.reason
                            ? (RETRIEVAL_REASONS[c.reason] ?? c.reason)
                            : "Fetching available posts…")}
                        {c.retryAt ? ` · Retry after ${stamp(c.retryAt)}` : ""}
                      </p>
                      {c.oldest && c.newest && (
                        <p className="text-muted-foreground">
                          Observed {stamp(c.oldest)} – {stamp(c.newest)}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          );
        })}
      </div>

      {coverage.length > 0 ? (
        <details className="group/coverage text-xs">
          <summary className="flex w-fit cursor-pointer items-center gap-1 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 transition-transform group-open/coverage:rotate-180 motion-reduce:transition-none"
            />
            Durable archive coverage
          </summary>
          <ul className="mt-2 space-y-2 border-t pt-2.5">
            {coverage.map((c) => (
              <li key={c.creatorId}>
                <p className="font-medium">
                  {jobs.flatMap((j) => j.creators).find((p) => p.creatorId === c.creatorId)?.name ??
                    `Creator ${c.creatorId}`}{" "}
                  <span className="font-normal text-muted-foreground">
                    ·{" "}
                    {c.initialized
                      ? "Initial target traversal finished"
                      : "Initial import incomplete / cached only"}
                    {c.pendingHead ? " · Head retrieval unfinished" : ""}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  Last successful refresh:{" "}
                  {c.lastSuccessfulRefresh ? stamp(c.lastSuccessfulRefresh) : "Never"}
                  {c.newestObserved ? ` · Newest observed: ${stamp(c.newestObserved)}` : ""}
                </p>
                {c.historySince && c.historyUntil && (
                  <p className="text-muted-foreground">
                    History request: {stamp(c.historySince)} – {stamp(c.historyUntil)} ·{" "}
                    {RETRIEVAL_REASONS[c.historyStatus ?? ""] ?? c.historyStatus}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            Observed dates and a finished traversal do not prove exhaustive X history or reply
            coverage. Archived text survives disconnection and restart.
          </p>
        </details>
      ) : null}
    </div>
  );
}
