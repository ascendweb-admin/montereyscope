"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { removeCreatorAction } from "@/app/actions/creators";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";

interface RemoveCreatorButtonProps {
  creatorId: number;
  displayName: string;
  researchListNames?: string[];
}

/**
 * Per-card removal trigger with an explicit confirmation step. The copy
 * spells out the real cascade: cached feed entries and transcripts for this
 * creator are deleted together with it, while nothing outside this
 * creator's scope is touched.
 */
export function RemoveCreatorButton({
  creatorId,
  displayName,
  researchListNames = [],
}: RemoveCreatorButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const { showToast, toastElement } = useToast();

  const handleRemove = async (): Promise<void> => {
    setPending(true);
    const outcome = await removeCreatorAction(creatorId);
    setPending(false);
    setOpen(false);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The creator could not be removed.", "error");
      return;
    }
    showToast(`${displayName} was removed from your library.`, "success");
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${displayName} from your library`}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" />
      </Button>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={pending}
        busyLabel="Removing…"
        onConfirm={() => void handleRemove()}
        title={`Remove ${displayName}?`}
        description="This cannot be undone."
        confirmLabel="Remove creator"
        cancelLabel="Keep creator"
        destructive
      >
        <p className="text-sm text-muted-foreground">
          Removing this creator also permanently deletes everything scope has cached for them —
          their saved channel entry, all cached video and livestream entries, and any extracted
          transcripts. Nothing else in your library is affected. You can add the channel back later,
          but its cache starts fresh.
        </p>
        {researchListNames.length > 0 && (
          <p className="text-sm text-muted-foreground">
            This also removes membership in these X Research lists: {researchListNames.join(", ")}.
            Cached posts shared with other creators and saved chat/report source snapshots are
            preserved.
          </p>
        )}
      </ConfirmDialog>

      {toastElement}
    </>
  );
}
