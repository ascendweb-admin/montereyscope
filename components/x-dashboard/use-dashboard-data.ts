"use client";

import { useCallback, useEffect, useState } from "react";

import type { ResearchPost } from "@/lib/x/research/model";
import type {
  FeedPage,
  InsightDetail,
  Period,
  ShowFilter,
  SyncSnapshot,
  UnreadCounts,
} from "@/lib/x/dashboard/model";

/** JSON fetch against the local server; errors carry the server's message. */
export async function requestJson<T>(
  url: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(url, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: init?.signal,
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = data.error as string | { message?: string } | undefined;
    throw new Error(
      typeof error === "string"
        ? error
        : (error?.message ?? "Something went wrong. Please try again."),
    );
  }
  return data as T;
}

export interface FeedQuery {
  creatorIds: number[];
  period: Period;
  show: ShowFilter;
  query: string;
}

function feedUrl(key: string, page: number): string {
  const q = JSON.parse(key) as FeedQuery;
  const params = new URLSearchParams({
    creators: q.creatorIds.join(","),
    period: q.period,
    show: q.show,
    page: String(page),
  });
  if (q.query.trim()) params.set("q", q.query.trim());
  return `/api/x-dashboard/feed?${params}`;
}

/**
 * Paged feed with infinite loading. Changing the query keeps the previous
 * posts on screen (marked stale) until the new first page arrives, so the
 * list never collapses to a skeleton while filters change.
 */
export function useFeed(query: FeedQuery) {
  const key = JSON.stringify(query);
  const [state, setState] = useState<{
    key: string;
    posts: ResearchPost[];
    page: number;
    total: number;
    scopeTotal: number;
    hasMore: boolean;
    error: string | null;
    loaded: boolean;
  }>({ key: "", posts: [], page: 0, total: 0, scopeTotal: 0, hasMore: false, error: null, loaded: false });
  const [revision, setRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<FeedPage>(feedUrl(key, 1), { signal: controller.signal })
      .then((page) => {
        setState({
          key,
          posts: page.posts,
          page: page.page,
          total: page.total,
          scopeTotal: page.scopeTotal,
          hasMore: page.hasMore,
          error: null,
          loaded: true,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          key,
          error: error instanceof Error ? error.message : "The feed could not be loaded.",
          loaded: true,
        }));
      });
    return () => controller.abort();
  }, [key, revision]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !state.hasMore || state.key !== key) return;
    setLoadingMore(true);
    try {
      const page = await requestJson<FeedPage>(feedUrl(key, state.page + 1));
      setState((current) => {
        if (current.key !== key) return current;
        const seen = new Set(current.posts.map((p) => p.tweet.id));
        return {
          ...current,
          posts: [...current.posts, ...page.posts.filter((p) => !seen.has(p.tweet.id))],
          page: page.page,
          total: page.total,
          hasMore: page.hasMore,
        };
      });
    } catch {
      /* The sentinel retries when it scrolls into view again. */
    } finally {
      setLoadingMore(false);
    }
  }, [key, loadingMore, state.hasMore, state.key, state.page]);

  return {
    ...state,
    /** True while a changed query is loading and older results are still shown. */
    stale: state.key !== key && state.loaded,
    initialLoading: !state.loaded,
    loadingMore,
    loadMore,
    reload: useCallback(() => setRevision((r) => r + 1), []),
  };
}

/** Sync state for the creators in view and unread counts for every list. */
export function useDashboardStatus(creatorIds: number[], initialUnread: UnreadCounts) {
  const key = creatorIds.join(",");
  const [sync, setSync] = useState<SyncSnapshot | null>(null);
  const [unread, setUnread] = useState(initialUnread);
  const [revision, setRevision] = useState(0);
  const active = sync?.state === "syncing" || sync?.state === "waiting";

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await requestJson<{ sync: SyncSnapshot; unread: UnreadCounts }>(
          `/api/x-dashboard/status?creators=${key}`,
        );
        if (disposed) return;
        setSync(data.sync);
        setUnread(data.unread);
        const busy = data.sync.state === "syncing" || data.sync.state === "waiting";
        timer = setTimeout(read, busy ? 2_000 : 20_000);
      } catch {
        if (!disposed) timer = setTimeout(read, 10_000);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key, revision]);

  // A snapshot of another scope (a response that lands after switching lists) never shows here.
  const current =
    sync &&
    sync.total === creatorIds.length &&
    sync.creators.every((c) => creatorIds.includes(c.creatorId))
      ? sync
      : null;
  return {
    sync: current,
    unread,
    setUnread,
    // A snapshot from a sync request may be older than the last poll: show it, then read again
    // right away so polling settles on the current state at the right pace.
    setSync: useCallback((next: SyncSnapshot) => {
      setSync(next);
      setRevision((r) => r + 1);
    }, []),
    active,
    refresh: useCallback(() => setRevision((r) => r + 1), []),
  };
}

/** One insight, polled while its answer is still being written. */
export function useInsight(id: string | null) {
  const [insight, setInsight] = useState<InsightDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await requestJson<{ insight: InsightDetail }>(
          `/api/x-dashboard/insights/${encodeURIComponent(id)}`,
        );
        if (disposed) return;
        setInsight(data.insight);
        setError(null);
        if (data.insight.status === "running") timer = setTimeout(read, 700);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : "Could not load this analysis.");
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [id, revision]);

  return {
    insight: insight?.id === id ? insight : null,
    error,
    setInsight,
    refresh: useCallback(() => setRevision((r) => r + 1), []),
  };
}
