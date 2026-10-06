import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/** The shared spinner glyph; always decorative because the label carries meaning. */
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("size-4 shrink-0 animate-spin motion-reduce:animate-none", className)}
    />
  );
}

interface PendingIndicatorProps {
  /** What is happening, e.g. "Fetching available captions with yt-dlp…". */
  label: string;
  /** Optional quiet hint, e.g. "This can take up to a minute.". */
  hint?: string;
  className?: string;
}

/**
 * The one inline pending treatment: a calm bordered strip with spinner plus
 * sentence. Used everywhere an async action runs so progress wording never
 * drifts between screens.
 */
export function PendingIndicator({ label, hint, className }: PendingIndicatorProps) {
  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <Spinner />
      <span className="min-w-0">{label}</span>
      {hint ? <span className="ml-auto hidden shrink-0 text-xs sm:inline">{hint}</span> : null}
    </p>
  );
}
