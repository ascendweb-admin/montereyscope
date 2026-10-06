"use client";
import { useEffect } from "react";
import { getTasks, updateTask } from "./task-store";
import type { AnalysisJob } from "@/lib/x/research/analysis-model";
/** Read durable jobs globally; opening another page never resumes analysis. */
export function ResearchActivity() {
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const observed = new Map<string, string>();
    const poll = async () => {
      try {
        const response = await fetch("/api/x-research/analysis", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { jobs: AnalysisJob[] };
          if (!disposed)
            for (const job of data.jobs) {
              const key = `x-analysis:${job.id}`,
                running = ["queued", "running", "waiting_for_provider"].includes(job.state.status);
              const signature = `${job.state.status}:${job.progress.reviewed}:${job.state.phase}`;
              const previous = observed.get(key);
              observed.set(key, signature);
              if (
                !running &&
                !getTasks().some((t) => t.key === key) &&
                (previous === signature ||
                  (previous === undefined && job.state.status === "complete"))
              )
                continue;
              updateTask({
                key,
                label: `X Research: ${job.config.question.slice(0, 80)}`,
                href: `/x-research?job=${job.id}`,
                status:
                  job.state.status === "complete"
                    ? "done"
                    : job.state.status === "failed"
                      ? "failed"
                      : job.state.status === "queued"
                        ? "queued"
                        : running
                          ? "running"
                          : "stopped",
                message: `${job.state.status} · ${job.state.phase} · Reviewed ${job.progress.reviewed} of ${job.scope.eligible} cached posts${job.state.reason ? ` · ${job.state.reason}` : ""}`,
                ...(running
                  ? {
                      cancel: () => {
                        void fetch(`/api/x-research/analysis/${job.id}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ action: "cancel" }),
                        }).catch(() => {});
                      },
                    }
                  : {}),
              });
            }
        }
      } catch {
        /* Retry observation; never mutate durable state on a read failure. */
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  return null;
}
