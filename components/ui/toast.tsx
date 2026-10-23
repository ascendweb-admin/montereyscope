"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle2, Info, TriangleAlert } from "lucide-react";

export type ToastTone = "success" | "error" | "info";

/** A link shown after the message, e.g. "View" for the thing that was just added. */
export interface ToastAction {
  label: string;
  href: string;
}

interface ToastState {
  message: string;
  tone: ToastTone;
  action?: ToastAction;
}

/** A toast with a link stays long enough to reach it. */
const ACTION_MIN_DURATION_MS = 8000;

const TONE_STYLES: Record<ToastTone, string> = {
  success:
    "border-emerald-500/40 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
  error: "border-destructive/40 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100",
  info: "bg-card text-card-foreground",
};

const TONE_ICONS: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: TriangleAlert,
  info: Info,
};

/**
 * Minimal self-dismissing toast for action feedback. Rendered inline by the
 * client component that owns an interaction; no global state needed.
 */
export function useToast(durationMs = 5000) {
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(
      () => setToast(null),
      toast.action ? Math.max(durationMs, ACTION_MIN_DURATION_MS) : durationMs,
    );
    return () => window.clearTimeout(timer);
  }, [toast, durationMs]);

  const showToast = (message: string, tone: ToastTone, action?: ToastAction): void => {
    setToast({ message, tone, action });
  };

  const toastElement = toast ? (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-none fixed inset-x-0 bottom-6 z-50 mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg ${TONE_STYLES[toast.tone]}`}
    >
      {(() => {
        const Icon = TONE_ICONS[toast.tone];
        return <Icon aria-hidden="true" className="size-4 shrink-0" />;
      })()}
      <span>{toast.message}</span>
      {toast.action ? (
        <Link
          href={toast.action.href}
          onClick={() => setToast(null)}
          className="pointer-events-auto shrink-0 rounded font-medium underline underline-offset-4 outline-none hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {toast.action.label}
        </Link>
      ) : null}
    </div>
  ) : null;

  return { showToast, toastElement };
}
