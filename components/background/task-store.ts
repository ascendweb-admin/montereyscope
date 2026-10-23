"use client";

import { useSyncExternalStore } from "react";

export interface BackgroundTask {
  key: string;
  label: string;
  href: string;
  status: "running" | "queued" | "done" | "failed" | "stopped";
  message?: string;
  result?: unknown;
  cancel?: () => void;
  /** When the task finished (ms), so an old failure can tell it was overtaken. */
  endedAt?: number;
}
const listeners = new Set<() => void>();
let tasks: BackgroundTask[] = [];
const empty: BackgroundTask[] = [];
const inFlight = new Map<string, Promise<unknown>>();
export const subscribeTasks = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getTasks = () => tasks;
export function updateTask(task: BackgroundTask) {
  const previous = tasks.find((item) => item.key === task.key);
  if (
    previous &&
    Object.keys(task).every(
      (key) => previous[key as keyof BackgroundTask] === task[key as keyof BackgroundTask],
    )
  )
    return;
  tasks = [task, ...tasks.filter((item) => item.key !== task.key)];
  for (const listener of listeners) listener();
}
export function dismissTask(key: string) {
  tasks = tasks.filter(
    (item) => item.key !== key || item.status === "running" || item.status === "queued",
  );
  for (const listener of listeners) listener();
}
export function useBackgroundTasks() {
  return useSyncExternalStore(subscribeTasks, getTasks, () => empty);
}
export function useBackgroundTask(key: string) {
  return useBackgroundTasks().find((task) => task.key === key);
}
/** Work belongs to the app session, never to the component awaiting it. */
export function runBackgroundTask<T extends { ok: boolean; message?: string }>(
  task: Pick<BackgroundTask, "key" | "label" | "href">,
  work: () => Promise<T>,
  /** How a finished result reads in Activity; by default ok is done, anything else failed. */
  statusOf: (result: T) => BackgroundTask["status"] = (result) => (result.ok ? "done" : "failed"),
): Promise<T> {
  const existing = inFlight.get(task.key);
  if (existing) return existing as Promise<T>;
  updateTask({ ...task, status: "running" });
  const promise = (async () => work())()
    .catch(
      () =>
        ({
          ok: false,
          message: "The task could not finish. Please try again.",
        }) as T,
    )
    .then((result) => {
      updateTask({
        ...task,
        status: statusOf(result),
        message: result.message,
        result,
        endedAt: Date.now(),
      });
      return result;
    })
    .finally(() => {
      inFlight.delete(task.key);
    });
  inFlight.set(task.key, promise);
  return promise;
}

export async function trackAcceptedReport(response: Response): Promise<void> {
  const body = (await response.json()) as {
    report?: { id: number; title?: string | null; status: BackgroundTask["status"] };
  };
  if (body.report)
    updateTask({
      key: `report:${body.report.id}`,
      label: body.report.title ? `Report: ${body.report.title}` : `Report #${body.report.id}`,
      href: `/reports?report=${body.report.id}`,
      status: body.report.status,
    });
}
