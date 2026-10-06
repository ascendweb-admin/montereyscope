"use client";

import { useBackgroundTask } from "@/components/background/task-store";
import { creatorTaskKey } from "@/components/background/operations";

import { useState } from "react";
import { RefreshCw } from "lucide-react";

import { refreshCreatorFeedsAction } from "@/components/background/operations";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { YtDlpSetupNote } from "@/components/ui/yt-dlp-setup-note";
import { useToast } from "@/components/ui/toast";

interface RefreshFeedButtonProps {
  creatorId: number;
  creatorName: string;
  /** True when a cached feed exists — failures then warn about stale data. */
  hasCachedVideos: boolean;
}

/**
 * Manual "Refresh feed" action. User-initiated only — scope never polls
 * YouTube in the background, and the server collapses duplicate clicks into
 * one yt-dlp run. Failure states render inline without touching the cached
 * list:
 * - with cached data: a stale-cache warning (the old feed stays usable);
 * - without cached data: an error note with a Try again action.
 */
export function RefreshFeedButton({
  creatorId,
  creatorName,
  hasCachedVideos,
}: RefreshFeedButtonProps) {
  const [localPending, setPending] = useState(false);
  const task = useBackgroundTask(creatorTaskKey(creatorId));
  const pending = localPending || task?.status === "running";
  const [failure, setFailure] = useState<{ message: string; errorCode: string | null } | null>(
    null,
  );
  const { showToast, toastElement } = useToast();

  const runRefresh = async (): Promise<void> => {
    if (pending) {
      return;
    }
    setPending(true);
    setFailure(null);
    const outcome = await refreshCreatorFeedsAction(creatorId);
    setPending(false);

    if (!outcome.ok) {
      setFailure({
        message: outcome.message ?? "The feed could not be updated right now. Please try again.",
        errorCode: outcome.errorCode ?? null,
      });
      return;
    }
    if (outcome.status === "already_in_progress") {
      showToast("A refresh for this creator is already running.", "info");
      return;
    }
    showToast(
      `Updated ${creatorName}: ${outcome.videoCount ?? 0} videos · ${outcome.livestreamCount ?? 0} livestreams.`,
      "success",
    );
  };

  const failureNote = failure ? (
    failure.errorCode === "ytdlp_missing" ? (
      <YtDlpSetupNote />
    ) : (
      <AlertNote
        tone={hasCachedVideos ? "warning" : "danger"}
        title={hasCachedVideos ? "Showing your saved cache." : undefined}
        action={
          <Button variant="outline" size="sm" onClick={() => void runRefresh()} disabled={pending}>
            Try again
          </Button>
        }
      >
        {failure.message}
      </AlertNote>
    )
  ) : null;

  return (
    <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:items-end">
      <Button onClick={() => void runRefresh()} disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <Spinner />
            Refreshing…
          </>
        ) : (
          <>
            <RefreshCw aria-hidden="true" />
            Refresh feed
          </>
        )}
      </Button>

      {failureNote}

      {/* Announced to screen readers while the request is in flight. */}
      <span role="status" aria-live="polite" className="sr-only">
        {pending ? "Fetching the latest uploads…" : ""}
      </span>

      {toastElement}
    </div>
  );
}
