"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  FileDown,
  Layers,
  MessageSquareQuote,
  Sparkles,
  Square,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/ai/model-picker";
import { useModelCatalog } from "@/components/ai/model-catalog-provider";
import { CHAT_MODE_OPTIONS, useChatMode } from "@/components/ai/chat-modes";
import { Select } from "@/components/ui/select";
import type { AiBackendId } from "@/lib/ai/backend-id";
import type {
  AnalysisJob,
  AnalysisLimits,
  CorpusPost,
  CorpusScope,
  PostResult,
} from "@/lib/x/research/analysis-model";
import { DEFAULT_ANALYSIS_LIMITS } from "@/lib/x/research/analysis-model";
import type { QuestionScopeDraft } from "./question-scope";
import { cn } from "@/lib/utils";

export async function researchJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ?? "Research could not finish. Try again."),
    );
  return data;
}
interface ResultPage {
  total: number;
  page: number;
  pageSize: number;
  posts: Array<{ post: CorpusPost; analysis: PostResult | null }>;
}
interface Conversation {
  threadId: number;
  turns: Array<{ id: string; question: string; state: AnalysisJob["state"] }>;
}
const active = (job: AnalysisJob | null) =>
  job && ["queued", "running", "waiting_for_provider"].includes(job.state.status);
const limitLabels: Record<keyof AnalysisLimits, string> = {
  contextTokens: "Context tokens",
  inputTokens: "Input tokens per call",
  outputTokens: "Output tokens per call",
  maxCalls: "Calls per attempt",
  maxTokens: "Tokens per attempt",
  timeoutMs: "Call timeout (ms)",
  maxRunMs: "Time per attempt (ms)",
  maxSnapshotBytes: "Snapshot budget (bytes)",
  retries: "Retries per batch",
};
const inputClass =
  "w-full min-w-0 rounded-md border border-input bg-background p-2.5 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

const DISPOSITION_STYLE: Record<string, string> = {
  relevant: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
  uncertain: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
  not_relevant: "text-muted-foreground",
};

const STATUS_LABEL: Record<string, string> = {
  complete: "Complete",
  running: "Running",
  queued: "Queued",
  waiting_for_provider: "Waiting for provider",
  cancelled: "Cancelled",
  failed: "Failed",
};

export function ResearchConsole({
  draft,
  initialJobId,
  className,
  onPrepareTopic,
}: {
  draft: QuestionScopeDraft | null;
  initialJobId?: string;
  className?: string;
  /** Prepares a related-topic question scope in the parent view. */
  onPrepareTopic?: (topic: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useChatMode();
  const [backend, setBackend] = useState<AiBackendId>("codex");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [limits, setLimits] = useState<AnalysisLimits>({ ...DEFAULT_ANALYSIS_LIMITS });
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [recent, setRecent] = useState<AnalysisJob[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [scope, setScope] = useState<CorpusScope | null>(null);
  const [citationAuthors, setCitationAuthors] = useState<
    Record<string, { name: string; handle: string; quotedName: string }>
  >({});
  const [results, setResults] = useState<ResultPage | null>(null);
  const [page, setPage] = useState(1);
  const [collection, setCollection] = useState("related");
  const [source, setSource] = useState<CorpusPost | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reportId, setReportId] = useState<number | null>(null);
  const [seenJobProp, setSeenJobProp] = useState(initialJobId);
  const [seenDraft, setSeenDraft] = useState(draft);
  const [newRevision, setNewRevision] = useState(Boolean(draft));
  const [topic, setTopic] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const evidenceRef = useRef<HTMLElement>(null);
  const requestVersion = useRef(0);
  if (seenJobProp !== initialJobId) {
    setSeenJobProp(initialJobId);
    if (initialJobId && initialJobId !== jobId) {
      setJobId(initialJobId);
      setJob(null);
      setResults(null);
      setSource(null);
      setSourceBusy(false);
      setConversation(null);
      setScope(null);
      setPage(1);
      setReportId(null);
      setError(null);
      setNewRevision(false);
    }
  }
  if (seenDraft !== draft) {
    setSeenDraft(draft);
    setNewRevision(true);
    setQuestion(draft?.question ?? "");
  }
  const { snapshot } = useModelCatalog();
  const models = snapshot.providers[backend].models;
  const selectedModel = models.find((m) => m.id === model);

  useEffect(() => {
    requestVersion.current++;
  }, [jobId]);

  useEffect(() => {
    let mounted = true;
    const load = () =>
      researchJson<{ jobs: AnalysisJob[] }>("/api/x-research/analysis")
        .then((data) => {
          if (mounted) setRecent(data.jobs);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!jobId) return;
    let mounted = true;
    const load = async () => {
      try {
        const [data, saved] = await Promise.all([
          researchJson<{
            job: AnalysisJob;
            results: ResultPage;
            citationAuthors: typeof citationAuthors;
          }>(`/api/x-research/analysis/${jobId}?page=${page}&collection=${collection}`),
          researchJson<{ conversation: Conversation | null; scope: CorpusScope }>(
            `/api/x-research/conversation?jobId=${jobId}`,
          ),
        ]);
        if (mounted) {
          setJob(data.job);
          setCitationAuthors(data.citationAuthors);
          setResults(data.results);
          setConversation(saved.conversation);
          setScope(saved.scope);
          setReadError(null);
        }
      } catch (err) {
        if (mounted) setReadError((err as Error).message);
      }
    };
    void load();
    const timer = setInterval(load, 1500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [jobId, page, collection]);
  function openJob(id: string) {
    requestVersion.current++;
    setJobId(id);
    setJob(null);
    setSource(null);
    setSourceBusy(false);
    setResults(null);
    setConversation(null);
    setScope(null);
    setReportId(null);
    setPage(1);
    setError(null);
    setNewRevision(false);
    setShowHistory(false);
    window.history.replaceState(null, "", `/x-research?job=${encodeURIComponent(id)}`);
  }
  async function estimate() {
    if (busy || active(job)) return;
    setBusy(true);
    setError(null);
    try {
      if (newRevision && !draft)
        throw new Error("Choose an Ask action to prepare a new scope revision.");
      if (!newRevision && !job) throw new Error("Prepare a scope or open saved research first.");
      const selection =
        draft?.kind === "results"
          ? {
              kind: "exact",
              search: Object.fromEntries(
                Object.entries(draft.search!).map(([key, value]) => [key, value.join("\n")]),
              ),
            }
          : draft?.kind === "selected"
            ? { kind: "selected", tweetIds: draft.tweetIds }
            : { kind: "all" };
      const scopeInput =
        newRevision && draft
          ? {
              listId: draft.listId,
              creatorIds: draft.creatorIds,
              start: draft.start,
              end: draft.end,
              timezone: draft.timezone,
              period: draft.period,
              types: draft.types,
              selection,
            }
          : conversation
            ? { threadId: conversation.threadId, parentJobId: job!.id }
            : { scopeId: job!.scopeId, parentJobId: job!.id };
      const data = await researchJson<{ job: AnalysisJob }>("/api/x-research/conversation", {
        ...scopeInput,
        question,
        mode,
        backend,
        ...(model ? { model, reasoningEffort: effort || null } : {}),
        limits,
        execute: false,
      });
      openJob(data.job.id);
      setJob(data.job);
      setQuestion("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function control(action: "cancel" | "resume") {
    if (!job || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await researchJson<{ job: AnalysisJob }>(`/api/x-research/analysis/${job.id}`, {
        action,
        ...(action === "resume"
          ? {
              limits: {
                maxCalls: limits.maxCalls,
                maxTokens: limits.maxTokens,
                maxRunMs: limits.maxRunMs,
              },
            }
          : {}),
      });
      setJob(data.job);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect(id: string) {
    if (!job) return;
    const version = ++requestVersion.current;
    setSourceBusy(true);
    setError(null);
    try {
      const data = await researchJson<{ source: CorpusPost }>(
        `/api/x-research/analysis/${job.id}?tweetId=${encodeURIComponent(id)}`,
      );
      if (version === requestVersion.current) {
        setSource(data.source);
        requestAnimationFrame(() => evidenceRef.current?.focus());
      }
    } catch (err) {
      if (version === requestVersion.current) setError((err as Error).message);
    } finally {
      if (version === requestVersion.current) setSourceBusy(false);
    }
  }
  async function save() {
    if (!job || busy) return;
    setBusy(true);
    setError(null);
    try {
      const data = await researchJson<{ report: { id: number } }>("/api/ai/reports", {
        researchJobId: job.id,
      });
      setReportId(data.report.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const jobActive = Boolean(active(job));
  const runningJob = recent.find((j) => active(j));
  return (
    <section
      aria-label="Ask and compare"
      className={cn(
        "flex min-w-0 flex-col gap-4 overflow-hidden rounded-2xl border bg-card shadow-sm",
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b px-4 py-3.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Sparkles aria-hidden="true" className="size-4" />
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-tight">Ask &amp; compare</h2>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          aria-expanded={showHistory}
          onClick={() => setShowHistory((current) => !current)}
        >
          <Layers aria-hidden="true" />
          Research {recent.length > 0 ? `(${recent.length})` : ""}
        </Button>
      </header>

      {showHistory ? (
        <div className="mx-4 rounded-xl border bg-muted/20 p-1.5">
          {recent.length ? (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto overscroll-contain">
              {recent.map((j) => (
                <li key={j.id}>
                  <button
                    type="button"
                    onClick={() => openJob(j.id)}
                    aria-current={j.id === jobId || undefined}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                      j.id === jobId
                        ? "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        active(j) ? "animate-pulse bg-emerald-500 motion-reduce:animate-none" : "bg-muted-foreground/50",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{j.config.question}</span>
                      <span className="block text-muted-foreground">
                        {STATUS_LABEL[j.state.status] ?? j.state.status}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-2.5 py-2 text-xs text-muted-foreground">
              No saved research yet. Prepared scans appear here.
            </p>
          )}
        </div>
      ) : null}

      {job ? (
        <div className="min-w-0 space-y-4 px-4 pb-4">
          <div className="space-y-2.5">
            <h3 className="text-sm leading-snug font-semibold break-words">
              {job.config.question}
            </h3>
            <p className="text-xs break-words text-muted-foreground">
              Frozen revision {job.scopeId.slice(0, 8)} ·{" "}
              {job.scope.creators.map((c) => c.name).join(", ")}
              {scope &&
                ` · ${scope.request.since} – ${scope.request.until} (end exclusive) · ${scope.request.types.join(", ")}`}
            </p>
            <div role="status" aria-live="polite" className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                    jobActive
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : job.state.status === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground",
                  )}
                >
                  {jobActive ? (
                    <span
                      aria-hidden="true"
                      className="size-1.5 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
                    />
                  ) : null}
                  {STATUS_LABEL[job.state.status] ?? job.state.status}
                </span>
                <span className="text-xs text-muted-foreground">{job.state.phase}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {job.progress.reviewed}/{job.scope.eligible} posts
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="Research progress"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, job.scope.eligible)}
                aria-valuenow={job.progress.reviewed}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-emerald-500/80 transition-all duration-700 motion-reduce:transition-none"
                  style={{
                    width: `${Math.min(100, Math.round((job.progress.reviewed / Math.max(1, job.scope.eligible)) * 100))}%`,
                  }}
                />
              </div>
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="text-emerald-700 dark:text-emerald-300">
                  {job.progress.relevant} relevant
                </span>
                <span className="text-amber-700 dark:text-amber-300">
                  {job.progress.uncertain} uncertain
                </span>
                <span>{job.progress.unfinished} unfinished</span>
                <span>{job.state.calls} calls</span>
                <span>{job.state.chargedTokens.toLocaleString()} charged tokens</span>
                <span>{job.state.reportedTokens.toLocaleString()} reported</span>
              </p>
              {job.state.reason && (
                <p className="text-xs break-words text-muted-foreground">{job.state.reason}</p>
              )}
            </div>
            <details className="group/limits text-xs">
              <summary className="flex w-fit cursor-pointer items-center gap-1 font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <ChevronDown
                  aria-hidden="true"
                  className="size-3.5 transition-transform group-open/limits:rotate-180 motion-reduce:transition-none"
                />
                Coverage, exclusions and estimates
              </summary>
              <div className="mt-2 space-y-1.5 border-t pt-2.5 text-muted-foreground">
                <p>
                  {job.scope.total} frozen posts · {job.scope.excluded.missing_date} unknown dates ·{" "}
                  {job.scope.excluded.incomplete_text} incomplete text ·{" "}
                  {job.scope.excluded.missing_text} missing text
                </p>
                <p>
                  {job.state.estimatedBatches} estimated screening batches ·{" "}
                  {job.state.estimatedTokens.toLocaleString()} estimated screening tokens; reduction
                  and verification require additional calls.
                </p>
                <p>
                  {job.config.backend} · {job.config.model} · {job.config.mode} ·{" "}
                  {job.config.reasoningEffort ?? "Default effort"}
                </p>
                {job.config.conversation?.abridged && (
                  <p>
                    Previous-turn context is abridged for the model. Prior answers remain saved;
                    this question still scans the full saved corpus.
                  </p>
                )}
                {job.scope.limitations.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
                {job.scope.coverage.map((c) => (
                  <p key={c.creatorId}>
                    {c.name}: {c.cachedPosts} cached · {c.oldest ?? "Unknown"} –{" "}
                    {c.newest ?? "Unknown"} ·{" "}
                    {c.hasError || c.pendingHead
                      ? "Partial retrieval"
                      : "Upstream completeness unverified"}
                  </p>
                ))}
                {job.progress.creators.map((c) => (
                  <p key={c.id}>
                    {job.scope.creators.find((s) => s.id === c.id)?.name ?? c.id}: {c.reviewed}/
                    {c.total} reviewed
                  </p>
                ))}
              </div>
            </details>
            <div className="flex flex-wrap items-center gap-2">
              {jobActive ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void control("cancel")}
                >
                  <Square aria-hidden="true" className="!size-3.5" />
                  Cancel research
                </Button>
              ) : (
                job.state.status !== "complete" && (
                  <Button size="sm" disabled={busy} onClick={() => void control("resume")}>
                    {job.state.calls === 0 ? "Start full scan" : "Resume research"}
                  </Button>
                )
              )}
              {job.state.result && (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void save()}>
                  <FileDown aria-hidden="true" className="!size-3.5" />
                  Save brief to Reports
                </Button>
              )}
              {reportId && (
                <>
                  <Link
                    className="text-xs font-medium underline underline-offset-4"
                    href="/reports"
                  >
                    Saved in Reports
                  </Link>
                  <a
                    className="text-xs font-medium underline underline-offset-4"
                    href={`/api/ai/reports/${reportId}/file`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open brief
                  </a>
                </>
              )}
            </div>
          </div>

          {conversation && conversation.turns.length > 1 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Conversation turns">
              {conversation.turns.map((t, i) => (
                <Button
                  key={t.id}
                  size="sm"
                  variant="ghost"
                  className={cn(
                    "h-auto max-w-full justify-start whitespace-normal px-2.5 py-1 text-left text-xs",
                    t.id === job.id
                      ? "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                  )}
                  aria-pressed={t.id === job.id}
                  onClick={() => openJob(t.id)}
                >
                  <MessageSquareQuote aria-hidden="true" className="!size-3.5 shrink-0" />
                  Turn {i + 1}: {t.question.slice(0, 40)}
                </Button>
              ))}
            </div>
          )}

          <div className="min-w-0 space-y-3" aria-label="Research answer">
            {job.state.result ? (
              <>
                <div className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {job.state.result.text.split(/(\[tweet:\d+\])/).map((part, i) =>
                    /^\[tweet:\d+\]$/.test(part) ? (
                      <button
                        key={i}
                        className="mx-0.5 inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0 align-baseline font-mono text-xs font-medium text-primary outline-none hover:bg-primary/20 focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void inspect(part.slice(7, -1))}
                      >
                        source {part.slice(7, -1)}
                      </button>
                    ) : (
                      part
                    ),
                  )}
                </div>
                <div
                  className="overflow-x-auto rounded-xl border"
                  tabIndex={0}
                  aria-label="Comparison table"
                >
                  <table className="w-full min-w-[46rem] text-left text-xs">
                    <caption className="px-3 pt-3 pb-2 text-left font-semibold">
                      Grounded comparison
                    </caption>
                    <thead>
                      <tr className="bg-muted/40">
                        {[
                          "Creator / speaker",
                          "Claim",
                          "Rationale / evidence",
                          "Horizon",
                          "Condition",
                          "Reading",
                        ].map((h) => (
                          <th
                            className="border-b px-2.5 py-2 font-medium text-muted-foreground"
                            key={h}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {job.state.result.claims.map((c, i) => (
                        <tr key={i} className="align-top even:bg-muted/20">
                          <td className="border-b px-2.5 py-2">
                            {[
                              ...new Set(
                                c.evidence.map((e) =>
                                  e.attribution === "quoted"
                                    ? `${citationAuthors[e.postId]?.quotedName ?? "Quoted speaker"} (quoted by ${citationAuthors[e.postId]?.name ?? e.postId})`
                                    : (citationAuthors[e.postId]?.name ??
                                      `Author of ${e.postId}`),
                                ),
                              ),
                            ].join("; ")}
                          </td>
                          <td className="border-b px-2.5 py-2">{c.claim}</td>
                          <td className="border-b px-2.5 py-2">
                            {c.evidence.map((e, k) => (
                              <button
                                className="block max-w-56 truncate text-left text-primary underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
                                key={k}
                                onClick={() => void inspect(e.postId)}
                              >
                                {e.excerpt} · Post {e.postId} ({e.attribution})
                              </button>
                            ))}
                          </td>
                          <td className="border-b px-2.5 py-2">{c.horizon ?? "Unspecified"}</td>
                          <td className="border-b px-2.5 py-2">{c.condition ?? "Unspecified"}</td>
                          <td className="border-b px-2.5 py-2">
                            {c.interpretation ? "Interpretation" : "Explicit claim"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">{job.state.result.scopeNote}</p>
              </>
            ) : (
              <p className="rounded-xl border border-dashed bg-muted/20 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
                {job.scope.eligible
                  ? "Validated post findings appear below as the scan progresses. A comparison appears after synthesis and source verification."
                  : "No eligible complete text in this retrieved scope. This does not establish absence on X."}
              </p>
            )}
          </div>

          <aside
            ref={evidenceRef}
            tabIndex={-1}
            aria-label="Frozen evidence"
            className="min-w-0 space-y-2 rounded-xl border bg-muted/20 p-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Evidence · answer-time snapshot
            </h3>
            {sourceBusy && (
              <p role="status" className="text-xs text-muted-foreground">
                Loading frozen source…
              </p>
            )}
            {source ? (
              <>
                <p className="text-sm font-medium">
                  {source.tweet.authorName}{" "}
                  <span className="font-normal text-muted-foreground">
                    (@{source.tweet.authorHandle})
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {source.tweet.publishedAt ?? "Unknown publication date"} · {source.postType} ·
                  Event: {source.eventAt}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">{source.tweet.text}</p>
                {source.tweet.quoted && (
                  <blockquote className="border-l-2 pl-2 text-xs whitespace-pre-wrap break-words text-muted-foreground">
                    Quoted context · {source.tweet.quoted.name ?? source.tweet.quoted.handle}:{" "}
                    {source.tweet.quoted.text}
                  </blockquote>
                )}
                {source.context && (
                  <p className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
                    Parent context only · {source.context.author}: {source.context.text}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Timeline attribution:{" "}
                  {source.provenance.map((p) => `${p.name} (${p.kind})`).join(", ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  Media and linked pages not analyzed. Archived source; current availability
                  unverified.
                </p>
                <a
                  className="inline-block text-xs font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
                  href={source.tweet.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open on X
                </a>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select a citation or result to inspect the exact full post used in this revision.
              </p>
            )}
          </aside>

          <div className="min-w-0 space-y-2.5" aria-label="Research post collection">
            <div className="space-y-1.5">
              <h3 className="text-sm font-semibold">Related posts in the retrieved scope</h3>
              <Select
                label="Result collection"
                size="sm"
                value={collection}
                onChange={(value) => {
                  setCollection(value);
                  setPage(1);
                  setResults(null);
                }}
                options={[
                  { value: "related", label: "Related and uncertain" },
                  { value: "unfinished", label: "Unfinished eligible posts" },
                  { value: "all", label: "Every frozen post" },
                ]}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Full scan · contextual relevance is model judgment. Relevant and uncertain posts
              remain paginated independently of answer citations.
            </p>
            {results && (
              <>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {results.total} posts · Page {results.page} of{" "}
                  {Math.max(1, Math.ceil(results.total / results.pageSize))}
                </p>
                <div
                  className="max-h-[28rem] space-y-2 overflow-y-auto overscroll-contain"
                  aria-label="Related post results"
                  tabIndex={0}
                >
                  {results.posts.map(({ post, analysis }) => {
                    const disposition =
                      analysis?.disposition ?? post.exclusion ?? "Unreviewed";
                    return (
                      <article
                        className="space-y-1.5 rounded-xl border bg-background/40 p-3"
                        key={post.tweet.id}
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                          <span className="font-medium">{post.tweet.authorName}</span>
                          <span className="text-muted-foreground">
                            {post.tweet.publishedAt ?? "Unknown date"}
                          </span>
                          <span
                            className={cn(
                              "ml-auto rounded-full border px-2 py-0.5 text-[11px] font-medium",
                              DISPOSITION_STYLE[disposition] ?? "text-muted-foreground",
                            )}
                          >
                            {disposition.replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="text-xs leading-relaxed break-words text-muted-foreground">
                          {post.tweet.text.slice(0, 500)}
                          {post.tweet.text.length > 500 ? "…" : ""}
                        </p>
                        <p className="text-xs break-words">
                          {analysis?.explanation ?? "No validated disposition."}
                        </p>
                        {analysis?.findings.map((f, i) => (
                          <p key={i} className="text-xs break-words">
                            {f.interpretation ? "Interpretation: " : ""}
                            {f.claim}
                          </p>
                        ))}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs text-muted-foreground"
                          onClick={() => void inspect(post.tweet.id)}
                        >
                          Inspect post {post.tweet.id}
                        </Button>
                      </article>
                    );
                  })}
                </div>
                {!results.total && (
                  <p className="text-xs text-muted-foreground">
                    {job.progress.unfinished
                      ? "No validated matches yet; unfinished posts remain."
                      : "No matches found in the retrieved posts. See coverage and uncertain results."}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={results.page <= 1}
                    onClick={() => {
                      setPage(results.page - 1);
                      setResults(null);
                    }}
                  >
                    <ArrowLeft aria-hidden="true" className="!size-3.5" />
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={results.page * results.pageSize >= results.total}
                    onClick={() => {
                      setPage(results.page + 1);
                      setResults(null);
                    }}
                  >
                    Next
                    <ArrowRight aria-hidden="true" className="!size-3.5" />
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : !draft ? (
        <div className="px-4">
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-6 text-center">
            <span
              aria-hidden="true"
              className="flex size-10 items-center justify-center rounded-full bg-muted"
            >
              <Sparkles aria-hidden="true" className="size-5 text-muted-foreground" />
            </span>
            <h3 className="text-sm font-semibold">Scan the archive with AI</h3>
            <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
              Prepare a scope from the feed — “Ask about this scope”, a search, or selected posts —
              then ask a question. Every eligible cached post is screened and the answer cites its
              sources.
            </p>
          </div>
        </div>
      ) : null}

      {(draft || job) && (
        <form
          className="space-y-3 border-t px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            void estimate();
          }}
        >
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-medium",
                newRevision ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
              )}
            >
              {newRevision ? "New scope revision" : "Follow-up"}
            </span>
            <span className="min-w-0 flex-1 text-muted-foreground">
              {newRevision
                ? `Scans ${draft?.label ?? "— choose an Ask action"}`
                : "Same frozen corpus; a new question-specific full scan"}
            </span>
            {job && draft && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                disabled={jobActive}
                onClick={() => setNewRevision((v) => !v)}
              >
                {newRevision ? "Reuse saved corpus" : "Use prepared scope"}
              </Button>
            )}
          </p>

          <div className="flex flex-wrap gap-1.5">
            {[
              "Who discussed ETH, and what did they say?",
              "Compare their theses, reasoning, time horizons and disagreements.",
              "Find ETH versus BTC arguments and compare their conditions.",
            ].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setQuestion(p)}
                className="rounded-full border bg-background px-2.5 py-1 text-left text-xs text-muted-foreground shadow-sm outline-none transition-colors hover:border-ring/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                {p}
              </button>
            ))}
          </div>

          <textarea
            aria-label={newRevision ? "Research question" : "Follow-up question"}
            className={cn(inputClass, "min-h-20 resize-y")}
            rows={3}
            required
            maxLength={4000}
            placeholder={
              newRevision
                ? "Ask about the prepared scope — name creators, assets and periods explicitly…"
                : "Ask a follow-up on the same frozen corpus…"
            }
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
          />

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">Reasoning mode</p>
              <div
                role="group"
                aria-label="Reasoning mode"
                className="flex items-center rounded-md bg-muted/70 p-0.5"
              >
                {CHAT_MODE_OPTIONS.map((m) => {
                  const selected = mode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={selected}
                      title={m.tagline}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        "flex-1 rounded-[5px] px-2 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                        selected
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-muted-foreground">
                  Provider
                </span>
                <Select
                  label="Provider"
                  size="sm"
                  value={backend}
                  onChange={(value) => {
                    setBackend(value as AiBackendId);
                    setModel("");
                    setEffort("");
                  }}
                  options={[
                    { value: "codex", label: "Codex" },
                    { value: "claude", label: "Claude" },
                    { value: "opencode", label: "OpenCode" },
                  ]}
                />
              </label>
              {selectedModel && selectedModel.reasoningOptions.length > 0 ? (
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">
                    Effort
                  </span>
                  <Select
                    label="Reasoning effort"
                    size="sm"
                    value={effort}
                    onChange={setEffort}
                    options={[
                      { value: "", label: "Provider default" },
                      ...selectedModel.reasoningOptions.map((e) => ({
                        value: e.id,
                        label: e.label,
                      })),
                    ]}
                  />
                </label>
              ) : (
                <div className="flex items-end">
                  <p className="pb-2 text-xs text-muted-foreground">Effort: provider default</p>
                </div>
              )}
            </div>
          </div>

          <ModelPicker
            provider={backend}
            models={models.map((m) => ({
              id: m.id,
              label: m.label,
              description: m.description,
              usable: m.runtimeCompatibility !== "unsupported",
            }))}
            value={model || "Saved model/settings"}
            onChange={(m) => {
              setModel(m);
              setEffort("");
            }}
            label="Research model"
          />

          <p className="text-xs leading-relaxed text-muted-foreground">
            Name creators, assets and periods explicitly when ambiguous. Pasted theses are user
            comparison material. Outside market facts require other sources. Saved model/settings
            uses Settings → AI providers; Quick, Balanced and Deep all scan every eligible post.
          </p>

          {onPrepareTopic ? (
            <div className="rounded-xl border border-dashed p-3">
              <label className="block space-y-1.5 text-xs font-medium">
                <span>Or scan for a related topic</span>
                <span className="block font-normal text-muted-foreground">
                  Prepares a full scan of the creator/date scope for posts related to the topic,
                  including indirect references.
                </span>
                <span className="flex gap-1.5">
                  <input
                    className={cn(inputClass, "h-9 py-0")}
                    value={topic}
                    maxLength={1000}
                    placeholder="e.g. ETH staking yield debates"
                    onChange={(e) => setTopic(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter prepares the topic scan instead of submitting
                      // the surrounding estimate form.
                      if (e.key === "Enter" && topic.trim()) {
                        e.preventDefault();
                        onPrepareTopic(topic.trim());
                        setTopic("");
                      }
                    }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={!topic.trim()}
                    onClick={() => {
                      onPrepareTopic(topic.trim());
                      setTopic("");
                    }}
                  >
                    Prepare
                  </Button>
                </span>
              </label>
            </div>
          ) : null}

          <details className="text-xs">
            <summary className="w-fit cursor-pointer font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              Work and context limits
            </summary>
            <div className="grid gap-2 pt-2 sm:grid-cols-2">
              {(Object.keys(limits) as Array<keyof AnalysisLimits>).map((k) => (
                <label key={k} className="space-y-1">
                  <span className="block text-muted-foreground">{limitLabels[k]}</span>
                  <input
                    className={cn(inputClass, "h-8 py-0")}
                    type="number"
                    min={k === "retries" ? 0 : 1}
                    step={1}
                    value={limits[k]}
                    onChange={(e) => setLimits((v) => ({ ...v, [k]: Number(e.target.value) }))}
                  />
                </label>
              ))}
            </div>
            <p className="pt-2 text-muted-foreground">
              Context limits are conservative, configurable ceilings. Work limits can increase on
              Resume; changing context/model requires a new turn. Estimates exclude additional
              comparison/verification calls.
            </p>
          </details>

          <Button
            type="submit"
            className="w-full"
            disabled={busy || jobActive || !question.trim()}
          >
            <Sparkles aria-hidden="true" />
            {busy
              ? "Preparing…"
              : jobActive
                ? "Scan in progress…"
                : newRevision
                  ? "Estimate new revision"
                  : "Estimate follow-up"}
          </Button>
        </form>
      )}

      {error && (
        <p
          role="alert"
          className="mx-4 mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs break-words text-destructive"
        >
          {error}
        </p>
      )}
      {readError && !error && (
        <p
          role="alert"
          className="mx-4 mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs break-words text-destructive"
        >
          {readError}
        </p>
      )}
      {runningJob && !showHistory ? (
        <button
          type="button"
          onClick={() => openJob(runningJob.id)}
          className="mx-4 mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-left text-xs text-emerald-800 outline-none hover:bg-emerald-500/15 focus-visible:ring-2 focus-visible:ring-ring dark:text-emerald-300"
        >
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
          />
          A scan is running — open it
        </button>
      ) : null}
    </section>
  );
}
