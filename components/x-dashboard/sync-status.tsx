"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Clock, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";

import { Spinner } from "@/components/ui/pending";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { formatRelativeTime } from "@/lib/format";
import type { DashboardCreator, SyncCreatorState, SyncSnapshot } from "@/lib/x/dashboard/model";
import { cn } from "@/lib/utils";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function names(sync: SyncSnapshot, creatorsById: Map<number, DashboardCreator>, busy: (c: SyncCreatorState) => boolean) {
  return sync.creators
    .filter(busy)
    .map((c) => creatorsById.get(c.creatorId)?.displayName)
    .filter((name): name is string => Boolean(name));
}

function summary(
  sync: SyncSnapshot | null,
  creatorsById: Map<number, DashboardCreator>,
): { label: string; tone: string; icon: React.ReactNode } {
  if (!sync) return { label: "Checking…", tone: "text-muted-foreground", icon: <Spinner className="size-3" /> };
  switch (sync.state) {
    case "syncing": {
      // Name the accounts when there are only a few, so a list shows what is really running.
      const running = (c: SyncCreatorState) => c.state === "syncing" || c.state === "waiting";
      const busy = names(sync, creatorsById, running);
      const first = sync.creators.filter(running).every((c) => c.firstSync);
      return {
        label:
          busy.length && busy.length <= 2
            ? `${first ? "First sync" : "Syncing"} · ${busy.join(", ")}`
            : sync.total > 1
              ? `Syncing · ${sync.pending} accounts left`
              : "Syncing…",
        tone: "text-foreground",
        icon: <Spinner className="size-3" />,
      };
    }
    case "waiting":
      return {
        label: `X paused us · resumes ${sync.retryAt ? clock(sync.retryAt) : "soon"}`,
        tone: "text-amber-700 dark:text-amber-400",
        icon: <Clock aria-hidden="true" className="size-3.5" />,
      };
    case "paused":
      return {
        label:
          sync.retryAt && Date.parse(sync.retryAt) > Date.now()
            ? `Paused by X · retries after ${clock(sync.retryAt)}`
            : "Paused by X · retries next sync",
        tone: "text-amber-700 dark:text-amber-400",
        icon: <Clock aria-hidden="true" className="size-3.5" />,
      };
    case "disconnected":
      return {
        label: "X not connected",
        tone: "text-amber-700 dark:text-amber-400",
        icon: <WifiOff aria-hidden="true" className="size-3.5" />,
      };
    case "error":
      return {
        label: "Sync problem",
        tone: "text-destructive",
        icon: <TriangleAlert aria-hidden="true" className="size-3.5" />,
      };
    case "never":
      return {
        label:
          sync.creators.some((c) => c.state !== "never")
            ? `${sync.creators.filter((c) => c.state === "never").length} not synced yet`
            : "Not synced yet",
        tone: "text-muted-foreground",
        icon: <span className="size-2 rounded-full bg-muted-foreground/40" />,
      };
    default: {
      const synced = sync.lastSyncedAt ? `Synced ${formatRelativeTime(sync.lastSyncedAt)}` : "Synced";
      return {
        label: sync.backfilling ? `${synced} · loading older posts` : synced,
        tone: "text-muted-foreground",
        icon: <span className="size-2 rounded-full bg-emerald-500" />,
      };
    }
  }
}

function creatorLine(state: SyncCreatorState): string {
  const older = state.olderPosts
    ? ` · ${state.olderPosts.waiting ? "older posts waiting for X" : `loading older posts back to ${shortDate(state.olderPosts.since)}`}`
    : "";
  switch (state.state) {
    case "syncing":
      return state.firstSync ? "First sync · getting recent posts…" : "Syncing…";
    case "waiting":
      return `Waiting for X · resumes ${state.retryAt ? clock(state.retryAt) : "soon"}`;
    case "paused":
      return state.retryAt && Date.parse(state.retryAt) > Date.now()
        ? `Paused by X · retries after ${clock(state.retryAt)}`
        : "Paused by X · retries next sync";
    case "disconnected":
    case "error":
      return state.message ?? "Couldn't sync";
    case "never":
      return "Never synced";
    default:
      return `Synced ${formatRelativeTime(state.lastSyncedAt) ?? ""}${state.newPosts ? ` · ${state.newPosts} new` : ""}${older}`;
  }
}

export function SyncStatus({
  sync,
  creatorsById,
  onSync,
  onStop,
  syncing,
}: {
  sync: SyncSnapshot | null;
  creatorsById: Map<number, DashboardCreator>;
  onSync: () => void;
  onStop: () => void;
  /** A sync request is in flight from this page. */
  syncing: boolean;
}) {
  useTick(30_000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node))
        setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const { label, tone, icon } = summary(sync, creatorsById);
  const busy = syncing || sync?.state === "syncing" || sync?.state === "waiting";
  return (
    <div ref={ref} className="relative flex items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-l-full border border-r-0 bg-background py-1 pr-2 pl-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          tone,
        )}
      >
        <span className="flex size-3.5 items-center justify-center">{icon}</span>
        <span className="max-w-64 truncate" suppressHydrationWarning>
          {label}
        </span>
        <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
      </button>
      <button
        type="button"
        onClick={onSync}
        disabled={busy}
        aria-label="Sync now"
        title={busy ? "Syncing…" : "Sync now"}
        className="inline-flex size-8 items-center justify-center rounded-r-full border bg-background text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
      >
        <RefreshCw aria-hidden="true" className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")} />
      </button>
      {open && sync ? (
        <div
          role="dialog"
          aria-label="Sync details"
          className="absolute top-full right-0 z-40 mt-2 w-80 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          {sync.message ? (
            <p className="m-1.5 rounded-lg bg-muted/60 px-2.5 py-2 text-xs leading-relaxed">
              {sync.message}
              {sync.state === "disconnected" ? (
                <>
                  {" "}
                  <Link href="/settings" className="font-medium underline underline-offset-2">
                    Open Settings
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}
          <ul className="max-h-72 overflow-y-auto">
            {sync.creators.map((state) => {
              const creator = creatorsById.get(state.creatorId);
              if (!creator) return null;
              return (
                <li key={state.creatorId} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
                  <CreatorAvatar creator={creator} className="size-7 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{creator.displayName}</span>
                    <span
                      className={cn(
                        "block truncate text-xs",
                        state.state === "error" || state.state === "disconnected"
                          ? "text-destructive"
                          : state.state === "waiting" || state.state === "paused"
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground",
                      )}
                      title={creatorLine(state)}
                      suppressHydrationWarning
                    >
                      {creatorLine(state)}
                    </span>
                  </span>
                  {state.state === "syncing" || (state.olderPosts && !state.olderPosts.waiting) ? (
                    <Spinner className="size-3.5" />
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex items-center justify-between gap-2 border-t px-2 pt-2 pb-1">
            <span className="text-[11px] text-muted-foreground">Posts are saved on this computer.</span>
            {sync.pending || sync.backfilling ? (
              <button
                type="button"
                onClick={() => {
                  onStop();
                  setOpen(false);
                }}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Stop sync
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onSync();
                  setOpen(false);
                }}
                className="rounded-md px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
              >
                Sync now
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
