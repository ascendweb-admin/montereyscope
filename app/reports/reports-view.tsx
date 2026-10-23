"use client";

import { trackAcceptedReport } from "@/components/background/task-store";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FileText, Plus } from "lucide-react";

import {
  REPORT_STYLE_OPTIONS,
  type ReportProfileId,
  type ReportStyleId,
} from "@/components/ai/report-options";
import { ReportStylePreview } from "@/components/ai/report-style-preview";
import { ReportDetail } from "@/components/reports/report-detail";
import { ReportList } from "@/components/reports/report-list";
import { createSourceLibraryLoader, NewReportFlow } from "@/components/reports/new-report-flow";
import {
  deriveReportTitle,
  matchesFacets,
  matchesFilter,
  matchesQuery,
  NO_FACETS,
  type ReportFacets,
  type ReportFilter,
  type ReportSummary,
} from "@/components/reports/model";
import {
  rememberReportPanel,
  useReportPanelPreference,
  type ReportPanelState,
} from "@/components/reports/panel-preference";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AppDialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";
import type { SourceRef } from "@/lib/content/model";
import { cn } from "@/lib/utils";
import { hasReportPdfBridge, saveReportPdf } from "@/lib/desktop/app-bridge";

export type {
  ReportSourceSummary,
  ReportSummary,
  ReportVideoSummary,
} from "@/components/reports/model";

// The preload bridge is fixed for the lifetime of a window. A server snapshot
// keeps hydration consistent before React reads the desktop capability.
const subscribeToPdfBridge = () => () => {};
const noPdfBridge = () => false;

/**
 * The Reports page: a reading room for every requested HTML report. The rail
 * lists reports by day with a cover drawn in each report's style; the pane
 * beside it opens the selected report in place, with its sources, PDF export,
 * and management actions in the header. Reports still in the queue show
 * their progress instead, and failed ones offer a retry. While any job is
 * queued or running the page polls GET /api/ai/reports every few seconds, so
 * statuses move on their own — no manual refresh.
 *
 * "New report" (the rail's footer, or the empty state) picks sources with
 * the same picker AI Chat uses, then the style and depth, and queues the
 * job without a chat; the new row is selected so its progress shows.
 *
 * Search narrows the rail by title, standfirst, creator, and source as the
 * user types, and — a beat later — by the documents' own text, those rows
 * showing where the text matched. The Filter popover narrows by creator,
 * category, and source type on top of the status filter.
 *
 * Below the lg breakpoint the panes stack: the list first, then the report
 * full-width with a back button. The selection is mirrored into ?report= so
 * a reload (or a link from elsewhere) lands on the same report.
 */

export interface ReportsViewProps {
  initialReports: ReportSummary[];
  /** Report to open first (from ?report=), when it exists. */
  initialSelectedId?: number | null;
}

const POLL_INTERVAL_MS = 3_000;
const REPORT_TITLE_MAX_LENGTH = 200;
/** Pause after the last keystroke before the document text is searched. */
const TEXT_SEARCH_DEBOUNCE_MS = 180;

/** Body-text hits for one query: report id → snippet (see the search route). */
interface TextMatches {
  query: string;
  snippets: Map<number, string | null>;
}

/** Keeps ?report= in step with the selection without adding history entries. */
function syncSelectionToUrl(id: number | null): void {
  const url = new URL(window.location.href);
  if (id === null) {
    url.searchParams.delete("report");
  } else {
    url.searchParams.set("report", String(id));
  }
  window.history.replaceState(window.history.state, "", url);
}

function EmptyReports({
  onNewReport,
  onWarmNewReport,
}: {
  onNewReport: () => void;
  /** Starts reading the picker's library before the click lands. */
  onWarmNewReport: () => void;
}) {
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-2xl flex-col items-center text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground text-background">
          <FileText aria-hidden="true" className="size-5" />
        </span>
        <h1 className="mt-5 text-sm font-medium text-muted-foreground">Reports</h1>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">No reports yet</h2>
        <p className="mt-2 max-w-md text-sm text-balance text-muted-foreground">
          A report distills the videos and posts you pick into one designed, self-contained document
          — at the depth you choose, in one of three styles. They open right here when they&apos;re
          ready.
        </p>

        <ul className="mt-8 grid w-full grid-cols-3 gap-3 sm:gap-4">
          {REPORT_STYLE_OPTIONS.map((option, index) => (
            <li
              key={option.id}
              className={cn(
                "flex flex-col gap-2 text-left",
                index === 1 ? "sm:-translate-y-2" : "sm:translate-y-1",
              )}
            >
              <span className="relative block h-28 overflow-hidden rounded-lg shadow-[0_18px_40px_-20px_rgb(0_0_0/0.45)] ring-1 ring-foreground/10 sm:h-36">
                <ReportStylePreview style={option.id} profile="balanced" />
              </span>
              <span className="px-0.5">
                <span className="block text-xs font-medium">{option.label}</span>
                <span className="hidden text-[11px] text-muted-foreground sm:block">
                  {option.tagline}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <Button
          className="mt-8 rounded-full"
          onClick={onNewReport}
          onPointerEnter={onWarmNewReport}
          onFocus={onWarmNewReport}
        >
          <Plus aria-hidden="true" />
          New report
        </Button>
      </div>
    </main>
  );
}

export function ReportsView({ initialReports, initialSelectedId = null }: ReportsViewProps) {
  const [reports, setReports] = useState<ReportSummary[]>(initialReports);
  // Guards against overlapping polls when a request outlives one interval.
  const pollingRef = useRef(false);

  const [selectedId, setSelectedId] = useState<number | null>(initialSelectedId);
  // Narrow screens show one pane at a time; a linked report opens straight away.
  const [detailOpen, setDetailOpen] = useState(
    initialSelectedId !== null && initialReports.some((report) => report.id === initialSelectedId),
  );
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ReportFilter>("all");
  const [facets, setFacets] = useState<ReportFacets>(NO_FACETS);
  const [textMatches, setTextMatches] = useState<TextMatches | null>(null);
  // The remembered panel state applies until the viewer opens or closes the
  // panel on this visit.
  const preferredPanel = useReportPanelPreference();
  const [chosenPanel, setChosenPanel] = useState<ReportPanelState | null>(null);
  const panel = chosenPanel ?? preferredPanel;

  // A server re-render (router.refresh when a job finishes, or a link to
  // another ?report= while this page is open) brings fresh props: adopt them.
  const [seenProps, setSeenProps] = useState({ initialReports, initialSelectedId });
  if (
    seenProps.initialReports !== initialReports ||
    seenProps.initialSelectedId !== initialSelectedId
  ) {
    setSeenProps({ initialReports, initialSelectedId });
    setReports(initialReports);
    if (initialSelectedId !== seenProps.initialSelectedId && initialSelectedId !== null) {
      setSelectedId(initialSelectedId);
      setDetailOpen(true);
      setFilter("all");
      setFacets(NO_FACETS);
    }
  }

  const [deleteTarget, setDeleteTarget] = useState<ReportSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ReportSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [newReportOpen, setNewReportOpen] = useState(false);
  // One reader per page: a hover's read is reused by the click that follows.
  const [libraryLoader] = useState(createSourceLibraryLoader);
  const canDownloadPdf = useSyncExternalStore(
    subscribeToPdfBridge,
    hasReportPdfBridge,
    noPdfBridge,
  );
  const [savingPdfId, setSavingPdfId] = useState<number | null>(null);
  const savingPdfRef = useRef(false);
  const { showToast, toastElement } = useToast();

  const trimmedQuery = query.trim();
  // Text hits only count for the query they answer; a newer one is pending.
  const snippets =
    textMatches !== null && textMatches.query === trimmedQuery ? textMatches.snippets : null;
  const visible = reports.filter(
    (report) =>
      matchesFilter(report, filter) &&
      matchesFacets(report, facets) &&
      (matchesQuery(report, query) || (snippets?.has(report.id) ?? false)),
  );

  useEffect(() => {
    if (!trimmedQuery) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/ai/reports/search?q=${encodeURIComponent(trimmedQuery)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          return;
        }
        const body = (await response.json()) as {
          matches?: Array<{ id: number; snippet: string | null }>;
        };
        if (Array.isArray(body.matches)) {
          setTextMatches({
            query: trimmedQuery,
            snippets: new Map(body.matches.map((match) => [match.id, match.snippet])),
          });
        }
      } catch {
        // Aborted by a newer keystroke, or the server is busy: the rail keeps
        // its title and source matches.
      }
    }, TEXT_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedQuery]);
  // The explicit choice while it exists; otherwise the newest finished report
  // in view (something to read), then simply the first row.
  const selected =
    reports.find((report) => report.id === selectedId) ??
    visible.find((report) => report.status === "done") ??
    visible[0] ??
    reports[0] ??
    null;

  function select(id: number): void {
    setSelectedId(id);
    setDetailOpen(true);
    syncSelectionToUrl(id);
  }

  function choosePanel(next: ReportPanelState): void {
    setChosenPanel(next);
    rememberReportPanel(next);
  }

  function showAll(): void {
    setQuery("");
    setFilter("all");
    setFacets(NO_FACETS);
  }

  async function downloadPdf(report: ReportSummary): Promise<void> {
    if (savingPdfRef.current) return;
    savingPdfRef.current = true;
    setSavingPdfId(report.id);
    try {
      const result = await saveReportPdf(report.id);
      if (!result.ok || !result.data) {
        showToast(result.error?.message ?? "Could not save the report as PDF.", "error");
      } else if (!result.data.canceled) {
        showToast("PDF saved.", "success");
      }
    } finally {
      savingPdfRef.current = false;
      setSavingPdfId(null);
    }
  }

  const hasActiveJobs = reports.some(
    (report) => report.status === "queued" || report.status === "running",
  );

  async function refreshReports(): Promise<void> {
    const response = await fetch("/api/ai/reports");
    if (!response.ok) {
      return;
    }
    const body = (await response.json()) as { reports?: ReportSummary[] };
    if (Array.isArray(body.reports)) {
      setReports(body.reports);
    }
  }

  useEffect(() => {
    if (!hasActiveJobs) {
      return;
    }
    const timer = window.setInterval(async () => {
      if (pollingRef.current) {
        return;
      }
      pollingRef.current = true;
      try {
        await refreshReports();
      } catch {
        // Transient network trouble: the next tick retries.
      } finally {
        pollingRef.current = false;
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hasActiveJobs]);

  async function copyPath(report: ReportSummary): Promise<void> {
    if (report.filePath === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(report.filePath);
      showToast("File path copied.", "success");
    } catch {
      showToast(`Could not copy the path. It is ${report.filePath}`, "error");
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) {
      return;
    }
    setDeleteBusy(true);
    try {
      const response = await fetch(`/api/ai/reports/${deleteTarget.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        showToast(body?.error?.message ?? "Could not delete the report.", "error");
        return;
      }
      const deletedId = deleteTarget.id;
      if (selected?.id === deletedId) {
        // Land on the neighbour below (or above, at the end of the list).
        const index = visible.findIndex((report) => report.id === deletedId);
        const neighbour = visible[index + 1] ?? visible[index - 1] ?? null;
        setSelectedId(neighbour?.id ?? null);
        syncSelectionToUrl(neighbour?.id ?? null);
        if (neighbour === null) setDetailOpen(false);
      }
      setReports((current) => current.filter((report) => report.id !== deletedId));
      showToast("Report deleted.", "success");
      setDeleteTarget(null);
    } catch {
      showToast("Could not delete the report.", "error");
    } finally {
      setDeleteBusy(false);
    }
  }

  function openRename(report: ReportSummary): void {
    setRenameTarget(report);
    setRenameValue(report.title ?? deriveReportTitle(report));
  }

  async function confirmRename(): Promise<void> {
    const title = renameValue.trim();
    if (renameTarget === null || title.length === 0) {
      return;
    }
    setRenameBusy(true);
    try {
      const response = await fetch(`/api/ai/reports/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        showToast(body?.error?.message ?? "Could not rename the report.", "error");
        return;
      }
      const body = (await response.json()) as { report?: ReportSummary };
      if (body.report) {
        const renamed = body.report;
        setReports((current) =>
          current.map((report) => (report.id === renamed.id ? { ...report, ...renamed } : report)),
        );
      }
      showToast("Report renamed.", "success");
      setRenameTarget(null);
    } catch {
      showToast("Could not rename the report.", "error");
    } finally {
      setRenameBusy(false);
    }
  }

  /**
   * Queues a report job and follows it: the rail is refreshed and cleared of
   * search and filters so the new row is in view, and the pane switches to
   * its progress. Resolves true once the job was accepted.
   */
  async function queueReport(
    request: { sources: SourceRef[]; profile: string; style: string },
    messages: { queued: string; failed: string },
  ): Promise<boolean> {
    try {
      const response = await fetch("/api/ai/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        showToast(body?.error?.message ?? messages.failed, "error");
        return false;
      }
      const accepted = (await response
        .clone()
        .json()
        .catch(() => null)) as { report?: { id?: number } } | null;
      await trackAcceptedReport(response);
      await refreshReports();
      if (typeof accepted?.report?.id === "number") {
        showAll();
        select(accepted.report.id);
      }
      showToast(messages.queued, "success");
      return true;
    } catch {
      showToast(messages.failed, "error");
      return false;
    }
  }

  async function retryReport(report: ReportSummary): Promise<void> {
    setRetryingId(report.id);
    try {
      await queueReport(
        {
          sources: report.sources.map((source) => ({ kind: source.kind, id: source.id })),
          profile: report.profile,
          style: report.style,
        },
        {
          queued: "Retry queued — it will run after any earlier jobs.",
          failed: "Could not queue the retry.",
        },
      );
    } finally {
      setRetryingId(null);
    }
  }

  function generateReport(
    sources: SourceRef[],
    profile: ReportProfileId,
    style: ReportStyleId,
  ): Promise<boolean> {
    return queueReport(
      { sources, profile, style },
      {
        queued: "Report queued — it will run after any earlier jobs.",
        failed: "Could not queue the report.",
      },
    );
  }

  const dialogs = (
    <>
      {toastElement}

      {newReportOpen ? (
        <NewReportFlow
          loader={libraryLoader}
          onClose={() => setNewReportOpen(false)}
          onGenerate={generateReport}
          onLoadFailed={() => {
            setNewReportOpen(false);
            showToast("Could not load your library. Try again.", "error");
          }}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => (deleteBusy ? undefined : setDeleteTarget(null))}
        title="Delete this report?"
        description="The report document and its cached transcripts are removed from disk. This cannot be undone."
        confirmLabel="Delete report"
        destructive
        busy={deleteBusy}
        busyLabel="Deleting…"
        onConfirm={() => void confirmDelete()}
      />

      <AppDialog
        open={renameTarget !== null}
        onClose={() => (renameBusy ? undefined : setRenameTarget(null))}
        title="Rename report"
        description="Names this report in the list; the document itself is unchanged."
        className="max-w-md"
        busy={renameBusy}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void confirmRename();
          }}
          className="flex flex-col gap-4"
        >
          <input
            autoFocus
            type="text"
            value={renameValue}
            maxLength={REPORT_TITLE_MAX_LENGTH}
            onChange={(event) => setRenameValue(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Report title"
            placeholder="A title that makes sense to you"
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={renameBusy}
              onClick={() => setRenameTarget(null)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={renameBusy || renameValue.trim().length === 0}>
              {renameBusy ? (
                <>
                  <Spinner />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </form>
      </AppDialog>
    </>
  );

  // The dialogs keep one place in the tree, so a flow that queues the first
  // report survives the switch from the empty state to the reading room.
  return (
    <>
      {reports.length === 0 || selected === null ? (
        <EmptyReports
          onNewReport={() => setNewReportOpen(true)}
          onWarmNewReport={libraryLoader.warm}
        />
      ) : (
        <main
          id="main"
          tabIndex={-1}
          data-viewport-shell
          className="relative flex h-[calc(100dvh-6.5rem)] min-h-0 overflow-hidden md:h-dvh"
        >
          <h1 className="sr-only">Reports</h1>
          <nav
            aria-label="Reports"
            className={cn(
              "w-full min-w-0 shrink-0 bg-card lg:block lg:w-72 lg:border-r xl:w-80",
              detailOpen ? "hidden" : "block",
            )}
          >
            <ReportList
              reports={reports}
              visible={visible}
              selectedId={selected.id}
              onSelect={select}
              query={query}
              onQuery={setQuery}
              filter={filter}
              onFilter={setFilter}
              facets={facets}
              onFacets={setFacets}
              snippets={snippets}
              onShowAll={showAll}
              onNewReport={() => setNewReportOpen(true)}
              onWarmNewReport={libraryLoader.warm}
            />
          </nav>

          <section
            aria-label="Selected report"
            className={cn("min-w-0 flex-1 flex-col lg:flex", detailOpen ? "flex" : "hidden")}
          >
            <ReportDetail
              key={selected.id}
              report={selected}
              reports={reports}
              busy={retryingId === selected.id || savingPdfId === selected.id}
              retrying={retryingId === selected.id}
              canDownloadPdf={canDownloadPdf}
              pdfBusy={savingPdfId !== null}
              savingPdf={savingPdfId === selected.id}
              panel={panel}
              onPanel={choosePanel}
              onBack={() => setDetailOpen(false)}
              onDownloadPdf={(target) => void downloadPdf(target)}
              onRename={openRename}
              onCopyPath={(target) => void copyPath(target)}
              onDelete={setDeleteTarget}
              onRetry={(target) => void retryReport(target)}
            />
          </section>
        </main>
      )}
      {dialogs}
    </>
  );
}
