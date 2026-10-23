"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  CircleStop,
  ChevronDown,
  Clock3,
  Hourglass,
  Layers3,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

import type { PickerCreator } from "@/components/ai/chat-source-picker";
import {
  laneOf,
  profileRefreshTask,
  refreshCreators,
  refreshXAccounts,
  remainingTargets,
  REFRESH_ALL_TASK,
  stopRefreshRun,
  useRefreshRun,
  alreadyRefreshing,
  targetsInScope,
  type RefreshLane,
  type RefreshLaneId,
  type RefreshRun,
  type RefreshScope,
  type RefreshTarget,
} from "@/components/background/creator-refresh";
import { creatorTaskKey, refreshCreatorContentAction } from "@/components/background/operations";
import { useBackgroundTasks, type BackgroundTask } from "@/components/background/task-store";
import { useXSyncStates } from "@/components/background/x-sync";
import {
  effectiveScope,
  platformsIn,
  refreshLabel,
  RefreshScopeMenu,
} from "@/components/library/refresh-scope-menu";
import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { PLATFORM_LABELS, PLATFORM_SEQUENCE } from "@/lib/creators/labels";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { formatRelativeTime, formatShortAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Refreshing creators from inside a source picker: everyone, one platform,
 * one person, or one of a person's accounts. The work runs through the
 * shared stores — per-account background tasks, the batch runs of
 * components/background/creator-refresh.ts, and the X sync states of
 * x-sync.ts — so the picker shows refreshes started anywhere (the Library's
 * "Refresh all", a creator page, the X Dashboard's own syncing), and closing
 * the dialog never stops one. Everything here is derived from those stores.
 *
 * YouTube and Rumble refresh beside X rather than behind it: X reads are
 * paced by X's rate limit and can wait minutes, which shows as "waiting"
 * with the time X lets them continue, never as a spinner without end.
 */

/** Where an account, or a person across their accounts, stands. */
export type RefreshStatus = "idle" | "queued" | "running" | "waiting" | "done" | "failed";

export interface AccountRefresh {
  account: PickerCreator;
  status: RefreshStatus;
  /** Its last update, the newest anything knows of. */
  updatedAt: string | null;
  /** Waiting on X (or paused by it): when it continues. */
  retryAt: string | null;
  /** Why the last attempt failed. */
  message: string | null;
}

export interface PersonRefresh {
  status: RefreshStatus;
  /** The least recent update across their accounts; null when one has never updated. */
  updatedAt: string | null;
  /** Each account's last update, for the tooltip: "YouTube 2 hours ago · X just now". */
  detail: string;
  /** Why the last attempt failed. */
  message: string | null;
  /** The soonest a waiting account continues. */
  retryAt: string | null;
  /**
   * The platforms that failed when others of the person's accounts did not,
   * so "X" can be named instead of the whole person; empty otherwise.
   */
  failedPlatforms: string[];
  accounts: AccountRefresh[];
}

interface Person {
  name: string;
  accounts: readonly PickerCreator[];
}

const IDLE: PersonRefresh = {
  status: "idle",
  updatedAt: null,
  detail: "",
  message: null,
  retryAt: null,
  failedPlatforms: [],
  accounts: [],
};

/** Most pressing first: a person reads as their busiest account. */
const PRECEDENCE: readonly RefreshStatus[] = [
  "running",
  "waiting",
  "queued",
  "failed",
  "done",
  "idle",
];

function groupPeople(creators: readonly PickerCreator[]): Map<number, Person> {
  const people = new Map<number, Person>();
  for (const creator of creators) {
    const person = people.get(creator.profileId);
    if (person) {
      people.set(creator.profileId, { ...person, accounts: [...person.accounts, creator] });
    } else {
      people.set(creator.profileId, {
        name: creator.displayName ?? "Creator",
        accounts: [creator],
      });
    }
  }
  for (const [id, person] of people) {
    people.set(id, {
      ...person,
      accounts: [...person.accounts].sort(
        (a, b) => PLATFORM_SEQUENCE.indexOf(a.platform) - PLATFORM_SEQUENCE.indexOf(b.platform),
      ),
    });
  }
  return people;
}

function later(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/** When a wait ends: "in 6 min", "in under a minute", "at 14:32" past the hour. */
export function untilLabel(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return "soon";
  const ms = Date.parse(iso) - nowMs;
  if (Number.isNaN(ms) || ms <= 60_000) return "in under a minute";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  return `at ${new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** The current time, ticking while `active`, for waits that grow while nothing else changes. */
function useNow(active: boolean, everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    // At once too: the time kept from before may be long gone.
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, everyMs);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [active, everyMs]);
  return now;
}

function failedResult(task: BackgroundTask | undefined): boolean {
  if (!task) return false;
  if (task.status === "failed") return true;
  // X being busy ends a task "stopped" rather than failed; it still didn't update.
  return task.status === "stopped" && (task.result as { ok?: boolean } | undefined)?.ok === false;
}

export function usePickerRefresh(creators: readonly PickerCreator[]) {
  const tasks = useBackgroundTasks();
  const allRun = useRefreshRun(REFRESH_ALL_TASK.key);
  const people = useMemo(() => groupPeople(creators), [creators]);
  const xIds = useMemo(
    () => creators.filter((creator) => creator.platform === "x").map((creator) => creator.id),
    [creators],
  );
  const xStates = useXSyncStates(xIds);
  const tasksByKey = useMemo(() => new Map(tasks.map((task) => [task.key, task])), [tasks]);
  const liveRun = allRun?.status === "running" ? allRun : null;

  const personOfAccount = useMemo(() => {
    const byAccount = new Map<number, number>();
    for (const [id, person] of people) {
      for (const account of person.accounts) byAccount.set(account.id, id);
    }
    return byAccount;
  }, [people]);

  const accountState = (account: PickerCreator): AccountRefresh => {
    const task = tasksByKey.get(creatorTaskKey(account.id));
    const x = account.platform === "x" ? xStates.get(account.id) : undefined;
    const updatedAt = later(account.lastRefreshedAt, x?.lastSyncedAt);
    const base = { account, updatedAt, retryAt: null, message: null };

    if (x?.state === "waiting") return { ...base, status: "waiting", retryAt: x.retryAt };
    if (x?.state === "syncing" || task?.status === "running") return { ...base, status: "running" };

    const lane = liveRun?.lanes.find((candidate) => candidate.id === laneOf(account.platform));
    const inLane = lane?.targets.some((target) => target.id === account.id) ?? false;
    if (lane && inLane && !lane.settled.includes(account.id)) {
      return { ...base, status: lane.active.includes(account.id) ? "running" : "queued" };
    }

    // A failure stands until something newer has brought the account up to date.
    const overtaken =
      updatedAt !== null && task?.endedAt !== undefined && Date.parse(updatedAt) > task.endedAt;
    if (failedResult(task) && !overtaken) {
      return { ...base, status: "failed", message: task?.message ?? "The update failed." };
    }
    if (x && (x.state === "error" || x.state === "disconnected" || x.state === "paused")) {
      return {
        ...base,
        status: "failed",
        retryAt: x.state === "paused" ? x.retryAt : null,
        message: x.message ?? "X couldn't be read.",
      };
    }
    const failedHere = lane?.failures.some((failure) => failure.id === account.id) ?? false;
    return { ...base, status: inLane && !failedHere ? "done" : "idle" };
  };

  const stateOf = (groupId: number): PersonRefresh => {
    const person = people.get(groupId);
    if (!person) return IDLE;
    const accounts = person.accounts.map(accountState);
    const updates = accounts.map((state) => state.updatedAt);
    const known = updates.filter((value): value is string => value !== null).sort();
    const status =
      PRECEDENCE.find((candidate) => accounts.some((state) => state.status === candidate)) ??
      "idle";
    const failed = accounts.filter((state) => state.status === "failed");
    const waiting = accounts
      .filter((state) => state.status === "waiting" && state.retryAt)
      .map((state) => state.retryAt!)
      .sort();
    return {
      status,
      updatedAt: known.length === updates.length ? (known[0] ?? null) : null,
      detail: accounts
        .map(
          (state) =>
            `${PLATFORM_LABELS[state.account.platform]} ${
              formatRelativeTime(state.updatedAt) ?? "never updated"
            }`,
        )
        .join(" · "),
      message: failed[0]?.message ?? null,
      retryAt: waiting[0] ?? null,
      failedPlatforms:
        failed.length > 0 && failed.length < accounts.length
          ? [...new Set(failed.map((state) => PLATFORM_LABELS[state.account.platform]))]
          : [],
      accounts,
    };
  };

  const targetOf = (account: PickerCreator, person: Person): RefreshTarget => ({
    id: account.id,
    displayName:
      person.accounts.length > 1
        ? `${person.name} (${PLATFORM_LABELS[account.platform]})`
        : person.name,
    platform: account.platform,
    updatedAt: later(account.lastRefreshedAt, xStates.get(account.id)?.lastSyncedAt),
  });

  // Everyone, in the rail's order, so a run moves down the list.
  const everyone = [...people.values()]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .flatMap((person) => person.accounts.map((account) => targetOf(account, person)));

  /** True while every account of the scope is already being refreshed. */
  const scopeBusy = (scope: RefreshScope): boolean =>
    alreadyRefreshing(allRun, targetsInScope(everyone, scope));

  const refreshAccount = (account: PickerCreator): void => {
    const person = people.get(personOfAccount.get(account.id) ?? -1);
    if (!person) return;
    if (account.platform === "x") {
      void refreshXAccounts([targetOf(account, person)], `Updating ${person.name}`);
    } else {
      void refreshCreatorContentAction(account.id);
    }
  };

  const refreshPerson = (groupId: number): void => {
    const person = people.get(groupId);
    if (!person) return;
    if (person.accounts.length === 1) {
      refreshAccount(person.accounts[0]);
    } else {
      void refreshCreators(
        profileRefreshTask(groupId, person.name),
        person.accounts.map((account) => targetOf(account, person)),
        "account",
      );
    }
  };

  /**
   * When an X lane continues, while every account it is still on waits for
   * X's limit; null while it is reading.
   */
  const laneWaitingUntil = (lane: RefreshLane): string | null => {
    if (lane.id !== "x" || lane.active.length === 0) return null;
    const states = lane.active.map((id) => xStates.get(id));
    if (!states.every((state) => state?.state === "waiting")) return null;
    return (
      states
        .map((state) => state?.retryAt ?? null)
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null
    );
  };

  return {
    /** The library-wide run, live or last finished. */
    allRun,
    everyone,
    peopleCount: people.size,
    laneWaitingUntil,
    /** How many people a set of account targets covers. */
    countPeople: (targets: readonly RefreshTarget[]) =>
      new Set(targets.map((target) => personOfAccount.get(target.id) ?? -target.id)).size,
    stateOf,
    scopeBusy,
    refreshAccount,
    refreshPerson,
    refreshScope: (scope: RefreshScope) => {
      void refreshCreators(REFRESH_ALL_TASK, targetsInScope(everyone, scope));
    },
    /** Retries or resumes exactly these accounts. */
    refreshTargets: (targets: readonly RefreshTarget[]) => {
      void refreshCreators(REFRESH_ALL_TASK, targets);
    },
    stop: (laneId?: RefreshLaneId) => stopRefreshRun(REFRESH_ALL_TASK.key, laneId),
  };
}

export type PickerRefresh = ReturnType<typeof usePickerRefresh>;

/**
 * Calls `onUpdated` whenever an account finishes refreshing while the picker
 * is open, wherever the refresh was started, so a host that fetched its
 * library can read it again.
 */
export function useAccountRefreshed(onUpdated: (() => void) | undefined): void {
  const tasks = useBackgroundTasks();
  const seen = useRef(new Map<string, BackgroundTask["status"]>());
  const latest = useRef(onUpdated);
  useEffect(() => {
    latest.current = onUpdated;
  });
  useEffect(() => {
    let updated = false;
    for (const task of tasks) {
      if (!task.key.startsWith("creator:")) continue;
      if (seen.current.get(task.key) === "running" && task.status === "done") updated = true;
      seen.current.set(task.key, task.status);
    }
    if (updated) latest.current?.();
  }, [tasks]);
}

function PlatformGlyph({ platform, className }: { platform: CreatorPlatform; className?: string }) {
  const Logo = platform === "x" ? XLogo : platform === "rumble" ? RumbleLogo : YouTubeLogo;
  return <Logo aria-hidden="true" className={cn("size-3.5 shrink-0", className)} />;
}

/**
 * "Refresh all" — or "Refresh X" while the picker shows only X: the main
 * action follows the platform filter, and the menu beside it offers every
 * platform with how stale it is. Beside the rail's Creators heading, in the
 * small-screen creator strip (without the menu), and as the way out of an
 * empty library.
 */
export function RefreshAllButton({
  refresh,
  scope = "all",
  variant = "ghost",
  label,
  withMenu = false,
  className,
}: {
  refresh: PickerRefresh;
  scope?: RefreshScope;
  variant?: "ghost" | "outline";
  label?: string;
  withMenu?: boolean;
  className?: string;
}) {
  const effective = effectiveScope(refresh.everyone, scope);
  const busy = refresh.scopeBusy(effective);
  const count =
    effective === "all" ? refresh.peopleCount : targetsInScope(refresh.everyone, effective).length;
  const who =
    effective === "all"
      ? count === 1
        ? "your creator"
        : `all ${count} creators`
      : `${count} ${PLATFORM_LABELS[effective]} ${count === 1 ? "account" : "accounts"}`;

  const disabled = busy || refresh.everyone.length === 0;
  const title = busy ? "Already updating…" : `Fetch the newest from ${who}`;
  const content = busy ? (
    <>
      <Spinner className="size-3.5" />
      Updating…
    </>
  ) : (
    <>
      <RefreshCw aria-hidden="true" className="size-3.5" />
      {label ?? refreshLabel(effective)}
    </>
  );

  if (!withMenu || platformsIn(refresh.everyone).length < 2) {
    return (
      <Button
        variant={variant}
        size="sm"
        onClick={() => refresh.refreshScope(effective)}
        disabled={disabled}
        aria-busy={busy}
        title={title}
        className={cn(
          "gap-1.5",
          variant === "ghost" && "h-7 px-2 text-muted-foreground hover:text-foreground",
          className,
        )}
      >
        {content}
      </Button>
    );
  }

  // One control: the action, and beside it the choice of what it covers.
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center rounded-md border bg-card shadow-sm",
        className,
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => refresh.refreshScope(effective)}
        disabled={disabled}
        aria-busy={busy}
        title={title}
        className="h-[26px] gap-1.5 rounded-r-none px-2 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-offset-0"
      >
        {content}
      </Button>
      <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
      <RefreshScopeMenu
        targets={refresh.everyone}
        run={refresh.allRun}
        peopleCount={refresh.peopleCount}
        onRefresh={refresh.refreshScope}
        // Narrow enough to open inside the rail rather than past the dialog's edge.
        menuClassName="w-[14.5rem]"
        triggerClassName="h-[26px] w-6 rounded-l-none px-0 text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-offset-0"
      />
    </div>
  );
}

/**
 * Says when a library-wide run starts and how it ended, once each, rather
 * than every step of its progress.
 */
export function RefreshAnnouncer({ refresh }: { refresh: PickerRefresh }) {
  const run = refresh.allRun;
  let message = "";
  if (run?.status === "running") {
    message = "Updating creators…";
  } else if (run?.status === "stopped") {
    message = "Stopped updating creators.";
  } else if (run?.status === "done") {
    const failed = refresh.countPeople(run.failures);
    message =
      failed === 0
        ? "Every creator is up to date."
        : failed === 1
          ? "1 creator could not be updated."
          : `${failed} creators could not be updated.`;
  }
  return (
    <p role="status" className="sr-only">
      {message}
    </p>
  );
}

function tooltipFor(name: string, state: PersonRefresh, now: number): string {
  switch (state.status) {
    case "running":
      return `Updating ${name}…`;
    case "waiting":
      return `Waiting for X, which limits how often posts can be read. Continues ${untilLabel(state.retryAt, now)}.`;
    case "queued":
      return `${name} is next in line — or refresh now`;
    case "failed":
      return `Couldn't update ${
        state.failedPlatforms.length > 0
          ? `${name} on ${state.failedPlatforms.join(" and ")}`
          : name
      }: ${state.message}\nClick to try again.`;
    default:
      return `Refresh ${name}${state.detail ? `\nLast updated: ${state.detail}` : ""}`;
  }
}

/** One platform of a person as a menu line: where it stands, in a few words. */
function accountStatus(state: AccountRefresh, now: number): string {
  switch (state.status) {
    case "running":
      return "Updating…";
    case "waiting":
      return `Waiting for X · ${untilLabel(state.retryAt, now)}`;
    case "queued":
      return "Queued";
    case "failed":
      return `Couldn’t update: ${state.message}`;
    default: {
      const updated = formatShortAgo(state.updatedAt, now);
      return updated ? `Updated ${updated}` : "Never updated";
    }
  }
}

/**
 * The per-person control in a group header: what happened last, and the
 * button that does it again — "Updated 2h ago", "Updating…", "Waiting for
 * X · in 6 min", "Retry". A person on several platforms gets a menu beside
 * it to refresh one platform alone, each with its own state.
 */
export function PersonRefreshButton({
  name,
  state,
  onRefresh,
  onRefreshAccount,
}: {
  name: string;
  state: PersonRefresh;
  onRefresh: () => void;
  onRefreshAccount?: (account: PickerCreator) => void;
}) {
  const now = useNow(state.status === "waiting");
  const running = state.status === "running";
  const updated = formatShortAgo(state.updatedAt, now);
  const updatedLabel = updated
    ? updated === "just now"
      ? "Updated just now"
      : `Updated ${updated}`
    : "Never updated";
  const failedLabel =
    state.failedPlatforms.length > 0
      ? `${state.failedPlatforms.join(" and ")} didn’t update`
      : "Couldn’t update";
  const waitingLabel = `Waiting for X · ${untilLabel(state.retryAt, now)}`;
  // The visible words stay in the name, so speech control can say what it sees.
  const label =
    state.status === "running"
      ? `Updating ${name}`
      : state.status === "waiting"
        ? `Refresh ${name} (${waitingLabel.toLowerCase()})`
        : state.status === "failed"
          ? `Retry updating ${name} (${failedLabel.toLowerCase()})`
          : state.status === "queued"
            ? `Refresh ${name} now (queued)`
            : `Refresh ${name} (${updatedLabel.toLowerCase()})`;
  const platforms = state.accounts.length > 1 && onRefreshAccount ? state.accounts : null;
  const button = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onRefresh}
      disabled={running}
      aria-busy={running}
      aria-label={label}
      title={tooltipFor(name, state, now)}
      className={cn(
        "gap-1.5 px-2 font-normal text-muted-foreground hover:text-foreground",
        state.status === "failed" && "text-amber-700 hover:text-amber-800 dark:text-amber-400",
        running && "disabled:opacity-100",
        platforms && "rounded-r-none pr-1.5",
      )}
    >
      {running ? (
        <>
          <Spinner className="size-3.5" />
          Updating…
        </>
      ) : state.status === "waiting" ? (
        <>
          <Hourglass aria-hidden="true" className="size-3.5" />
          <span className="hidden sm:inline">{waitingLabel}</span>
        </>
      ) : state.status === "failed" ? (
        <>
          <TriangleAlert aria-hidden="true" className="size-3.5" />
          {failedLabel} · Retry
        </>
      ) : state.status === "queued" ? (
        <>
          <Clock3 aria-hidden="true" className="size-3.5" />
          Queued
        </>
      ) : (
        <>
          <RefreshCw aria-hidden="true" className="size-3.5" />
          <span className="hidden sm:inline">{updatedLabel}</span>
        </>
      )}
    </Button>
  );
  if (!platforms) return button;
  return (
    <div className="flex items-center">
      {button}
      <ActionMenu
        label={`Refresh one of ${name}'s platforms`}
        variant="ghost"
        size="sm"
        icon={<ChevronDown aria-hidden="true" className="size-3.5" />}
        triggerClassName="w-6 rounded-l-none px-0 text-muted-foreground shadow-none hover:text-foreground"
        items={[
          {
            id: "all",
            label: "All platforms",
            icon: <Layers3 />,
            hint: running ? "Updating…" : updatedLabel,
            disabled: running,
            onSelect: onRefresh,
          },
          ...platforms.map((account, index) => ({
            id: String(account.account.id),
            label: PLATFORM_LABELS[account.account.platform],
            icon: <PlatformGlyph platform={account.account.platform} className="size-4" />,
            hint: accountStatus(account, now),
            disabled: account.status === "running",
            separated: index === 0,
            onSelect: () => onRefreshAccount?.(account.account),
          })),
        ]}
      />
    </div>
  );
}

/**
 * The rail's per-person refresh. With something to say (updating, waiting on
 * X, queued, done in this run, failed) it holds a slot at the row's end, and
 * the mark turns into a refresh button under the pointer or focus. With
 * nothing to say it takes no room at all: the button floats over the row's
 * end only while the row is pointed at or focused, so names and counts keep
 * their full width.
 */
export function RailRefreshSlot({
  name,
  state,
  onRefresh,
}: {
  name: string;
  state: PersonRefresh;
  onRefresh: () => void;
}) {
  const now = useNow(state.status === "waiting");
  if (state.status === "running") {
    return (
      <span
        className="mr-1 flex size-7 shrink-0 items-center justify-center text-primary"
        title={`Updating ${name}…`}
      >
        <Spinner className="size-3.5" />
        <span className="sr-only">Updating {name}</span>
      </span>
    );
  }
  const mark =
    state.status === "failed" ? (
      <TriangleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />
    ) : state.status === "waiting" ? (
      <Hourglass className="size-3.5 text-muted-foreground" />
    ) : state.status === "queued" ? (
      <Clock3 className="size-3.5 text-muted-foreground/60" />
    ) : state.status === "done" ? (
      <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
    ) : null;
  const refreshButton = (className: string) => (
    <button
      type="button"
      onClick={onRefresh}
      aria-label={state.status === "failed" ? `Retry updating ${name}` : `Refresh ${name}`}
      title={tooltipFor(name, state, now)}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-[opacity,color,background-color] group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        className,
      )}
    >
      <RefreshCw aria-hidden="true" className="size-3.5" />
    </button>
  );
  if (!mark) {
    // Where nothing hovers, the group header's refresh stands in.
    return refreshButton("absolute top-1/2 right-1.5 -translate-y-1/2 border bg-card shadow-sm");
  }
  return (
    <span className="relative mr-1 flex size-7 shrink-0 items-center justify-center">
      {mark ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0 motion-reduce:transition-none"
        >
          {mark}
        </span>
      ) : null}
      {/* Tapping the mark refreshes too, where nothing hovers. */}
      {refreshButton("relative hover:bg-background/80")}
    </span>
  );
}

/** "YouTube & Rumble", "YouTube", "X": the platforms a lane is refreshing. */
function laneName(lane: RefreshLane): string {
  if (lane.id === "x") return "X";
  const present = new Set(lane.targets.map((target) => target.platform));
  const names = (["youtube", "rumble"] as const)
    .filter((platform) => present.has(platform))
    .map((platform) => PLATFORM_LABELS[platform]);
  return names.join(" & ") || "Videos";
}

function LaneGlyphs({ lane }: { lane: RefreshLane }) {
  const present = new Set(lane.targets.map((target) => target.platform));
  return (
    <span className="flex shrink-0 items-center gap-1">
      {PLATFORM_SEQUENCE.filter((platform) => present.has(platform)).map((platform) => (
        <PlatformGlyph key={platform} platform={platform} className="size-3" />
      ))}
    </span>
  );
}

/** "Bijan Bowen, Bob Loukas and 3 more". */
function listNames(names: readonly string[], shown = 3): string {
  return (
    names.slice(0, shown).join(", ") +
    (names.length > shown ? ` and ${names.length - shown} more` : "")
  );
}

/** One lane of a run: progress while it goes, then what came of it, with its own action. */
function LaneRow({
  lane,
  run,
  now,
  newCount,
  waitingUntil,
  canStop,
  onStop,
  onRetry,
}: {
  lane: RefreshLane;
  run: RefreshRun;
  now: number;
  newCount: number;
  /** X lane: when X's limit lets it continue, while it waits on nothing else. */
  waitingUntil: string | null;
  canStop: boolean;
  onStop: () => void;
  onRetry: (targets: readonly RefreshTarget[]) => void;
}) {
  const total = lane.targets.length;
  const settled = lane.settled.length;
  const updated = settled - lane.failures.length;
  const nameOf = (id: number) => lane.targets.find((target) => target.id === id)?.displayName;
  const newNote =
    newCount > 0 ? (
      <span className="text-emerald-700 dark:text-emerald-400"> · {newCount} new</span>
    ) : null;

  let icon: React.ReactNode;
  let text: React.ReactNode;
  let action: React.ReactNode = null;
  if (lane.status === "running") {
    icon =
      waitingUntil !== null ? (
        <Hourglass className="size-3.5 text-muted-foreground" />
      ) : (
        <Spinner className="size-3.5 text-primary" />
      );
    text = (
      <>
        <span className="tabular-nums">
          {settled} of {total}
        </span>
        {newNote}
        <span className="text-muted-foreground">
          {waitingUntil !== null
            ? ` · waiting for X’s limit, continues ${untilLabel(waitingUntil, now)}`
            : lane.id === "video" && lane.active.length > 0
              ? ` · ${listNames(
                  lane.active.map(nameOf).filter((name): name is string => !!name),
                  2,
                )}`
              : lane.id === "x"
                ? " · checking for new posts"
                : ""}
        </span>
      </>
    );
    action = canStop ? (
      <Button variant="ghost" size="sm" onClick={onStop} className="h-7 shrink-0 px-2">
        <CircleStop aria-hidden="true" className="size-3.5" />
        Stop
      </Button>
    ) : null;
  } else if (lane.problem) {
    icon = <TriangleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />;
    text = <span>{lane.problem}</span>;
  } else if (lane.status === "stopped") {
    icon = <CircleStop className="size-3.5 text-muted-foreground" />;
    text = (
      <>
        Stopped — {updated} of {total} updated{newNote}
      </>
    );
    action = (
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRetry(remainingTargets(run, lane.id))}
        className="h-7 shrink-0 px-2.5"
      >
        <RefreshCw aria-hidden="true" className="size-3.5" />
        Resume
      </Button>
    );
  } else if (lane.failures.length > 0) {
    icon = <TriangleAlert className="size-3.5 text-amber-600 dark:text-amber-400" />;
    text = (
      <>
        {updated} of {total} updated{newNote}
        <span className="text-muted-foreground" title={lane.failures[0].message}>
          {" "}
          · Couldn’t update {listNames(lane.failures.map((failure) => failure.displayName))}:{" "}
          {lane.failures[0].message}
        </span>
      </>
    );
    action = (
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRetry(lane.failures)}
        className="h-7 shrink-0 px-2.5"
      >
        <RefreshCw aria-hidden="true" className="size-3.5" />
        Try again
      </Button>
    );
  } else {
    icon = <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />;
    text = (
      <>
        {total === 1 ? "Updated" : `All ${total} updated`}
        {newNote}
        {lane.skipped.length > 0 ? (
          <span className="text-muted-foreground">
            {" "}
            · {lane.skipped.length} checked moments ago
          </span>
        ) : null}
      </>
    );
  }

  return (
    <li aria-label={laneName(lane)} className="flex min-h-8 items-center gap-3">
      <span className="flex w-36 shrink-0 items-center gap-2 text-xs font-medium">
        <LaneGlyphs lane={lane} />
        <span className="truncate">{laneName(lane)}</span>
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        {lane.status === "running" ? (
          <span
            role="progressbar"
            aria-label={`Updating ${laneName(lane)}`}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={settled}
            className="hidden h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
          >
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
              // A sliver up front so the bar reads as started.
              style={{ width: `${Math.max(4, (settled / Math.max(1, total)) * 100)}%` }}
            />
          </span>
        ) : null}
        <span className="min-w-0 truncate text-xs">{text}</span>
      </span>
      {action}
    </li>
  );
}

/**
 * The library-wide run across the top of the source grid, a row per lane:
 * YouTube and Rumble move on while X waits for its limit, each with its own
 * Stop. Then what came of it — new sources to look at, the accounts that
 * failed with a retry, or where a stopped lane can resume. Runs that ended
 * before the picker opened are not news and stay hidden.
 */
export function RefreshRunBanner({
  refresh,
  openedAt,
  newByLane,
  showingNew,
  onShowNew,
  dismissedAt,
  onDismiss,
}: {
  refresh: PickerRefresh;
  /** When the picker opened; earlier results are already in the data. */
  openedAt: number;
  /** Sources that arrived since the picker opened, per lane. */
  newByLane: Readonly<Record<RefreshLaneId, number>>;
  showingNew: boolean;
  onShowNew: () => void;
  /** The start of the run the user dismissed. */
  dismissedAt: number | null;
  onDismiss: (run: RefreshRun) => void;
}) {
  const run = refresh.allRun;
  const running = run?.status === "running";
  const now = useNow(running);
  if (!run) return null;
  if (!running && ((run.finishedAt ?? 0) < openedAt || dismissedAt === run.startedAt)) {
    return null;
  }

  const newCount = newByLane.video + newByLane.x;
  const people = refresh.countPeople(run.targets);
  const failedPeople = refresh.countPeople(run.failures);
  const runningLanes = run.lanes.filter((lane) => lane.status === "running").length;
  const allClear =
    !running && run.failures.length === 0 && run.lanes.every((lane) => lane.status === "done");

  const showNew =
    newCount > 0 && !showingNew ? (
      <Button variant="outline" size="sm" onClick={onShowNew} className="h-7 shrink-0 gap-1 px-2.5">
        Show new
        <ArrowRight aria-hidden="true" className="size-3.5" />
      </Button>
    ) : null;
  const dismiss = running ? null : (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => onDismiss(run)}
      aria-label="Dismiss"
      title="Dismiss"
      className="size-7 shrink-0 text-muted-foreground"
    >
      <X aria-hidden="true" />
    </Button>
  );
  const newNote =
    newCount > 0 ? (
      <span className="font-normal text-emerald-700 dark:text-emerald-400">
        {" "}
        · {newCount} new {newCount === 1 ? "source" : "sources"}
      </span>
    ) : null;

  // A lane that couldn't run at all (X not connected) is one problem, not
  // a failure per creator: the headline says what did update.
  const blocked = run.lanes.filter((lane) => lane.problem);
  const clean = run.lanes.filter(
    (lane) => !lane.problem && lane.status === "done" && lane.failures.length === 0,
  );
  const title = running
    ? "Updating creators"
    : allClear
      ? people > 1 && people === refresh.peopleCount
        ? `All ${people} creators updated`
        : `Updated ${people} ${people === 1 ? "creator" : "creators"}`
      : blocked.length > 0 && blocked.length + clean.length === run.lanes.length
        ? clean.length > 0
          ? `${clean.map(laneName).join(" and ")} updated`
          : `${blocked.map(laneName).join(" and ")} couldn’t be updated`
        : run.status === "stopped"
          ? `Stopped — ${people - refresh.countPeople(remainingTargets(run)) - failedPeople} of ${people} updated`
          : failedPeople >= people
            ? "No creator could be updated"
            : `Updated ${people - failedPeople} of ${people} creators`;
  const icon = running ? (
    <Spinner className="text-primary" />
  ) : allClear ? (
    <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />
  ) : run.status === "stopped" && run.failures.length === 0 ? (
    <CircleStop aria-hidden="true" className="size-4 text-muted-foreground" />
  ) : (
    <TriangleAlert aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
  );

  return (
    <div
      className={cn(
        "border-b px-5 py-2.5",
        allClear ? "bg-emerald-500/5" : running ? "bg-muted/30" : "bg-amber-500/5",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex size-4 shrink-0 items-center justify-center">{icon}</span>
        <p className="min-w-0 flex-1 text-sm font-medium">
          {title}
          {newNote}
        </p>
        {showNew}
        {dismiss}
      </div>
      {/* All clear needs no breakdown; otherwise each lane says where it stands. */}
      {allClear ? null : (
        <ul className="mt-1.5 space-y-0.5 pl-7">
          {run.lanes.map((lane) => (
            <LaneRow
              key={lane.id}
              lane={lane}
              run={run}
              now={now}
              newCount={newByLane[lane.id]}
              waitingUntil={refresh.laneWaitingUntil(lane)}
              canStop={runningLanes > 0}
              onStop={() => refresh.stop(lane.id)}
              onRetry={refresh.refreshTargets}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
