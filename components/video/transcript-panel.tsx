"use client";

import { useRef, useState } from "react";
import { Check, ClipboardCheck, ClipboardCopy, ExternalLink, FileText } from "lucide-react";

import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/format";

export interface TranscriptPanelTranscript {
  text: string;
  language: string;
  captionSource: "manual" | "automatic";
  fetchedAt: string;
}

interface TranscriptPanelProps {
  videoUrl: string;
  /** Cached transcript rendered server-side, or null when none exists yet. */
  transcript: TranscriptPanelTranscript | null;
  /** Platform the video lives on; drives the external-link label. */
  platform?: CreatorPlatform;
}

const EXTERNAL_LINK_LABELS: Record<CreatorPlatform, string> = {
  youtube: "Open on YouTube",
  rumble: "Open on Rumble",
  x: "Open on X",
};

function sourceLabel(kind: "manual" | "automatic"): string {
  return kind === "manual" ? "human-made captions" : "auto-generated captions";
}

/**
 * Read-only view of a video's cached transcript, so answers can be checked
 * against what was actually said. Fetching is never a user step: scope reads
 * a video's captions in the background the first time an AI chat or report
 * covers it, and the text appears here from then on. Transcript text is
 * rendered as a plain-text child only.
 */
export function TranscriptPanel({
  videoUrl,
  transcript,
  platform = "youtube",
}: TranscriptPanelProps) {
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const [justCopied, setJustCopied] = useState(false);
  const resetCopyTimer = useRef<number | null>(null);

  const handleCopy = async (): Promise<void> => {
    if (!transcript || justCopied) {
      return;
    }
    setCopyState(null);
    const outcome = await copyTextToClipboard(transcript.text);
    if (outcome === "failed") {
      setCopyState("failed");
      return;
    }
    setCopyState("copied");
    setJustCopied(true);
    if (resetCopyTimer.current !== null) {
      window.clearTimeout(resetCopyTimer.current);
    }
    resetCopyTimer.current = window.setTimeout(() => setJustCopied(false), 2000);
  };

  return (
    <Card className="mt-6">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText aria-hidden="true" className="size-5 text-muted-foreground" />
            Transcript
          </CardTitle>
          {transcript ? (
            <>
              <Badge variant={transcript.captionSource === "manual" ? "default" : "secondary"}>
                {sourceLabel(transcript.captionSource)}
              </Badge>
              <Badge variant="outline">English</Badge>
            </>
          ) : null}
        </div>
        <CardDescription>
          {transcript
            ? "What the AI reads when it answers about this video."
            : "scope reads this video's captions automatically the first time you ask AI about it. The transcript shows up here afterwards."}
        </CardDescription>
      </CardHeader>

      {transcript ? (
        <CardContent className="flex flex-col gap-4">
          <span role="status" aria-live="polite" className="sr-only">
            {justCopied ? "Transcript copied to your clipboard." : ""}
            {copyState === "failed"
              ? "Copying failed. The transcript stays on screen so you can copy it manually."
              : ""}
          </span>
          <p className="text-xs text-muted-foreground">
            Source: {sourceLabel(transcript.captionSource)} · Language: English · Read{" "}
            <time
              dateTime={transcript.fetchedAt}
              title={formatAbsoluteTimestamp(transcript.fetchedAt) ?? undefined}
            >
              {formatRelativeTime(transcript.fetchedAt) ?? "recently"}
            </time>
          </p>
          <div
            role="region"
            aria-label="Transcript text"
            tabIndex={0}
            className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-sm leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
          >
            {transcript.text}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button variant="outline" onClick={() => void handleCopy()} disabled={justCopied}>
              {justCopied ? (
                <>
                  <ClipboardCheck aria-hidden="true" />
                  Copied
                </>
              ) : (
                <>
                  <ClipboardCopy aria-hidden="true" />
                  Copy transcript
                </>
              )}
            </Button>
            <a
              href={videoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {EXTERNAL_LINK_LABELS[platform]}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </div>

          {copyState === "copied" ? (
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <Check aria-hidden="true" className="size-4" />
              Transcript copied to your clipboard.
            </p>
          ) : copyState === "failed" ? (
            <AlertNote tone="danger" title="Copying failed.">
              The transcript above is unaffected — click inside it, select the text, and press
              Ctrl+C (or Cmd+C) to copy it manually.
            </AlertNote>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
