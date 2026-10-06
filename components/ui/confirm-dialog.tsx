"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One-sentence stakes summary shown under the title. */
  description?: string;
  /** The detailed explanation of exactly what happens and what is kept. */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive confirms render the red action and focus the safe Cancel. */
  destructive?: boolean;
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
}

/**
 * Confirmation modal for irreversible or destructive actions. The safe
 * Cancel button receives initial focus (first in tab order), the confirm
 * button disables while work runs, and dismissal locks while busy.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  busy = false,
  busyLabel,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Destructive confirms start on the SAFE action. Runs after AppDialog's
  // showModal effect (child effects fire first), so this wins the race
  // against the browser's default first-focusable target.
  useEffect(() => {
    if (!open) {
      return;
    }
    const id = window.setTimeout(() => cancelRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className="max-w-md"
      busy={busy}
    >
      {children ? <div className="flex flex-col gap-4">{children}</div> : null}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button ref={cancelRef} variant="ghost" disabled={busy} onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          variant={destructive ? "destructive" : "default"}
          disabled={busy}
          onClick={onConfirm}
          aria-busy={busy || undefined}
        >
          {busy ? (
            <>
              <Spinner />
              {busyLabel ?? "Working…"}
            </>
          ) : (
            confirmLabel
          )}
        </Button>
      </div>
    </AppDialog>
  );
}
