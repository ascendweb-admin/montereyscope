"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Globe,
  Inbox,
  MessageCircle,
  PenLine,
  Quote,
  Repeat2,
  SearchX,
  Sparkles,
  TriangleAlert,
  Users,
  X,
} from "lucide-react";

import { ResearchConsole } from "./research-console";
import { RetrievalControls } from "./retrieval-controls";
import { SearchControls, type SearchFields } from "./search-controls";
import { QuestionScope, type QuestionScopeDraft } from "./question-scope";
import { ScopeSidebar } from "./scope-sidebar";
import { PostRow } from "./post-row";
import type { TweetViewModel } from "@/lib/x/view-model";
import { TweetDetailDialog } from "@/components/channel/tweet-card";
import { AppDialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { PendingIndicator } from "@/components/ui/pending";
import { DatePicker } from "@/components/ui/date-picker";
import { calendarDate, shiftDate } from "@/lib/x/research/dates";
import {
  POST_TYPES,
  type CachedFeed,
  type ResearchCreator,
  type ResearchList,
  type ResearchPost,
  type ResearchPostType,
} from "@/lib/x/research/model";
import { cn } from "@/lib/utils";

const field =
  "h-9 min-w-0 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

const TYPE_META: Record<ResearchPostType, { label: string; icon: typeof PenLine }> = {
  original: { label: "Originals", icon: PenLine },
  quote: { label: "Quotes", icon: Quote },
  reply: { label: "Replies", icon: MessageCircle },
  repost: { label: "Reposts", icon: Repeat2 },
};

const PERIOD_OPTIONS = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "custom", label: "Custom" },
] as const;

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === "string"
        ? result.error
        : "The local data could not be loaded. Please try again.",
    );
  return result as T;
}

export function XResearchView({
  initialLists,
  creators: initialCreators,
  categories,
  initialJobId,
}: {
  initialJobId?: string;
  initialLists: ResearchList[];
  creators: ResearchCreator[];
  categories: Array<{ id: number; name: string }>;
}) {
  const initialListsRef = useRef(initialLists);
  const [lists, setLists] = useState(initialLists);
  const [creators, setCreators] = useState(initialCreators);
  const [activeId, setActiveId] = useState<number | null>(initialLists[0]?.id ?? null);
  const [selected, setSelected] = useState<number[]>(initialLists[0]?.creatorIds ?? []);
  const [timezone, setTimezone] = useState("UTC");
  const [timezoneInput, setTimezoneInput] = useState("UTC");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [period, setPeriod] = useState("7d");
  const [types, setTypes] = useState<ResearchPostType[]>(["original", "quote", "reply"]);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState<SearchFields | null>(null);
  const [postSelection, setPostSelection] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const [questionScope, setQuestionScope] = useState<QuestionScopeDraft | null>(null);
  const [result, setResult] = useState<{
    key: string;
    scopeKey: string;
    feed?: CachedFeed;
    error?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [hydrating, setHydrating] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const onRetrievalProgress = useCallback(() => setRevision((r) => r + 1), []);
  const [detail, setDetail] = useState<ResearchPost | null>(null);
  const [editing, setEditing] = useState<ResearchList | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<number[]>([]);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerCategory, setPickerCategory] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showTimezone, setShowTimezone] = useState(false);
  const consoleColumnRef = useRef<HTMLDivElement>(null);
  const timezoneRef = useRef<HTMLDivElement>(null);
  const active = lists.find((list) => list.id === activeId);
  const available = active ? creators.filter((c) => active.creatorIds.includes(c.id)) : creators;

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setTimezone(zone);
      setTimezoneInput(zone);
      const today = calendarDate(new Date(), zone);
      setEnd(today);
      setStart(shiftDate(today, -6));
      try {
        const saved = localStorage.getItem("scope-x-research-list");
        const list = initialListsRef.current.find((l) => String(l.id) === saved);
        if (saved === "adhoc") {
          setActiveId(null);
          setSelected([]);
        } else if (list) {
          setActiveId(list.id);
          setSelected(list.creatorIds);
        }
      } catch {
        /* Storage is optional; lists and posts live in SQLite. */
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const browsingKey = JSON.stringify({
    activeId,
    selected,
    start,
    end,
    timezone,
    types,
    period,
    search,
  });
  const scopeKey = `${browsingKey}:${page}`;
  const selectedPostIds = postSelection.key === browsingKey ? postSelection.ids : [];
  const queryKey = `${scopeKey}:${revision}`;
  // Keep the same scoped cached feed mounted while page commits update it.
  // This also preserves the Details trigger for keyboard focus restoration.
  const feed = result?.scopeKey === scopeKey ? (result.feed ?? null) : null;
  const loading = Boolean(start && end) && result?.key !== queryKey && feed === null;
  const readError =
    !start || !end
      ? "Choose both calendar dates to browse cached posts."
      : result?.key === queryKey
        ? result.error
        : null;

  useEffect(() => {
    if (!start || !end) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      creators: selected.join(","),
      start,
      end,
      timezone,
      types: types.join(","),
      page: String(page),
      period,
    });
    if (activeId !== null) params.set("listId", String(activeId));
    if (search) {
      params.set("mode", "exact");
      for (const [key, value] of Object.entries(search)) params.set(key, value);
    }

    requestJson<CachedFeed>(`/api/x-research/feed?${params}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setResult({ key: queryKey, scopeKey, feed: value });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setResult({
            key: queryKey,
            scopeKey,
            error: err instanceof Error ? err.message : "The cached feed could not be loaded.",
          });
      });
    return () => controller.abort();
  }, [activeId, selected, start, end, timezone, types, page, period, search, queryKey, scopeKey]);

  // On viewports without the docked console column, bring the console into
  // view when a question scope is prepared so the Ask flow is never lost.
  useEffect(() => {
    if (!questionScope) return;
    if (window.matchMedia("(min-width: 1536px)").matches) return;
    consoleColumnRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [questionScope]);

  useEffect(() => {
    if (!showTimezone) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (timezoneRef.current && !timezoneRef.current.contains(event.target as Node)) {
        setShowTimezone(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showTimezone]);

  function prepareQuestion(kind: QuestionScopeDraft["kind"], question?: string) {
    if (!feed) return;
    setQuestionScope({
      kind,
      listId: activeId,
      start,
      end,
      period,
      question,
      label:
        kind === "list"
          ? (active?.name ?? "Ad hoc selection")
          : kind === "results"
            ? "All exact results"
            : "Selected posts",
      creatorIds: [...selected],
      bounds: { ...feed.bounds },
      timezone,
      types: [...types],
      ...(kind === "results" && feed.search ? { search: feed.search } : {}),
      ...(kind === "selected" ? { tweetIds: [...selectedPostIds] } : {}),
      count:
        kind === "list"
          ? feed.scopeTotal
          : kind === "results"
            ? feed.total
            : selectedPostIds.length,
      browsingKey,
    });
  }

  function chooseList(id: number | null) {
    setActiveId(id);
    setSelected(lists.find((l) => l.id === id)?.creatorIds ?? []);
    setPage(1);
    try {
      localStorage.setItem("scope-x-research-list", id === null ? "adhoc" : String(id));
    } catch {
      /* optional */
    }
  }
  function openEditor(list: ResearchList | "new") {
    setEditing(list);
    setName(list === "new" ? "" : list.name);
    setDescription(list === "new" ? "" : list.description);
    setMembers(list === "new" ? selected : list.creatorIds);
    setDialogError(null);
    setPickerQuery("");
    setPickerCategory(0);
  }
  async function saveList() {
    if (editing === null || busy) return;
    setBusy(true);
    setDialogError(null);
    try {
      const { list } = await requestJson<{ list: ResearchList }>(
        editing === "new" ? "/api/x-research/lists" : `/api/x-research/lists/${editing.id}`,
        {
          method: editing === "new" ? "POST" : "PATCH",
          body: JSON.stringify({ name, description, creatorIds: members }),
        },
      );
      setLists((current) =>
        [...current.filter((l) => l.id !== list.id), list].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      );
      setActiveId(list.id);
      setSelected(list.creatorIds);
      setPage(1);
      setRevision((r) => r + 1);
      setEditing(null);
      try {
        localStorage.setItem("scope-x-research-list", String(list.id));
      } catch {
        /* optional */
      }
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : "Could not save this list.");
    } finally {
      setBusy(false);
    }
  }
  function preset(value: string, zone = timezone) {
    setPeriod(value);
    setPage(1);
    if (value !== "custom") {
      const today = calendarDate(new Date(), zone);
      setEnd(today);
      setStart(shiftDate(today, value === "30d" ? -29 : value === "7d" ? -6 : 0));
    }
  }
  const stamp = (value: string | null) =>
    value ? new Date(value).toLocaleString(undefined, { timeZone: timezone }) : "Unknown";

  const lastRefresh = feed
    ? feed.coverage
        .map((c) => c.lastRefreshedAt)
        .filter((at): at is string => at !== null)
        .sort()
        .at(-1) ?? null
    : null;
  const cachedCreators = feed
    ? feed.coverage.filter((c) => c.cachedPosts > 0).length
    : 0;

  return (
    <div className="mx-auto w-full max-w-[110rem] px-4 pt-6 pb-16 sm:px-6 lg:px-8">
      <header className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight">X Research</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Saved creator lists and your local post archive — browse the feed, search it exactly, and
          ask AI about any scope.
        </p>
      </header>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[230px_minmax(0,1fr)] 2xl:grid-cols-[230px_minmax(0,1fr)_400px]">
        <ScopeSidebar
          lists={lists}
          activeId={activeId}
          activeList={active}
          creators={available}
          selected={selected}
          onChooseList={chooseList}
          onToggleCreator={(id, checked) => {
            setSelected((current) =>
              checked ? [...current, id] : current.filter((existing) => existing !== id),
            );
            setPage(1);
          }}
          onSelectAllCreators={() => {
            setSelected(available.map((c) => c.id));
            setPage(1);
          }}
          onClearCreators={() => {
            setSelected([]);
            setPage(1);
          }}
          onNewList={() => openEditor("new")}
          onEditList={() => active && openEditor(active)}
          onDeleteList={() => {
            setDeleting(true);
            setDialogError(null);
          }}
          onSavedCreator={async (creator) => {
            const entry = {
              id: creator.id,
              displayName: creator.displayName,
              handle: creator.handle,
              categoryIds: creator.categories.map((c) => c.id),
            };
            setCreators((current) => [...current.filter((c) => c.id !== entry.id), entry]);
            if (active) {
              const { list } = await requestJson<{ list: ResearchList }>(
                `/api/x-research/lists/${active.id}`,
                {
                  method: "PATCH",
                  body: JSON.stringify({
                    name: active.name,
                    description: active.description,
                    creatorIds: [...new Set([...active.creatorIds, creator.id])],
                  }),
                },
              );
              setLists((current) => current.map((l) => (l.id === list.id ? list : l)));
            }
            setSelected((current) => [...new Set([...current, creator.id])]);
            setPage(1);
            setRevision((r) => r + 1);
          }}
        />

        <section aria-label="Cached research feed" className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold break-words">
                {active?.name ?? "Ad hoc selection"}
              </h2>
              {active?.description && (
                <p className="mt-0.5 text-sm break-words text-muted-foreground">
                  {active.description}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                {selected.length} selected creator{selected.length === 1 ? "" : "s"}
                {active ? ` · ${active.creatorIds.length} in list` : ""}
                {feed ? ` · ${feed.total.toLocaleString()} posts in window` : ""}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={!feed || !selected.length}
              onClick={() => prepareQuestion("list")}
            >
              <Sparkles aria-hidden="true" />
              {active ? "Ask about this list" : "Ask about this scope"}
            </Button>
          </div>

          <div className="mt-3 rounded-2xl border bg-card shadow-sm">
            <div className="p-3.5">
              <RetrievalControls
                listId={activeId}
                refreshIds={active?.creatorIds ?? selected}
                selected={selected}
                start={start}
                end={end}
                timezone={timezone}
                period={period}
                onProgress={onRetrievalProgress}
                onViewNewDates={() => preset("7d")}
              />
            </div>

            <div className="space-y-3 border-t p-3.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div
                  role="group"
                  aria-label="Period"
                  className="flex shrink-0 items-center rounded-md bg-muted/70 p-0.5"
                >
                  {PERIOD_OPTIONS.map((option) => {
                    const isPressed = period === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={isPressed}
                        onClick={() => preset(option.value)}
                        className={cn(
                          "rounded-[5px] px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                          isPressed
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="sr-only sm:not-sr-only">From</span>
                    <DatePicker
                      ariaLabel="From date"
                      className="w-36"
                      today={calendarDate(new Date(), timezone)}
                      value={start}
                      disabled={period === "24h"}
                      onChange={(date) => {
                        setStart(date);
                        setPeriod("custom");
                        setPage(1);
                      }}
                    />
                  </div>
                  <span aria-hidden="true" className="text-xs text-muted-foreground">
                    →
                  </span>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="sr-only sm:not-sr-only">Through</span>
                    <DatePicker
                      ariaLabel="Through date"
                      className="w-36"
                      align="end"
                      today={calendarDate(new Date(), timezone)}
                      value={end}
                      disabled={period === "24h"}
                      onChange={(date) => {
                        setEnd(date);
                        setPeriod("custom");
                        setPage(1);
                      }}
                    />
                  </div>
                </div>

                <div ref={timezoneRef} className="relative ml-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={showTimezone}
                    onClick={() => setShowTimezone((current) => !current)}
                    className="text-xs text-muted-foreground"
                  >
                    <Globe aria-hidden="true" />
                    {timezone}
                  </Button>
                  {showTimezone ? (
                    <form
                      className="absolute right-0 top-full z-30 mt-1.5 w-72 space-y-2 rounded-xl border bg-popover p-3.5 text-popover-foreground shadow-lg"
                      onSubmit={(e) => {
                        e.preventDefault();
                        try {
                          new Intl.DateTimeFormat("en", { timeZone: timezoneInput });
                          setTimezone(timezoneInput);
                          if (period !== "custom") preset(period, timezoneInput);
                          setPage(1);
                          setError(null);
                          setShowTimezone(false);
                        } catch {
                          setError("Choose an IANA timezone, for example Europe/Amsterdam.");
                        }
                      }}
                    >
                      <label className="block space-y-1 text-xs font-medium">
                        Timezone (IANA name)
                        <input
                          className={cn(field, "h-8 text-xs")}
                          value={timezoneInput}
                          onChange={(e) => setTimezoneInput(e.target.value)}
                        />
                      </label>
                      <p className="text-xs text-muted-foreground">
                        Calendar dates are read in this zone. Reposts use the sharing event date.
                      </p>
                      <Button type="submit" size="sm" className="w-full">
                        Apply timezone
                      </Button>
                    </form>
                  ) : null}
                </div>
              </div>

              <fieldset>
                <legend className="sr-only">Post types</legend>
                <div className="flex flex-wrap items-center gap-1.5">
                  {POST_TYPES.map((type) => {
                    const meta = TYPE_META[type];
                    const isPressed = types.includes(type);
                    const Icon = meta.icon;
                    return (
                      <button
                        key={type}
                        type="button"
                        aria-pressed={isPressed}
                        onClick={() => {
                          setTypes((current) =>
                            isPressed
                              ? current.filter((t) => t !== type)
                              : [...current, type],
                          );
                          setPage(1);
                        }}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                          isPressed
                            ? // Selected keeps its fill on hover; the fill dims
                              // slightly and the border tints so hovering the
                              // selected chip still reads as interactive.
                              "border-transparent bg-secondary text-secondary-foreground shadow-sm hover:border-ring/60 hover:bg-secondary/70"
                            : "border-input bg-background text-muted-foreground hover:border-ring/40 hover:text-foreground",
                        )}
                      >
                        <Icon aria-hidden="true" className="size-3.5" />
                        {meta.label}
                      </button>
                    );
                  })}
                  {types.length === 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
                      <TriangleAlert aria-hidden="true" className="size-3.5" />
                      Select at least one post type.
                    </span>
                  )}
                </div>
              </fieldset>

              <SearchControls
                search={search}
                onSearch={(fields) => {
                  setSearch(fields);
                  setPage(1);
                }}
                onFeed={() => {
                  setSearch(null);
                  setPage(1);
                }}
              />
            </div>
          </div>

          {loading && (
            <div className="mt-4">
              <PendingIndicator label="Loading cached posts…" />
            </div>
          )}
          {(error || readError) && (
            <div
              role="alert"
              className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3.5 text-sm"
            >
              <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">{error || readError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError(null);
                  setRevision((r) => r + 1);
                }}
              >
                Retry
              </Button>
            </div>
          )}

          {!loading && !error && !readError && feed ? (
            <>
              {feed.search ? (
                <div
                  className="mt-4 space-y-1 rounded-xl border border-ring/30 bg-primary/5 p-3.5 text-xs"
                  role="status"
                >
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <SearchX aria-hidden="true" className="size-4 text-muted-foreground" />
                    {feed.total.toLocaleString()} exact{" "}
                    {feed.total === 1 ? "match" : "matches"} in{" "}
                    {feed.scopeTotal.toLocaleString()} scoped posts
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-muted-foreground"
                      onClick={() => {
                        setSearch(null);
                        setPage(1);
                      }}
                    >
                      <X aria-hidden="true" className="!size-3.5" />
                      Clear search
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="ml-auto h-6 px-2 text-xs"
                      disabled={!selected.length}
                      onClick={() => prepareQuestion("results")}
                    >
                      <Sparkles aria-hidden="true" className="!size-3.5" />
                      Ask about these results
                    </Button>
                  </p>
                  <p className="text-muted-foreground">
                    Text is incomplete or missing for {feed.incompleteText} scoped{" "}
                    {feed.incompleteText === 1 ? "post" : "posts"}; unretrieved text can contain
                    additional matches. Quoted speech is excluded and repost matches belong to the
                    original author. This searches the archive in the requested period; it does not
                    establish exhaustive history or absence of discussion.
                  </p>
                </div>
              ) : (
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    {cachedCreators}/{selected.length} creators with cached posts
                    {lastRefresh ? ` · most recent refresh ${stamp(lastRefresh)}` : ""}
                    {feed.unknownDates > 0
                      ? ` · ${feed.unknownDates} posts excluded for unknown dates`
                      : ""}
                  </span>
                  <details className="group/coverage min-w-0">
                    <summary className="flex w-fit cursor-pointer items-center gap-1 font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                      <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 transition-transform group-open/coverage:rotate-180 motion-reduce:transition-none"
                      />
                      Coverage details
                    </summary>
                    <div className="mt-2 space-y-2 border-t pt-2">
                      <p className="max-w-xl text-muted-foreground">
                        Observed date bounds do not establish complete coverage. Refresh timestamps
                        record a successful traversal (or a legacy library fetch), not exhaustive
                        post or reply coverage.
                        {feed.unknownDates > 0
                          ? ` ${feed.unknownDates} posts are excluded because their publication or repost event date is unknown.`
                          : ""}
                      </p>
                      <ul className="space-y-1.5">
                        {feed.coverage.map((c) => (
                          <li key={c.creatorId}>
                            <span className="font-medium text-foreground">{c.name}</span>{" "}
                            <span className="text-muted-foreground">
                              · {c.cachedPosts} archived posts ·{" "}
                              {c.oldest ? stamp(c.oldest) : "Unknown"} –{" "}
                              {c.newest ? stamp(c.newest) : "Unknown"} ·{" "}
                              {c.lastRefreshedAt
                                ? `refreshed ${stamp(c.lastRefreshedAt)}`
                                : "never refreshed"}
                              {c.hasError ? " · last attempt failed; cached posts preserved" : ""}
                              {c.pendingHead
                                ? " · head retrieval unfinished; cached posts preserved"
                                : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </details>
                </div>
              )}

              {!feed.posts.length ? (
                <div className="mt-4 flex flex-col items-center gap-3 rounded-2xl border border-dashed px-6 py-14 text-center">
                  <span
                    aria-hidden="true"
                    className="flex size-12 items-center justify-center rounded-full bg-muted"
                  >
                    {!selected.length ? (
                      <Users className="size-6 text-muted-foreground" />
                    ) : feed.search ? (
                      <SearchX className="size-6 text-muted-foreground" />
                    ) : (
                      <Inbox className="size-6 text-muted-foreground" />
                    )}
                  </span>
                  <h3 className="text-sm font-semibold">
                    {!selected.length
                      ? "Select creators to browse"
                      : feed.search
                        ? "No exact matches in the cached scope"
                        : "No cached posts in this scope"}
                  </h3>
                  <p className="max-w-md text-balance text-sm text-muted-foreground">
                    {!selected.length
                      ? "Choose saved X creators or add them to a list."
                      : !types.length
                        ? "Select at least one post type."
                        : "Try other dates or post types. This does not establish that the creators posted nothing."}
                  </p>
                </div>
              ) : (
                <>
                  <p
                    role="status"
                    className="mt-4 mb-2 text-xs tabular-nums text-muted-foreground"
                  >
                    Showing {(feed.page - 1) * feed.pageSize + 1}–
                    {Math.min(feed.page * feed.pageSize, feed.total)} of{" "}
                    {feed.total.toLocaleString()}{" "}
                    {feed.search ? "exact matches" : "cached posts"}
                  </p>
                  <ul className="divide-y divide-border overflow-hidden rounded-2xl border bg-card shadow-sm">
                    {feed.posts.map((post) => (
                      <PostRow
                        key={post.tweet.id}
                        post={post}
                        selected={selectedPostIds.includes(post.tweet.id)}
                        onToggleSelect={(checked) => {
                          setPostSelection((current) => {
                            const ids = current.key === browsingKey ? current.ids : [];
                            return {
                              key: browsingKey,
                              ids: checked
                                ? [...new Set([...ids, post.tweet.id])]
                                : ids.filter((id) => id !== post.tweet.id),
                            };
                          });
                        }}
                        onOpenDetail={() => {
                          setDetailError(null);
                          setDetail(post);
                        }}
                      />
                    ))}
                  </ul>
                  <nav
                    aria-label={feed.search ? "Search pagination" : "Feed pagination"}
                    className="mt-4 flex items-center justify-center gap-3"
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={feed.page === 1}
                      onClick={() => setPage(feed.page - 1)}
                    >
                      Previous
                    </Button>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      Page {feed.page} of {Math.ceil(feed.total / feed.pageSize)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={feed.page * feed.pageSize >= feed.total}
                      onClick={() => setPage(feed.page + 1)}
                    >
                      Next
                    </Button>
                  </nav>
                </>
              )}

              {selectedPostIds.length > 0 && (
                <div className="sticky bottom-4 z-30 mt-4 flex justify-center">
                  <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border bg-card py-2 pr-2 pl-4 shadow-lg">
                    <p className="text-sm font-medium">
                      {selectedPostIds.length} post{selectedPostIds.length === 1 ? "" : "s"}{" "}
                      selected
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      onClick={() => setPostSelection({ key: browsingKey, ids: [] })}
                    >
                      Clear
                    </Button>
                    <Button size="sm" onClick={() => prepareQuestion("selected")}>
                      <Sparkles aria-hidden="true" />
                      Ask about selection
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : null}
        </section>

        <div
          ref={consoleColumnRef}
          className="min-w-0 space-y-4 xl:col-span-2 2xl:col-span-1 2xl:sticky 2xl:top-6 2xl:max-h-[calc(100dvh-3rem)] 2xl:overflow-y-auto 2xl:overscroll-contain"
        >
          {questionScope && (
            <QuestionScope
              scope={questionScope}
              changed={questionScope.browsingKey !== browsingKey}
            />
          )}
          <ResearchConsole
            draft={questionScope}
            initialJobId={initialJobId}
            onPrepareTopic={(topicValue) =>
              prepareQuestion(
                "list",
                `Find posts related to ${topicValue}, including indirect references, and explain the contextual relevance. Compare supported arguments.`,
              )
            }
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Reading lists and changing filters use the local archive. Refresh and historical
            retrieval require an explicit click; unfinished work resumes only when requested.
            Historical and reply coverage may be incomplete. Attached media and linked pages are not
            analyzed.
          </p>
        </div>
      </div>

      <TweetDetailDialog
        tweet={detail?.tweet ?? null}
        open={detail !== null}
        onClose={() => setDetail(null)}
        context={
          detail && (
            <div>
              {!detail.tweet.readyForAnalysis && (
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  disabled={hydrating}
                  onClick={async () => {
                    setHydrating(true);
                    setDetailError(null);
                    try {
                      const { tweet } = await requestJson<{ tweet: TweetViewModel }>(
                        "/api/x-research/hydrate",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            creatorId: detail.tweet.creatorId,
                            tweetId: detail.tweet.id,
                          }),
                        },
                      );
                      setDetail((current) =>
                        current?.tweet.id === tweet.id ? { ...current, tweet } : current,
                      );
                      setRevision((r) => r + 1);
                    } catch (err) {
                      setDetailError(
                        err instanceof Error ? err.message : "Full text could not be fetched.",
                      );
                    } finally {
                      setHydrating(false);
                    }
                  }}
                >
                  {hydrating ? "Fetching full text…" : "Fetch full text"}
                </Button>
              )}
              {detailError && (
                <p role="alert" className="mt-2 text-xs text-destructive">
                  {detailError}
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Archived text last retrieved: {stamp(detail.tweet.textFetchedAt ?? null)}.
                {detail.tweet.availability === "observed"
                  ? " The last read returned readable post text"
                  : detail.tweet.availability === "not_retrievable"
                    ? " The last detail read could not retrieve this post"
                    : " Post availability was not established"}
                {detail.tweet.availabilityCheckedAt
                  ? ` (${stamp(detail.tweet.availabilityCheckedAt)})`
                  : ""}
                . Current availability on X is unverified; archived text is preserved.
              </p>
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                Thread context:{" "}
                {detail.tweet.timelineKind === "reply"
                  ? detail.parentCached
                    ? "parent post is cached; complete thread coverage is unknown"
                    : "parent post is not cached"
                  : "complete conversation coverage is unknown"}
                .
              </p>
            </div>
          )
        }
      />

      <AppDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "New research list" : "Edit research list"}
        description="Lists are saved locally. Membership changes preserve creators and their archived posts."
        busy={busy}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void saveList();
          }}
        >
          <label className="block space-y-1 text-sm">
            List name
            <input
              className={field}
              value={name}
              maxLength={100}
              required
              autoFocus
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="block space-y-1 text-sm">
            Description
            <textarea
              className={cn(field, "h-20 py-2")}
              value={description}
              maxLength={1000}
              onChange={(e) => setDescription(e.target.value)}
              disabled={busy}
            />
          </label>
          {editing === "new" && categories.length > 0 && (
            <label className="block space-y-1 text-sm">
              Start from category
              <Select
                label="Start from category"
                disabled={busy}
                value={String(pickerCategory)}
                onChange={(value) => {
                  const category = Number(value);
                  setPickerCategory(category);
                  setMembers(
                    creators.filter((c) => c.categoryIds.includes(category)).map((c) => c.id),
                  );
                }}
                options={[
                  { value: "0", label: "Choose a category snapshot" },
                  ...categories.map((c) => ({ value: String(c.id), label: c.name })),
                ]}
              />
              <span className="block text-xs text-muted-foreground">
                Includes its saved X creators now; later category edits do not change the list.
              </span>
            </label>
          )}
          <label className="block space-y-1 text-sm">
            Find saved X creators
            <input
              className={field}
              value={pickerQuery}
              onChange={(e) => setPickerQuery(e.target.value)}
              disabled={busy}
            />
          </label>
          <fieldset disabled={busy}>
            <legend className="mb-2 text-sm font-medium">
              Shared library · {members.length} selected
            </legend>
            <div className="max-h-60 space-y-1.5 overflow-y-auto pr-1">
              {creators
                .filter((c) =>
                  `${c.displayName} ${c.handle}`.toLowerCase().includes(pickerQuery.toLowerCase()),
                )
                .map((c) => {
                  const checked = members.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                        checked ? "border-ring/40 bg-accent/50" : "hover:bg-accent/40",
                      )}
                    >
                      <input
                        className="accent-foreground"
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setMembers((current) =>
                            e.target.checked
                              ? [...current, c.id]
                              : current.filter((id) => id !== c.id),
                          )
                        }
                      />
                      <span className="min-w-0">
                        {c.displayName}{" "}
                        <span className="text-muted-foreground">@{c.handle}</span>
                      </span>
                    </label>
                  );
                })}
              {!creators.length && (
                <p className="text-sm text-muted-foreground">
                  No X creators saved yet. Save the list, then use Add creator.
                </p>
              )}
            </div>
          </fieldset>
          {dialogError && (
            <p role="alert" className="text-sm text-destructive">
              {dialogError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save list"}
            </Button>
          </div>
        </form>
      </AppDialog>

      <AppDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={`Delete ${active?.name ?? "list"}?`}
        description="Only this list and its memberships will be removed. Shared creators and all archived posts are kept."
        busy={busy}
      >
        {dialogError && (
          <p role="alert" className="mb-3 text-sm text-destructive">
            {dialogError}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => setDeleting(false)}>
            Keep list
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (!active) return;
              setBusy(true);
              setDialogError(null);
              try {
                await requestJson(`/api/x-research/lists/${active.id}`, { method: "DELETE" });
                setLists((current) => current.filter((l) => l.id !== active.id));
                chooseList(null);
                setDeleting(false);
              } catch (err) {
                setDialogError(err instanceof Error ? err.message : "Could not delete this list.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Deleting…" : "Delete list"}
          </Button>
        </div>
      </AppDialog>
    </div>
  );
}
