"use client";

import { Info, Sparkles, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ScopeSelectionNote {
  tone: "info" | "danger";
  message: string;
}

export interface ScopeSelectionBarProps {
  /** How many items are currently selected. */
  count: number;
  /** Singular noun for the selected items ("video", "source", "tweet"). */
  noun?: string;
  /** How many of those lack cached content and will be skipped. */
  skippedCount: number;
  /** What the skipped items are missing; defaults to a transcript. */
  skippedLabel?: string;
  onChat: () => void;
  onClear: () => void;
  /** Hydrates missing content for the same selection, when provided. */
  onFetch?: () => void;
  /** Label for the fetch action (e.g. "Fetch selected"). */
  fetchLabel?: string;
  fetchDisabled?: boolean;
  fetchBusy?: boolean;
  /** Opens the shared report options for the same selection, when provided. */
  onReport?: () => void;
  /** Disables the chat/report actions — the selection cannot ground a chat. */
  chatDisabled?: boolean;
  /** Shown while `chatDisabled`, explaining what is missing. */
  disabledHint?: string | null;
  /** One-off status note: validation refusals, skipped lists. */
  note?: ScopeSelectionNote | null;
  className?: string;
}

/**
 * The floating action bar for AI scope selection (stage 5), shared by the
 * channel feed and the AI Research page. Shows the live count plus the
 * primary "Chat about selection" action; the chat side stays honestly
 * disabled while nothing selected can ground a conversation.
 */
export function ScopeSelectionBar({
  count,
  noun = "video",
  skippedCount,
  skippedLabel = "without a transcript",
  onChat,
  onClear,
  onFetch,
  fetchLabel = "Fetch selected",
  fetchDisabled = false,
  fetchBusy = false,
  onReport,
  chatDisabled = false,
  disabledHint = null,
  note = null,
  className,
}: ScopeSelectionBarProps) {
  return (
    <div className={cn("w-fit max-w-full rounded-xl border bg-card p-3 shadow-lg", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-sm font-medium">
          {count === 0
            ? "Nothing selected"
            : `${count} ${count === 1 ? noun : `${noun}s`} selected`}
          {skippedCount > 0 ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · {skippedCount} {skippedLabel} will be skipped
            </span>
          ) : null}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClear} disabled={count === 0}>
            Clear
          </Button>
          {onFetch ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onFetch}
              disabled={fetchDisabled}
              aria-busy={fetchBusy}
            >
              {fetchBusy ? "Fetching…" : fetchLabel}
            </Button>
          ) : null}
          {onReport ? (
            <Button variant="outline" size="sm" onClick={onReport} disabled={chatDisabled}>
              Generate report
            </Button>
          ) : null}
          <Button size="sm" onClick={onChat} disabled={chatDisabled}>
            <Sparkles aria-hidden="true" />
            Chat about selection
          </Button>
        </div>
      </div>
      {note ? (
        <p
          className={cn(
            "mt-2 flex items-start gap-1.5 text-xs",
            note.tone === "danger" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {note.tone === "danger" ? (
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{note.message}</span>
        </p>
      ) : null}
      {chatDisabled && disabledHint ? (
        <p className="mt-2 text-xs text-muted-foreground">{disabledHint}</p>
      ) : null}
    </div>
  );
}
