"use client";

import Link from "next/link";
import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clock,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileVideo,
  PanelRight,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import {
  reportProfileOption,
  reportStyleOption,
  type ReportProfileId,
  type ReportStyleId,
} from "@/components/ai/report-options";
import { ReportStylePreview, reportStyleSwatch } from "@/components/ai/report-style-preview";
import {
  deriveReportTitle,
  jobsAhead,
  originLabel,
  reportSources,
  sourceCountLabel,
  sourceTotal,
  type ReportOutlineEntry,
  type ReportSourceSummary,
  type ReportSummary,
} from "@/components/reports/model";
import {
  isPanelDocked,
  type ReportPanelState,
  type ReportPanelTab,
} from "@/components/reports/panel-preference";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { AlertNote } from "@/components/ui/alert-note";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { XLogo } from "@/components/ui/platform-logos";
import { formatAbsoluteTimestamp, formatDuration, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// The reader frame mounts only after hydration: a server-rendered frame can
// finish loading before React attaches onLoad, leaving the spinner up forever.
const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

/** Sources shown in the progress view before "show all" kicks in. */
const INITIAL_VISIBLE_SOURCES = 6;

export interface ReportDetailProps {
  report: ReportSummary;
  /** Every report, so a queued one can say how many jobs are ahead of it. */
  reports: readonly ReportSummary[];
  /** A report-level action (retry, PDF save) is in flight for this report. */
  busy: boolean;
  retrying: boolean;
  canDownloadPdf: boolean;
  /** Some report's PDF is being saved; one save runs at a time. */
  pdfBusy: boolean;
  savingPdf: boolean;
  /** The side panel's requested state; tabs the report lacks fall back. */
  panel: ReportPanelState;
  onPanel: (state: ReportPanelState) => void;
  /** Returns to the list on narrow screens, where the panes stack. */
  onBack: () => void;
  onDownloadPdf: (report: ReportSummary) => void;
  onRename: (report: ReportSummary) => void;
  onCopyPath: (report: ReportSummary) => void;
  onDelete: (report: ReportSummary) => void;
  onRetry: (report: ReportSummary) => void;
}

/** The tab the panel can actually show for this report, or null when closed. */
function resolvePanelTab(
  panel: ReportPanelState,
  hasOutline: boolean,
  hasSources: boolean,
): ReportPanelTab | null {
  if (panel === "outline") return hasOutline ? "outline" : hasSources ? "sources" : null;
  if (panel === "sources") return hasSources ? "sources" : hasOutline ? "outline" : null;
  return null;
}

/** "N posts" for the X briefs (every source is a post), "N sources" otherwise. */
function countLabel(report: ReportSummary): string {
  if (report.sourceCountKnown === false) return "Sources in document";
  const count = sourceTotal(report);
  if (report.origin === "report") {
    return sourceCountLabel(count);
  }
  return count === 1 ? "1 post" : `${count} posts`;
}

/**
 * The selected report. Finished reports open right here in a sandboxed
 * reader, with a side panel holding the document's outline (jump to any
 * section) and the sources it was written from; reports still on their way
 * show where they are in the pipeline instead, and failed ones explain what
 * went wrong next to a retry.
 */
export function ReportDetail(props: ReportDetailProps) {
  const { report, panel, onPanel } = props;
  const sources = reportSources(report);
  const ready = report.status === "done" && report.fileUrl !== null;
  const hasOutline = report.outline.length > 0;
  const tab = ready ? resolvePanelTab(panel, hasOutline, sources.length > 0) : null;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [jumpedTo, setJumpedTo] = useState<string | null>(null);

  /**
   * Scrolls the reader to a heading. The frame is sandboxed (an opaque
   * origin), so the page cannot reach into its document — but it may still
   * navigate it, and a navigation that only changes the fragment scrolls
   * the loaded document in place without reloading it.
   */
  function jumpTo(entry: ReportOutlineEntry): void {
    setJumpedTo(entry.id);
    const frame = frameRef.current;
    const src = frame?.getAttribute("src");
    try {
      frame?.contentWindow?.location.replace(`${src}#${encodeURIComponent(entry.id)}`);
    } catch {
      // The frame is gone or not navigable; the click is simply a no-op.
    }
    // Over the report on narrow screens: get out of the way of the jump.
    if (!isPanelDocked()) onPanel("closed");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DetailHeader
        {...props}
        ready={ready}
        panelTab={tab}
        hasOutline={hasOutline}
        hasSources={sources.length > 0}
      />
      {ready ? (
        <div className="relative flex min-h-0 flex-1">
          <ReportReader report={report} frameRef={frameRef} />
          {tab !== null ? (
            <>
              <button
                type="button"
                aria-label="Close panel"
                tabIndex={-1}
                onClick={() => onPanel("closed")}
                className="absolute inset-0 z-10 bg-black/20 xl:hidden"
              />
              <ReportSidePanel
                report={report}
                sources={sources}
                tab={tab}
                jumpedTo={jumpedTo}
                onTab={onPanel}
                onClose={() => onPanel("closed")}
                onJump={jumpTo}
              />
            </>
          ) : null}
        </div>
      ) : (
        <ReportProgress {...props} sources={sources} />
      )}
    </div>
  );
}

/**
 * Beside the reader: the outline of the document — every section and
 * subsection, a click away — with its reading time, and the sources the
 * report was written from. Docked from xl, an overlay below that.
 */
function ReportSidePanel({
  report,
  sources,
  tab,
  jumpedTo,
  onTab,
  onClose,
  onJump,
}: {
  report: ReportSummary;
  sources: ReportSourceSummary[];
  tab: ReportPanelTab;
  jumpedTo: string | null;
  onTab: (tab: ReportPanelTab) => void;
  onClose: () => void;
  onJump: (entry: ReportOutlineEntry) => void;
}) {
  const tabs: Array<{ id: ReportPanelTab; label: string; count?: number }> = [];
  if (report.outline.length > 0) tabs.push({ id: "outline", label: "Outline" });
  if (sources.length > 0) tabs.push({ id: "sources", label: "Sources", count: sources.length });

  return (
    <aside
      aria-label="Outline and sources"
      className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85%] flex-col border-l bg-card shadow-2xl xl:static xl:w-72 xl:max-w-none xl:shadow-none 2xl:w-80"
    >
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b px-2.5">
        <div
          role="tablist"
          aria-label="Report panel"
          className="flex h-8 items-center gap-0.5 rounded-full bg-muted/70 p-0.5"
        >
          {tabs.map((option) => (
            <button
              key={option.id}
              id={`report-panel-tab-${option.id}`}
              type="button"
              role="tab"
              aria-selected={tab === option.id}
              aria-controls="report-panel"
              onClick={() => onTab(option.id)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                tab === option.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
              {option.count !== undefined ? (
                <span className="text-muted-foreground tabular-nums">{option.count}</span>
              ) : null}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          aria-label="Close panel"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>
      <div
        id="report-panel"
        role="tabpanel"
        aria-labelledby={`report-panel-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === "outline" ? (
          <ReportOutline report={report} jumpedTo={jumpedTo} onJump={onJump} />
        ) : (
          <ul className="space-y-0.5 p-2">
            {sources.map((source) => (
              <li key={`${source.kind}:${source.id}`}>
                <SourceRow source={source} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** The document's sections as a jump list, subsections tucked under theirs. */
function ReportOutline({
  report,
  jumpedTo,
  onJump,
}: {
  report: ReportSummary;
  jumpedTo: string | null;
  onJump: (entry: ReportOutlineEntry) => void;
}) {
  const sections = report.outline.filter((entry) => entry.level === 2).length;
  return (
    <div className="px-2.5 pt-3 pb-4">
      <p className="flex flex-wrap items-center gap-x-1.5 px-2 pb-2.5 text-xs text-muted-foreground">
        {report.readingMinutes !== null ? (
          <>
            <Clock3 aria-hidden="true" className="size-3.5" />
            <span className="font-medium text-foreground">{report.readingMinutes} min read</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        {report.wordCount !== null && report.wordCount > 0 ? (
          <>
            <span className="tabular-nums">{report.wordCount.toLocaleString()} words</span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span>{sections === 1 ? "1 section" : `${sections} sections`}</span>
      </p>
      <nav aria-label="Report outline">
        <ol className="space-y-px">
          {report.outline.map((entry, index) => {
            const current = entry.id === jumpedTo;
            return (
              <li key={`${entry.id}:${index}`}>
                <button
                  type="button"
                  aria-current={current ? "location" : undefined}
                  onClick={() => onJump(entry)}
                  className={cn(
                    "block w-full rounded-lg text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [overflow-wrap:anywhere]",
                    entry.level === 2
                      ? "px-2 py-1.5 text-[13px] leading-snug font-medium"
                      : "ml-2 w-[calc(100%-0.5rem)] rounded-l-none border-l py-1 pr-2 pl-3 text-xs leading-snug text-muted-foreground",
                    current
                      ? "bg-accent text-foreground"
                      : "hover:bg-accent/60 hover:text-foreground",
                    current && entry.level === 3 && "border-foreground/40",
                  )}
                >
                  {entry.text}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

function DetailHeader({
  report,
  busy,
  canDownloadPdf,
  pdfBusy,
  savingPdf,
  onPanel,
  onBack,
  onDownloadPdf,
  onRename,
  onCopyPath,
  onDelete,
  ready,
  panelTab,
  hasOutline,
  hasSources,
}: ReportDetailProps & {
  ready: boolean;
  panelTab: ReportPanelTab | null;
  hasOutline: boolean;
  hasSources: boolean;
}) {
  const profile = reportProfileOption(report.profile as ReportProfileId);
  const style = reportStyleOption(report.style as ReportStyleId);
  const swatch = reportStyleSwatch(report.style as ReportStyleId);
  const title = deriveReportTitle(report);
  const saved = originLabel(report.origin);
  const stamp =
    report.status === "done" && report.completedAt
      ? { verb: saved ? "Saved" : "Finished", iso: report.completedAt }
      : { verb: "Requested", iso: report.createdAt };

  const menuItems: ActionMenuItem[] = [];
  if (report.status === "done") {
    menuItems.push({
      id: "rename",
      label: "Rename",
      icon: <Pencil />,
      disabled: busy,
      onSelect: () => onRename(report),
    });
  }
  if (report.filePath !== null) {
    menuItems.push({
      id: "copy-path",
      label: "Copy file path",
      hint: "Self-contained HTML, saved locally",
      icon: <Copy />,
      onSelect: () => onCopyPath(report),
    });
  }
  if (report.status !== "running") {
    menuItems.push({
      id: "delete",
      label: "Delete",
      icon: <Trash2 />,
      destructive: true,
      disabled: busy,
      separated: menuItems.length > 0,
      onSelect: () => onDelete(report),
    });
  }

  return (
    <header className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5 sm:px-5">
      <Button
        variant="ghost"
        size="icon"
        className="-ml-2 size-8 shrink-0 lg:hidden"
        aria-label="Back to reports"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden="true" />
      </Button>
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold tracking-tight" title={title}>
          {title}
        </h2>
        <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {saved ? (
            <XLogo aria-hidden="true" className="size-2.5 shrink-0 text-foreground" />
          ) : (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full ring-1 ring-foreground/15"
              style={{ background: swatch.accent }}
            />
          )}
          <span className="truncate">
            {saved ?? `${style.label} · ${profile.label}`} · {countLabel(report)}
            {ready && report.readingMinutes !== null ? ` · ${report.readingMinutes} min read` : ""}
            <span className="hidden sm:inline">
              {" · "}
              <span title={formatAbsoluteTimestamp(stamp.iso) ?? undefined}>
                {stamp.verb} {formatRelativeTime(stamp.iso) ?? "recently"}
              </span>
            </span>
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {ready && (hasOutline || hasSources) ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={panelTab !== null}
            aria-label="Outline and sources"
            title={panelTab !== null ? "Hide outline and sources" : "Show outline and sources"}
            onClick={() =>
              onPanel(panelTab !== null ? "closed" : hasOutline ? "outline" : "sources")
            }
            className={cn("h-8 gap-1.5 rounded-full px-2.5", panelTab !== null && "bg-accent")}
          >
            <PanelRight aria-hidden="true" />
            <span className="sr-only 2xl:not-sr-only">Contents</span>
          </Button>
        ) : null}
        {ready && canDownloadPdf ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 rounded-full px-2.5 xl:px-3"
            disabled={busy || pdfBusy}
            title={savingPdf ? undefined : "Save as PDF"}
            onClick={() => onDownloadPdf(report)}
          >
            {savingPdf ? <Spinner /> : <Download aria-hidden="true" />}
            <span className="sr-only xl:not-sr-only">
              {savingPdf ? "Saving PDF…" : "Download PDF"}
            </span>
          </Button>
        ) : null}
        {ready ? (
          <a
            href={report.fileUrl ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new window"
            className={cn(buttonVariants({ size: "sm" }), "h-8 gap-1.5 rounded-full px-3")}
          >
            <ExternalLink aria-hidden="true" />
            <span>
              Open<span className="sr-only xl:not-sr-only"> report</span>
            </span>
          </a>
        ) : null}
        {menuItems.length > 0 ? (
          <ActionMenu
            label="More report actions"
            items={menuItems}
            triggerClassName="size-8 rounded-full"
          />
        ) : null}
      </div>
    </header>
  );
}

/**
 * The finished document, framed in place. The frame is fully sandboxed (the
 * report has no scripts anyway) except that its links may open new windows,
 * which the file route's embed mode points every external link at. Until the
 * document paints, the frame shows the style's own paper with a spinner, so
 * switching reports never flashes white over a dark Terminal report.
 */
function ReportReader({
  report,
  frameRef,
}: {
  report: ReportSummary;
  frameRef: RefObject<HTMLIFrameElement | null>;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const hydrated = useSyncExternalStore(subscribeNever, onClient, onServer);
  const swatch = reportStyleSwatch(report.style as ReportStyleId);
  // The query also busts the frame when a report finishes under the same id.
  const src = `${report.fileUrl}?embed=1&v=${encodeURIComponent(report.completedAt ?? "")}`;
  const loaded = loadedUrl === src;

  return (
    <div
      aria-busy={!loaded}
      className="relative min-w-0 flex-1"
      style={{ background: swatch.page }}
    >
      {hydrated ? (
        <iframe
          ref={frameRef}
          key={src}
          src={src}
          title={`${deriveReportTitle(report)} (report preview)`}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          onLoad={() => setLoadedUrl(src)}
          className={cn(
            "absolute inset-0 size-full border-0 transition-opacity duration-200 motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : null}
      {loaded ? null : (
        <div
          className="absolute inset-0 flex items-center justify-center gap-2 text-sm"
          style={{ color: swatch.muted }}
        >
          <Spinner />
          Opening report…
        </div>
      )}
    </div>
  );
}

const STEPS = ["Queued", "Writing", "Ready"] as const;

/** The three-stop pipeline under a pending or failed report. */
function Pipeline({ report }: { report: ReportSummary }) {
  const current = report.status === "queued" ? 0 : 1;
  const failed = report.status === "failed";
  return (
    <ol aria-label="Progress" className="grid w-full grid-cols-3">
      {STEPS.map((step, index) => {
        const complete = index < current;
        const active = index === current;
        return (
          <li
            key={step}
            aria-current={active ? "step" : undefined}
            className="relative flex flex-col items-center gap-1.5"
          >
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-3 right-[calc(50%+1.25rem)] left-[calc(-50%+1.25rem)] h-px",
                  index <= current ? "bg-foreground/50" : "bg-border",
                )}
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-[11px] font-semibold",
                complete && "border-transparent bg-foreground text-background",
                active && !failed && "border-foreground bg-background text-foreground",
                active && failed && "border-transparent bg-destructive text-white",
                !complete && !active && "bg-background text-muted-foreground",
              )}
            >
              {complete ? (
                <Check className="size-3.5" />
              ) : active && failed ? (
                <X className="size-3.5" />
              ) : active && report.status === "running" ? (
                <Spinner className="size-3.5" />
              ) : active && report.status === "queued" ? (
                <Clock className="size-3.5" />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn(
                "text-[11px] font-medium",
                active ? "text-foreground" : "text-muted-foreground",
                active && failed && "text-destructive",
              )}
            >
              {active && failed ? "Failed" : step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ReportProgress({
  report,
  reports,
  busy,
  retrying,
  onRetry,
  onDelete,
  sources,
}: ReportDetailProps & { sources: ReportSourceSummary[] }) {
  const ahead = report.status === "queued" ? jobsAhead(report, reports) : 0;
  const requested = formatRelativeTime(report.createdAt) ?? "recently";

  let heading: string;
  let body: string;
  switch (report.status) {
    case "queued":
      heading = "Waiting its turn";
      body =
        ahead === 0
          ? "Reports run one at a time — this one starts next."
          : `Reports run one at a time — ${ahead} ${ahead === 1 ? "job is" : "jobs are"} ahead of this one.`;
      break;
    case "running":
      heading = "Generating the report…";
      body =
        "This can take several minutes. It keeps going in the background, so feel free to leave this page.";
      break;
    case "failed":
      heading = "This report didn't finish";
      body =
        "Nothing was saved. Trying again queues a new report with the same sources and options.";
      break;
    default:
      heading = "The report file is unavailable";
      body = "It may have been moved or deleted from disk.";
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-6 pt-12 pb-10 text-center sm:pt-16">
        <div
          className={cn(
            "relative h-48 w-40 overflow-hidden rounded-lg shadow-[0_24px_48px_-20px_rgb(0_0_0/0.45)] ring-1 ring-foreground/10",
            report.status === "failed" && "opacity-60 grayscale",
          )}
        >
          <ReportStylePreview
            style={report.style as ReportStyleId}
            profile={report.profile as ReportProfileId}
          />
          {report.status === "running" ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-pulse bg-gradient-to-b from-transparent via-white/25 to-transparent motion-reduce:animate-none"
            />
          ) : null}
        </div>

        <div className="mt-8 w-full max-w-sm">
          <Pipeline report={report} />
        </div>

        <h3 className="mt-8 text-lg font-semibold tracking-tight">{heading}</h3>
        <p className="mt-1.5 max-w-md text-sm text-balance text-muted-foreground">{body}</p>
        <p
          className="mt-2 text-xs text-muted-foreground"
          title={formatAbsoluteTimestamp(report.createdAt) ?? undefined}
        >
          Requested {requested}
        </p>

        {report.status === "failed" && report.error ? (
          <AlertNote tone="danger" title="The report job failed." className="mt-6 text-left">
            {report.error}
          </AlertNote>
        ) : null}

        {report.status === "failed" || report.status === "queued" ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {report.status === "failed" ? (
              <Button className="rounded-full" disabled={busy} onClick={() => onRetry(report)}>
                {retrying ? <Spinner /> : <RotateCcw aria-hidden="true" />}
                Try again
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="rounded-full text-muted-foreground hover:text-destructive"
              disabled={busy}
              onClick={() => onDelete(report)}
            >
              <Trash2 aria-hidden="true" />
              {report.status === "queued" ? "Remove from queue" : "Delete"}
            </Button>
          </div>
        ) : null}
      </div>

      {sources.length > 0 ? <SourceGrid sources={sources} /> : null}
    </div>
  );
}

/** The sources of a report that cannot be read yet, collapsible for wide scopes. */
function SourceGrid({ sources }: { sources: ReportSourceSummary[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? sources : sources.slice(0, INITIAL_VISIBLE_SOURCES);
  const hidden = sources.length - visible.length;
  return (
    <section aria-label="Report sources" className="mx-auto w-full max-w-3xl px-4 pb-12 sm:px-6">
      <h3 className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {sourceCountLabel(sources.length)}
      </h3>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {visible.map((source) => (
          <li key={`${source.kind}:${source.id}`}>
            <SourceRow source={source} />
          </li>
        ))}
      </ul>
      {hidden > 0 || (expanded && sources.length > INITIAL_VISIBLE_SOURCES) ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 gap-1 text-muted-foreground"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("transition-transform", expanded && "rotate-180")}
          />
          {expanded ? "Show fewer sources" : `Show ${hidden} more source${hidden === 1 ? "" : "s"}`}
        </Button>
      ) : null}
    </section>
  );
}

/** One source: thumbnail, title, and creator. Videos open their in-app page;
 * X posts open the canonical status URL. */
function SourceRow({ source }: { source: ReportSourceSummary }) {
  const [failedThumbnail, setFailedThumbnail] = useState<string | null>(null);
  const isTweet = source.kind === "tweet";
  const className =
    "group/source flex items-start gap-3 rounded-xl p-2 outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";
  const duration = source.durationSeconds !== null ? formatDuration(source.durationSeconds) : null;
  const body = (
    <>
      <span className="relative block aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-muted ring-1 ring-foreground/5">
        {source.thumbnailUrl && failedThumbnail !== source.thumbnailUrl ? (
          <img
            ref={(image) => {
              // Cached failures may finish before hydration attaches onError.
              if (image?.complete && image.naturalWidth === 0)
                setFailedThumbnail(source.thumbnailUrl);
            }}
            onError={() => setFailedThumbnail(source.thumbnailUrl)}
            referrerPolicy="no-referrer"
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
              <XLogo className="size-3.5 text-foreground" />
            ) : (
              <FileVideo className="size-4" />
            )}
          </span>
        )}
        {duration ? (
          <span className="absolute right-1 bottom-1 rounded bg-black/75 px-1 text-[10px] leading-4 font-medium text-white tabular-nums">
            {duration}
          </span>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="line-clamp-2 text-xs leading-snug font-medium [overflow-wrap:anywhere]">
          {source.title}
        </span>
        <span className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          {isTweet ? <XLogo aria-hidden="true" className="size-2.5 shrink-0" /> : null}
          <span className="truncate">
            {source.featuredNames && source.featuredNames.length > 0
              ? `${source.featuredNames.join(", ")} on ${source.creatorName}`
              : source.creatorName}
          </span>
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
