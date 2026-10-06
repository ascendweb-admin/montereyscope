"use client";

/**
 * Shared model catalog controller (dynamic catalog stage).
 *
 * Mounted once in the application shell. It renders the persisted snapshot
 * immediately (the provider starts from the bundled catalog, then applies the
 * server snapshot), refreshes stale providers on launch/focus/picker open,
 * checks freshness every five minutes while the tab is visible, and polls
 * lightly only while a refresh is actually running. One manual refresh
 * bypasses the TTL and shares server-side in-flight work.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { AiBackendId } from "@/lib/ai/backend-id";
import { bundledCatalogSnapshot } from "@/lib/ai/models/bundled";
import { CATALOG_FRESHNESS_MS, type ModelCatalogSnapshot } from "@/lib/ai/models/types";

const PROVIDERS: readonly AiBackendId[] = ["codex", "opencode", "claude"];

/** How often a visible tab re-checks freshness. */
const FRESHNESS_CHECK_MS = CATALOG_FRESHNESS_MS;

/** Lightweight poll cadence while a discovery is running. */
const ACTIVE_REFRESH_POLL_MS = 2_000;

/** Client-side manual-refresh cooldown (the server enforces its own). */
const MANUAL_COOLDOWN_MS = 5_000;

export interface ModelCatalogContextValue {
  snapshot: ModelCatalogSnapshot;
  /** Providers with a discovery currently running. */
  refreshingProviders: AiBackendId[];
  /** Explicit user refresh; bypasses the TTL, cooldown-guarded. */
  refresh: (provider?: AiBackendId) => Promise<void>;
  /** Refreshes any provider whose snapshot has aged out. */
  ensureFresh: () => void;
  /** Applies a snapshot already fetched by a caller (for example a route). */
  applySnapshot: (next: ModelCatalogSnapshot) => void;
}

const ModelCatalogContext = createContext<ModelCatalogContextValue | null>(null);

/**
 * Per-provider merge: within one connection the newer revision wins; a
 * persisted generations prevent delayed responses from restoring an old
 * account, even though catalog revision numbering restarts.
 */
export function mergeSnapshots(
  current: ModelCatalogSnapshot,
  incoming: ModelCatalogSnapshot,
): ModelCatalogSnapshot {
  const providers = { ...current.providers };
  let changed = false;
  for (const provider of PROVIDERS) {
    const next = incoming.providers?.[provider];
    if (!next) {
      continue;
    }
    const previous = providers[provider];
    if (next.connectionKey === "bundled" && previous.connectionKey !== "bundled") continue;
    // Compare the persisted generation before the per-connection revision.
    const nextGeneration = next.generation ?? 0;
    const previousGeneration = previous.generation ?? 0;
    if (nextGeneration < previousGeneration) continue;
    if (
      nextGeneration === previousGeneration &&
      (next.observedAt ?? 0) < (previous.observedAt ?? 0)
    )
      continue;
    if (
      nextGeneration > previousGeneration ||
      next.connectionKey !== previous.connectionKey ||
      next.revision >= previous.revision
    ) {
      providers[provider] = next;
      changed = true;
    }
  }
  if (!changed) {
    return current;
  }
  return { checkedAt: incoming.checkedAt, providers };
}

async function fetchCatalogSnapshot(signal?: AbortSignal): Promise<ModelCatalogSnapshot | null> {
  try {
    const response = await fetch("/api/ai/models", {
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ModelCatalogSnapshot;
  } catch {
    return null;
  }
}

async function postCatalogRefresh(
  provider: AiBackendId,
  manual = false,
): Promise<ModelCatalogSnapshot | null> {
  try {
    const response = await fetch("/api/ai/models/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, manual }),
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ModelCatalogSnapshot;
  } catch {
    return null;
  }
}

export function ModelCatalogProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<ModelCatalogSnapshot>(() => bundledCatalogSnapshot());
  const snapshotRef = useRef(snapshot);
  const manualAt = useRef(new Map<AiBackendId, number>());
  const mounted = useRef(true);
  const requests = useRef(new Map<AiBackendId, Promise<void>>());
  const automaticAt = useRef(0);
  const [pendingProviders, setPendingProviders] = useState<AiBackendId[]>([]);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applySnapshot = useCallback((next: ModelCatalogSnapshot) => {
    if (!mounted.current) {
      return;
    }
    setSnapshot((current) => mergeSnapshots(current, next));
  }, []);

  const requestRefresh = useCallback(
    (provider: AiBackendId, manual: boolean): Promise<void> => {
      const existing = requests.current.get(provider);
      if (existing) return existing;
      setPendingProviders((current) => [...current, provider]);
      const request = postCatalogRefresh(provider, manual)
        .then((result) => {
          if (result) applySnapshot(result);
          else if (mounted.current)
            setSnapshot((current) => ({
              ...current,
              providers: {
                ...current.providers,
                [provider]: {
                  ...current.providers[provider],
                  error: "The model list could not be refreshed. Try again.",
                },
              },
            }));
        })
        .finally(() => {
          requests.current.delete(provider);
          if (mounted.current)
            setPendingProviders((current) => current.filter((id) => id !== provider));
        });
      requests.current.set(provider, request);
      return request;
    },
    [applySnapshot],
  );

  const ensureFresh = useCallback(() => {
    // The server rechecks the connection even for a fresh catalog. This also
    // detects external sign-ins and CLI replacements without reloading Scope.
    if (Date.now() - automaticAt.current < MANUAL_COOLDOWN_MS) return;
    automaticAt.current = Date.now();
    for (const provider of PROVIDERS) void requestRefresh(provider, false);
  }, [requestRefresh]);

  const refresh = useCallback(
    async (provider?: AiBackendId) => {
      const targeted = provider === undefined ? [...PROVIDERS] : [provider];
      const now = Date.now();
      await Promise.all(
        targeted.map(async (id) => {
          if (now - (manualAt.current.get(id) ?? 0) < MANUAL_COOLDOWN_MS) return;
          manualAt.current.set(id, now);
          await requestRefresh(id, true);
        }),
      );
    },
    [requestRefresh],
  );

  // Launch: render the persisted snapshot, then refresh stale providers.
  useEffect(() => {
    const controller = new AbortController();
    ensureFresh();
    void (async () => {
      const cached = await fetchCatalogSnapshot(controller.signal);
      if (cached) {
        applySnapshot(cached);
      }
    })();
    return () => controller.abort();
  }, [applySnapshot, ensureFresh]);

  // Focus/visibility return re-checks freshness (silent on failure).
  useEffect(() => {
    const onFocus = (): void => ensureFresh();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") {
        ensureFresh();
      }
    };
    const onAuthChanged = (): void => {
      automaticAt.current = 0;
      ensureFresh();
    };
    window.addEventListener("scope:ai-auth-changed", onAuthChanged);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("scope:ai-auth-changed", onAuthChanged);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ensureFresh]);

  // Visible tabs re-check freshness every five minutes.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        ensureFresh();
      }
    }, FRESHNESS_CHECK_MS);
    return () => clearInterval(timer);
  }, [ensureFresh]);

  const refreshingProviders = useMemo(
    () =>
      PROVIDERS.filter(
        (provider) =>
          pendingProviders.includes(provider) || snapshot.providers[provider]?.refreshing === true,
      ),
    [snapshot, pendingProviders],
  );
  const anyRefreshing = refreshingProviders.length > 0;

  // While a discovery is running, poll cheaply so other clients' refreshes
  // show up here too; stop as soon as nothing is running or the tab hides.
  useEffect(() => {
    if (!anyRefreshing) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      timer = setTimeout(() => {
        void (async () => {
          if (document.visibilityState === "visible") {
            const next = await fetchCatalogSnapshot();
            if (next && !cancelled) {
              applySnapshot(next);
            }
          }
          if (!cancelled) {
            schedule();
          }
        })();
      }, ACTIVE_REFRESH_POLL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [anyRefreshing, applySnapshot]);

  const value = useMemo<ModelCatalogContextValue>(
    () => ({ snapshot, refreshingProviders, refresh, ensureFresh, applySnapshot }),
    [snapshot, refreshingProviders, refresh, ensureFresh, applySnapshot],
  );

  return <ModelCatalogContext.Provider value={value}>{children}</ModelCatalogContext.Provider>;
}

/**
 * Reads the shared catalog. Components outside the shell provider fall back to
 * the bundled catalog so a picker never renders empty.
 */
export function useModelCatalog(): ModelCatalogContextValue {
  const context = useContext(ModelCatalogContext);
  const fallbackSnapshot = useMemo(() => bundledCatalogSnapshot(), []);
  const noop = useCallback(async () => {}, []);
  const noopSync = useCallback(() => {}, []);
  const noopApply = useCallback(() => {}, []);
  return (
    context ?? {
      snapshot: fallbackSnapshot,
      refreshingProviders: [],
      refresh: noop,
      ensureFresh: noopSync,
      applySnapshot: noopApply,
    }
  );
}
