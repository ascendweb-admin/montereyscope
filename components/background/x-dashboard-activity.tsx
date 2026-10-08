"use client";

import { useEffect } from "react";

import { getTasks, updateTask } from "./task-store";
import type { InsightSummary, SyncSnapshot } from "@/lib/x/dashboard/model";

/**
 * Mirrors X Dashboard work into the activity panel from any page: AI
 * analyses while they write, and X syncs while they run. Reads local state
 * only; it never starts or resumes work.
 */
export function XDashboardActivity() {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const seen = new Map<string, string>();
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
          const sync = data.sync;
          if (sync) {
            const running = sync.state === "syncing" || sync.state === "waiting";
            busy ||= running;
            const previous = seen.get("x-sync");
            seen.set("x-sync", sync.state);
            if (running || (previous && previous !== sync.state && (previous === "syncing" || previous === "waiting")))
              updateTask({
                key: "x-sync",
                label: "Syncing X",
                href: "/x-dashboard",
                status: running
                  ? "running"
                  : sync.state === "error" || sync.state === "disconnected"
                    ? "failed"
                    : sync.state === "paused"
                      ? "stopped"
                      : "done",
                message: running
                  ? sync.state === "waiting"
                    ? (sync.message ?? "Waiting for X")
                    : `${sync.total - sync.pending} of ${sync.total} accounts done`
                  : (sync.message ?? (sync.newPosts ? `${sync.newPosts} new posts` : "Up to date")),
              });
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
