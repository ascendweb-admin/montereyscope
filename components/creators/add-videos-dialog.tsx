"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock3, ListVideo, RotateCw, TriangleAlert } from "lucide-react";

import {
  importVideosAction,
  previewVideoLinkAction,
  type PreviewVideoLinkOutcome,
} from "@/app/actions/videos";
import { VideoPreviewSummary } from "@/components/creators/video-preview-card";
import { AlertNote } from "@/components/ui/alert-note";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/pending";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import {
  estimateScopeLoad,
  formatVideoHours,
  MAX_SCOPE_VIDEO_HOURS,
  MAX_SCOPE_VIDEOS,
} from "@/lib/ai/scope-selection";
import { extractVideoLinks, MAX_PASTED_VIDEO_LINKS } from "@/lib/videos/import/links";
import type { VideoPreview } from "@/lib/videos/import/service";
import { cn } from "@/lib/utils";

/** Links looked up at once; each costs two yt-dlp jobs on the server. */
const POOL_SIZE = 3;

/** What looking up one link found. */
type Check =
  | { status: "checking" }
  | { status: "ready"; preview: VideoPreview }
  | { status: "already"; preview: VideoPreview }
  /** `preview` is kept when the video was resolved before saving turned it down. */
  | { status: "rejected"; message: string; preview?: VideoPreview }
  /** A transient failure (network, throttling): worth a retry. */
  | { status: "failed"; message: string };

interface Row {
  /** The canonical link, or the pasted text for something that is not a video link. */
  key: string;
  url: string;
  check: Check;
  /** Saved to the person's Other videos in this dialog. */
  added: boolean;
  /** Why saving this row failed in a way that is worth retrying. */
  saveError: string | null;
}

/** The lookups of one paste. Closing or starting over cancels it, so late results are ignored. */
interface Run {
  cancelled: boolean;
  active: number;
  queue: string[];
}

function toCheck(outcome: PreviewVideoLinkOutcome): Check {
  if (outcome.ok) {
    return outcome.preview.alreadyAttached
      ? { status: "already", preview: outcome.preview }
      : { status: "ready", preview: outcome.preview };
  }
  return outcome.retryable
    ? { status: "failed", message: outcome.message }
    : { status: "rejected", message: outcome.message };
}

function previewOf(row: Row): VideoPreview | null {
  return row.check.status === "ready" ||
    row.check.status === "already" ||
    row.check.status === "rejected"
    ? (row.check.preview ?? null)
    : null;
}

const countVideos = (count: number): string => `${count} ${count === 1 ? "video" : "videos"}`;

export interface AddVideosDialogProps {
  /** The person the videos feature; they land in this person's Other videos. */
  profile: { id: number; displayName: string };
  /** Called after videos were saved, e.g. to refresh the page behind the dialog. */
  onImported?: () => void;
}

/**
 * Paste video links (one per line or all at once), review what each one is,
 * then add the ones that can be used to a person's Other videos.
 *
 * Every link is looked up on its own, three at a time, and its row fills in as
 * it resolves. Only videos with usable English captions are ready; anything
 * else says why it is not. The commit step saves the ticked rows; if some fail,
 * the dialog stays open with their errors and a Retry while the saved ones stay
 * marked "Added". Closing cancels the lookups still pending.
 */
export function AddVideosDialog({ profile, onImported }: AddVideosDialogProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [text, setText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [followHost, setFollowHost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const { showToast, toastElement } = useToast();
  const runRef = useRef<Run | null>(null);

  const cancelRun = (): void => {
    if (runRef.current) {
      runRef.current.cancelled = true;
      runRef.current = null;
    }
  };

  // Navigating away mid-lookup must not leave results landing in a dead tree.
  useEffect(
    () => () => {
      if (runRef.current) {
        runRef.current.cancelled = true;
      }
    },
    [],
  );

  const settle = (key: string, check: Check): void => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, check } : row)));
    if (check.status === "ready") {
      setSelected((current) => new Set(current).add(key));
    }
  };

  const checkLink = async (url: string, run: Run): Promise<void> => {
    let check: Check;
    try {
      check = toCheck(await previewVideoLinkAction(url, profile.id));
    } catch {
      check = { status: "failed", message: "scope could not check this link. Please try again." };
    }
    if (!run.cancelled) {
      settle(url, check);
    }
  };

  const pump = (run: Run): void => {
    while (!run.cancelled && run.active < POOL_SIZE && run.queue.length > 0) {
      const url = run.queue.shift() as string;
      run.active += 1;
      void checkLink(url, run).finally(() => {
        run.active -= 1;
        pump(run);
      });
    }
  };

  const startRun = (urls: string[]): void => {
    cancelRun();
    const run: Run = { cancelled: false, active: 0, queue: [...urls] };
    runRef.current = run;
    pump(run);
  };

  const closeAndReset = (): void => {
    cancelRun();
    setOpen(false);
    // Let the closing animation finish before clearing state.
    window.setTimeout(() => {
      setStep("paste");
      setText("");
      setPasteError(null);
      setTruncated(false);
      setRows([]);
      setSelected(new Set());
      setFollowHost(false);
      setSaving(false);
      setBatchError(null);
    }, 150);
  };

  const findVideos = (): void => {
    if (text.trim().length === 0) {
      return;
    }
    const found = extractVideoLinks(text);
    if (found.links.length === 0 && found.rejected.length === 0) {
      setPasteError("No video links found. Paste full addresses that start with https://");
      return;
    }
    setPasteError(null);
    setTruncated(found.truncated);
    setBatchError(null);
    setSelected(new Set());
    setRows([
      ...found.links.map((link): Row => ({
        key: link.url,
        url: link.url,
        check: { status: "checking" },
        added: false,
        saveError: null,
      })),
      ...found.rejected.map((rejected): Row => ({
        key: `rejected:${rejected.raw}`,
        url: rejected.raw,
        check: { status: "rejected", message: rejected.message },
        added: false,
        saveError: null,
      })),
    ]);
    setStep("review");
    startRun(found.links.map((link) => link.url));
  };

  const backToPaste = (): void => {
    cancelRun();
    setRows([]);
    setSelected(new Set());
    setBatchError(null);
    setStep("paste");
  };

  const retryCheck = (key: string): void => {
    const run = runRef.current;
    if (!run || run.cancelled) {
      return;
    }
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, check: { status: "checking" } } : row)),
    );
    run.queue.push(key);
    pump(run);
  };

  const toggle = (key: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const readyRows = rows.filter((row) => row.check.status === "ready" && !row.added);
  const chosen = readyRows.filter((row) => selected.has(row.key));
  const checking = rows.filter((row) => row.check.status === "checking").length;
  const addedCount = rows.filter((row) => row.added).length;
  const failedSaveCount = rows.filter((row) => row.saveError !== null && !row.added).length;
  const load = estimateScopeLoad(
    chosen.map((row) => ({
      kind: "video" as const,
      durationSeconds: previewOf(row)?.durationSeconds,
    })),
  );

  /** Saves the given rows; each succeeds or fails on its own. */
  const commit = async (urls: string[]): Promise<void> => {
    if (saving || urls.length === 0) {
      return;
    }
    setSaving(true);
    setBatchError(null);
    const outcome = await importVideosAction(urls, { profileId: profile.id, followHost }).catch(
      () => ({ ok: false as const, message: "The videos could not be added. Please try again." }),
    );
    setSaving(false);
    if (!outcome.ok) {
      setBatchError(outcome.message);
      return;
    }

    const sent = new Set(urls);
    const results = new Map(outcome.results.map((result) => [result.url, result]));
    const nextSelected = new Set(selected);
    let succeeded = 0;
    let failed = 0;
    const nextRows = rows.map((row): Row => {
      if (!sent.has(row.url)) {
        return row;
      }
      const result = results.get(row.url);
      if (result && result.status !== "rejected") {
        succeeded += 1;
        nextSelected.delete(row.key);
        return { ...row, added: true, saveError: null };
      }
      failed += 1;
      const error = result?.error;
      if (error && !error.retryable) {
        // A final answer (for example no English captions): it cannot be retried.
        nextSelected.delete(row.key);
        return {
          ...row,
          check: {
            status: "rejected",
            message: error.message,
            preview: previewOf(row) ?? undefined,
          },
          saveError: null,
        };
      }
      return {
        ...row,
        saveError: error?.message ?? "scope did not report back on this video. Try again.",
      };
    });
    setRows(nextRows);
    setSelected(nextSelected);

    if (succeeded > 0) {
      onImported?.();
    }
    const stillPending = nextRows.some(
      (row) => row.check.status === "ready" && !row.added && nextSelected.has(row.key),
    );
    if (failed === 0 && !stillPending) {
      const total = nextRows.filter((row) => row.added).length;
      closeAndReset();
      showToast(`Added ${countVideos(total)} to ${profile.displayName}'s Other videos.`, "success");
    }
  };

  const primary =
    addedCount > 0 && chosen.length === 0 && failedSaveCount === 0 ? (
      <Button onClick={closeAndReset}>Done</Button>
    ) : (
      <Button
        disabled={chosen.length === 0 || checking > 0 || saving}
        aria-busy={saving || undefined}
        onClick={() => void commit(chosen.map((row) => row.url))}
      >
        {saving ? (
          <>
            <Spinner />
            Adding…
          </>
        ) : (
          `Add ${countVideos(chosen.length)}`
        )}
      </Button>
    );

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <ListVideo aria-hidden="true" />
        Add videos
      </Button>

      <AppDialog
        open={open}
        onClose={closeAndReset}
        busy={saving}
        title={`Add videos to ${profile.displayName}`}
        description={`Paste links to videos on other channels that ${profile.displayName} appears in. They join their Other videos and work like any other video.`}
        // Top-anchored so the list can grow downward as links resolve.
        className="max-w-2xl sm:mt-[6dvh] sm:max-h-[calc(94dvh-1rem)]"
      >
        {step === "paste" ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              findVideos();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <label htmlFor="add-videos-links" className="text-sm font-medium">
                Paste video links, one per line or all at once
              </label>
              <textarea
                id="add-videos-links"
                autoFocus
                rows={7}
                spellCheck={false}
                autoComplete="off"
                value={text}
                placeholder={"https://www.youtube.com/watch?v=…\nhttps://rumble.com/v…"}
                onChange={(event) => {
                  setText(event.target.value);
                  setPasteError(null);
                }}
                onKeyDown={(event) => {
                  // Enter adds a line; the lookup is deliberate.
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    findVideos();
                  }
                }}
                aria-invalid={pasteError ? true : undefined}
                aria-describedby={pasteError ? "add-videos-error" : "add-videos-hint"}
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
              />
              {pasteError ? (
                <p id="add-videos-error" role="alert" className="text-sm text-destructive">
                  {pasteError}
                </p>
              ) : (
                <p id="add-videos-hint" className="text-xs text-muted-foreground">
                  YouTube and Rumble videos with English captions can be added, up to{" "}
                  {MAX_PASTED_VIDEO_LINKS} at a time. Press Ctrl+Enter to look them up.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeAndReset}>
                Cancel
              </Button>
              <Button type="submit" disabled={text.trim().length === 0}>
                Find videos
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {checking > 0
                ? `Checking ${checking} of ${rows.length} ${rows.length === 1 ? "link" : "links"}…`
                : `${countVideos(readyRows.length + addedCount)} can be added from ${rows.length} ${
                    rows.length === 1 ? "link" : "links"
                  }.`}
            </p>
            {truncated ? (
              <AlertNote tone="info" politeness="polite">
                Only the first {MAX_PASTED_VIDEO_LINKS} links were used.
              </AlertNote>
            ) : null}
            {failedSaveCount > 0 ? (
              <AlertNote tone="warning" politeness="polite">
                {failedSaveCount === 1
                  ? "1 video could not be added."
                  : `${failedSaveCount} videos could not be added.`}{" "}
                Retry {failedSaveCount === 1 ? "it" : "them"}, or untick to skip.
              </AlertNote>
            ) : null}
            {batchError ? <AlertNote tone="danger">{batchError}</AlertNote> : null}

            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {chosen.length} of {readyRows.length} ready selected
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving || readyRows.length === 0}
                  onClick={() => setSelected(new Set(readyRows.map((row) => row.key)))}
                >
                  Select all ready
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving || chosen.length === 0}
                  onClick={() => setSelected(new Set())}
                >
                  None
                </Button>
              </div>
            </div>

            <ul aria-label="Pasted videos" className="flex flex-col gap-2">
              {rows.map((row) => (
                <ReviewRow
                  key={row.key}
                  row={row}
                  checked={selected.has(row.key)}
                  busy={saving}
                  onToggle={() => toggle(row.key)}
                  onRetryCheck={() => retryCheck(row.key)}
                  onRetrySave={() => void commit([row.url])}
                />
              ))}
            </ul>

            <div className="sticky bottom-0 -mx-6 -mb-5 flex flex-col gap-3 border-t bg-card px-6 py-3">
              {chosen.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {countVideos(chosen.length)} · {formatVideoHours(load.videoSeconds)} selected. An
                  analysis takes up to {MAX_SCOPE_VIDEOS} videos or {MAX_SCOPE_VIDEO_HOURS} hours.
                </p>
              ) : null}
              <label className="flex items-start gap-2.5 text-sm">
                <Switch
                  checked={followHost}
                  disabled={saving}
                  onChange={(event) => setFollowHost(event.target.checked)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  Also follow these channels
                  <span className="block text-xs text-muted-foreground">
                    Adds each video&apos;s channel to your library, with its own feed.
                  </span>
                </span>
              </label>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="ghost" onClick={backToPaste} disabled={saving}>
                  Back
                </Button>
                {primary}
              </div>
            </div>
          </div>
        )}
      </AppDialog>
      {toastElement}
    </>
  );
}

function ReviewRow({
  row,
  checked,
  busy,
  onToggle,
  onRetryCheck,
  onRetrySave,
}: {
  row: Row;
  checked: boolean;
  busy: boolean;
  onToggle: () => void;
  onRetryCheck: () => void;
  onRetrySave: () => void;
}) {
  const { check } = row;
  const preview = previewOf(row);
  const selectable = check.status === "ready" && !row.added;

  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-lg border bg-card p-3",
        checked && selectable && "border-ring bg-accent/30",
        !selectable && !row.added && "bg-muted/20",
      )}
    >
      <SelectionCheckbox
        className="mt-0.5"
        checked={row.added || (selectable && checked)}
        disabled={!selectable || busy}
        onChange={onToggle}
        aria-label={`Select ${preview?.title ?? row.url}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {preview ? (
          <VideoPreviewSummary preview={preview} />
        ) : (
          <p className="truncate font-mono text-xs text-muted-foreground" title={row.url}>
            {row.url}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <RowStatus row={row} />
          {check.status === "failed" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRetryCheck}
              aria-label={`Retry ${row.url}`}
            >
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          ) : null}
          {row.saveError !== null && !row.added ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRetrySave}
              aria-label={`Retry adding ${preview?.title ?? row.url}`}
            >
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** One line saying what became of a row; never colour alone. */
function RowStatus({ row }: { row: Row }) {
  const { check } = row;
  if (row.added) {
    return (
      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" />
        Added
      </p>
    );
  }
  if (row.saveError !== null) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-destructive">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">Couldn&apos;t add: {row.saveError}</span>
      </p>
    );
  }
  switch (check.status) {
    case "checking":
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner className="size-3.5" />
          Checking…
        </p>
      );
    case "ready":
      return (
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          Ready
          {check.preview.alreadyInLibrary ? (
            <span className="font-normal text-muted-foreground"> · already in your library</span>
          ) : null}
        </p>
      );
    case "already":
      return (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 aria-hidden="true" className="size-3.5 shrink-0" />
          Already in Other videos
        </p>
      );
    case "rejected":
      return (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">Rejected: {check.message}</span>
        </p>
      );
    case "failed":
      return (
        <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0">Couldn&apos;t check: {check.message}</span>
        </p>
      );
  }
}
