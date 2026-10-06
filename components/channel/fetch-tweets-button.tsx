"use client";

import { useBackgroundTask } from "@/components/background/task-store";
import { creatorTaskKey } from "@/components/background/operations";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";

import { refreshCreatorTweetsAction } from "@/components/background/operations";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";

interface FetchTweetsButtonProps {
  creatorId: number;
  creatorName: string;
  hasCachedTweets: boolean;
}

/**
 * The creator header's explicit "Fetch recent tweets" action. User-initiated
 * only; concurrent taps collapse into one provider run, and a failed fetch
 * leaves cached posts untouched.
 */
export function FetchTweetsButton({
  creatorId,
  creatorName,
  hasCachedTweets,
}: FetchTweetsButtonProps) {
  const router = useRouter();
  const [localPending, setPending] = useState(false);
  const task = useBackgroundTask(creatorTaskKey(creatorId));
  const pending = localPending || task?.status === "running";
  const { showToast, toastElement } = useToast();

  const run = async (): Promise<void> => {
    if (pending) {
      return;
    }
    setPending(true);
    const outcome = await refreshCreatorTweetsAction(creatorId, "recent");
    setPending(false);
    if (!outcome.ok) {
      showToast(outcome.message ?? `Could not fetch ${creatorName}'s posts.`, "error");
      return;
    }
    if (outcome.status === "already_in_progress") {
      showToast("A fetch for this account is already running.", "info");
    } else if (outcome.newItemCount && outcome.newItemCount > 0) {
      showToast(
        `Fetched ${outcome.newItemCount} recent ${outcome.newItemCount === 1 ? "post" : "posts"} from ${creatorName}.`,
        "success",
      );
    } else {
      showToast("The recent timeline is already up to date.", "success");
    }
    router.refresh();
  };

  return (
    <div className="contents">
      <Button
        variant={hasCachedTweets ? "outline" : "default"}
        onClick={() => void run()}
        disabled={pending}
        aria-busy={pending}
      >
        {pending ? <Spinner /> : <Download aria-hidden="true" />}
        {pending ? "Fetching…" : "Fetch recent tweets"}
      </Button>
      {toastElement}
    </div>
  );
}
