"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  BarChart3,
  Check,
  ChevronRight,
  Copy,
  FileText,
  Flame,
  History,
  Lightbulb,
  Maximize2,
  Minimize2,
  Scale,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { InsightMarkdown } from "@/components/x-dashboard/insight-markdown";
import { requestJson, useInsight } from "@/components/x-dashboard/use-dashboard-data";
import { formatRelativeTime } from "@/lib/format";
import {
  INSIGHT_PRESETS,
  PERIOD_LABELS,
  SHOW_LABELS,
  type InsightDetail,
  type InsightScope,
  type InsightSummary,
} from "@/lib/x/dashboard/model";
import { cn } from "@/lib/utils";

/** What the panel would analyze right now (the visible feed, or a selection). */
export type DraftScope = Omit<InsightScope, "since" | "until">;

const PRESET_ICONS: Record<string, typeof Sparkles> = {
  brief: Sparkles,
  narratives: Flame,
  tickers: BarChart3,
  consensus: Scale,
  creators: UserRound,
  actionable: Lightbulb,
};

function plainCopy(detail: InsightDetail, text: string): string {
  return text.replace(/\[post:(\d+)\]/g, (_, id: string) =>
    detail.sources[id] ? `(@${detail.sources[id].authorHandle})` : "",
  );
}

/** The AI Chat composer, sized for the panel: text on top, hint and Send/Stop below. */
function Composer({
  placeholder,
  disabled,
  autoFocus,
  value,
  onChange,
  onSubmit,
  running = false,
  onStop,
  hint,
}: {
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  running?: boolean;
  onStop?: () => void;
  hint?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 180)}px`;
  }, [value]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && !running && value.trim()) onSubmit();
      }}
      className="rounded-lg border border-input bg-background shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-card motion-reduce:transition-none"
    >
      <textarea
        ref={ref}
        rows={2}
        value={value}
        maxLength={4000}
        placeholder={placeholder}
        aria-label={placeholder}
        disabled={disabled && !running}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        className="block max-h-44 min-h-14 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-2 pr-2 pb-2 pl-3.5">
        <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{hint}</div>
        {running ? (
          <Button type="button" variant="secondary" size="sm" className="h-7 px-2.5" onClick={onStop}>
            <Square aria-hidden="true" className="!size-3" />
            Stop
          </Button>
        ) : (
          <Button type="submit" size="sm" className="h-7 px-2.5" disabled={disabled || !value.trim()}>
            <ArrowUp aria-hidden="true" />
            Send
          </Button>
        )}
      </div>
    </form>
  );
}

/** "Using Codex · model · Change", shown inside the composer. */
function ModelHint({ aiLabel }: { aiLabel: string }) {
  return (
    <>
      {aiLabel} ·{" "}
      <Link href="/settings" className="underline-offset-2 hover:text-foreground hover:underline">
        Change
      </Link>
    </>
  );
}

/** What the panel is about to analyze, as one quiet line. */
function ScopeLine({
  scope,
  preview,
  onClearSelection,
}: {
  scope: DraftScope;
  preview: { postCount: number; total: number; accounts: number } | null | "error";
  onClearSelection: () => void;
}) {
  const selection = scope.tweetIds?.length ?? 0;
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-1.5">
        <span className="font-medium text-foreground">
          {selection ? `${selection} selected post${selection === 1 ? "" : "s"}` : scope.label}
        </span>
        {selection ? (
          <button
            type="button"
            onClick={onClearSelection}
            className="inline-flex items-center gap-0.5 rounded-full border px-1.5 leading-5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3" />
            Use whole feed
          </button>
        ) : (
          <span>
            · {PERIOD_LABELS[scope.period]} · {SHOW_LABELS[scope.show]}
            {scope.query ? ` · “${scope.query}”` : ""}
          </span>
        )}
      </p>
      <p className="tabular-nums" aria-live="polite">
        {preview === null
          ? "Counting posts…"
          : preview === "error"
            ? "Couldn't count posts for this view."
            : preview.postCount === 0
              ? "No posts with text here yet — widen the time range or sync first."
              : `${preview.postCount.toLocaleString()} post${preview.postCount === 1 ? "" : "s"} from ${preview.accounts} account${preview.accounts === 1 ? "" : "s"}${preview.total > preview.postCount ? ` (newest ${preview.postCount.toLocaleString()} of ${preview.total.toLocaleString()})` : ""}`}
      </p>
    </div>
  );
}

/** Copy and Save sit under the answer they act on, like AI Chat. */
function AnswerActions({
  detail,
  content,
  latest,
  busy,
  onSave,
}: {
  detail: InsightDetail;
  content: string;
  latest: boolean;
  busy: boolean;
  onSave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const action = "h-7 gap-1.5 px-2 text-xs text-muted-foreground [&_svg]:size-3.5";
  return (
    <div className="mt-2 -ml-2 flex flex-wrap items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className={action}
        onClick={() => {
          void navigator.clipboard?.writeText(plainCopy(detail, content)).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? "Copied" : "Copy"}
      </Button>
      {!latest ? null : detail.reportId ? (
        <>
          <Button variant="ghost" size="sm" className={action} disabled={busy} onClick={onSave}>
            <FileText aria-hidden="true" />
            Update report
          </Button>
          <Link
            href="/reports"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Check aria-hidden="true" className="size-3.5" />
            Saved in Reports
          </Link>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={action}
          disabled={busy || !detail.messages.some((m) => m.role === "assistant" && m.status === "complete")}
          onClick={onSave}
        >
          <FileText aria-hidden="true" />
          Save to Reports
        </Button>
      )}
    </div>
  );
}

function InsightView({
  detail,
  aiLabel,
  wide,
  onFollowUp,
  onRetry,
  onStop,
  onSave,
  busy,
}: {
  detail: InsightDetail;
  aiLabel: string;
  wide: boolean;
  onFollowUp: (question: string) => Promise<boolean>;
  onRetry: () => void;
  onStop: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const running = detail.status === "running";
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lastLength = detail.messages.at(-1)?.content.length ?? 0;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  // Follow the answer as it streams. Scrolling the panel's own scroller (not
  // scrollIntoView) can never move it sideways or scroll the feed behind it.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (running && scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [running, lastLength, detail.messages.length]);
  const lastAnswer = detail.messages.findLast((m) => m.role === "assistant");
  const startedAt = Date.parse(detail.messages.at(-1)?.createdAt ?? detail.updatedAt);
  const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
  const column = cn("w-full", wide && "mx-auto max-w-3xl");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain">
        <div className={cn(column, "space-y-5 px-5 pt-4 pb-6")}>
          <div>
            <h3 className="text-base leading-snug font-semibold tracking-tight">{detail.title}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {detail.scope.tweetIds?.length
                ? `${detail.postCount} selected post${detail.postCount === 1 ? "" : "s"}`
                : `${detail.scope.label} · ${PERIOD_LABELS[detail.scope.period]} · ${detail.postCount.toLocaleString()} posts`}
              {" · "}
              <span suppressHydrationWarning>{formatRelativeTime(detail.createdAt)}</span>
            </p>
          </div>
          {detail.messages.map((message, index) =>
            message.role === "user" ? (
              index === 0 ? null : (
                <div key={message.id} className="flex justify-end">
                  <p className="max-w-[85%] rounded-lg bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap text-secondary-foreground [overflow-wrap:anywhere]">
                    {message.content}
                  </p>
                </div>
              )
            ) : message.status === "running" && !message.content ? (
              <div key={message.id} className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground" role="status">
                <Spinner />
                <span>
                  {index === 1
                    ? `Reading ${detail.postCount.toLocaleString()} post${detail.postCount === 1 ? "" : "s"}…`
                    : "Thinking…"}
                </span>
                <span className="ml-auto text-xs tabular-nums">{elapsed}s</span>
              </div>
            ) : message.status === "failed" ? (
              <div
                key={message.id}
                role="alert"
                className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm"
              >
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="min-w-0 flex-1">
                  <p>{detail.error ?? message.content}</p>
                  {message.id === lastAnswer?.id ? (
                    <Button size="sm" variant="outline" className="mt-2 h-7" onClick={onRetry}>
                      Try again
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : (
              <div key={message.id}>
                <InsightMarkdown
                  text={message.content}
                  sources={detail.sources}
                  streaming={message.status === "running"}
                />
                {message.status === "cancelled" ? (
                  <p className="mt-1 text-xs text-muted-foreground">Stopped here — this answer may be incomplete.</p>
                ) : null}
                {message.status === "running" || !message.content ? null : (
                  <AnswerActions
                    detail={detail}
                    content={message.content}
                    latest={message.id === lastAnswer?.id && !running}
                    busy={busy}
                    onSave={onSave}
                  />
                )}
              </div>
            ),
          )}
        </div>
      </div>
      <div className="border-t pt-3 pb-4">
        <div className={cn(column, "px-5")}>
          <Composer
            placeholder="Ask a follow-up…"
            disabled={busy}
            running={running}
            onStop={onStop}
            hint={<ModelHint aiLabel={aiLabel} />}
            value={draft}
            onChange={setDraft}
            onSubmit={() => {
              const question = draft.trim();
              setDraft("");
              void onFollowUp(question).then((ok) => {
                if (!ok) setDraft(question);
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function HistoryList({
  insights,
  activeId,
  onOpen,
  onDelete,
}: {
  insights: InsightSummary[];
  activeId: string | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!insights.length)
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        Your analyses will show up here.
      </p>
    );
  return (
    <ul className="space-y-0.5 px-2 py-2">
      {insights.map((insight) => (
        <li key={insight.id} className="group/item relative">
          <button
            type="button"
            onClick={() => onOpen(insight.id)}
            aria-current={insight.id === activeId || undefined}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 pr-9 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              insight.id === activeId ? "bg-accent" : "hover:bg-accent/60",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                insight.status === "running"
                  ? "animate-pulse bg-foreground/70 motion-reduce:animate-none"
                  : insight.status === "failed"
                    ? "bg-destructive"
                    : "bg-muted-foreground/40",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{insight.title}</span>
              <span className="block truncate text-xs text-muted-foreground" suppressHydrationWarning>
                {insight.status === "running" ? "Writing…" : formatRelativeTime(insight.createdAt)} ·{" "}
                {insight.postCount.toLocaleString()} posts
              </span>
            </span>
          </button>
          <button
            type="button"
            aria-label={`Delete ${insight.title}`}
            title="Delete"
            onClick={() => onDelete(insight.id)}
            className="absolute top-2 right-1.5 rounded-md p-1.5 text-muted-foreground opacity-0 outline-none transition-opacity group-hover/item:opacity-100 hover:bg-background hover:text-destructive focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AnalyzePanel({
  scope,
  aiLabel,
  activeId,
  onActiveIdChange,
  onClearSelection,
  onClose,
  draftQuestion,
  onDraftQuestionChange,
  wide,
  onWideChange,
}: {
  scope: DraftScope;
  aiLabel: string;
  activeId: string | null;
  onActiveIdChange: (id: string | null) => void;
  onClearSelection: () => void;
  onClose: () => void;
  draftQuestion: string;
  onDraftQuestionChange: (value: string) => void;
  /** Reading view: the panel covers the feed with a centered column. */
  wide: boolean;
  onWideChange: (wide: boolean) => void;
}) {
  const [view, setView] = useState<"home" | "history">("home");
  const [insights, setInsights] = useState<InsightSummary[]>([]);
  const [previewState, setPreviewState] = useState<{
    key: string;
    value: { postCount: number; total: number; accounts: number } | "error";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { insight, error: loadError, setInsight } = useInsight(activeId);
  const scopeKey = JSON.stringify(scope);

  const loadHistory = useCallback(() => {
    requestJson<{ insights: InsightSummary[] }>("/api/x-dashboard/insights")
      .then((data) => setInsights(data.insights))
      .catch(() => {});
  }, []);
  useEffect(loadHistory, [loadHistory, insight?.status]);

  const preview = !scope.creatorIds.length
    ? { postCount: 0, total: 0, accounts: 0 }
    : previewState?.key === scopeKey
      ? previewState.value
      : null;
  useEffect(() => {
    const parsed = JSON.parse(scopeKey) as DraftScope;
    if (!parsed.creatorIds.length) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      requestJson<{ postCount: number; total: number; accounts: number }>(
        "/api/x-dashboard/insights/preview",
        { body: { scope: parsed }, signal: controller.signal },
      )
        .then((value) => setPreviewState({ key: scopeKey, value }))
        .catch(() => {
          if (!controller.signal.aborted) setPreviewState({ key: scopeKey, value: "error" });
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [scopeKey]);

  async function start(input: { preset?: string; question?: string }, target: DraftScope = scope) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      const data = await requestJson<{ insight: InsightDetail }>("/api/x-dashboard/insights", {
        body: { scope: target, ...input },
      });
      setInsight(data.insight);
      onActiveIdChange(data.insight.id);
      setView("home");
      loadHistory();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the analysis.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function act(body: Record<string, unknown>) {
    if (!activeId) return false;
    setBusy(true);
    setError(null);
    try {
      const data = await requestJson<{ insight: InsightDetail }>(
        `/api/x-dashboard/insights/${encodeURIComponent(activeId)}`,
        { body },
      );
      setInsight(data.insight);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const empty = preview !== null && preview !== "error" && preview.postCount === 0;
  const showInsight = view === "home" && activeId;

  const column = cn("w-full", wide && "mx-auto max-w-3xl");

  return (
    <section aria-label="Analyze with AI" className="flex h-full min-h-0 flex-col bg-card">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b px-2.5">
        {showInsight || view === "history" ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Back to new analysis"
            onClick={() => {
              setView("home");
              onActiveIdChange(null);
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : (
          <Sparkles aria-hidden="true" className="mr-0.5 ml-2 size-4 text-muted-foreground" />
        )}
        <h2 className="ml-1 flex-1 truncate text-sm font-semibold">
          {view === "history" ? "Past analyses" : showInsight ? "Analysis" : "Analyze with AI"}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8 text-muted-foreground", view === "history" && "bg-accent text-foreground")}
          aria-label="Past analyses"
          aria-pressed={view === "history"}
          title="Past analyses"
          onClick={() => setView((current) => (current === "history" ? "home" : "history"))}
        >
          <History aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={wide ? "Back to side panel" : "Open wide"}
          aria-pressed={wide}
          title={wide ? "Back to side panel" : "Open wide"}
          onClick={() => onWideChange(!wide)}
        >
          {wide ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label="Close analysis panel"
          title="Close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>

      {error ? (
        <div role="alert" className={cn(column, "px-4 pt-3")}>
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <p className="min-w-0 flex-1">{error}</p>
            <button type="button" aria-label="Dismiss" onClick={() => setError(null)}>
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}

      {view === "history" ? (
        <div className="min-h-0 flex-1 overflow-x-clip overflow-y-auto">
          <div className={column}>
            <HistoryList
              insights={insights}
              activeId={activeId}
              onOpen={(id) => {
                onActiveIdChange(id);
                setView("home");
              }}
              onDelete={(id) => {
                void requestJson(`/api/x-dashboard/insights/${encodeURIComponent(id)}`, { method: "DELETE" })
                  .then(() => {
                    if (id === activeId) onActiveIdChange(null);
                    loadHistory();
                  })
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : "Couldn't delete."));
              }}
            />
          </div>
        </div>
      ) : showInsight ? (
        insight ? (
          <InsightView
            detail={insight}
            aiLabel={aiLabel}
            wide={wide}
            busy={busy}
            onStop={() => void act({ action: "stop" })}
            onSave={() => void act({ action: "save" })}
            onFollowUp={(question) => act({ action: "ask", question })}
            onRetry={() => {
              const lastQuestion = insight.messages.findLast((m) => m.role === "user");
              if (insight.messages.length > 2 && lastQuestion)
                void act({ action: "ask", question: lastQuestion.content });
              else
                void start(
                  insight.preset ? { preset: insight.preset } : { question: lastQuestion?.content ?? "" },
                  insight.scope,
                );
            }}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {loadError ?? <Spinner />}
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain">
            <div className={cn(column, "space-y-5 px-3 pt-4 pb-4")}>
              <div className="px-2">
                <ScopeLine scope={scope} preview={preview} onClearSelection={onClearSelection} />
              </div>
              <div>
                <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">Analyses</p>
                <ul>
                  {INSIGHT_PRESETS.map((preset) => {
                    const Icon = PRESET_ICONS[preset.id] ?? Sparkles;
                    return (
                      <li key={preset.id}>
                        <button
                          type="button"
                          disabled={busy || empty}
                          onClick={() => void start({ preset: preset.id })}
                          className="group/preset flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none"
                        >
                          <Icon
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-colors group-hover/preset:text-foreground motion-reduce:transition-none"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm leading-tight font-medium">{preset.label}</span>
                            <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                              {preset.description}
                            </span>
                          </span>
                          <ChevronRight
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/preset:opacity-100 group-focus-visible/preset:opacity-100 motion-reduce:transition-none"
                          />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
              {insights.length ? (
                <div>
                  <div className="mb-1 flex items-center justify-between px-2">
                    <p className="text-xs font-medium text-muted-foreground">Recent</p>
                    <button
                      type="button"
                      onClick={() => setView("history")}
                      className="rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      See all
                    </button>
                  </div>
                  <ul>
                    {insights.slice(0, 3).map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => onActiveIdChange(item.id)}
                          className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                        >
                          {item.status === "running" ? (
                            <Spinner className="size-4" />
                          ) : (
                            <History aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <span className="min-w-0 flex-1 truncate">{item.title}</span>
                          <span className="shrink-0 text-xs text-muted-foreground" suppressHydrationWarning>
                            {formatRelativeTime(item.createdAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
          <div className="border-t px-4 pt-3 pb-4">
            <div className={column}>
              <Composer
                placeholder="Ask anything about these posts…"
                disabled={busy || empty}
                autoFocus={Boolean(scope.tweetIds?.length)}
                hint={<ModelHint aiLabel={aiLabel} />}
                value={draftQuestion}
                onChange={onDraftQuestionChange}
                onSubmit={() => {
                  const question = draftQuestion.trim();
                  onDraftQuestionChange("");
                  void start({ question }).then((ok) => {
                    if (!ok) onDraftQuestionChange(question);
                  });
                }}
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
