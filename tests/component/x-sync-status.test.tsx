// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  coveredSince: null,
  message: null,
  errorCode: null,
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
  render(
    <SyncStatus
      sync={sync}
      creatorsById={creators}
      onSync={vi.fn()}
      onStop={onStop}
      syncing={false}
    />,
  );

const pill = () => screen.getAllByRole("button")[0];
const open = () => fireEvent.click(pill());

it("names the few new accounts being imported, and can stop that import", () => {
  const onStop = vi.fn();
  show(
    snapshot(
      [
        creator(1, { state: "syncing", firstSync: true, lastSyncedAt: null }),
        creator(2, { state: "waiting", firstSync: true, lastSyncedAt: null }),
        creator(3),
      ],
      { state: "syncing", pending: 2 },
    ),
    onStop,
  );
  expect(pill().textContent).toContain("Getting posts · Alex, Zed");
  open();
  fireEvent.click(screen.getByRole("button", { name: "Stop importing" }));
  expect(onStop).toHaveBeenCalled();
});

it("treats waiting out an X rate limit as an ordinary check, with no warning", () => {
  const retryAt = new Date(Date.now() + 600_000).toISOString();
  show(
    snapshot([creator(1, { state: "waiting", retryAt }), creator(2)], {
      state: "waiting",
      pending: 1,
      retryAt,
      message:
        "X limits how fast apps can read posts, so Scope is waiting a moment. It continues automatically.",
    }),
  );
  expect(pill().textContent).toContain("Checking for new posts…");
  expect(pill().className).not.toMatch(/amber/);
  open();
  expect(screen.queryByText(/paused|Paused|Waiting for X|resumes/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
  expect(screen.getByText(/gets the newest posts first/)).toBeTruthy();
});

it("shows a rate-limit pause as a calm last-updated time", () => {
  const retryAt = new Date(Date.now() + 600_000).toISOString();
  show(
    snapshot([creator(1, { state: "paused", retryAt, errorCode: "rate_limited" })], {
      state: "paused",
      retryAt,
      message: "X is limiting how fast apps can read posts. Scope tries again on the next update.",
    }),
  );
  expect(pill().textContent).toMatch(/^Updated just now/);
  expect(pill().className).not.toMatch(/amber/);
  open();
  expect(screen.queryByText(/Paused|limiting/)).toBeNull();
  expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
});

it("keeps older posts importing in the background out of the headline", () => {
  const since = "2026-09-08T12:00:00.000Z";
  show(
    snapshot([creator(1, { olderPosts: { since, waiting: true } }), creator(3)], {
      backfilling: 1,
    }),
  );
  expect(pill().textContent).toMatch(/^Updated just now$/);
  open();
  expect(screen.getByText("Updated just now · adding older posts")).toBeTruthy();
  expect(screen.queryByText(/waiting for X|back to/)).toBeNull();
  expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
});

it("only warns about problems someone can fix", () => {
  const protectedAccount = creator(1, {
    state: "error",
    errorCode: "protected_account",
    message: "This account is protected, so its posts can't be read.",
  });
  const offline = creator(2, {
    state: "error",
    errorCode: "network",
    message: "Couldn't reach X.",
  });
  const { unmount } = show(snapshot([protectedAccount, offline], { state: "error" }));
  expect(pill().textContent).toContain("1 account needs attention");
  expect(pill().className).toMatch(/amber/);
  open();
  expect(
    screen.getAllByText("This account is protected, so its posts can't be read.").length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("Couldn't reach X.")).toBeNull();
  unmount();
  show(snapshot([offline], { state: "error" }));
  expect(pill().textContent).toMatch(/^Updated just now$/);
  expect(pill().className).not.toMatch(/amber/);
});

it("says posts may be behind once rate limits have held them back for a long time", () => {
  const old = new Date(Date.now() - 20 * 3600_000).toISOString();
  show(
    snapshot([creator(1, { state: "paused", lastSyncedAt: old, errorCode: "rate_limited" })], {
      state: "paused",
      lastSyncedAt: old,
    }),
  );
  expect(pill().textContent).toContain("Updated 20 hours ago");
  open();
  expect(screen.getByText(/may be a bit behind/)).toBeTruthy();
});

it("links to the full technical details in Settings", () => {
  show(snapshot([creator(1)]));
  open();
  expect(screen.getByRole("link", { name: "Details" }).getAttribute("href")).toBe(
    "/settings#x-sync-details",
  );
});

it("focuses update details and returns to its trigger after Escape or updating", () => {
  show(snapshot([creator(1)]));
  const trigger = pill();
  open();
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "Details" }));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  open();
  fireEvent.click(screen.getByRole("button", { name: "Update now" }));
  expect(document.activeElement).toBe(trigger);
});

it("dismisses update details when keyboard focus leaves the nonmodal popup", () => {
  show(snapshot([creator(1)]));
  open();
  const refresh = screen.getByRole("button", { name: "Check for new posts" });
  act(() => refresh.focus());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(refresh);
});
