"use client";

import { trackAcceptedReport } from "@/components/background/task-store";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  FileText,
  FileVideo,
  Pencil,
  RotateCcw,
  TriangleAlert,
  Trash2,
} from "lucide-react";

import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { AppDialog } from "@/components/ui/dialog";
import { PendingIndicator, Spinner } from "@/components/ui/pending";
import { XLogo } from "@/components/ui/platform-logos";
import { useToast } from "@/components/ui/toast";
import {
  reportProfileOption,
  reportStyleOption,
  type ReportProfileId,
  type ReportStyleId,
} from "@/components/ai/report-options";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The reports list: one card per requested HTML report. Each card leads with
 * the report's extracted headline (the analyst's own title) and standfirst,
 * shows the source videos it was grounded in — thumbnails linking back to
 * the local video pages — and offers the actions that matter: opening the
 * finished document, copying its path, renaming it, retrying a failure, and
 * deleting it along with its files. While any job is queued or running the
 * list polls GET /api/ai/reports every few seconds, so statuses move on
 * their own — no manual refresh.
 */

export interface ReportVideoSummary {
  id: string;
  title: string;
  creatorId: number;
  creatorName: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
}

export interface ReportSourceSummary {
  kind: "video" | "tweet";
  id: string;
  title: string;
  creatorId: number;
  creatorName: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  url: string;
  durationSeconds: number | null;
}

export interface ReportSummary {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  /** Headline extracted from the finished report (or a rename); null before. */
  title: string | null;
  /** Standfirst extracted from the finished report; null before that. */
  dek: string | null;
  videoIds: string[];
  videoCount: number;
  /** Mixed source count across videos and X posts. */
  sourceCount: number;
  /** Sources resolved against the local cache, in request order. */
  sources: ReportSourceSummary[];
  /** The video sources only; kept for compatibility. */
  videos: ReportVideoSummary[];
  /** Depth profile the report runs with (brief | balanced | deep). */
  profile: string;
  /** Visual style the report is written in (editorial | terminal | swiss). */
  style: string;
  /** The report's location on disk once done (loopback-only app). */
  filePath: string | null;
  /** URL the finished report is served from, or null while it runs. */
  fileUrl: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ReportsViewProps {
  initialReports: ReportSummary[];
}

const POLL_INTERVAL_MS = 3_000;
/** Sources shown per card before the "show all" toggle kicks in. */
const INITIAL_VISIBLE_SOURCES = 8;
const REPORT_TITLE_MAX_LENGTH = 200;

function StatusBadge({ status }: { status: ReportSummary["status"] }) {
  switch (status) {
    case "queued":
      return (
        <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
          <Clock aria-hidden="true" className="size-3" />
          Queued
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" className="shrink-0 gap-1">
          <Spinner className="size-3" />
          Running
        </Badge>
      );
    case "done":
      return (
        <Badge className="shrink-0 gap-1 border-transparent bg-emerald-600 text-white">
          <CheckCircle2 aria-hidden="true" className="size-3" />
          Done
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" className="shrink-0 gap-1">
          <TriangleAlert aria-hidden="true" className="size-3" />
          Failed
        </Badge>
      );
  }
}

/**
 * The best name the list can give a report without an extracted one: the
 * single source's title, the first source plus a count, or the report id.
 */
function deriveReportTitle(report: ReportSummary): string {
  if (report.title !== null && report.title.length > 0) {
    return report.title;
  }
  const sources = report.sources.length > 0 ? report.sources : report.videos;
  const [first] = sources;
  if (first) {
    return sources.length > 1 ? `${first.title} +${sources.length - 1} more` : first.title;
  }
  if (report.sourceCount > 1) {
    return `${report.sourceCount}-source analysis`;
  }
  return `Report #${report.id}`;
}

/** One report source: thumbnail, title, and creator. Videos link to their
 * in-app page; X posts link to the canonical status URL. */
function SourceChip({ source }: { source: ReportSourceSummary }) {
  const isTweet = source.kind === "tweet";
  const className =
    "group/source flex flex-col gap-1.5 rounded-lg border bg-card p-1.5 text-card-foreground shadow-sm transition-colors hover:border-ring/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const body = (
    <>
      <span className="relative block aspect-video overflow-hidden rounded-md bg-muted">
        {source.thumbnailUrl ? (
          <img
            src={source.thumbnailUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-200 group-hover/source:scale-[1.04] motion-reduce:transition-none"
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-full items-center justify-center text-muted-foreground"
          >
            {isTweet ? (
              <XLogo className="size-4 text-foreground" />
            ) : (
              <FileVideo className="size-5" />
            )}
          </span>
        )}
      </span>
      <span className="block min-w-0 px-0.5 pb-0.5">
        <span className="block truncate text-xs font-medium [overflow-wrap:anywhere]">
          {source.title}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {source.creatorName}
        </span>
      </span>
    </>
  );
  if (isTweet) {
    return (
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer"
        title={source.title}
        className={className}
      >
        {body}
      </a>
    );
  }
  return (
    <Link
      href={`/channels/${source.creatorId}/videos/${source.id}`}
      title={source.title}
      className={className}
    >
      {body}
    </Link>
  );
}

/** The report's sources as a compact grid, collapsible for wide scopes. */
function SourcesStrip({ sources }: { sources: ReportSourceSummary[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? sources : sources.slice(0, INITIAL_VISIBLE_SOURCES);
  const hiddenCount = sources.length - visible.length;
  return (
    <section aria-label="Report sources">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {sources.length === 1 ? "1 source" : `${sources.length} sources`}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {visible.map((source) => (
          <SourceChip key={`${source.kind}:${source.id}`} source={source} />
        ))}
      </div>
      {hiddenCount > 0 || (expanded && sources.length > INITIAL_VISIBLE_SOURCES) ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 gap-1 text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
          />
          {expanded
            ? "Show fewer sources"
            : `Show ${hiddenCount} more source${hiddenCount === 1 ? "" : "s"}`}
        </Button>
      ) : null}
    </section>
  );
}

/** Created/finished stamps: relative up front, exact time on hover. */
function ReportMeta({ report }: { report: ReportSummary }) {
  const createdRelative = formatRelativeTime(report.createdAt) ?? "recently";
  const createdAbsolute = formatAbsoluteTimestamp(report.createdAt);
  const finishedRelative = report.completedAt
    ? (formatRelativeTime(report.completedAt) ?? "recently")
    : null;
  const finishedAbsolute = formatAbsoluteTimestamp(report.completedAt);
  return (
    <p className="text-xs text-muted-foreground">
      <span title={createdAbsolute ?? undefined}>Created {createdRelative}</span>
      {finishedRelative !== null ? (
        <>
          <span aria-hidden="true"> · </span>
          <span title={finishedAbsolute ?? undefined}>finished {finishedRelative}</span>
        </>
      ) : null}
    </p>
  );
}

function ReportCard({
  report,
  busy,
  onRequestDelete,
  onRequestRename,
  onRetry,
}: {
  report: ReportSummary;
  /** A list-level action (e.g. a retry) is in flight for this card. */
  busy: boolean;
  onRequestDelete: (report: ReportSummary) => void;
  onRequestRename: (report: ReportSummary) => void;
  onRetry: (report: ReportSummary) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    };
  }, []);

  async function copyPath(): Promise<void> {
    if (report.filePath === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(report.filePath);
      setCopied(true);
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
      copyTimer.current = window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard access denied — the path is also in the tooltip.
    }
  }

  const profileOption = reportProfileOption(report.profile as ReportProfileId);
  const styleOption = reportStyleOption(report.style as ReportStyleId);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Report #{report.id} · {profileOption.label} · {styleOption.label}
          </p>
          <CardTitle className="mt-1.5 text-lg leading-snug [overflow-wrap:anywhere]">
            {deriveReportTitle(report)}
          </CardTitle>
          {report.dek !== null ? (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{report.dek}</p>
          ) : null}
        </div>
        <StatusBadge status={report.status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {report.sources.length > 0 ? (
          <SourcesStrip sources={report.sources} />
        ) : report.videos.length > 0 ? (
          <SourcesStrip
            sources={report.videos.map((video) => ({
              kind: "video" as const,
              id: video.id,
              title: video.title,
              creatorId: video.creatorId,
              creatorName: video.creatorName,
              thumbnailUrl: video.thumbnailUrl,
              publishedAt: video.publishedAt,
              url: `/channels/${video.creatorId}/videos/${video.id}`,
              durationSeconds: video.durationSeconds,
            }))}
          />
        ) : null}

        {report.status === "queued" ? (
          <p className="text-sm text-muted-foreground">
            Waiting its turn — reports run one at a time.
          </p>
        ) : null}
        {report.status === "running" ? (
          <PendingIndicator label="Generating the report…" hint="This can take several minutes." />
        ) : null}
        {report.status === "failed" && report.error ? (
          <AlertNote tone="danger" title="The report job failed.">
            {report.error}
          </AlertNote>
        ) : null}

        <div className="flex flex-col gap-3 border-t pt-3">
          <ReportMeta report={report} />
          <div className="flex flex-wrap items-center gap-2">
            {report.status === "done" && report.fileUrl ? (
              <a
                href={report.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
                Open report
              </a>
            ) : null}
            {report.status === "failed" ? (
              <Button size="sm" className="gap-1.5" disabled={busy} onClick={() => onRetry(report)}>
                {busy ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <RotateCcw aria-hidden="true" className="size-3.5" />
                )}
                Try again
              </Button>
            ) : null}
            {report.status === "done" ? (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => onRequestRename(report)}
              >
                <Pencil aria-hidden="true" className="size-3.5" />
                Rename
              </Button>
            ) : null}
            {report.filePath !== null ? (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 font-mono text-muted-foreground"
                onClick={() => void copyPath()}
                title={report.filePath}
              >
                {copied ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : (
                  <Copy aria-hidden="true" className="size-3.5" />
                )}
                {copied ? "Copied" : "Copy path"}
              </Button>
            ) : null}
            {report.status !== "running" ? (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => onRequestDelete(report)}
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
                Delete
              </Button>
            ) : null}
          </div>
          {report.status === "done" ? (
            <p className="text-xs text-muted-foreground">
              Self-contained HTML — saved locally, opens in any browser without a network.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function ReportsView({ initialReports }: ReportsViewProps) {
  const [reports, setReports] = useState<ReportSummary[]>(initialReports);
  // Guards against overlapping polls when a request outlives one interval.
  const pollingRef = useRef(false);

  const [deleteTarget, setDeleteTarget] = useState<ReportSummary | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ReportSummary | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const { showToast, toastElement } = useToast();

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

  async function retryReport(report: ReportSummary): Promise<void> {
    setRetryingId(report.id);
    try {
      const response = await fetch("/api/ai/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources: report.sources.map((source) => ({ kind: source.kind, id: source.id })),
          profile: report.profile,
          style: report.style,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        showToast(body?.error?.message ?? "Could not queue the retry.", "error");
        return;
      }
      await trackAcceptedReport(response);
      await refreshReports();
      showToast("Retry queued — it will run after any earlier jobs.", "success");
    } catch {
      showToast("Could not queue the retry.", "error");
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 md:px-8 md:py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Designed HTML reports written from your cached transcripts, with the sources they were
          grounded in. Generate one from any conversation with the &ldquo;Generate report&rdquo;
          action in the Ask AI panel.
        </p>
      </header>

      {reports.length === 0 ? (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
          <span
            aria-hidden="true"
            className={cn("flex size-14 items-center justify-center rounded-full bg-muted")}
          >
            <FileText className="size-7 text-muted-foreground" />
          </span>
          <h2 className="text-base font-semibold">No reports yet</h2>
          <p className="max-w-md text-balance text-sm text-muted-foreground">
            Reports distill a selection of videos into one designed, self-contained HTML document —
            at the depth (brief, balanced, or deep) and in the visual style you pick. Start one from
            a chat, or pick videos on the research page.
          </p>
          <Link
            href="/research"
            className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            Go to AI Research
          </Link>
        </div>
      ) : (
        <div className="mt-8 flex flex-col gap-4">
          {reports.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              busy={retryingId === report.id}
              onRequestDelete={setDeleteTarget}
              onRequestRename={openRename}
              onRetry={(target) => void retryReport(target)}
            />
          ))}
        </div>
      )}

      {toastElement}

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
    </main>
  );
}
