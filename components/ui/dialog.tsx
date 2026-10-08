"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useId } from "react";

interface AppDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Extra classes on the dialog panel. */
  className?: string;
  /** Extra classes on the body wrapper below the header. */
  bodyClassName?: string;
  /**
   * While busy the dialog cannot be dismissed (Escape, backdrop, close
   * button) so in-flight work is never orphaned mid-confirmation.
   */
  busy?: boolean;
}

/**
 * Lightweight modal built on the native <dialog> element so focus handling,
 * Escape-to-close, and the inert background come free without extra
 * dependencies. Backdrop clicks close the dialog. Focus is restored to the
 * element that opened it, including when the dialog unmounts.
 */
export function AppDialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  bodyClassName,
  busy = false,
}: AppDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Restore focus when the dialog closes — native <dialog> usually does this,
  // but an explicit restore keeps the guarantee if React swaps content or the
  // opener moved between open and close.
  useEffect(() => {
    if (open) {
      return;
    }
    const id = window.setTimeout(() => {
      if (
        openerRef.current &&
        openerRef.current.isConnected &&
        document.activeElement === document.body
      ) {
        openerRef.current.focus();
      }
      openerRef.current = null;
    }, 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Unmount safety net (e.g. a page navigation tears the tree down mid-flow).
  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      if (opener && opener.isConnected && document.activeElement === document.body) {
        opener.focus();
      }
    };
  }, []);

  const requestClose = (): void => {
    if (!busy) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) {
          requestClose();
        }
      }}
      className={cn(
        "fixed m-auto max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg overflow-y-auto overscroll-contain rounded-xl border bg-card p-0 text-card-foreground shadow-lg backdrop:bg-black/50 backdrop:backdrop-blur-sm",
        className,
      )}
    >
      <div className="flex flex-col gap-1 border-b px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-base font-semibold tracking-tight">
            {title}
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={requestClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {description ? (
          <p id={descriptionId} className="text-sm text-balance text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <div className={cn("px-6 py-5", bodyClassName)}>{children}</div>
    </dialog>
  );
}
