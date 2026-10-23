"use client";

import { useEffect, useSyncExternalStore } from "react";

import type { SyncCreatorState, SyncSnapshot } from "@/lib/x/dashboard/model";

/**
 * X accounts refresh through the X Dashboard's sync engine on the server
 * (lib/x/dashboard/sync.ts): one request starts them all, the engine paces
 * the reads against X's rate limit and waits it out, and no request is held
 * open meanwhile. This module follows that work from the client — a single
 * poll of GET /api/x-dashboard/sync covers every account being watched — so
 * a refresh can wait for an account to settle, and the source pickers can
 * show which accounts are syncing, or waiting on X until when.
 */

const ACTIVE: ReadonlySet<SyncCreatorState["state"]> = new Set(["syncing", "waiting"]);

/** Still going: reading posts, or waiting for X's rate limit to let it continue. */
export function isXSyncActive(state: SyncCreatorState | undefined): boolean {
  return state !== undefined && ACTIVE.has(state.state);
}

/** Polls that may fail in a row before the accounts waited on are given up on. */
const MAX_FAILED_POLLS = 15;
const DEFAULT_POLL_MS = 2_000;
/**
 * While a picker shows X accounts and none is going: often enough to notice
 * what the X Dashboard's own syncing changes underneath it.
 */
const QUIET_POLL_MS = 30_000;
const EMPTY: ReadonlyMap<number, SyncCreatorState> = new Map();

let pollMs = DEFAULT_POLL_MS;
let states: ReadonlyMap<number, SyncCreatorState> = EMPTY;
const listeners = new Set<() => void>();
/** Accounts a refresh waits on, until they settle. */
const settleWaiters = new Map<number, Array<(state: SyncCreatorState) => void>>();
/** Accounts a picker shows: polled quickly while any is going, and now and then otherwise. */
const observers = new Map<number, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** When the scheduled poll fires, so something more urgent can bring it forward. */
let timerDue = 0;
let polling = false;
let failedPolls = 0;

function publish(update: readonly SyncCreatorState[]): void {
  if (update.length > 0) {
    const next = new Map(states);
    for (const state of update) next.set(state.creatorId, state);
    states = next;
    for (const listener of listeners) listener();
  }
  for (const [id, waiters] of settleWaiters) {
    const state = states.get(id);
    if (state && !isXSyncActive(state)) {
      settleWaiters.delete(id);
      for (const resolve of waiters) resolve(state);
    }
  }
}

/** How soon to look again; null when nothing is watched. */
function nextPollMs(): number | null {
  if (settleWaiters.size > 0 || [...observers.keys()].some((id) => isXSyncActive(states.get(id)))) {
    return pollMs;
  }
  return observers.size > 0 ? Math.max(pollMs, QUIET_POLL_MS) : null;
}

function schedule(): void {
  const delay = nextPollMs();
  if (polling || delay === null) return;
  if (timer !== null) {
    if (timerDue <= Date.now() + delay) return;
    clearTimeout(timer);
  }
  timerDue = Date.now() + delay;
  timer = setTimeout(() => {
    timer = null;
    void poll();
  }, delay);
}

/** Polls now rather than at the next tick, unless a poll is already on its way. */
function pollNow(): void {
  if (polling) return;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  void poll();
}

/** Lost track for good: whatever was waited on settles as unknown rather than hanging. */
function giveUp(): void {
  publish(
    [...settleWaiters.keys()].map((id) => ({
      ...(states.get(id) ?? blankState(id)),
      creatorId: id,
      state: "error",
      errorCode: "network",
      retryAt: null,
      message: "Scope lost track of this update. It may still finish in the background.",
    })),
  );
}

function blankState(creatorId: number): SyncCreatorState {
  return {
    creatorId,
    state: "idle",
    lastSyncedAt: null,
    retryAt: null,
    message: null,
    errorCode: null,
    newPosts: 0,
    firstSync: false,
    olderPosts: null,
    coveredSince: null,
  };
}

async function poll(): Promise<void> {
  const ids = [...new Set([...settleWaiters.keys(), ...observers.keys()])];
  if (ids.length === 0) return;
  polling = true;
  try {
    const response = await fetch(`/api/x-dashboard/sync?creators=${ids.join(",")}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { sync?: SyncSnapshot };
    failedPolls = 0;
    publish(body.sync?.creators ?? []);
  } catch {
    failedPolls += 1;
    if (failedPolls >= MAX_FAILED_POLLS) {
      failedPolls = 0;
      giveUp();
    }
  } finally {
    polling = false;
    schedule();
  }
}

async function post(body: object): Promise<Record<string, unknown>> {
  const response = await fetch("/api/x-dashboard/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const sync = data.sync as SyncSnapshot | undefined;
  publish(sync?.creators ?? []);
  if (!response.ok) {
    const error = data.error as { message?: string } | undefined;
    throw new Error(error?.message ?? "Couldn't start updating X.");
  }
  return data;
}

/**
 * Checks these X accounts for new posts now, ahead of automatic work. Starts
 * nothing while X can't be read, and says why in `problem` instead.
 */
export async function startXSync(
  creatorIds: readonly number[],
  label: string,
): Promise<{ problem: string | null }> {
  try {
    const data = await post({ creatorIds, listId: null, label, ifConnected: true });
    return {
      problem:
        data.reason === "disconnected"
          ? typeof data.message === "string"
            ? data.message
            : "X isn't connected."
          : null,
    };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : "Couldn't start updating X." };
  }
}

/** Stops these accounts' syncing; whatever is saved stays. */
export function stopXSync(creatorIds: readonly number[]): void {
  if (creatorIds.length > 0) {
    void post({ action: "stop", creatorIds }).catch(() => {});
  }
}

/** The account's state once it is neither syncing nor waiting on X. */
export function whenXSettled(creatorId: number): Promise<SyncCreatorState> {
  const known = states.get(creatorId);
  if (known && !isXSyncActive(known)) {
    return Promise.resolve(known);
  }
  return new Promise((resolve) => {
    settleWaiters.set(creatorId, [...(settleWaiters.get(creatorId) ?? []), resolve]);
    schedule();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The sync state of these X accounts, read once on mount and followed while
 * any of them is still going — including syncs the X Dashboard started.
 */
export function useXSyncStates(
  creatorIds: readonly number[],
): ReadonlyMap<number, SyncCreatorState> {
  const key = creatorIds.join(",");
  useEffect(() => {
    if (!key) return;
    const ids = key.split(",").map(Number);
    for (const id of ids) observers.set(id, (observers.get(id) ?? 0) + 1);
    pollNow();
    return () => {
      for (const id of ids) {
        const count = (observers.get(id) ?? 1) - 1;
        if (count <= 0) observers.delete(id);
        else observers.set(id, count);
      }
    };
  }, [key]);
  return useSyncExternalStore(
    subscribe,
    () => states,
    () => EMPTY,
  );
}

/** Test seam: poll faster, and forget every state — settling, as idle, whatever was waited on. */
export function resetXSync(options: { pollMs?: number } = {}): void {
  for (const [id, waiters] of settleWaiters) {
    for (const resolve of waiters) resolve(blankState(id));
  }
  if (timer !== null) clearTimeout(timer);
  timer = null;
  polling = false;
  failedPolls = 0;
  pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  states = EMPTY;
  settleWaiters.clear();
  observers.clear();
}
