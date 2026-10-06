"use client";

import { FileText, Loader2 } from "lucide-react";

import {
  REPORT_PROFILE_OPTIONS,
  REPORT_STYLE_OPTIONS,
  useReportOptions,
  type ReportProfileId,
  type ReportStyleId,
} from "@/components/ai/report-options";
import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
 * dialog opens where the user last left it. Radio groups keep native
 * semantics; the cards are just labels.
 */
export function ReportOptionsDialog({
  open,
  onClose,
  onGenerate,
  busy = false,
}: ReportOptionsDialogProps) {
  const [profile, style, setProfile, setStyle] = useReportOptions();

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Generate report"
      description="One self-contained HTML document from this selection's cached sources."
      busy={busy}
    >
      <div className="flex flex-col gap-5">
        <fieldset disabled={busy} className="min-w-0">
          <legend className="text-sm font-medium">How deep should it go?</legend>
          <div className="mt-2 grid gap-2">
            {REPORT_PROFILE_OPTIONS.map((option) => {
              const selected = profile === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none",
                    selected ? "border-primary/60 bg-accent/60" : "border-input hover:bg-accent/40",
                  )}
                >
                  <input
                    type="radio"
                    name="report-profile"
                    value={option.id}
                    checked={selected}
                    onChange={() => setProfile(option.id)}
                    className="mt-1 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{option.label}</span>
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
          <legend className="text-sm font-medium">How should it look?</legend>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {REPORT_STYLE_OPTIONS.map((option) => {
              const selected = style === option.id;
              return (
                <label
                  key={option.id}
                  className={cn(
                    "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 transition-colors outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none",
                    selected ? "border-primary/60 bg-accent/60" : "border-input hover:bg-accent/40",
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
                  <span className="text-sm font-medium">{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.tagline}</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <p className="text-xs text-muted-foreground">
          Reports run one at a time in the background and use your Codex plan&rsquo;s usage. Track
          progress on the Reports page.
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
