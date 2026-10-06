"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/pending";
import {
  dismissTask,
  getTasks,
  updateTask,
  useBackgroundTasks,
  type BackgroundTask,
} from "./task-store";

const isActive = (task: BackgroundTask) => task.status === "running" || task.status === "queued";

const statusLabels: Record<BackgroundTask["status"], string> = {
  running: "In progress",
  queued: "Queued",
  done: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};

function TaskIcon({ status }: { status: BackgroundTask["status"] }) {
  if (status === "running") return <Spinner />;
  const Icon =
    status === "queued"
      ? Clock3
      : status === "failed"
        ? TriangleAlert
        : status === "stopped"
          ? Square
          : CheckCircle2;
  return <Icon aria-hidden="true" className="size-4" />;
}

function TaskRow({
  task,
  onNavigate,
  onDismiss,
}: {
  task: BackgroundTask;
  onNavigate: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="group flex items-start gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-muted/60">
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground",
          isActive(task) && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
          task.status === "done" && "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
          task.status === "failed" && "bg-destructive/10 text-destructive",
        )}
      >
        <TaskIcon status={task.status} />
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={task.href}
          onClick={onNavigate}
          className="flex items-start gap-1 rounded-sm text-sm font-medium leading-5 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{task.label}</span>
          <ArrowUpRight
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
        </Link>
        <p
          className={cn(
            "mt-1 text-xs text-muted-foreground",
            task.status === "failed" && "text-destructive",
          )}
        >
          {statusLabels[task.status]}
        </p>
        {task.message && (
          <p
            className={cn(
              "mt-1.5 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]",
              task.status === "failed" && "text-destructive",
            )}
          >
            {task.message}
          </p>
        )}
      </div>
      {isActive(task) && task.cancel ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-0.5 h-7 px-2 shadow-none"
          aria-label={`Stop ${task.label}`}
          onClick={task.cancel}
        >
          Stop
        </Button>
      ) : !isActive(task) ? (
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0 text-muted-foreground"
          aria-label={`Dismiss ${task.label}`}
          onClick={onDismiss}
        >
          <X />
        </Button>
      ) : null}
    </li>
  );
}

export function BackgroundActivity() {
  const tasks = useBackgroundTasks();
  const [open, setOpen] = useState(false);
  const [notification, setNotification] = useState<BackgroundTask | null>(null);
  const statuses = useRef(new Map<string, string>());
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const closePanel = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);
  // Reports already execute on the server. Discover them globally, including retries on Reports.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/ai/reports", { cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as {
            reports?: Array<{
              id: number;
              title: string | null;
              status: "queued" | "running" | "done" | "failed";
              error: string | null;
            }>;
          };
          if (!disposed)
            for (const report of body.reports ?? []) {
              const key = `report:${report.id}`;
              // Don't flood activity with historical reports on startup.
              if (
                report.status === "running" ||
                report.status === "queued" ||
                getTasks().some((task) => task.key === key)
              ) {
                updateTask({
                  key,
                  label: report.title ? `Report: ${report.title}` : `Report #${report.id}`,
                  status: report.status,
                  href: "/reports",
                  message: report.error ?? undefined,
                });
              }
            }
        }
      } catch {
        /* The next poll retries without overwriting job state. */
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let completed: BackgroundTask | undefined;
    for (const task of tasks) {
      const previous = statuses.current.get(task.key);
      if (
        (previous === "running" || previous === "queued") &&
        task.status !== "running" &&
        task.status !== "queued"
      )
        completed ??= task;
      statuses.current.set(task.key, task.status);
    }
    if (completed) {
      // Refresh whichever page is now visible; this never navigates the user.
      router.refresh();
      const task = completed;
      setTimeout(() => setNotification(task), 0);
    }
  }, [tasks, router]);
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => setNotification(null), 6000);
    return () => clearTimeout(timer);
  }, [notification]);
  const activeTasks = tasks.filter(isActive);
  const recentTasks = tasks.filter((task) => !isActive(task));
  const active = activeTasks.length;
  const failed = recentTasks.some((task) => task.status === "failed");

  return (
    <div ref={containerRef} className="relative md:w-full">
      <Button
        ref={triggerRef}
        variant="ghost"
        className={cn(
          "h-9 gap-2.5 px-3 text-muted-foreground shadow-none md:h-11 md:w-full md:justify-start",
          open && "bg-accent text-accent-foreground",
        )}
        aria-label={active ? `Background activity, ${active} active` : "Background activity"}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setNotification(null);
        }}
      >
        {active ? (
          <Spinner className="text-blue-600 dark:text-blue-400" />
        ) : (
          <Activity aria-hidden="true" />
        )}
        <span className="text-foreground">Activity</span>
        {active ? (
          <span className="ml-auto min-w-5 rounded-md bg-blue-500/10 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-blue-600 dark:text-blue-400">
            {active}
          </span>
        ) : failed ? (
          <span
            className="ml-auto size-1.5 rounded-full bg-destructive"
            aria-label="Failed tasks"
          />
        ) : (
          <span className="ml-auto hidden text-xs font-normal text-muted-foreground md:inline">
            All clear
          </span>
        )}
        <ChevronRight aria-hidden="true" className="hidden text-muted-foreground md:block" />
      </Button>

      {open && (
        <section
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${panelId}-title`}
          aria-describedby={`${panelId}-description`}
          className="fixed inset-x-4 top-16 flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-[0_12px_48px_-12px_rgba(0,0,0,0.25)] md:absolute md:inset-x-auto md:bottom-0 md:left-[calc(100%+1rem)] md:top-auto md:max-h-[min(32rem,calc(100dvh-8rem))] md:w-96"
        >
          <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
            <div>
              <h2 id={`${panelId}-title`} className="text-sm font-semibold tracking-tight">
                Activity
              </h2>
              <p id={`${panelId}-description`} className="mt-1 text-xs text-muted-foreground">
                {active
                  ? `${active} ${active === 1 ? "task" : "tasks"} in progress. Keep browsing.`
                  : "Your background tasks, in one place."}
              </p>
            </div>
            <Button
              ref={closeRef}
              size="icon"
              variant="ghost"
              className="-mr-1 -mt-1 size-7 text-muted-foreground"
              aria-label="Close activity"
              onClick={closePanel}
            >
              <X />
            </Button>
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-10 text-center">
                <span className="mb-4 flex size-11 items-center justify-center rounded-full border bg-muted/40 text-muted-foreground">
                  <Activity aria-hidden="true" className="size-5" />
                </span>
                <p className="text-sm font-medium">You’re all caught up</p>
                <p className="mt-2 max-w-60 text-xs leading-5 text-muted-foreground">
                  Feed refreshes, transcripts, AI answers, and reports will appear here.
                </p>
              </div>
            ) : (
              <>
                {active > 0 && (
                  <div>
                    <h3 className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                      In progress <span className="ml-1 tabular-nums">{active}</span>
                    </h3>
                    <ul>
                      {activeTasks.map((task) => (
                        <TaskRow
                          key={task.key}
                          task={task}
                          onNavigate={() => setOpen(false)}
                          onDismiss={() => {
                            dismissTask(task.key);
                            closeRef.current?.focus();
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                )}
                {recentTasks.length > 0 && (
                  <div className={cn(active > 0 && "mt-2 border-t pt-2")}>
                    <div className="flex items-center justify-between px-3 py-1">
                      <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        Recent
                      </h3>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[11px] text-muted-foreground"
                        onClick={() => {
                          recentTasks.forEach((task) => dismissTask(task.key));
                          setNotification(null);
                          closeRef.current?.focus();
                        }}
                      >
                        Clear finished
                      </Button>
                    </div>
                    <ul>
                      {recentTasks.map((task) => (
                        <TaskRow
                          key={task.key}
                          task={task}
                          onNavigate={() => setOpen(false)}
                          onDismiss={() => {
                            dismissTask(task.key);
                            closeRef.current?.focus();
                          }}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="border-t bg-muted/20 px-5 py-3 text-[11px] text-muted-foreground">
            Activity from this session
          </div>
        </section>
      )}

      {notification && !open && (
        <div
          role="status"
          className="fixed bottom-5 right-5 flex w-80 max-w-[calc(100vw-2.5rem)] items-start gap-3 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
        >
          <span
            className={cn(
              "mt-0.5",
              notification.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <TaskIcon status={notification.status} />
          </span>
          <Link
            href={notification.href}
            className="min-w-0 flex-1 rounded-sm text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setNotification(null)}
          >
            <span className="block font-medium [overflow-wrap:anywhere]">{notification.label}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {statusLabels[notification.status]}
            </span>
          </Link>
          <Button
            size="icon"
            variant="ghost"
            className="-mr-1 -mt-1 size-7 text-muted-foreground"
            aria-label="Dismiss notification"
            onClick={() => setNotification(null)}
          >
            <X />
          </Button>
        </div>
      )}
    </div>
  );
}
