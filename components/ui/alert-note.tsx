import { CheckCircle2, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type AlertTone = "danger" | "warning" | "success" | "info";

const TONE_STYLES: Record<AlertTone, string> = {
  danger:
    "border-destructive/40 bg-red-50 text-red-900 dark:border-destructive/30 dark:bg-red-950 dark:text-red-100",
  warning:
    "border-amber-500/40 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-950 dark:text-amber-100",
  success:
    "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100",
  info: "border-border bg-muted/40 text-card-foreground",
};

const TONE_ICONS: Record<AlertTone, LucideIcon> = {
  danger: TriangleAlert,
  warning: TriangleAlert,
  success: CheckCircle2,
  info: Info,
};

interface AlertNoteProps {
  tone: AlertTone;
  /** Bold lead-in, e.g. "Showing your saved cache." */
  title?: string;
  children: ReactNode;
  /** Trailing action area (e.g. a Try again button). */
  action?: ReactNode;
  /**
   * Assertive live announcement for genuine failures (role="alert");
   * pass polite for advisory notes (role="status").
   */
  politeness?: "assertive" | "polite" | "off";
  className?: string;
}

/**
 * The one inline notice treatment for operation results. Every tone pairs an
 * icon with the message so state never relies on color alone.
 */
export function AlertNote({
  tone,
  title,
  children,
  action,
  politeness = "assertive",
  className,
}: AlertNoteProps) {
  const Icon = TONE_ICONS[tone];
  const role =
    politeness === "assertive" ? "alert" : politeness === "polite" ? "status" : undefined;
  return (
    <div
      role={role}
      className={cn(
        "flex w-full items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        TONE_STYLES[tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {title ? (
            <>
              <strong>{title}</strong>{" "}
            </>
          ) : null}
          {children}
        </span>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}
