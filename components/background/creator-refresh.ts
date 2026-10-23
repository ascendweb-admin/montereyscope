"use client";

import { useSyncExternalStore } from "react";

import type { RefreshContentOutcome } from "@/app/actions/feeds";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { SyncCreatorState } from "@/lib/x/dashboard/model";
import { isTemporaryXError } from "@/lib/x/model";
import { creatorTaskKey, refreshCreatorContentAction } from "./operations";
import { runBackgroundTask, updateTask, type BackgroundTask } from "./task-store";
import { startXSync, stopXSync, whenXSettled } from "./x-sync";

/**
 * Batch refreshes — "Refresh all" in the Library, a person's accounts on
 * their page, everyone or one platform from a source picker — as runs that
 * belong to the app session rather than to the button that started them.
 * Every surface reads the same run by its key: a refresh started in the
 * Library shows its progress in the picker, and closing a dialog never
 * orphans one.
 *
 * A run has a lane per kind of source, and the lanes run side by side, so X
 * being slow never holds up a video:
 * - YouTube and Rumble accounts refresh two at a time (yt-dlp's own limit)
 *   through the per-account action everything else uses;
 * - X accounts go to the X Dashboard's sync engine in one request
 *   (x-sync.ts), which paces reads against X's rate limit and waits it out
 *   on the server. Accounts checked moments ago are left alone, and nothing
 *   starts while X isn't connected.
 *
 * Asking for more while a run goes adds to it: "Refresh YouTube" during a
 * slow X sync starts the video lane next to it. Stopping takes effect at
 * once, for one lane or both: an account in flight is left to finish on its
 * own (its own background task still reports it).
 */

/** One account to refresh, named the way progress and failures read. */
export interface RefreshTarget {
  id: number;
  displayName: string;
  platform: CreatorPlatform;
  /** Its last update, so an X account checked moments ago can be left alone. */
  updatedAt?: string | null;
}

export interface RefreshFailure extends RefreshTarget {
  message: string;
  errorCode: string | null;
}

export type RefreshLaneId = "video" | "x";

export function laneOf(platform: CreatorPlatform): RefreshLaneId {
  return platform === "x" ? "x" : "video";
}

export interface RefreshLane {
  id: RefreshLaneId;
  targets: readonly RefreshTarget[];
  /** Accounts finished, refreshed or failed, in the order they finished. */
  settled: readonly number[];
  /** Accounts in flight. */
  active: readonly number[];
  /** X accounts checked moments ago, counted as up to date without a read. */
  skipped: readonly number[];
  failures: readonly RefreshFailure[];
  status: "running" | "done" | "stopped";
  /** Why nothing in the lane could run (X not connected); its accounts are its failures. */
  problem: string | null;
  videoCount: number;
  livestreamCount: number;
  tweetCount: number;
}

/** How a run shows up in Activity. */
export interface RefreshRunTask {
  key: string;
  label: string;
  /** Prefix for "<progressLabel> 2 of 5" while the run is in flight. */
  progressLabel: string;
  href: string;
}

export interface RefreshRun {
  key: string;
  status: "running" | "done" | "stopped";
  lanes: readonly RefreshLane[];
  startedAt: number;
  finishedAt: number | null;
  // Across lanes, for one-line summaries:
  targets: readonly RefreshTarget[];
  /** Accounts finished so far, refreshed or failed. */
  done: number;
  refreshedCount: number;
  videoCount: number;
  livestreamCount: number;
  tweetCount: number;
  failures: readonly RefreshFailure[];
}

export interface RefreshRunOutcome {
  ok: boolean;
  message?: string;
  run: RefreshRun;
}

/** What a refresh covers: everyone, or every account on one platform. */
export type RefreshScope = "all" | CreatorPlatform;

export function targetsInScope(
  targets: readonly RefreshTarget[],
  scope: RefreshScope,
): RefreshTarget[] {
  return scope === "all" ? [...targets] : targets.filter((target) => target.platform === scope);
}

/** The stalest update among these accounts; null when one of them never updated. */
export function oldestUpdate(targets: readonly RefreshTarget[]): string | null {
  const updates = targets.map((target) => target.updatedAt ?? null);
  const known = updates.filter((value): value is string => value !== null).sort();
  return known.length === updates.length ? (known[0] ?? null) : null;
}

/** True while every one of these accounts is already being refreshed by `run`. */
export function alreadyRefreshing(
  run: RefreshRun | undefined,
  targets: readonly RefreshTarget[],
): boolean {
  if (run?.status !== "running" || targets.length === 0) return false;
  const going = new Set(
    run.lanes
      .filter((lane) => lane.status === "running")
      .flatMap((lane) => lane.targets.map((target) => target.id)),
  );
  return targets.every((target) => going.has(target.id));
}

/** Everyone in the library: the Library's "Refresh all" and the source pickers share it. */
export const REFRESH_ALL_TASK: RefreshRunTask = {
  key: "refresh-all",
  label: "Updating all creators",
  progressLabel: "Updating creators",
  href: "/",
};

/** One person's accounts, the same run their creator page starts. */
export function profileRefreshTask(profileId: number, displayName: string): RefreshRunTask {
  return {
    key: `refresh-profile-${profileId}`,
    label: `Updating ${displayName}`,
    progressLabel: `Updating ${displayName}'s accounts`,
    href: `/creators/${profileId}`,
  };
}

/** yt-dlp runs two processes at once by default (lib/ytdlp/runner.ts). */
const VIDEO_CONCURRENCY = 2;
/** An X account checked this recently is left alone by a refresh of many. */
const X_FRESH_MS = 2 * 60_000;

interface StopSwitch {
  requested: boolean;
  /** Resolves (with null) once a stop is requested, releasing every wait in the lane. */
  signal: Promise<null>;
  request: () => void;
}

function stopSwitch(): StopSwitch {
  let release!: (value: null) => void;
  const stop: StopSwitch = {
    requested: false,
    signal: new Promise<null>((resolve) => {
      release = resolve;
    }),
    request: () => {
      stop.requested = true;
      release(null);
    },
  };
  return stop;
}

interface LaneWork {
  lane: RefreshLane;
  stop: StopSwitch;
  /** Video accounts waiting for a free slot. */
  queue: RefreshTarget[];
  workers: number;
}

interface LiveRun {
  task: RefreshRunTask;
  startedAt: number;
  lanes: Map<RefreshLaneId, LaneWork>;
  /** Work still going: video workers and X accounts being followed. */
  outstanding: number;
  finish: () => void;
}

const listeners = new Set<() => void>();
const runs = new Map<string, RefreshRun>();
const live = new Map<string, LiveRun>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The latest run under `key`, live while it goes and kept once it ends. */
export function useRefreshRun(key: string): RefreshRun | undefined {
  return useSyncExternalStore(
    subscribe,
    () => runs.get(key),
    () => undefined,
  );
}

export function getRefreshRun(key: string): RefreshRun | undefined {
  return runs.get(key);
}

/** Stops a run now — every lane, or just one. */
export function stopRefreshRun(key: string, laneId?: RefreshLaneId): void {
  const current = live.get(key);
  if (!current) return;
  for (const [id, work] of current.lanes) {
    if ((laneId === undefined || laneId === id) && work.lane.status === "running") {
      if (id === "x") stopXSync(work.lane.active);
      work.stop.request();
    }
  }
}

/** The accounts a run never finished, to pick up where it left off. */
export function remainingTargets(run: RefreshRun, laneId?: RefreshLaneId): RefreshTarget[] {
  return run.lanes
    .filter((lane) => laneId === undefined || lane.id === laneId)
    .flatMap((lane) => lane.targets.filter((target) => !lane.settled.includes(target.id)));
}

/** Forgets every finished run; used between tests. */
export function resetRefreshRuns(): void {
  for (const [key, run] of runs) {
    if (run.status !== "running") runs.delete(key);
  }
  notify();
}

function summarize(current: LiveRun, status: RefreshRun["status"]): RefreshRun {
  const lanes = [...current.lanes.values()].map((work) => work.lane);
  const sum = (pick: (lane: RefreshLane) => number) =>
    lanes.reduce((total, lane) => total + pick(lane), 0);
  const failures = lanes.flatMap((lane) => lane.failures);
  const done = sum((lane) => lane.settled.length);
  return {
    key: current.task.key,
    status,
    lanes,
    startedAt: current.startedAt,
    finishedAt: status === "running" ? null : Date.now(),
    targets: lanes.flatMap((lane) => lane.targets),
    done,
    refreshedCount: done - failures.length,
    videoCount: sum((lane) => lane.videoCount),
    livestreamCount: sum((lane) => lane.livestreamCount),
    tweetCount: sum((lane) => lane.tweetCount),
    failures,
  };
}

function publish(current: LiveRun): void {
  const run = summarize(current, "running");
  runs.set(current.task.key, run);
  updateTask({
    key: current.task.key,
    label: `${current.task.progressLabel} ${Math.min(run.done + 1, run.targets.length)} of ${
      run.targets.length
    }`,
    href: current.task.href,
    status: "running",
    cancel: () => stopRefreshRun(current.task.key),
  });
  notify();
}

/** The lane, opened (or opened again after it ended) for more accounts. */
function openLane(current: LiveRun, laneId: RefreshLaneId): LaneWork {
  const work = current.lanes.get(laneId);
  if (work?.lane.status === "running") return work;
  // A lane that ended counts afresh: its earlier accounts are done with.
  const opened: LaneWork = {
    lane: {
      id: laneId,
      targets: [],
      settled: [],
      active: [],
      skipped: [],
      failures: [],
      status: "running",
      problem: null,
      videoCount: 0,
      livestreamCount: 0,
      tweetCount: 0,
    },
    stop: stopSwitch(),
    queue: [],
    workers: 0,
  };
  current.lanes.set(laneId, opened);
  return opened;
}

function begin(current: LiveRun): void {
  current.outstanding += 1;
}

/** One piece of work is over: close the lanes with nothing left, and the run with no work left. */
function end(current: LiveRun): void {
  current.outstanding -= 1;
  for (const work of current.lanes.values()) {
    const { lane } = work;
    if (lane.status !== "running" || lane.active.length > 0) continue;
    const unsettled = lane.targets.some((target) => !lane.settled.includes(target.id));
    if (work.stop.requested) {
      work.lane = { ...lane, status: unsettled ? "stopped" : "done" };
    } else if (!unsettled && work.queue.length === 0) {
      work.lane = { ...lane, status: "done" };
    }
  }
  if (current.outstanding === 0) {
    current.finish();
  } else {
    publish(current);
  }
}

function record(work: LaneWork, target: RefreshTarget, outcome: RefreshContentOutcome): void {
  const { lane } = work;
  const refreshed = outcome.ok && outcome.status === "refreshed";
  work.lane = {
    ...lane,
    active: lane.active.filter((id) => id !== target.id),
    settled: lane.settled.includes(target.id) ? lane.settled : [...lane.settled, target.id],
    failures: outcome.ok
      ? lane.failures
      : [
          ...lane.failures,
          {
            ...target,
            message: outcome.message ?? "The feed could not be updated right now.",
            errorCode: outcome.errorCode ?? null,
          },
        ],
    videoCount: lane.videoCount + (refreshed ? (outcome.addedVideos ?? 0) : 0),
    livestreamCount: lane.livestreamCount + (refreshed ? (outcome.addedLivestreams ?? 0) : 0),
    tweetCount: lane.tweetCount + (refreshed ? (outcome.addedTweets ?? 0) : 0),
  };
}

/** Leaves an account the lane stopped waiting for; it finishes on its own. */
function release(work: LaneWork, target: RefreshTarget): void {
  work.lane = { ...work.lane, active: work.lane.active.filter((id) => id !== target.id) };
}

async function videoWorker(current: LiveRun, work: LaneWork): Promise<void> {
  while (work.queue.length > 0 && !work.stop.requested) {
    const target = work.queue.shift()!;
    work.lane = { ...work.lane, active: [...work.lane.active, target.id] };
    publish(current);
    const outcome = await Promise.race([refreshCreatorContentAction(target.id), work.stop.signal]);
    if (outcome === null) {
      release(work, target);
      return;
    }
    record(work, target, outcome);
    publish(current);
  }
}

function addVideo(current: LiveRun, targets: readonly RefreshTarget[]): void {
  const work = openLane(current, "video");
  work.lane = { ...work.lane, targets: [...work.lane.targets, ...targets] };
  work.queue.push(...targets);
  while (work.workers < VIDEO_CONCURRENCY && work.queue.length > 0) {
    work.workers += 1;
    begin(current);
    void videoWorker(current, work).finally(() => {
      work.workers -= 1;
      end(current);
    });
  }
}

function addX(current: LiveRun, targets: readonly RefreshTarget[]): void {
  const work = openLane(current, "x");
  // Of many, the ones checked moments ago stay as they are: a read each, for nothing new.
  const now = Date.now();
  const fresh =
    targets.length > 1
      ? targets.filter(
          (target) => target.updatedAt && now - Date.parse(target.updatedAt) < X_FRESH_MS,
        )
      : [];
  const due = targets.filter((target) => !fresh.includes(target));
  work.lane = {
    ...work.lane,
    targets: [...work.lane.targets, ...targets],
    skipped: [...work.lane.skipped, ...fresh.map((target) => target.id)],
    settled: [...work.lane.settled, ...fresh.map((target) => target.id)],
    active: [...work.lane.active, ...due.map((target) => target.id)],
  };
  const followed = refreshXAccounts(due, current.task.label, { quiet: due.length > 1 });
  for (const [index, target] of due.entries()) {
    begin(current);
    void Promise.race([followed[index], work.stop.signal])
      .then((outcome) => {
        if (outcome === null) {
          release(work, target);
          return;
        }
        record(work, target, outcome);
        if (outcome.errorCode === "x_unavailable") {
          work.lane = { ...work.lane, problem: outcome.message ?? null };
        }
      })
      .finally(() => end(current));
  }
}

function addTargets(current: LiveRun, targets: readonly RefreshTarget[]): void {
  // Accounts already in a running lane are not asked for twice.
  const going = new Set(
    [...current.lanes.values()]
      .filter((work) => work.lane.status === "running")
      .flatMap((work) => work.lane.targets.map((target) => target.id)),
  );
  const added = targets.filter((target) => !going.has(target.id));
  const video = added.filter((target) => laneOf(target.platform) === "video");
  const x = added.filter((target) => laneOf(target.platform) === "x");
  if (video.length > 0) addVideo(current, video);
  if (x.length > 0) addX(current, x);
}

function statusOf({ ok, run }: RefreshRunOutcome): BackgroundTask["status"] {
  // `run` is missing only when the task store caught an unexpected throw.
  if (run?.status === "stopped") return "stopped";
  return ok ? "done" : "failed";
}

/**
 * Refreshes `targets` under `task`, each kind of account in its own lane. A
 * run already going under the same key takes the new accounts on, and the
 * caller gets that run's outcome.
 */
export function refreshCreators(
  task: RefreshRunTask,
  targets: readonly RefreshTarget[],
  noun: "creator" | "account" = "creator",
): Promise<RefreshRunOutcome> {
  const running = live.get(task.key);
  if (running) {
    // Held open like a start, so a lane whose new accounts need nothing still closes.
    begin(running);
    addTargets(running, targets);
    end(running);
  }
  return runBackgroundTask(
    { key: task.key, label: task.label, href: task.href },
    async () => {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const current: LiveRun = {
        task,
        startedAt: Date.now(),
        lanes: new Map(),
        outstanding: 0,
        finish: () => finish(),
      };
      live.set(task.key, current);
      // Held open while the lanes start, so an account that settles at once can't end the run early.
      begin(current);
      addTargets(current, targets);
      publish(current);
      end(current);
      await finished;
      live.delete(task.key);

      const stopped = [...current.lanes.values()].some((work) => work.lane.status === "stopped");
      const run = summarize(current, stopped ? "stopped" : "done");
      runs.set(task.key, run);
      notify();

      const plural = (count: number) => `${count} ${count === 1 ? noun : `${noun}s`}`;
      return {
        ok: run.failures.length === 0,
        message: stopped
          ? `Stopped after ${run.done} of ${plural(run.targets.length)}.`
          : run.failures.length
            ? `${plural(run.failures.length)} could not be updated. Retry from the Library.`
            : undefined,
        run,
      };
    },
    statusOf,
  );
}

/** How an X account's settled sync reads as a refresh outcome. */
function outcomeOf(state: SyncCreatorState): RefreshContentOutcome {
  if (state.state === "error" || state.state === "disconnected" || state.state === "paused") {
    const until =
      state.state === "paused" && state.retryAt
        ? ` Try again after ${new Date(state.retryAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}.`
        : "";
    return {
      ok: false,
      errorCode: state.errorCode ?? "invalid_response",
      message: `${state.message ?? "X couldn't be read."}${until}`,
    };
  }
  return {
    ok: true,
    status: "refreshed",
    refreshedAt: state.lastSyncedAt ?? undefined,
    addedTweets: state.newPosts,
  };
}

/**
 * Checks X accounts for new posts through the sync engine — one request for
 * all of them — with a background task per account, like every other
 * account's refresh, that ends when its sync settles.
 *
 * When X can't be read at all, a refresh of many says so once (`quiet`): no
 * account gets a task of its own, so nothing marks each of them as failed
 * for what is one problem with X. A refresh of one account still reports it
 * there, since that is where it was asked for.
 */
export function refreshXAccounts(
  targets: readonly RefreshTarget[],
  label = "Updating creators",
  { quiet = false }: { quiet?: boolean } = {},
): Promise<RefreshContentOutcome>[] {
  if (targets.length === 0) return [];
  const started = startXSync(
    targets.map((target) => target.id),
    label,
  );
  const unavailable = (problem: string): RefreshContentOutcome => ({
    ok: false,
    errorCode: "x_unavailable",
    message: problem,
  });
  const follow = (target: RefreshTarget) =>
    runBackgroundTask(
      { key: creatorTaskKey(target.id), label: "Updating creator", href: `/channels/${target.id}` },
      async (): Promise<RefreshContentOutcome> => {
        const { problem } = await started;
        if (problem) return unavailable(problem);
        return outcomeOf(await whenXSettled(target.id));
      },
      // X being busy stops a refresh without failing it, as everywhere else.
      (result) => (result.ok ? "done" : isTemporaryXError(result.errorCode) ? "stopped" : "failed"),
    );
  return targets.map((target) =>
    quiet
      ? started.then(({ problem }) => (problem ? unavailable(problem) : follow(target)))
      : follow(target),
  );
}
