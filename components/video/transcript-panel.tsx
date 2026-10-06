"use client";

import { useBackgroundTask } from "@/components/background/task-store";
import { transcriptTaskKey } from "@/components/background/operations";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardCheck,
  ClipboardCopy,
  ExternalLink,
  FileText,
  RefreshCw,
} from "lucide-react";

import type { TranscriptActionResult } from "@/app/actions/transcripts";
import { getTranscriptAction } from "@/components/background/operations";
import { AlertNote } from "@/components/ui/alert-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PendingIndicator } from "@/components/ui/pending";
import { YtDlpSetupNote } from "@/components/ui/yt-dlp-setup-note";
import { useToast } from "@/components/ui/toast";
import { copyTextToClipboard } from "@/lib/clipboard";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { formatAbsoluteTimestamp, formatRelativeTime } from "@/lib/format";

export interface TranscriptPanelTranscript {
  text: string;
  language: string;
  captionSource: "manual" | "automatic";
  fetchedAt: string;
  fromCache: boolean;
}

interface TranscriptFailure {
  errorCode: string;
  message: string;
  availableManualLanguages?: string[];
  availableAutomaticLanguages?: string[];
}

interface TranscriptPanelProps {
  creatorId: number;
  videoId: string;
  videoUrl: string;
  /** Cached transcript rendered server-side, when caching is enabled. */
  initialTranscript: TranscriptPanelTranscript | null;
  cacheEnabled: boolean;
  /** Platform the video lives on; drives the external-link label. */
  platform?: CreatorPlatform;
}

const EXTERNAL_LINK_LABELS: Record<CreatorPlatform, string> = {
  youtube: "Open on YouTube",
  rumble: "Open on Rumble",
  x: "Open on X",
};

type PendingIntent = "get" | "refresh";

const PENDING_WORDING: Record<PendingIntent, string> = {
  get: "Fetching English captions…",
  refresh: "Re-extracting the transcript…",
};

function sourceLabel(kind: "manual" | "automatic"): string {
  return kind === "manual" ? "human-made captions" : "auto-generated captions";
}

/**
 * Stage 4 transcript workflow, hardened in stage 5: extract a caption track
 * with yt-dlp, render it as readable plain text, and copy it with one
 * click. An existing transcript stays visible and copyable while a new
 * extraction runs; buttons disable instead of disappearing so a double
 * press can never start a second job. All states are explicit — progress
 * wording, specific failures with a retry of the SAME action, English-only extraction and accessible live-region
 * confirmations. Transcript text is rendered as a plain-text child only.
 */
export function TranscriptPanel({
  creatorId,
  videoId,
  videoUrl,
  initialTranscript,
  cacheEnabled,
  platform = "youtube",
}: TranscriptPanelProps) {
  const [transcript, setTranscript] = useState<TranscriptPanelTranscript | null>(initialTranscript);
  const [localPending, setPending] = useState<PendingIntent | null>(null);
  const task = useBackgroundTask(transcriptTaskKey(videoId));
  const pending = localPending ?? (task?.status === "running" ? "get" : null);
  const [failure, setFailure] = useState<TranscriptFailure | null>(null);
  // Remembers which action to re-run from the Try again button.
  const [lastIntent, setLastIntent] = useState<PendingIntent>("get");
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const [justCopied, setJustCopied] = useState(false);
  const { showToast, toastElement } = useToast();
  const resetCopyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!task?.result) return;
    const result = task.result as TranscriptActionResult;
    const timer = setTimeout(() => {
      if (result.ok) {
        setTranscript(result.transcript);
        setFailure(null);
      } else {
        setFailure({ ...result });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [task?.result]);

  const runAction = useCallback(
    async (intent: PendingIntent): Promise<void> => {
      if (pending !== null) {
        return;
      }
      setLastIntent(intent);
      setPending(intent);
      setFailure(null);
      setCopyState(null);
      const result = await getTranscriptAction(creatorId, videoId, intent);
      setPending(null);

      if (!result.ok) {
        setFailure({
          errorCode: result.errorCode,
          message: result.message ?? "scope could not extract this transcript.",
          availableManualLanguages: result.availableManualLanguages,
          availableAutomaticLanguages: result.availableAutomaticLanguages,
        });
        return;
      }

      setTranscript(result.transcript);
      if (intent === "refresh") {
        showToast("Transcript refreshed.", "success");
      } else if (result.transcript.fromCache) {
        showToast("Loaded your cached transcript.", "info");
      }
    },
    [creatorId, videoId, pending, showToast],
  );

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

  const retrySameIntent = (): void => {
    void runAction(lastIntent);
  };

  const hasTranscript = transcript !== null;

  return (
    <Card className="mt-6">
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText aria-hidden="true" className="size-5 text-muted-foreground" />
            Transcript
          </CardTitle>
          {hasTranscript ? (
            <>
              <Badge variant={transcript.captionSource === "manual" ? "default" : "secondary"}>
                {sourceLabel(transcript.captionSource)}
              </Badge>
              <Badge variant="outline">English</Badge>
            </>
          ) : null}
        </div>
        <CardDescription>
          Extracts original English captions locally and converts them to clean, readable text. No
          media is downloaded and nothing is analyzed.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Accessible status line: announces progress and copy results. */}
        <span role="status" aria-live="polite" className="sr-only">
          {pending ? PENDING_WORDING[pending] : ""}
          {!pending && justCopied ? "Transcript copied to your clipboard." : ""}
          {!pending && copyState === "failed"
            ? "Copying failed. The transcript stays on screen so you can copy it manually."
            : ""}
        </span>

        {hasTranscript ? (
          <>
            <p className="text-xs text-muted-foreground">
              Source: {sourceLabel(transcript.captionSource)} · Language: English ·{" "}
              {cacheEnabled ? (
                <>
                  Cached{" "}
                  <time
                    dateTime={transcript.fetchedAt}
                    title={formatAbsoluteTimestamp(transcript.fetchedAt) ?? undefined}
                  >
                    {formatRelativeTime(transcript.fetchedAt) ?? "recently"}
                  </time>
                </>
              ) : (
                "Not cached (caching is off in Settings)"
              )}
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
              <Button onClick={() => void handleCopy()} disabled={justCopied} aria-busy={false}>
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
              <Button
                variant="outline"
                onClick={() => void runAction("refresh")}
                disabled={pending !== null}
                aria-busy={pending === "refresh"}
              >
                <RefreshCw aria-hidden="true" />
                Refresh transcript
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

            {/* Visible copy confirmation / failure instruction. */}
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
          </>
        ) : null}

        {pending ? (
          <PendingIndicator label={PENDING_WORDING[pending]} hint="This can take up to a minute." />
        ) : null}

        {!hasTranscript && !pending && !failure ? (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <p className="mx-auto max-w-prose text-sm text-muted-foreground [overflow-wrap:anywhere]">
              No transcript has been extracted for this video yet. Scope will look for human-made or
              original auto-generated English captions, convert them to plain text, and cache them
              here.
            </p>
            <div className="mt-4 flex justify-center">
              <Button onClick={() => void runAction("get")} aria-busy={pending === "get"}>
                <FileText aria-hidden="true" />
                Get transcript
              </Button>
            </div>
          </div>
        ) : null}

        {failure && !pending ? (
          failure.errorCode === "ytdlp_missing" ? (
            <YtDlpSetupNote />
          ) : (
            <AlertNote
              tone="danger"
              title={`${failure.errorCode.replace(/_/g, " ")}.`}
              action={
                <Button variant="outline" size="sm" onClick={retrySameIntent}>
                  Try again
                </Button>
              }
            >
              {failure.message}
            </AlertNote>
          )
        ) : null}

        {toastElement}
      </CardContent>
    </Card>
  );
}
