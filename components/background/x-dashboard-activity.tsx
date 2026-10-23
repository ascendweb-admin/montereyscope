"use client";

import { useEffect } from "react";

import { getTasks, updateTask } from "./task-store";
import type { InsightSummary, SyncSnapshot } from "@/lib/x/dashboard/model";
import { isRunning, needsAttention } from "@/lib/x/dashboard/sync-copy";

/**
 * Mirrors X Dashboard work into the activity panel from any page: AI
 * analyses while they write, and a new X account's first import. Reads local state
 * only; it never starts or resumes work.
 */
export function XDashboardActivity() {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const seen = new Map<string, string>();
    /** Accounts whose first import this session watched run. */
    const watched = new Set<number>();
    const poll = async () => {
      let busy = false;
      try {
        const response = await fetch("/api/x-dashboard/activity", { cache: "no-store" });
        if (response.ok && !disposed) {
          const data = (await response.json()) as { insights: InsightSummary[]; sync: SyncSnapshot | null };
          for (const insight of data.insights) {
            const key = `x-insight:${insight.id}`;
            const running = insight.status === "running";
            busy ||= running;
            const previous = seen.get(key);
            seen.set(key, insight.status);
            // Only report work this session watched start, or that is running now.
            if (!running && previous === undefined && !getTasks().some((t) => t.key === key)) continue;
            if (!running && previous === insight.status) continue;
            updateTask({
              key,
              label: `AI: ${insight.title}`,
              href: `/x-dashboard?insight=${insight.id}`,
              status: running
                ? "running"
                : insight.status === "complete"
                  ? "done"
                  : insight.status === "failed"
                    ? "failed"
                    : "stopped",
              message: running
                ? `Reading ${insight.postCount.toLocaleString()} posts…`
                : (insight.error ?? (insight.status === "complete" ? "Analysis ready" : "Stopped")),
            });
          }
          // Routine background updates stay out of Activity; only a new account's first import shows,
          // and it is done once its recent posts are in (older posts keep arriving quietly).
          const sync = data.sync;
          if (sync) {
            const importing = sync.creators.filter((c) => c.firstSync && isRunning(c));
            busy ||= importing.length > 0;
            for (const c of importing) watched.add(c.creatorId);
            if (importing.length)
              updateTask({
                key: "x-sync",
                label: "Getting posts from X",
                href: "/x-dashboard",
                status: "running",
                message:
                  importing.length === 1 ? "Importing a new account…" : `Importing ${importing.length} new accounts…`,
              });
            else if (watched.size) {
              const finished = sync.creators.filter((c) => watched.has(c.creatorId));
              watched.clear();
              const problem = finished.find(needsAttention);
              updateTask({
                key: "x-sync",
                label: "Getting posts from X",
                href: "/x-dashboard",
                status: problem ? "failed" : "done",
                message: problem
                  ? (problem.message ?? "An account couldn't be imported.")
                  : finished.some((c) => !c.lastSyncedAt)
                    ? "Posts will finish arriving on the next update."
                    : "Posts are ready",
              });
            }
          }
        }
      } catch {
        /* Observation only; try again on the next tick. */
      }
      if (!disposed) timer = setTimeout(poll, busy ? 2500 : 8000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return null;
}
