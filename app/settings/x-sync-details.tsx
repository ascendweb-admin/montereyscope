"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { requestJson } from "@/components/x-dashboard/use-dashboard-data";
import type { SyncSnapshot } from "@/lib/x/dashboard/model";
import { technicalCreatorLine } from "@/lib/x/dashboard/sync-copy";
import { cn } from "@/lib/utils";

interface DetailCreator {
  id: number;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
}

const accounts = (n: number) => `${n} account${n === 1 ? "" : "s"}`;

const STATE_LABELS: Record<SyncSnapshot["state"], string> = {
  idle: "Idle",
  syncing: "Syncing",
  waiting: "Waiting out an X rate limit",
  paused: "Paused by X rate limits",
  error: "Some accounts failed",
  disconnected: "Disconnected",
  never: "Never synced",
};

/**
 * Settings → X sync details: the technical view of the X Dashboard's syncing
 * (rate-limit waits, retry times, older posts importing) that everyday views
 * leave out. Collapsed by default; polls only while open.
 */
export function XSyncDetails() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ creators: DetailCreator[]; sync: SyncSnapshot | null } | null>(null);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  const load = useCallback(() => {
    void requestJson<{ creators: DetailCreator[]; sync: SyncSnapshot | null }>("/api/x-dashboard/sync-details")
      .then(setData)
      .catch(() => {});
  }, []);

  const loaded = Boolean(data);
  // The X Dashboard's "Details" link lands here already open (onToggle syncs the state).
  useEffect(() => {
    const showHashTarget = () => {
      if (!loaded || window.location.hash !== "#x-sync-details" || !ref.current) return;
      ref.current.open = true;
      ref.current.closest("section")?.scrollIntoView({ block: "start" });
    };
    showHashTarget();
    window.addEventListener("hashchange", showHashTarget);
    return () => window.removeEventListener("hashchange", showHashTarget);
  }, [loaded]);
  useEffect(() => {
    load();
    if (!open) return;
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [open, load]);

  if (!data?.creators.length) return null;
  const { sync, creators } = data;
  const stop = async () => {
    setStopping(true);
    await requestJson("/api/x-dashboard/sync", {
      body: { action: "stop", creatorIds: creators.map((c) => c.id) },
    }).catch(() => {});
    setStopping(false);
    load();
  };

  return (
    <section
      id="x-sync-details"
      aria-labelledby="x-sync-details-heading"
      className="mt-6 scroll-mt-6 rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <h2 id="x-sync-details-heading" className="text-base font-semibold tracking-tight">
        X sync details
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        The technical view of how Scope reads X: rate-limit waits, retry times and older posts
        importing in the background. Handy for troubleshooting; nothing here needs regular attention.
      </p>
      <details
        ref={ref}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="group mt-3"
      >
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden="true"
            className="size-4 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
          />
          {open ? "Hide details" : "Show details"}
        </summary>
        {sync ? (
          <div className="mt-3">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Overall</dt>
              <dd className="font-medium">{STATE_LABELS[sync.state]}</dd>
              <dt className="text-muted-foreground">Reading recent posts</dt>
              <dd className="tabular-nums">
                {sync.pending} of {accounts(sync.total)}
              </dd>
              <dt className="text-muted-foreground">Importing older posts</dt>
              <dd className="tabular-nums">{accounts(sync.backfilling)}</dd>
              {sync.retryAt ? (
                <>
                  <dt className="text-muted-foreground">Next retry</dt>
                  <dd suppressHydrationWarning>{new Date(sync.retryAt).toLocaleTimeString()}</dd>
                </>
              ) : null}
              {sync.message ? (
                <>
                  <dt className="text-muted-foreground">Message</dt>
                  <dd>{sync.message}</dd>
                </>
              ) : null}
            </dl>
            <ul className="mt-4 divide-y rounded-lg border">
              {sync.creators.map((state) => {
                const creator = creators.find((c) => c.id === state.creatorId);
                if (!creator) return null;
                return (
                  <li key={state.creatorId} className="flex items-center gap-2.5 px-3 py-2">
                    <CreatorAvatar creator={creator} className="size-7 text-[10px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {creator.displayName}
                        {creator.handle ? (
                          <span className="ml-1.5 font-normal text-muted-foreground">@{creator.handle}</span>
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          "block text-xs [overflow-wrap:anywhere]",
                          state.state === "error" || state.state === "disconnected"
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                        suppressHydrationWarning
                      >
                        {technicalCreatorLine(state)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {sync.pending || sync.backfilling ? (
              <div className="mt-3 flex justify-end">
                <Button variant="outline" size="sm" disabled={stopping} onClick={() => void stop()}>
                  Stop all syncing
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </details>
    </section>
  );
}
