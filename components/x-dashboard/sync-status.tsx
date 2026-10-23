"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";

import { Spinner } from "@/components/ui/pending";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import type { DashboardCreator, SyncSnapshot } from "@/lib/x/dashboard/model";
import {
  checkCadence,
  creatorSummary,
  importingNew,
  isRunning,
  syncNotes,
  syncSummary,
  type SyncTone,
} from "@/lib/x/dashboard/sync-copy";
import { cn } from "@/lib/utils";

function useTick(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}

const TONE_CLASS: Record<SyncTone, string> = {
  loading: "text-muted-foreground",
  busy: "text-foreground",
  fresh: "text-muted-foreground",
  quiet: "text-muted-foreground",
  attention: "text-amber-700 dark:text-amber-400",
};

function ToneIcon({ tone, disconnected }: { tone: SyncTone; disconnected: boolean }) {
  if (tone === "loading" || tone === "busy") return <Spinner className="size-3" />;
  if (tone === "attention")
    return disconnected ? (
      <WifiOff aria-hidden="true" className="size-3.5" />
    ) : (
      <TriangleAlert aria-hidden="true" className="size-3.5" />
    );
  return (
    <span
      className={cn(
        "size-2 rounded-full",
        tone === "fresh" ? "bg-emerald-500" : "bg-muted-foreground/40",
      )}
    />
  );
}

export function SyncStatus({
  sync,
  creatorsById,
  onSync,
  onStop,
  syncing,
  checkEveryMs = null,
}: {
  sync: SyncSnapshot | null;
  creatorsById: Map<number, DashboardCreator>;
  onSync: () => void;
  onStop: () => void;
  /** A sync request is in flight from this page. */
  syncing: boolean;
  /** How often these accounts are checked while on screen (0: automatic updates off). */
  checkEveryMs?: number | null;
}) {
  useTick(30_000);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("a, button:not(:disabled)")?.focus();
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const { label, tone } = syncSummary(sync, (id) => creatorsById.get(id)?.displayName);
  const busy = syncing || Boolean(sync?.creators.some(isRunning));
  const notes = sync ? syncNotes(sync) : null;
  return (
    <div
      ref={ref}
      className="relative flex items-center"
      onBlur={(event) => {
        if (
          event.relatedTarget !== triggerRef.current &&
          !panelRef.current?.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-l-full border border-r-0 bg-background py-1 pr-2 pl-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          TONE_CLASS[tone],
        )}
      >
        <span className="flex size-3.5 items-center justify-center">
          <ToneIcon tone={tone} disconnected={sync?.state === "disconnected"} />
        </span>
        <span className="max-w-64 truncate" suppressHydrationWarning>
          {label}
        </span>
        <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
      </button>
      <button
        type="button"
        onClick={onSync}
        disabled={busy}
        aria-label="Check for new posts"
        title={busy ? "Checking for new posts…" : "Check for new posts"}
        className="inline-flex size-8 items-center justify-center rounded-r-full border bg-background text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
      >
        <RefreshCw
          aria-hidden="true"
          className={cn("size-3.5", busy && "animate-spin motion-reduce:animate-none")}
        />
      </button>
      {open && sync && notes ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Update details"
          className="absolute top-full right-0 z-40 mt-2 w-80 rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-xl"
        >
          {notes.problem ? (
            <p className="m-1.5 rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
              {notes.problem}
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
              const line = creatorSummary(state);
              return (
                <li
                  key={state.creatorId}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5"
                >
                  <CreatorAvatar creator={creator} className="size-7 text-[10px]" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {creator.displayName}
                    </span>
                    <span
                      className={cn(
                        "block truncate text-xs",
                        TONE_CLASS[line.tone === "busy" ? "quiet" : line.tone],
                      )}
                      title={line.text}
                      suppressHydrationWarning
                    >
                      {line.text}
                    </span>
                  </span>
                  {isRunning(state) ? <Spinner className="size-3.5" /> : null}
                </li>
              );
            })}
          </ul>
          {notes.info.map((note) => (
            <p key={note} className="mx-2 mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {note}
            </p>
          ))}
          {checkEveryMs !== null ? (
            <p className="mx-2 mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {checkCadence(checkEveryMs, sync.total)}
            </p>
          ) : null}
          <div className="mt-1.5 flex items-center justify-between gap-2 border-t px-2 pt-2 pb-1">
            <span className="text-[11px] text-muted-foreground">
              Saved on this computer ·{" "}
              <Link
                href="/settings#x-sync-details"
                className="underline-offset-2 hover:text-foreground hover:underline"
              >
                Details
              </Link>
            </span>
            {importingNew(sync) ? (
              <button
                type="button"
                onClick={() => {
                  onStop();
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Stop importing
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  onSync();
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className="rounded-md px-2 py-1 text-xs font-medium hover:bg-accent disabled:opacity-50"
              >
                Update now
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
