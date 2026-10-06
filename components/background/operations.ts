"use client";

import type { RefreshContentOutcome, RefreshFeedOutcome } from "@/app/actions/feeds";
import type { TranscriptActionResult, TranscriptSelectionInput } from "@/app/actions/transcripts";
import type { XRefreshActionOutcome, XFetchActionOutcome } from "@/app/actions/x";
import { runBackgroundTask } from "./task-store";

async function request<T>(payload: object): Promise<T> {
  const response = await fetch("/api/background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error("Task request failed");
  return response.json() as Promise<T>;
}
export const creatorTaskKey = (id: number) => `creator:${id}`;
export const transcriptTaskKey = (id: string) => `transcript:${id}`;
export function refreshCreatorContentAction(creatorId: number): Promise<RefreshContentOutcome> {
  return runBackgroundTask(
    { key: creatorTaskKey(creatorId), label: "Updating creator", href: `/channels/${creatorId}` },
    () => request({ operation: "content", creatorId }),
  );
}
export function refreshCreatorFeedsAction(creatorId: number): Promise<RefreshFeedOutcome> {
  return runBackgroundTask(
    { key: creatorTaskKey(creatorId), label: "Updating creator", href: `/channels/${creatorId}` },
    () => request({ operation: "feeds", creatorId }),
  );
}
export function getTranscriptAction(
  creatorId: number,
  videoId: string,
  intent: "get" | "refresh" | "select",
  selection?: TranscriptSelectionInput,
): Promise<TranscriptActionResult> {
  return runBackgroundTask(
    {
      key: transcriptTaskKey(videoId),
      label: intent === "refresh" ? "Refreshing transcript" : "Extracting transcript",
      href: `/channels/${creatorId}/videos/${videoId}`,
    },
    () => request({ operation: "transcript", creatorId, videoId, intent, selection }),
  );
}
export function refreshCreatorTweetsAction(
  creatorId: number,
  mode: "recent" | "older" = "recent",
  limit?: number,
): Promise<XRefreshActionOutcome> {
  return runBackgroundTask(
    {
      key: creatorTaskKey(creatorId),
      label: mode === "older" ? "Loading older posts" : "Fetching recent posts",
      href: `/channels/${creatorId}`,
    },
    () => request({ operation: "tweets", creatorId, mode, limit }),
  );
}
export function fetchTweetsAction(
  creatorId: number,
  tweetIds: readonly string[],
): Promise<XFetchActionOutcome> {
  return runBackgroundTask(
    { key: `posts:${creatorId}`, label: "Fetching selected posts", href: `/channels/${creatorId}` },
    async () => {
      const result = await request<XFetchActionOutcome>({
        operation: "selected-tweets",
        creatorId,
        tweetIds,
      });
      if (result.batch?.failedCount)
        return {
          ...result,
          ok: false,
          message: `${result.batch.failedCount} posts could not be fetched. Try again from the creator page.`,
        };
      return result;
    },
  );
}
