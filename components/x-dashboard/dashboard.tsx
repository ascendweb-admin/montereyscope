"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowUp, Check, Menu, Pencil, Sparkles, WifiOff, X } from "lucide-react";

import { TweetDetailDialog } from "@/components/channel/tweet-card";
import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { Button } from "@/components/ui/button";
import { XLogo } from "@/components/ui/platform-logos";
import { AnalyzePanel, type DraftScope } from "@/components/x-dashboard/analyze-panel";
import { AvatarStack } from "@/components/x-dashboard/avatars";
import { FeedList, FilterBar } from "@/components/x-dashboard/feed-column";
import { ListEditor } from "@/components/x-dashboard/list-editor";
import { ListRail } from "@/components/x-dashboard/list-rail";
import { SyncStatus } from "@/components/x-dashboard/sync-status";
import { requestJson, useDashboardStatus, useFeed } from "@/components/x-dashboard/use-dashboard-data";
import type { CreatorSummary } from "@/lib/creators/service";
import {
  isPeriod,
  isShowFilter,
  scopeKey,
  type DashboardCreator,
  type DashboardList,
  type Period,
  type ShowFilter,
  type SyncSnapshot,
  type UnreadCounts,
} from "@/lib/x/dashboard/model";
import type { ResearchPost } from "@/lib/x/research/model";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "scope-x-dashboard";
interface Stored {
  listId?: number | null;
  period?: Period;
  show?: ShowFilter;
  panel?: boolean;
}
function readStored(): Stored {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Stored;
    return typeof value === "object" && value ? value : {};
  } catch {
    return {};
  }
}
function writeStored(patch: Stored) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readStored(), ...patch }));
  } catch {
    /* Preferences are optional. */
  }
}

/** The analysis panel docks beside the feed from 1536px; below that it slides over. */
const WIDE_QUERY = "(min-width: 1536px)";
function useIsWide(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(WIDE_QUERY);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

function Onboarding({
  xConnected,
  xHandle,
  onCreatorAdded,
}: {
  xConnected: boolean;
  xHandle: string | null;
  onCreatorAdded: (creator: DashboardCreator) => void;
}) {
  const steps = [
    {
      title: "Connect your X account",
      done: xConnected,
      body: xConnected
        ? `Connected${xHandle ? ` as @${xHandle}` : ""}. Posts are read through your account and saved on this computer.`
        : "Scope reads posts through your own X login. Nothing is posted on your behalf.",
      action: xConnected ? null : (
        <Link
          href="/settings"
          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Connect in Settings
        </Link>
      ),
    },
    {
      title: "Add the accounts you follow",
      done: false,
      body: "Search by name or paste a profile link. Their recent posts sync in automatically.",
      action: (
        <AddCreatorDialog
          size="sm"
          categories={[]}
          initialPlatform="x"
          lockPlatform
          fetchAfterSave={false}
          onSaved={(creator: CreatorSummary) =>
            onCreatorAdded({
              id: creator.id,
              displayName: creator.displayName,
              handle: creator.handle,
              avatarUrl: creator.avatarUrl,
              categoryIds: creator.categories.map((c) => c.id),
            })
          }
        />
      ),
    },
    {
      title: "Group them into lists and ask AI",
      done: false,
      body: "Make lists like “Macro” or “Traders”, then get a brief, top narratives or every ticker mentioned in one click.",
      action: null,
    },
  ];
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground text-background">
          <XLogo className="size-5" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Your X Dashboard</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          A clean feed of the accounts you care about, with AI analysis on top. Three steps to get going:
        </p>
        <ol className="mt-7 space-y-3">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-4 rounded-2xl border bg-card p-4">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                  step.done ? "bg-emerald-500 text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {step.done ? <Check aria-hidden="true" className="size-4" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{step.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{step.body}</p>
                {step.action ? <div className="mt-3">{step.action}</div> : null}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </main>
  );
}

export function XDashboard({
  initialLists,
  initialCreators,
  categories,
  initialUnread,
  xConnected,
  xHandle,
  autoSyncMinutes,
  aiLabel,
  initialInsightId,
  initialListId,
}: {
  initialLists: DashboardList[];
  initialCreators: DashboardCreator[];
  categories: Array<{ id: number; name: string }>;
  initialUnread: UnreadCounts;
  xConnected: boolean;
  xHandle: string | null;
  autoSyncMinutes: number;
  aiLabel: string;
  initialInsightId: string | null;
  initialListId: number | null;
}) {
  const [lists, setLists] = useState(initialLists);
  const [creators, setCreators] = useState(initialCreators);
  const [listId, setListId] = useState<number | null>(initialListId);
  const [period, setPeriod] = useState<Period>("7d");
  const [show, setShow] = useState<ShowFilter>("posts");
  const [query, setQuery] = useState("");
  const [creatorFilter, setCreatorFilter] = useState<number[] | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(Boolean(initialInsightId));
  const [panelWide, setPanelWide] = useState(false);
  const [insightId, setInsightId] = useState<string | null>(initialInsightId);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [editor, setEditor] = useState<{ list: DashboardList | null; members: number[] } | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const [detail, setDetail] = useState<ResearchPost | null>(null);
  const [syncRequested, setSyncRequested] = useState(false);
  const [newPosts, setNewPosts] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const isWide = useIsWide();

  // Restore the last list and filters after hydration (storage is per machine).
  useEffect(() => {
    const stored = readStored();
    const frame = requestAnimationFrame(() => {
      if (initialListId === null && stored.listId != null && initialLists.some((l) => l.id === stored.listId))
        setListId(stored.listId);
      if (isPeriod(stored.period)) setPeriod(stored.period);
      if (isShowFilter(stored.show)) setShow(stored.show);
      // On wide screens the analysis panel starts open unless it was closed before.
      if (stored.panel !== false && !initialInsightId && window.matchMedia(WIDE_QUERY).matches)
        setPanelOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialInsightId, initialListId, initialLists]);

  const creatorsById = useMemo(() => new Map(creators.map((c) => [c.id, c])), [creators]);
  const activeList = lists.find((l) => l.id === listId) ?? null;
  const scopeCreators = useMemo(
    () =>
      (activeList ? activeList.creatorIds : creators.map((c) => c.id))
        .map((id) => creatorsById.get(id))
        .filter((c): c is DashboardCreator => Boolean(c))
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [activeList, creators, creatorsById],
  );
  const scopeIds = useMemo(() => scopeCreators.map((c) => c.id), [scopeCreators]);
  const feedIds = useMemo(
    () => (creatorFilter?.length ? scopeIds.filter((id) => creatorFilter.includes(id)) : scopeIds),
    [creatorFilter, scopeIds],
  );

  const feed = useFeed({ creatorIds: feedIds, period, show, query });
  const status = useDashboardStatus(scopeIds, initialUnread);
  const { sync, setSync, setUnread, refresh: refreshStatus } = status;
  const syncing = sync?.state === "syncing" || sync?.state === "waiting";
  const terms = useMemo(
    () => (query.match(/"[^"]+"|\S+/g) ?? []).filter((t) => !t.startsWith("-")).map((t) => t.replace(/"/g, "")),
    [query],
  );

  // Opening a scope syncs it when stale and marks it read after a moment.
  const scopeIdsKey = scopeIds.join(",");
  useEffect(() => {
    if (!scopeIdsKey) return;
    let cancelled = false;
    void requestJson<{ started: boolean; sync: SyncSnapshot }>("/api/x-dashboard/sync", {
      body: {
        creatorIds: scopeIdsKey.split(",").map(Number),
        listId,
        label: activeList?.name ?? "All accounts",
        ifStale: true,
      },
    })
      .then((data) => {
        if (!cancelled && data.started) setSync(data.sync);
      })
      .catch(() => {});
    const seen = setTimeout(() => {
      void requestJson("/api/x-dashboard/seen", { body: { listId } }).catch(() => {});
      setUnread((current) => ({ ...current, [scopeKey(listId)]: 0 }));
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(seen);
    };
    // Runs once per scope; the list name and status setters are stable enough here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeIdsKey, listId]);

  // When a sync finishes with new posts, refresh in place or offer them.
  const previous = useRef<{ key: string; sync: SyncSnapshot } | null>(null);
  useEffect(() => {
    // Only compare snapshots of the same scope: switching lists is not a sync finishing.
    const before = previous.current?.key === scopeIdsKey ? previous.current.sync : null;
    previous.current = sync ? { key: scopeIdsKey, sync } : null;
    if (!sync || !before) return;
    const wasBusy = before.state === "syncing" || before.state === "waiting";
    const busy = sync.state === "syncing" || sync.state === "waiting";
    if (wasBusy && !busy) {
      setSyncRequested(false);
      if (sync.newPosts > 0) {
        const atTop = (scrollRef.current?.scrollTop ?? 0) < 120;
        if (atTop || !feed.posts.length) feed.reload();
        else setNewPosts(sync.newPosts);
      }
    }
  }, [sync, feed, scopeIdsKey]);
  // While the very first import runs, stream posts in as they arrive.
  useEffect(() => {
    if (!syncing || feed.posts.length) return;
    const timer = setInterval(feed.reload, 4000);
    return () => clearInterval(timer);
  }, [syncing, feed.posts.length, feed.reload]);

  // Day headers stick right below the (variable-height) feed header.
  useLayoutEffect(() => {
    const header = headerRef.current;
    const root = scrollRef.current;
    if (!header || !root) return;
    const observer = new ResizeObserver(() =>
      root.style.setProperty("--feed-header-height", `${header.offsetHeight}px`),
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, [creators.length]);

  const setActiveInsight = useCallback((id: string | null) => {
    setInsightId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("insight", id);
    else url.searchParams.delete("insight");
    window.history.replaceState(null, "", url);
  }, []);

  const chooseList = useCallback((id: number | null) => {
    setListId(id);
    // A new scope starts a fresh analysis; past ones stay under History.
    setActiveInsight(null);
    setCreatorFilter(null);
    setSelection([]);
    setNewPosts(0);
    setRailOpen(false);
    writeStored({ listId: id });
    scrollRef.current?.scrollTo({ top: 0 });
  }, [setActiveInsight]);

  const syncNow = useCallback(() => {
    if (!scopeIds.length) return;
    setSyncRequested(true);
    void requestJson<{ sync: SyncSnapshot }>("/api/x-dashboard/sync", {
      body: { creatorIds: scopeIds, listId, label: activeList?.name ?? "All accounts" },
    })
      .then((data) => setSync(data.sync))
      .catch(() => setSyncRequested(false))
      .finally(refreshStatus);
  }, [activeList?.name, listId, scopeIds, setSync, refreshStatus]);

  const stopSync = useCallback(() => {
    if (!scopeIds.length) return;
    void requestJson<{ sync: SyncSnapshot }>("/api/x-dashboard/sync", {
      body: { action: "stop", creatorIds: scopeIds },
    })
      .then(refreshStatus)
      .catch(() => {});
  }, [refreshStatus, scopeIds]);

  const toggleSelect = useCallback((id: string) => {
    setSelection((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id].slice(-200)));
  }, []);
  const openPanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    if (!open) setPanelWide(false);
    if (window.matchMedia(WIDE_QUERY).matches) writeStored({ panel: open });
  }, []);
  const askAbout = useCallback(
    (post: ResearchPost) => {
      setSelection([post.tweet.id]);
      setInsightId(null);
      setDraftQuestion("");
      openPanel(true);
    },
    [openPanel],
  );
  const addCreator = useCallback((creator: DashboardCreator) => {
    setCreators((current) => [...current.filter((c) => c.id !== creator.id), creator]);
    // A brand-new account syncs right away.
    void requestJson("/api/x-dashboard/sync", {
      body: { creatorIds: [creator.id], listId: null, label: creator.displayName },
    }).catch(() => {});
  }, []);

  const filterNames = creatorFilter?.length
    ? scopeCreators.filter((c) => creatorFilter.includes(c.id)).map((c) => `@${c.handle ?? c.displayName}`)
    : [];
  const scopeLabel = filterNames.length
    ? filterNames.length <= 2
      ? filterNames.join(" & ")
      : `${filterNames.length} accounts`
    : (activeList?.name ?? "All accounts");
  const draftScope: DraftScope = {
    label: scopeLabel,
    listId,
    creatorIds: feedIds,
    period,
    show,
    query: query.trim() || null,
    ...(selection.length ? { tweetIds: selection } : {}),
  };

  if (!creators.length)
    return <Onboarding xConnected={xConnected} xHandle={xHandle} onCreatorAdded={addCreator} />;

  const rail = (
    <ListRail
      lists={lists}
      creatorsById={creatorsById}
      totalCreators={creators.length}
      activeListId={listId}
      unread={status.unread}
      autoSyncMinutes={autoSyncMinutes}
      onSelect={chooseList}
      onNew={() => setEditor({ list: null, members: creatorFilter ?? [] })}
      onEdit={(list) => setEditor({ list, members: list.creatorIds })}
    />
  );

  const panel = (
    <AnalyzePanel
      scope={draftScope}
      aiLabel={aiLabel}
      activeId={insightId}
      onActiveIdChange={setActiveInsight}
      onClearSelection={() => setSelection([])}
      onClose={() => openPanel(false)}
      draftQuestion={draftQuestion}
      onDraftQuestionChange={setDraftQuestion}
      wide={panelWide}
      onWideChange={setPanelWide}
    />
  );

  return (
    <div data-viewport-shell className="relative flex h-[calc(100dvh-6.5rem)] min-h-0 overflow-hidden md:h-dvh">
      <aside className="hidden w-64 shrink-0 border-r bg-card lg:block">{rail}</aside>
      {railOpen ? (
        <>
          <button
            type="button"
            aria-label="Close lists"
            onClick={() => setRailOpen(false)}
            className="absolute inset-0 z-30 bg-black/40 lg:hidden"
          />
          <aside className="absolute inset-y-0 left-0 z-40 w-72 max-w-[85vw] border-r bg-card shadow-xl lg:hidden">{rail}</aside>
        </>
      ) : null}

      <main id="main" ref={scrollRef} className="relative min-w-0 flex-1 overflow-x-clip overflow-y-auto overscroll-contain">
        <div className="min-h-full w-full">
          <div ref={headerRef} className="sticky top-0 z-10 border-b bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
            <div className="flex items-center gap-3 px-4 pt-3 pb-2.5 sm:px-5">
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 size-8 lg:hidden"
                aria-label="Show lists"
                onClick={() => setRailOpen(true)}
              >
                <Menu aria-hidden="true" />
              </Button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-xl font-bold tracking-tight">{activeList?.name ?? "All accounts"}</h1>
                  {activeList ? (
                    <button
                      type="button"
                      aria-label={`Edit ${activeList.name}`}
                      title="Edit list"
                      onClick={() => setEditor({ list: activeList, members: activeList.creatorIds })}
                      className="rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Pencil aria-hidden="true" className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <AvatarStack creators={scopeCreators} max={5} size="xs" />
                  <span className="truncate">
                    {scopeCreators.length} account{scopeCreators.length === 1 ? "" : "s"}
                    {activeList?.description ? ` · ${activeList.description}` : ""}
                  </span>
                </div>
              </div>
              <div className="hidden sm:block">
                <SyncStatus
                  sync={sync}
                  creatorsById={creatorsById}
                  onSync={syncNow}
                  onStop={stopSync}
                  syncing={syncRequested}
                />
              </div>
              {!panelOpen || !isWide ? (
                <Button size="sm" className="h-8 rounded-full" onClick={() => openPanel(true)} disabled={!scopeIds.length}>
                  <Sparkles aria-hidden="true" />
                  Analyze
                </Button>
              ) : null}
            </div>
            <FilterBar
              period={period}
              onPeriod={(value) => {
                setPeriod(value);
                writeStored({ period: value });
              }}
              show={show}
              onShow={(value) => {
                setShow(value);
                writeStored({ show: value });
              }}
              query={query}
              onQuery={setQuery}
              creators={scopeCreators}
              creatorFilter={creatorFilter}
              onCreatorFilter={setCreatorFilter}
            />
            {!xConnected ? (
              <p className="flex items-center gap-2 border-t bg-amber-500/[0.07] px-5 py-2 text-xs text-amber-800 dark:text-amber-300">
                <WifiOff aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">X isn&apos;t connected, so new posts won&apos;t sync. You&apos;re seeing saved posts.</span>
                <Link href="/settings" className="shrink-0 font-medium underline underline-offset-2">
                  Connect
                </Link>
              </p>
            ) : null}
          </div>

          {newPosts > 0 ? (
            <div className="pointer-events-none sticky top-[calc(var(--feed-header-height,0px)+0.75rem)] z-20 -mb-9 flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setNewPosts(0);
                  feed.reload();
                  scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                }}
                className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground shadow-lg outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <ArrowUp aria-hidden="true" className="size-4" />
                {newPosts} new post{newPosts === 1 ? "" : "s"}
              </button>
            </div>
          ) : null}

          <FeedList
            posts={feed.posts}
            total={feed.total}
            hasMore={feed.hasMore}
            loadingMore={feed.loadingMore}
            initialLoading={feed.initialLoading}
            stale={feed.stale}
            error={feed.error}
            terms={terms}
            selection={selection}
            syncing={Boolean(syncing || syncRequested)}
            neverSynced={sync?.state === "never" || (sync?.state === "disconnected" && !sync.lastSyncedAt)}
            xConnected={xConnected}
            hasCreators={scopeIds.length > 0}
            query={query}
            period={period}
            scrollRoot={scrollRef}
            onLoadMore={feed.loadMore}
            onRetry={feed.reload}
            onToggleSelect={toggleSelect}
            onAsk={askAbout}
            onOpen={setDetail}
            onPeriod={(value) => {
              setPeriod(value);
              writeStored({ period: value });
            }}
            onClearQuery={() => setQuery("")}
            onEditList={activeList ? () => setEditor({ list: activeList, members: activeList.creatorIds }) : null}
            onSync={syncNow}
          />
        </div>

        {selection.length ? (
          <div className="pointer-events-none sticky bottom-5 z-20 flex justify-center">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-foreground py-1.5 pr-1.5 pl-4 text-background shadow-xl">
              <span className="pr-1 text-sm font-medium tabular-nums">
                {selection.length} selected
              </span>
              <button
                type="button"
                onClick={() => setSelection([])}
                aria-label="Clear selection"
                className="rounded-full p-1.5 text-background/70 outline-none hover:bg-background/15 hover:text-background focus-visible:ring-2 focus-visible:ring-background/60"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setInsightId(null);
                  openPanel(true);
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-background px-3.5 py-1.5 text-xs font-semibold text-foreground outline-none hover:bg-background/85 focus-visible:ring-2 focus-visible:ring-background/60"
              >
                <Sparkles aria-hidden="true" className="size-3.5" />
                Analyze selected
              </button>
            </div>
          </div>
        ) : null}
      </main>

      {panelOpen && panelWide ? (
        // The reading view covers the feed (which stays mounted, scroll intact).
        <aside className="absolute inset-y-0 right-0 left-0 z-40 lg:left-64 lg:border-l">{panel}</aside>
      ) : null}
      {panelOpen && !panelWide && isWide ? (
        <aside className="w-[26rem] shrink-0 border-l">{panel}</aside>
      ) : null}
      {panelOpen && !panelWide && !isWide ? (
        <>
          <button
            type="button"
            aria-label="Close analysis panel"
            onClick={() => openPanel(false)}
            className="absolute inset-0 z-30 bg-black/30 backdrop-blur-[1px]"
          />
          <aside className="absolute inset-y-0 right-0 z-40 w-full max-w-[28rem] border-l shadow-2xl">{panel}</aside>
        </>
      ) : null}

      {editor ? (
        <ListEditor
          list={editor.list}
          creators={creators}
          categories={categories}
          initialMembers={editor.members}
          onClose={() => setEditor(null)}
          onCreatorAdded={addCreator}
          onSaved={(saved) => {
            setLists((current) =>
              [...current.filter((l) => l.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)),
            );
            setEditor(null);
            chooseList(saved.id);
          }}
          onDeleted={(id) => {
            setLists((current) => current.filter((l) => l.id !== id));
            setEditor(null);
            if (listId === id) chooseList(null);
          }}
        />
      ) : null}

      <TweetDetailDialog tweet={detail?.tweet ?? null} open={detail !== null} onClose={() => setDetail(null)} />
    </div>
  );
}
