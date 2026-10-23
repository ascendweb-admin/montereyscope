// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { XDashboardActivity } from "@/components/background/x-dashboard-activity";
import { creatorTaskKey, refreshCreatorTweetsAction } from "@/components/background/operations";
import { dismissTask, getTasks } from "@/components/background/task-store";
import { X_BUSY_MESSAGE } from "@/lib/x/model";
import type { SyncCreatorState, SyncSnapshot } from "@/lib/x/dashboard/model";

const creator = (extra: Partial<SyncCreatorState> = {}): SyncCreatorState => ({
  creatorId: 1,
  state: "idle",
  lastSyncedAt: new Date().toISOString(),
  retryAt: null,
  coveredSince: null,
  message: null,
  errorCode: null,
  newPosts: 0,
  firstSync: false,
  olderPosts: null,
  ...extra,
});
const snapshot = (c: SyncCreatorState): SyncSnapshot => ({
  state: c.state,
  lastSyncedAt: c.lastSyncedAt,
  pending: c.state === "syncing" || c.state === "waiting" ? 1 : 0,
  total: 1,
  retryAt: c.retryAt,
  message: c.message,
  newPosts: 0,
  backfilling: c.olderPosts ? 1 : 0,
  creators: [c],
});

let next: SyncSnapshot;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ insights: [], sync: next }))),
  );
});
afterEach(() => {
  cleanup();
  for (const task of getTasks()) dismissTask(task.key);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const poll = () => act(() => vi.advanceTimersByTimeAsync(10_000));
const syncTask = () => getTasks().find((t) => t.key === "x-sync");

it("keeps routine checks and rate-limit waits out of Activity", async () => {
  next = snapshot(creator({ state: "waiting", retryAt: new Date(Date.now() + 600_000).toISOString() }));
  render(<XDashboardActivity />);
  await poll();
  next = snapshot(creator({ state: "paused", errorCode: "rate_limited" }));
  await poll();
  expect(syncTask()).toBeUndefined();
});

it("shows a new account's import and finishes once its recent posts are in", async () => {
  next = snapshot(creator({ state: "waiting", firstSync: true, lastSyncedAt: null }));
  render(<XDashboardActivity />);
  await poll();
  expect(syncTask()).toMatchObject({ status: "running", label: "Getting posts from X" });
  // Older posts still importing do not keep the task running.
  next = snapshot(creator({ olderPosts: { since: "2026-09-01T00:00:00.000Z", waiting: true } }));
  await poll();
  expect(syncTask()).toMatchObject({ status: "done", message: "Posts are ready" });
});

it("ends a creator fetch neutrally, not as a failure, when X is busy", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, errorCode: "rate_limited", message: "X is rate limiting reads." })),
    ),
  );
  const outcome = await refreshCreatorTweetsAction(7, "recent");
  expect(outcome).toMatchObject({ ok: false, errorCode: "rate_limited", message: X_BUSY_MESSAGE });
  expect(getTasks().find((t) => t.key === creatorTaskKey(7))).toMatchObject({
    status: "stopped",
    message: X_BUSY_MESSAGE,
  });
});
