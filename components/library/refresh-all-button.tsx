"use client";

import { useState } from "react";
import {
  runBackgroundTask,
  updateTask,
  useBackgroundTask,
} from "@/components/background/task-store";
import { RefreshCw } from "lucide-react";

import { refreshCreatorContentAction } from "@/components/background/operations";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { YtDlpSetupNote } from "@/components/ui/yt-dlp-setup-note";
import { useToast } from "@/components/ui/toast";

export interface RefreshAllCreator {
  id: number;
  displayName: string;
}

interface RefreshAllFailure {
  id: number;
  displayName: string;
  message: string;
  errorCode: string | null;
}

interface RefreshAllResult {
  failures: RefreshAllFailure[];
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
}

/**
 * Library-wide "Refresh all" action. Refreshes every saved creator's cached
 * feed sequentially through the same per-creator server action the channel
 * page uses, so the one-refresh-at-a-time guard per creator still applies.
 * Progress is shown in the button; per-creator failures are collected and
 * reported together, leaving the previously cached feeds untouched.
 */
export function RefreshAllButton({ creators, onRefreshed }: RefreshAllButtonProps) {
  const [localPending, setPending] = useState(false);
  const task = useBackgroundTask("refresh-all");
  const pending = localPending || task?.status === "running";
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failure, setFailure] = useState<RefreshAllResult | null>(null);
  const { showToast, toastElement } = useToast();

  const runRefresh = async (
    targets: ReadonlyArray<{ id: number; displayName: string }>,
  ): Promise<void> => {
    if (pending || targets.length === 0) {
      return;
    }
    setPending(true);
    setFailure(null);
    setProgress({ done: 0, total: targets.length });

    let refreshedCount = 0;
    let videoCount = 0;
    let livestreamCount = 0;
    let tweetCount = 0;
    const failures: RefreshAllFailure[] = [];

    await runBackgroundTask(
      { key: "refresh-all", label: "Updating all creators", href: "/" },
      async () => {
        for (const [index, creator] of targets.entries()) {
          updateTask({
            key: "refresh-all",
            label: `Updating creators ${index + 1} of ${targets.length}`,
            href: "/",
            status: "running",
          });
          setProgress({ done: index, total: targets.length });
          const outcome = await refreshCreatorContentAction(creator.id);
          if (outcome.ok) {
            refreshedCount += 1;
            if (outcome.status === "refreshed") {
              videoCount += outcome.addedVideos ?? 0;
              livestreamCount += outcome.addedLivestreams ?? 0;
              tweetCount += outcome.addedTweets ?? 0;
            }
          } else {
            failures.push({
              id: creator.id,
              displayName: creator.displayName,
              message: outcome.message ?? "The feed could not be updated right now.",
              errorCode: outcome.errorCode ?? null,
            });
          }
        }

        return {
          ok: failures.length === 0,
          message: failures.length
            ? `${failures.length} creator updates failed. Retry from the Library.`
            : undefined,
        };
      },
    );
    setProgress(null);
    setPending(false);

    if (refreshedCount > 0) {
      onRefreshed?.();
    }
    if (failures.length === 0) {
      const parts = [
        videoCount > 0 ? `${videoCount} ${videoCount === 1 ? "video" : "videos"}` : null,
        livestreamCount > 0
          ? `${livestreamCount} ${livestreamCount === 1 ? "livestream" : "livestreams"}`
          : null,
        tweetCount > 0 ? `${tweetCount} ${tweetCount === 1 ? "post" : "posts"}` : null,
      ].filter((part): part is string => part !== null);
      showToast(
        `Updated ${refreshedCount} ${refreshedCount === 1 ? "creator" : "creators"}${
          parts.length > 0 ? `: ${parts.join(" · ")}` : ""
        }.`,
        "success",
      );
      return;
    }
    setFailure({ failures, refreshedCount, total: targets.length });
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
                failure.total === 1 ? "creator" : "creators"
              }.`
            : "No feed was updated."
        }
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runRefresh(failure.failures)}
            disabled={pending}
          >
            Try again
          </Button>
        }
      >
        Could not update {names}: {firstMessage}
      </AlertNote>
    )
  ) : null;

  // `contents` lets the button, live region, and failure note participate in
  // the parent toolbar's flex layout: the button lines up with the status
  // text while the note wraps onto its own full-width row.
  return (
    <div className="contents">
      <Button
        variant="outline"
        onClick={() => void runRefresh(creators)}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? (
          <>
            <Spinner />
            {progress
              ? `Refreshing ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
              : task?.label + "…"}
          </>
        ) : (
          <>
            <RefreshCw aria-hidden="true" />
            Refresh all
          </>
        )}
      </Button>

      {/* Announced to screen readers while the requests are in flight. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending && progress
          ? `Refreshing all creators: ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
          : ""}
      </span>

      {failureNote}
      {toastElement}
    </div>
  );
}
