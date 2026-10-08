"use client";

import { useEffect, useState } from "react";
import { Check, FileText, Loader2 } from "lucide-react";

import {
  REPORT_PROFILE_OPTIONS,
  REPORT_STYLE_OPTIONS,
  useReportOptions,
  type ReportProfileId,
  type ReportStyleId,
} from "@/components/ai/report-options";
import { ReportStylePreview } from "@/components/ai/report-style-preview";
import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isAiBackendId, type AiBackendId } from "@/lib/ai/backend-id";
import { cn } from "@/lib/utils";

/** Whose usage a report draws on, phrased for the dialog's footnote. */
const USAGE_SOURCE: Record<AiBackendId, string> = {
  codex: "your Codex plan’s usage",
  opencode: "your OpenCode Go usage",
  claude: "your Claude plan’s usage",
};

/**
 * Reads the provider selected in Settings each time the dialog opens, so the
 * footnote follows a change made since the panel mounted. Null while loading
 * or when the read fails; the footnote then stays provider-neutral.
 */
function useActiveBackend(open: boolean): AiBackendId | null {
  const [backend, setBackend] = useState<AiBackendId | null>(null);
  useEffect(() => {
    if (!open) {
      return;
    }
    const abort = new AbortController();
    fetch("/api/settings/ai-backend", { cache: "no-store", signal: abort.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { value?: unknown } | null) => {
        if (!abort.signal.aborted && isAiBackendId(body?.value)) {
          setBackend(body.value);
        }
      })
      .catch(() => {});
    return () => abort.abort();
  }, [open]);
  return backend;
}

/** Three ascending bars showing how far a profile digs (1 = Brief, 3 = Deep). */
function DepthMeter({ level, active }: { level: number; active: boolean }) {
  return (
    <span aria-hidden="true" className="flex items-end gap-0.5">
      {[1, 2, 3].map((step) => (
        <span
          key={step}
          className={cn(
            "w-1 rounded-full transition-colors motion-reduce:transition-none",
            step === 1 ? "h-1.5" : step === 2 ? "h-2.5" : "h-3.5",
            step > level
              ? "bg-muted-foreground/20"
              : active
                ? "bg-primary"
                : "bg-muted-foreground/60",
          )}
        />
      ))}
    </span>
  );
}

interface ReportOptionsDialogProps {
  open: boolean;
  onClose: () => void;
  /** Queues the report with the selected options; the panel owns the request. */
  onGenerate: (profile: ReportProfileId, style: ReportStyleId) => void;
  /** While the queue request is in flight the dialog cannot be dismissed. */
  busy?: boolean;
}

/**
 * The "Generate report" dialog: picks the report's depth profile and visual
 * style, then queues the job. Both selections are remembered across visits
 * (the same localStorage-backed store the chat mode switcher uses), so the
 * dialog opens where the user last left it. Each style card shows a
 * miniature of a report in that style. Radio groups keep native semantics;
 * the cards are just labels.
 */
export function ReportOptionsDialog({
  open,
  onClose,
  onGenerate,
  busy = false,
}: ReportOptionsDialogProps) {
  const [profile, style, setProfile, setStyle] = useReportOptions();
  const backend = useActiveBackend(open);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Generate report"
      description="One self-contained HTML document from this selection's cached sources."
      busy={busy}
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-6">
        <fieldset disabled={busy} className="min-w-0">
          <legend className="text-sm font-medium">How should it look?</legend>
          <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {REPORT_STYLE_OPTIONS.map((option) => {
              const selected = style === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "group flex cursor-pointer flex-col rounded-xl border p-1.5 transition-colors outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none",
                    selected
                      ? "border-primary/70 bg-accent/60"
                      : "border-input hover:border-primary/30 hover:bg-accent/30",
                  )}
                >
                  <input
                    type="radio"
                    name="report-style"
                    value={option.id}
                    checked={selected}
                    onChange={() => setStyle(option.id)}
                    className="sr-only"
                  />
                  <span
                    className={cn(
                      "relative block h-36 overflow-hidden rounded-lg ring-1 ring-foreground/10 transition-transform duration-200 ease-out motion-reduce:transition-none",
                      !selected && "group-hover:-translate-y-0.5",
                    )}
                  >
                    <ReportStylePreview style={option.id} profile={profile} />
                  </span>
                  <span className="px-1.5 pt-2.5 pb-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{option.label}</span>
                      {selected ? (
                        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {option.tagline}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset disabled={busy} className="min-w-0">
          <legend className="text-sm font-medium">How deep should it go?</legend>
          <div className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {REPORT_PROFILE_OPTIONS.map((option, index) => {
              const selected = profile === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer flex-col gap-2 rounded-xl border p-3 transition-colors outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none",
                    selected
                      ? "border-primary/70 bg-accent/60"
                      : "border-input hover:border-primary/30 hover:bg-accent/30",
                  )}
                >
                  <input
                    type="radio"
                    name="report-profile"
                    value={option.id}
                    checked={selected}
                    onChange={() => setProfile(option.id)}
                    className="sr-only"
                  />
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{option.label}</span>
                    <DepthMeter level={index + 1} active={selected} />
                  </span>
                  <span className="text-xs text-muted-foreground">{option.tagline}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <p className="text-xs text-muted-foreground">
          Reports run one at a time in the background and use{" "}
          {backend ? USAGE_SOURCE[backend] : "your AI provider’s usage"}. Track progress on the
          Reports page.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => onGenerate(profile, style)} aria-busy={busy}>
            {busy ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                Queuing…
              </>
            ) : (
              <>
                <FileText aria-hidden="true" />
                Generate report
              </>
            )}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
