import { Clock, TriangleAlert } from "lucide-react";

import { reportStyleSwatch } from "@/components/ai/report-style-preview";
import type { ReportStyleId } from "@/components/ai/report-options";
import type { ReportStatus } from "@/components/reports/model";
import { Spinner } from "@/components/ui/pending";
import { cn } from "@/lib/utils";

/**
 * A thumbnail-sized page in the report's own style: its paper, accent, and
 * ink, with the headline and body abstracted to bars. Gives every row in the
 * list a recognizable cover without loading the document. A corner badge
 * marks reports that are not finished. Decorative — the row's text carries
 * the meaning.
 */
export function ReportCover({
  style,
  status,
  className,
}: {
  style: string;
  status: ReportStatus;
  className?: string;
}) {
  const swatch = reportStyleSwatch(style as ReportStyleId);
  const pending = status === "queued" || status === "running";
  return (
    <span aria-hidden="true" className={cn("relative block h-12 w-9 shrink-0", className)}>
      <span
        className={cn(
          "flex size-full flex-col gap-[3px] overflow-hidden rounded-[5px] p-[5px] shadow-sm ring-1 ring-foreground/10",
          status === "failed" && "opacity-60 grayscale",
        )}
        style={{ background: swatch.page }}
      >
        <span className="block h-[2px] w-2.5 rounded-full" style={{ background: swatch.accent }} />
        <span
          className={cn("mt-px block h-[3px] w-full rounded-full", pending && "animate-pulse")}
          style={{ background: swatch.ink, opacity: 0.85 }}
        />
        <span
          className={cn("block h-[3px] w-3/4 rounded-full", pending && "animate-pulse")}
          style={{ background: swatch.ink, opacity: 0.85 }}
        />
        <span className="mt-0.5 block h-px w-full" style={{ background: swatch.rule }} />
        {pending ? null : (
          <>
            <span
              className="block h-[2px] w-full rounded-full"
              style={{ background: swatch.ink, opacity: 0.25 }}
            />
            <span
              className="block h-[2px] w-full rounded-full"
              style={{ background: swatch.ink, opacity: 0.25 }}
            />
            <span
              className="block h-[2px] w-2/3 rounded-full"
              style={{ background: swatch.ink, opacity: 0.25 }}
            />
          </>
        )}
      </span>
      {status === "done" ? null : (
        <span
          className={cn(
            "absolute -right-1.5 -bottom-1.5 flex size-[18px] items-center justify-center rounded-full ring-2 ring-card",
            status === "failed"
              ? "bg-destructive text-white"
              : "bg-background text-foreground shadow-sm",
          )}
        >
          {status === "running" ? <Spinner className="size-3" /> : null}
          {status === "queued" ? <Clock className="size-3 text-muted-foreground" /> : null}
          {status === "failed" ? <TriangleAlert className="size-2.5" /> : null}
        </span>
      )}
    </span>
  );
}
