// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SyncStatus } from "@/components/x-dashboard/sync-status";
import type { DashboardCreator, SyncCreatorState, SyncSnapshot } from "@/lib/x/dashboard/model";

afterEach(cleanup);
const creators = new Map<number, DashboardCreator>(
  ["Alex", "Zed", "Ann"].map((name, i) => [
    i + 1,
    { id: i + 1, displayName: name, handle: name.toLowerCase(), avatarUrl: null, categoryIds: [] },
  ]),
);
const now = new Date().toISOString();
const creator = (creatorId: number, extra: Partial<SyncCreatorState> = {}): SyncCreatorState => ({
  creatorId,
  state: "idle",
  lastSyncedAt: now,
  retryAt: null,
  message: null,
  newPosts: 0,
  firstSync: false,
  olderPosts: null,
  ...extra,
});
const snapshot = (list: SyncCreatorState[], extra: Partial<SyncSnapshot> = {}): SyncSnapshot => ({
  state: "idle",
  lastSyncedAt: now,
  pending: 0,
  total: list.length,
  retryAt: null,
  message: null,
  newPosts: 0,
  backfilling: 0,
  creators: list,
  ...extra,
});
const show = (sync: SyncSnapshot, onStop = vi.fn()) =>
  render(<SyncStatus sync={sync} creatorsById={creators} onSync={vi.fn()} onStop={onStop} syncing={false} />);

it("names the few accounts actually syncing instead of counting the list", () => {
  show(
    snapshot(
      [
        creator(1, { state: "syncing", firstSync: true, lastSyncedAt: null }),
        creator(2, { state: "waiting", firstSync: true, lastSyncedAt: null }),
        creator(3),
      ],
      { state: "syncing", pending: 2 },
    ),
  );
  expect(screen.getByRole("button", { name: /First sync · Alex, Zed/ })).toBeTruthy();
});

it("shows a background import of older posts as synced, and can stop it", () => {
  const onStop = vi.fn();
  const since = "2026-09-08T12:00:00.000Z";
  show(snapshot([creator(1, { olderPosts: { since, waiting: false } }), creator(3)], { backfilling: 1 }), onStop);
  fireEvent.click(screen.getByRole("button", { name: /Synced .* · loading older posts/ }));
  expect(screen.getByText(/loading older posts back to/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop sync" }));
  expect(onStop).toHaveBeenCalled();
});

it("says X paused syncing rather than reporting a failure", () => {
  const retryAt = new Date(Date.now() + 600_000).toISOString();
  show(
    snapshot([creator(1, { state: "paused", retryAt })], {
      state: "paused",
      retryAt,
      message: "X is limiting requests, so Scope paused. It tries again on the next sync.",
    }),
  );
  expect(screen.getByRole("button", { name: /Paused by X · retries after/ })).toBeTruthy();
  expect(screen.queryByText("Sync problem")).toBeNull();
});
