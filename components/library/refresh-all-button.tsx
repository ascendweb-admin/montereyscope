"use client";

import { useRef, useState } from "react";
import { RefreshCw } from "lucide-react";

import {
  alreadyRefreshing,
  refreshCreators,
  REFRESH_ALL_TASK,
  targetsInScope,
  useRefreshRun,
  type RefreshFailure,
  type RefreshRunTask,
  type RefreshScope,
  type RefreshTarget,
} from "@/components/background/creator-refresh";
import {
  effectiveScope,
  platformsIn,
  refreshLabel,
  RefreshScopeMenu,
} from "@/components/library/refresh-scope-menu";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { YtDlpSetupNote } from "@/components/ui/yt-dlp-setup-note";
import { useToast } from "@/components/ui/toast";

export type RefreshAllCreator = RefreshTarget;

interface RefreshAllResult {
  failures: readonly RefreshFailure[];
  refreshedCount: number;
  total: number;
}

interface RefreshAllButtonProps {
  creators: readonly RefreshAllCreator[];
  /**
   * Called after the run when at least one creator refreshed, so host pages
   * (e.g. the feed) can re-render their server data.
   */
  onRefreshed?: () => void;
  /**
   * Background-task identity. The library-wide run uses the defaults; a
   * creator page refreshing one person's accounts passes its own so the two
   * never read as the same job.
   */
  task?: RefreshAllTask;
  /** Noun for progress and results: "creator" library-wide, "account" on a creator page. */
  noun?: "creator" | "account";
  /**
   * Offers a menu beside the button to refresh one platform alone, and lets
   * the button follow the platform in view (`scope`): "Refresh X".
   */
  platformMenu?: boolean;
  /** The platform filter the button follows when `platformMenu` is on. */
  scope?: RefreshScope;
  /** How many people the accounts belong to, for the menu's "13 creators". */
  peopleCount?: number;
}

export type RefreshAllTask = RefreshRunTask;

/**
 * Library-wide "Refresh all" action. Refreshes every saved creator's cached
 * feed sequentially through the same per-creator server action the channel
 * page uses, so the one-refresh-at-a-time guard per creator still applies.
 * The run lives in the shared refresh store (components/background/
 * creator-refresh.ts), so a run started from a source picker shows its
 * progress here too. Progress is shown in the button; per-creator failures
 * are collected and reported together, leaving the previously cached feeds
 * untouched.
 *
 * With `platformMenu` it is the same split control as the source pickers'
 * "Refresh all": the menu refreshes one platform alone, and a platform asked
 * for while another refreshes joins that run instead of waiting for it.
 */
export function RefreshAllButton({
  creators,
  onRefreshed,
  task: taskIdentity = REFRESH_ALL_TASK,
  noun = "creator",
  platformMenu = false,
  scope = "all",
  peopleCount,
}: RefreshAllButtonProps) {
  const run = useRefreshRun(taskIdentity.key);
  const effective = platformMenu ? effectiveScope(creators, scope) : "all";
  const inScope = targetsInScope(creators, effective);
  // The button is where the Library sees a run's progress, whatever it
  // covers; more platforms join it from the menu.
  const pending = run?.status === "running";
  const progress = run?.status === "running" ? { done: run.done, total: run.targets.length } : null;
  const [failure, setFailure] = useState<RefreshAllResult | null>(null);
  const { showToast, toastElement } = useToast();
  // A run asked for more while this button already waits on it reports once.
  const awaiting = useRef(false);

  const runRefresh = async (targets: readonly RefreshTarget[]): Promise<void> => {
    if (targets.length === 0 || alreadyRefreshing(run, targets)) {
      return;
    }
    setFailure(null);
    const outcome = refreshCreators(taskIdentity, targets, noun);
    if (awaiting.current) {
      return;
    }
    awaiting.current = true;
    const { run: finished } = await outcome.finally(() => {
      awaiting.current = false;
    });
    if (!finished) {
      return;
    }

    if (finished.refreshedCount > 0) {
      onRefreshed?.();
    }
    if (finished.status === "stopped") {
      showToast(
        `Stopped after ${finished.done} of ${finished.targets.length} ${
          finished.targets.length === 1 ? noun : `${noun}s`
        }.`,
        "info",
      );
      return;
    }
    if (finished.failures.length === 0) {
      const { refreshedCount, videoCount, livestreamCount, tweetCount } = finished;
      const parts = [
        videoCount > 0 ? `${videoCount} ${videoCount === 1 ? "video" : "videos"}` : null,
        livestreamCount > 0
          ? `${livestreamCount} ${livestreamCount === 1 ? "livestream" : "livestreams"}`
          : null,
        tweetCount > 0 ? `${tweetCount} ${tweetCount === 1 ? "post" : "posts"}` : null,
      ].filter((part): part is string => part !== null);
      showToast(
        `Updated ${refreshedCount} ${refreshedCount === 1 ? noun : `${noun}s`}${
          parts.length > 0 ? `: ${parts.join(" · ")}` : ""
        }.`,
        "success",
      );
      return;
    }
    setFailure({
      failures: finished.failures,
      refreshedCount: finished.refreshedCount,
      total: finished.targets.length,
    });
  };

  const names = failure ? failure.failures.map((failed) => failed.displayName).join(", ") : "";
  const firstMessage = failure ? failure.failures[0].message : "";
  const allYtdlpMissing =
    failure !== null && failure.failures.every((failed) => failed.errorCode === "ytdlp_missing");

  const failureNote = failure ? (
    allYtdlpMissing ? (
      <YtDlpSetupNote />
    ) : (
      <AlertNote
        tone="warning"
        politeness="polite"
        title={
          failure.refreshedCount > 0
            ? `Refreshed ${failure.refreshedCount} of ${failure.total} ${
                failure.total === 1 ? noun : `${noun}s`
              }.`
            : "No feed was updated."
        }
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runRefresh(failure.failures)}
            disabled={alreadyRefreshing(run, failure.failures)}
          >
            Try again
          </Button>
        }
      >
        Could not update {names}: {firstMessage}
      </AlertNote>
    )
  ) : null;

  const content = pending ? (
    <>
      <Spinner />
      {progress
        ? `Refreshing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
        : "Refreshing…"}
    </>
  ) : (
    <>
      <RefreshCw aria-hidden="true" />
      {refreshLabel(effective)}
    </>
  );
  const withMenu = platformMenu && platformsIn(creators).length > 1;

  // `contents` lets the button, live region, and failure note participate in
  // the parent toolbar's flex layout: the button lines up with the status
  // text while the note wraps onto its own full-width row.
  return (
    <div className="contents">
      {withMenu ? (
        // One control: the action, and beside it the choice of what it covers.
        <div className="flex h-9 shrink-0 items-center rounded-md border border-input shadow-sm">
          <Button
            variant="ghost"
            onClick={() => void runRefresh(inScope)}
            disabled={pending}
            aria-busy={pending}
            className="h-[34px] rounded-r-none pr-3 focus-visible:ring-offset-0"
          >
            {content}
          </Button>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
          <RefreshScopeMenu
            targets={creators}
            run={run}
            peopleCount={peopleCount}
            onRefresh={(choice) => void runRefresh(targetsInScope(creators, choice))}
            triggerClassName="h-[34px] w-8 rounded-l-none px-0 shadow-none focus-visible:ring-offset-0"
          />
        </div>
      ) : (
        <Button
          variant="outline"
          onClick={() => void runRefresh(inScope)}
          disabled={pending}
          aria-busy={pending}
        >
          {content}
        </Button>
      )}

      {/* Announced to screen readers while the requests are in flight. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending && progress
          ? `Refreshing all ${noun}s: ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : ""}
      </span>

      {failureNote}
      {toastElement}
    </div>
  );
}
