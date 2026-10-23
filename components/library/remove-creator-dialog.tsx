"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";

import { removeCreatorAction, removeProfileAction } from "@/app/actions/creators";
import { PLATFORM_LABELS, PlatformLogo, formatHandle } from "@/components/creators/profile-ui";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import type { CreatorPlatform } from "@/lib/creators/repository";

interface RemovableAccount {
  id: number;
  platform: CreatorPlatform;
  handle: string | null;
  displayName: string;
  researchListNames?: string[];
}

interface RemoveProfileDialogProps {
  open: boolean;
  onClose: () => void;
  profileId: number;
  displayName: string;
  accounts: readonly RemovableAccount[];
  /** Receives the confirmation message after a successful removal. */
  onRemoved: (message: string) => void;
  /** Receives the failure message; the dialog closes either way. */
  onError: (message: string) => void;
}

function ResearchListNote({ names }: { names: readonly string[] }) {
  if (names.length === 0) {
    return null;
  }
  return (
    <p className="text-sm text-muted-foreground">
      This also removes membership in these X Research lists: {names.join(", ")}. Cached posts
      shared with other creators and saved chat/report source snapshots are preserved.
    </p>
  );
}

/**
 * Confirms removing a whole person. The copy spells out the real cascade —
 * every linked account goes, with all of its cached content — and lists the
 * accounts so nothing is removed by surprise.
 */
export function RemoveProfileDialog({
  open,
  onClose,
  profileId,
  displayName,
  accounts,
  onRemoved,
  onError,
}: RemoveProfileDialogProps) {
  const [pending, setPending] = useState(false);
  const researchListNames = [
    ...new Set(accounts.flatMap((account) => account.researchListNames ?? [])),
  ];

  const handleRemove = async (): Promise<void> => {
    setPending(true);
    const outcome = await removeProfileAction(profileId);
    setPending(false);
    onClose();
    if (!outcome.ok) {
      onError(outcome.message ?? "The creator could not be removed.");
      return;
    }
    onRemoved(`${displayName} was removed from your library.`);
  };

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
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
        {accounts.length > 1 ? " every linked account," : " their saved account,"} all cached
        videos, livestreams, and posts, and any extracted transcripts. Nothing else in your library
        is affected.
      </p>
      {accounts.length > 1 ? (
        <ul className="flex flex-col gap-1.5 rounded-lg border bg-muted/20 p-3 text-sm">
          {accounts.map((account) => (
            <li key={account.id} className="flex min-w-0 items-center gap-2">
              <PlatformLogo platform={account.platform} className="size-3.5 shrink-0" />
              <span className="truncate">
                {formatHandle(account.handle) ?? account.displayName}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {PLATFORM_LABELS[account.platform]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <ResearchListNote names={researchListNames} />
    </ConfirmDialog>
  );
}

/** Library-card trigger for removing a whole person. */
export function RemoveProfileButton(props: Omit<RemoveProfileDialogProps, "open" | "onClose">) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${props.displayName} from your library`}
        title="Remove creator"
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" />
      </Button>
      <RemoveProfileDialog {...props} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

interface RemoveAccountDialogProps {
  open: boolean;
  onClose: () => void;
  account: RemovableAccount;
  /** The person the account belongs to, for the copy. */
  profileName: string;
  /** How many accounts the person has; removing the only one removes them. */
  accountCount: number;
  onRemoved: (message: string) => void;
  onError: (message: string) => void;
}

/**
 * Confirms removing one platform account from a person. Its cache goes with
 * it; the person and their other accounts stay.
 */
export function RemoveAccountDialog({
  open,
  onClose,
  account,
  profileName,
  accountCount,
  onRemoved,
  onError,
}: RemoveAccountDialogProps) {
  const lastAccount = accountCount <= 1;
  const others = accountCount - 1;
  const [pending, setPending] = useState(false);
  const label = `${formatHandle(account.handle) ?? account.displayName} on ${PLATFORM_LABELS[account.platform]}`;

  const handleRemove = async (): Promise<void> => {
    setPending(true);
    const outcome = await removeCreatorAction(account.id);
    setPending(false);
    onClose();
    if (!outcome.ok) {
      onError(outcome.message ?? "The account could not be removed.");
      return;
    }
    onRemoved(
      lastAccount
        ? `${profileName} was removed from your library.`
        : `Removed ${label} from ${profileName}.`,
    );
  };

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      busy={pending}
      busyLabel="Removing…"
      onConfirm={() => void handleRemove()}
      title={`Remove ${label}?`}
      description="This cannot be undone."
      confirmLabel={lastAccount ? "Remove creator" : "Remove account"}
      cancelLabel="Keep it"
      destructive
    >
      <p className="text-sm text-muted-foreground">
        {lastAccount
          ? `This is ${profileName}'s only account, so ${profileName} leaves your library too. `
          : `${profileName} stays in your library with their other ${others === 1 ? "account" : `${others} accounts`}. `}
        Everything scope cached for this account — videos, livestreams, posts, and transcripts — is
        permanently deleted. You can add it back later, but its cache starts fresh.
      </p>
      <ResearchListNote names={account.researchListNames ?? []} />
    </ConfirmDialog>
  );
}
