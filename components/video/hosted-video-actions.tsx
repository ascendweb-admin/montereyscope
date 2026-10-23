"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ListMinus, UserPlus } from "lucide-react";

import { followCreatorAction } from "@/app/actions/creators";
import { removeVideosAction } from "@/app/actions/videos";
import { refreshCreatorContentAction } from "@/components/background/operations";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/pending";
import { useToast } from "@/components/ui/toast";

interface HostedVideoActionsProps {
  videoId: string;
  /** The channel the video is cached under. */
  host: { id: number; displayName: string; followed: boolean };
  /** The person whose Other videos hold it, or null when none is known. */
  person: { id: number; displayName: string; otherVideoCount: number } | null;
}

/**
 * What a hand-picked video's page offers about its channel: **Follow {host}**
 * (the channel joins the library and its feed fills in) and **Remove from
 * {person}**. Both only make sense while the channel is a source-only host, so
 * a followed channel's page shows neither. The component stays mounted either
 * way, so the toast after following survives the refresh that follows it.
 */
export function HostedVideoActions({ videoId, host, person }: HostedVideoActionsProps) {
  const router = useRouter();
  const { showToast, toastElement } = useToast();
  const [following, setFollowing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const follow = async (): Promise<void> => {
    if (following) {
      return;
    }
    setFollowing(true);
    const outcome = await followCreatorAction(host.id).catch(() => ({
      ok: false as const,
      message: "The channel could not be followed. Please try again.",
    }));
    setFollowing(false);
    if (!outcome.ok) {
      showToast(outcome.message, "error");
      return;
    }
    // The channel only has this video so far; fill its feed in the background.
    void refreshCreatorContentAction(outcome.creator.id);
    showToast(
      `Following ${outcome.creator.displayName}. Its feed is updating in the background.`,
      "success",
      { label: "View", href: `/creators/${outcome.creator.profileId}` },
    );
    router.refresh();
  };

  const closeRemoveDialog = (): void => {
    setConfirmingRemove(false);
    setRemoveError(null);
  };

  const remove = async (): Promise<void> => {
    if (person === null || removing) {
      return;
    }
    setRemoving(true);
    setRemoveError(null);
    const outcome = await removeVideosAction(person.id, [videoId]).catch(() => ({
      ok: false as const,
      message: "The video could not be removed. Please try again.",
    }));
    if (!outcome.ok) {
      setRemoveError(outcome.message);
      setRemoving(false);
      return;
    }
    // The Other videos tab disappears with its last video, and this page with
    // the video itself, so land on the person's page with the confirmation.
    const params = new URLSearchParams();
    if (person.otherVideoCount > 1) {
      params.set("view", "other");
    }
    params.set(
      "notice",
      outcome.removed === 0
        ? "That video was already removed."
        : `Removed the video from ${person.displayName}'s Other videos.`,
    );
    router.replace(`/creators/${person.id}?${params}`);
  };

  return (
    <>
      {host.followed ? null : (
        <>
          <Button variant="outline" disabled={following} onClick={() => void follow()}>
            {following ? <Spinner /> : <UserPlus aria-hidden="true" />}
            {following ? "Following…" : `Follow ${host.displayName}`}
          </Button>
          {person ? (
            <Button variant="outline" onClick={() => setConfirmingRemove(true)}>
              <ListMinus aria-hidden="true" />
              Remove from {person.displayName}
            </Button>
          ) : null}
        </>
      )}

      {person ? (
        <ConfirmDialog
          open={confirmingRemove}
          onClose={closeRemoveDialog}
          title={`Remove this video from ${person.displayName}'s Other videos?`}
          description="Its transcript is deleted if nothing else uses it, and so is its channel if it has no other videos here."
          confirmLabel="Remove"
          busyLabel="Removing…"
          destructive
          busy={removing}
          onConfirm={() => void remove()}
        >
          {removeError ? <AlertNote tone="danger">{removeError}</AlertNote> : null}
        </ConfirmDialog>
      ) : null}
      {toastElement}
    </>
  );
}
