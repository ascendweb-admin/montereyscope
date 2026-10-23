"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { FileText, Plus, Search, SearchX, X } from "lucide-react";

import { reportProfileOption, type ReportProfileId } from "@/components/ai/report-options";
import { ReportCover } from "@/components/reports/report-cover";
import {
  ActiveFacetChips,
  PlatformMark,
  ReportAvatarStack,
  ReportFilterMenu,
} from "@/components/reports/report-filters";
import {
  compactAge,
  creatorLabel,
  deriveReportTitle,
  facetOptions,
  focusSnippet,
  groupReportsByDate,
  jobsAhead,
  matchesFilter,
  sourceCountLabel,
  sourceTotal,
  splitSnippet,
  type ReportFacets,
  type ReportFilter,
  type ReportSummary,
} from "@/components/reports/model";
import { formatAbsoluteTimestamp } from "@/lib/format";
import { cn } from "@/lib/utils";

const FILTERS: readonly { id: ReportFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "active", label: "Active" },
  { id: "failed", label: "Failed" },
];

/** What kind of document a finished row is: its depth, or what saved it. */
function kindLabel(report: ReportSummary): string {
  if (report.origin === "x-dashboard") return "X brief";
  if (report.origin === "x-research") return "Research brief";
  return reportProfileOption(report.profile as ReportProfileId).label;
}

/**
 * The row's last line: who the report is about (avatars and a name, or the
 * platforms when no source resolves to a known creator), then its state —
 * or, once finished, its kind and age.
 */
function RowMeta({
  report,
  reports,
}: {
  report: ReportSummary;
  reports: readonly ReportSummary[];
}) {
  const who = creatorLabel(report);
  const stamp = report.completedAt ?? report.createdAt;
  const age = (
    <span title={formatAbsoluteTimestamp(stamp) ?? undefined}>
      {compactAge(stamp) ?? "recently"}
    </span>
  );
  let state: ReactNode;
  switch (report.status) {
    case "running":
      state = (
        <>
          <span className="font-medium text-foreground">Writing</span> ·{" "}
          {sourceCountLabel(sourceTotal(report))}
        </>
      );
      break;
    case "queued": {
      const ahead = jobsAhead(report, reports);
      state = <>Queued · {ahead === 0 ? "next up" : `${ahead} ahead`}</>;
      break;
    }
    case "failed":
      state = (
        <>
          <span className="font-medium text-destructive">Failed</span> · {age}
        </>
      );
      break;
    case "done":
      state = (
        <>
          {kindLabel(report)} · {age}
        </>
      );
      break;
  }
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
      {report.platforms.length > 0 ? (
        <span className="flex shrink-0 items-center gap-1">
          {report.platforms.map((platform) => (
            <PlatformMark key={platform} platform={platform} />
          ))}
        </span>
      ) : null}
      <ReportAvatarStack creators={report.creators} />
      {/* The name gives way before the state does. */}
      {who ? <span className="min-w-0 truncate font-medium text-foreground/80">{who}</span> : null}
      <span className={cn("whitespace-nowrap", who ? "shrink-0" : "min-w-0 truncate")}>
        {who ? <span aria-hidden="true">· </span> : null}
        {state}
      </span>
    </span>
  );
}

/** A search hit inside the document, matched terms highlighted. */
function Snippet({ snippet }: { snippet: string }) {
  return (
    <span className="line-clamp-2 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">
      {splitSnippet(focusSnippet(snippet)).map((part, index) =>
        part.match ? (
          <mark
            key={index}
            className="rounded-[3px] bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-400/25 dark:text-amber-100"
          >
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * The Reports rail: page title, search with the Filter popover beside it
 * (creator, category, source type) and the filters in force as chips, a
 * status filter (only when there is more than one kind of report to tell
 * apart), and the reports grouped by the day they were requested — each with
 * its standfirst (or, while searching, where the text matched) and who it is
 * about. Arrow keys (or j/k) move the selection through the visible rows;
 * "/" jumps to search from anywhere on the page. "New report" at the foot
 * starts a report from freshly picked sources.
 */
export function ReportList({
  reports,
  visible,
  selectedId,
  onSelect,
  query,
  onQuery,
  filter,
  onFilter,
  facets,
  onFacets,
  snippets,
  onShowAll,
  onNewReport,
  onWarmNewReport,
}: {
  reports: readonly ReportSummary[];
  /** The rows left after search and filter, in list order. */
  visible: readonly ReportSummary[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  query: string;
  onQuery: (value: string) => void;
  filter: ReportFilter;
  onFilter: (value: ReportFilter) => void;
  facets: ReportFacets;
  onFacets: (value: ReportFacets) => void;
  /** Body-text search hits for the current query: report id → snippet. */
  snippets: ReadonlyMap<number, string | null> | null;
  /** Clears search, status, and filters. */
  onShowAll: () => void;
  /** Opens the new-report flow (sources, then style and depth). */
  onNewReport: () => void;
  /** Starts reading the picker's library before the click lands. */
  onWarmNewReport: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const groups = groupReportsByDate(visible);
  // Roving tab stop: the selected row, or the first row when it is filtered out.
  const tabStopId = visible.some((report) => report.id === selectedId)
    ? selectedId
    : (visible[0]?.id ?? null);
  const filters = FILTERS.map((option) => ({
    ...option,
    count: reports.filter((report) => matchesFilter(report, option.id)).length,
  })).filter((option) => option.id === "all" || option.count > 0 || option.id === filter);
  // "All" plus a single kind means there is nothing to tell apart.
  const showFilters = filters.length > 2;
  const options = facetOptions(reports);

  // A linked or defaulted selection further down the rail starts in view.
  useEffect(() => {
    if (selectedId !== null) {
      rowRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest" });
    }
    // Only on mount: later selections come from clicks and keys in view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) &&
        !target.isContentEditable &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function moveSelection(event: KeyboardEvent<HTMLElement>): void {
    const keys: Record<string, number> = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 };
    let next: ReportSummary | undefined;
    const index = visible.findIndex((report) => report.id === selectedId);
    if (event.key in keys) {
      next = visible[Math.min(visible.length - 1, Math.max(0, index + keys[event.key]))];
    } else if (event.key === "Home") {
      next = visible[0];
    } else if (event.key === "End") {
      next = visible[visible.length - 1];
    }
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    onSelect(next.id);
    rowRefs.current.get(next.id)?.focus();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background">
          <FileText aria-hidden="true" className="size-3.5" />
        </span>
        <h2 className="text-sm font-semibold tracking-tight">Reports</h2>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {reports.length}
          <span className="sr-only"> {reports.length === 1 ? "report" : "reports"}</span>
        </span>
      </div>

      <div className="shrink-0 space-y-2 px-3 pb-3">
        <div className="relative flex items-center gap-1.5">
          <label className="relative block min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref={searchRef}
              type="search"
              value={query}
              aria-label="Search reports"
              placeholder="Search reports"
              onChange={(event) => onQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  onQuery("");
                }
                if (event.key === "ArrowDown" && visible.length > 0) {
                  event.preventDefault();
                  const target = visible.find((report) => report.id === selectedId) ?? visible[0];
                  onSelect(target.id);
                  rowRefs.current.get(target.id)?.focus();
                }
              }}
              className="h-8 w-full rounded-full border bg-muted/40 pr-14 pl-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/30 focus:bg-background motion-reduce:transition-none [&::-webkit-search-cancel-button]:hidden"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  onQuery("");
                  searchRef.current?.focus();
                }}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded border bg-background px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                /
              </kbd>
            )}
          </label>
          <ReportFilterMenu
            options={options}
            facets={facets}
            onFacets={onFacets}
            matching={visible.length}
            total={reports.length}
          />
        </div>
        <ActiveFacetChips options={options} facets={facets} onFacets={onFacets} />
        {showFilters ? (
          <div
            role="group"
            aria-label="Filter by status"
            className="flex h-8 items-center gap-0.5 overflow-x-auto rounded-full bg-muted/70 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {filters.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={filter === option.id}
                onClick={() => onFilter(option.id)}
                className={cn(
                  "flex h-7 shrink-0 grow items-center justify-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  filter === option.id
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option.label}
                <span
                  className={cn(
                    "tabular-nums",
                    option.id === "failed" && option.count > 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {option.count}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {visible.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-12 text-center">
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <SearchX aria-hidden="true" className="size-4" />
            </span>
            <p className="mt-3 text-sm font-medium">No matching reports</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try another search, status, or filter.
            </p>
            <button
              type="button"
              onClick={onShowAll}
              className="mt-3 rounded-md px-2 py-1 text-xs font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              Show all reports
            </button>
          </div>
        ) : (
          <div onKeyDown={moveSelection}>
            {groups.map((group) => (
              <section key={group.label} aria-label={group.label} className="mt-1 first:mt-0">
                <h2 className="sticky top-0 z-10 bg-card/95 px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur supports-[backdrop-filter]:bg-card/80">
                  {group.label}
                </h2>
                <ul className="space-y-0.5">
                  {group.reports.map((report) => {
                    const active = report.id === selectedId;
                    const title = deriveReportTitle(report);
                    const snippet = query.trim() ? (snippets?.get(report.id) ?? null) : null;
                    return (
                      <li key={report.id}>
                        <button
                          ref={(element) => {
                            if (element) rowRefs.current.set(report.id, element);
                            else rowRefs.current.delete(report.id);
                          }}
                          type="button"
                          aria-current={active ? "true" : undefined}
                          tabIndex={report.id === tabStopId ? 0 : -1}
                          title={report.dek ?? undefined}
                          onClick={() => onSelect(report.id)}
                          className={cn(
                            "flex w-full min-w-0 items-start gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                            active ? "bg-accent" : "hover:bg-accent/60",
                          )}
                        >
                          <ReportCover style={report.style} status={report.status} />
                          <span className="flex min-w-0 flex-1 flex-col gap-1 pt-px">
                            <span
                              className={cn(
                                "line-clamp-2 text-sm leading-snug [overflow-wrap:anywhere]",
                                active ? "font-semibold" : "font-medium",
                                report.status === "failed" && !active && "text-muted-foreground",
                              )}
                            >
                              {title}
                            </span>
                            {snippet ? (
                              <Snippet snippet={snippet} />
                            ) : report.dek ? (
                              <span className="line-clamp-2 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">
                                {report.dek}
                              </span>
                            ) : null}
                            <RowMeta report={report} reports={reports} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t px-3 py-2.5">
        <button
          type="button"
          onClick={onNewReport}
          onPointerEnter={onWarmNewReport}
          onFocus={onWarmNewReport}
          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <span className="flex size-6 items-center justify-center rounded-full border border-dashed">
            <Plus aria-hidden="true" className="size-3.5" />
          </span>
          New report
        </button>
      </div>
    </div>
  );
}
