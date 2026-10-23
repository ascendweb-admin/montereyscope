"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ResearchPost } from "@/lib/x/research/model";
import type {
  DashboardStatus,
  FeedCoverage,
  FeedPage,
  InsightDetail,
  Period,
  ShowFilter,
  SyncSnapshot,
  UnreadCounts,
} from "@/lib/x/dashboard/model";

/** A refused request; `field` names the input the server could not accept. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly field: string | null = null,
  ) {
    super(message);
  }
}

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
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    // An abort can occur after headers arrive, while the body is being read.
    // It must remain an abort, never a successful empty response.
    if (init?.signal?.aborted || (error instanceof Error && error.name === "AbortError"))
      throw error;
    throw new Error("The server returned an unreadable response. Please try again.");
  }
  const object =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (!response.ok) {
    const error = object?.error as string | { message?: string } | undefined;
    throw new RequestError(
      typeof error === "string"
        ? error
        : (error?.message ?? "Something went wrong. Please try again."),
      typeof object?.field === "string" ? object.field : null,
    );
  }
  if (!object) throw new Error("The server returned an invalid response. Please try again.");
  return object as T;
}

async function requestFeedPage(url: string, signal?: AbortSignal): Promise<FeedPage> {
  const page = await requestJson<FeedPage>(url, { signal });
  if (
    !Array.isArray(page.posts) ||
    !Number.isSafeInteger(page.page) ||
    page.page < 1 ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    !Number.isSafeInteger(page.scopeTotal) ||
    page.scopeTotal < 0 ||
    typeof page.hasMore !== "boolean"
  )
    throw new Error("The feed response was incomplete. Please try again.");
  return page;
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
    /** The server refused the search text itself; retrying cannot help. */
    invalidQuery: boolean;
    loaded: boolean;
  }>({
    key: "",
    posts: [],
    page: 0,
    total: 0,
    scopeTotal: 0,
    hasMore: false,
    error: null,
    invalidQuery: false,
    loaded: false,
  });
  const [revision, setRevision] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const current = useRef(state);
  useEffect(() => {
    current.current = state;
  });

  useEffect(() => {
    const controller = new AbortController();
    requestFeedPage(feedUrl(key, 1), controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setState({
          key,
          posts: page.posts,
          page: page.page,
          total: page.total,
          scopeTotal: page.scopeTotal,
          hasMore: page.hasMore,
          error: null,
          invalidQuery: false,
          loaded: true,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({
          ...current,
          key,
          error: error instanceof Error ? error.message : "The feed could not be loaded.",
          invalidQuery: error instanceof RequestError && error.field === "q",
          loaded: true,
        }));
      });
    return () => controller.abort();
  }, [key, revision]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !state.hasMore || state.key !== key) return;
    setLoadingMore(true);
    try {
      const page = await requestFeedPage(feedUrl(key, state.page + 1));
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

  /**
   * Re-reads the first page after posts were saved. `replace` swaps it in (the reader is at the
   * top); otherwise the list stays put and the result is how many newer posts are waiting above.
   * Either way the total updates, so older posts that arrived can be scrolled to.
   */
  const refreshInPlace = useCallback(
    async (replace: boolean): Promise<number> => {
      const shown = current.current;
      if (shown.key !== key || !shown.loaded) return 0;
      const page = await requestFeedPage(feedUrl(key, 1)).catch(() => null);
      if (!page || current.current.key !== key) return 0;
      if (replace) {
        setState((prev) =>
          prev.key !== key
            ? prev
            : {
                ...prev,
                posts: page.posts,
                page: page.page,
                total: page.total,
                scopeTotal: page.scopeTotal,
                hasMore: page.hasMore,
                error: null,
                invalidQuery: false,
              },
        );
        return 0;
      }
      const ids = new Set(current.current.posts.map((p) => p.tweet.id));
      const top = current.current.posts[0]?.eventAt ?? "";
      setState((prev) =>
        prev.key !== key
          ? prev
          : {
              ...prev,
              total: page.total,
              scopeTotal: page.scopeTotal,
              hasMore: prev.posts.length < page.total,
            },
      );
      return page.posts.filter((p) => !ids.has(p.tweet.id) && p.eventAt >= top).length;
    },
    [key],
  );

  return {
    ...state,
    /** True while a changed query is loading and older results are still shown. */
    stale: state.key !== key && state.loaded,
    initialLoading: !state.loaded,
    loadingMore,
    loadMore,
    refreshInPlace,
    reload: useCallback(() => setRevision((r) => r + 1), []),
  };
}

/**
 * Sync state for the creators in view, unread counts for every list, and a
 * revision that changes whenever their posts change. Polling also tells the
 * server what is on screen (accounts and timeframe), so those go first.
 */
export function useDashboardStatus(
  creatorIds: number[],
  period: Period,
  initialUnread: UnreadCounts,
) {
  const key = `${creatorIds.join(",")}|${period}`;
  const [status, setStatus] = useState<(Omit<DashboardStatus, "unread"> & { key: string }) | null>(
    null,
  );
  const [unread, setUnread] = useState(initialUnread);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let reads = 0;
    const [ids, view] = key.split("|");
    const read = async () => {
      try {
        const data = await requestJson<DashboardStatus>(
          `/api/x-dashboard/status?creators=${ids}&period=${view}`,
        );
        if (disposed) return;
        setStatus({ ...data, key });
        setUnread(data.unread);
        const busy = data.sync.state === "syncing" || data.sync.state === "waiting";
        // Quick right after a change (the server starts work for it) and while posts are arriving;
        // otherwise often enough that new posts show within seconds.
        timer = setTimeout(
          read,
          reads++ === 0 || busy ? 1_500 : data.coverage?.importing ? 4_000 : 8_000,
        );
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

  // A status of another scope (a response that lands after switching lists) never shows here.
  const current = status && status.key === key ? status : null;
  const sync = current?.sync ?? null;
  return {
    sync,
    unread,
    setUnread,
    /** Changes whenever posts are saved for these accounts. */
    revision: current?.revision ?? null,
    coverage: (current?.coverage ?? null) as FeedCoverage | null,
    checkEveryMs: current?.checkEveryMs ?? null,
    // A snapshot from a sync request may be older than the last poll: show it, then read again
    // right away so polling settles on the current state at the right pace.
    setSync: useCallback(
      (next: SyncSnapshot) => {
        setStatus((prev) => (prev && prev.key === key ? { ...prev, sync: next } : prev));
        setRevision((r) => r + 1);
      },
      [key],
    ),
    active: sync?.state === "syncing" || sync?.state === "waiting",
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
        if (!disposed)
          setError(err instanceof Error ? err.message : "Could not load this analysis.");
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
