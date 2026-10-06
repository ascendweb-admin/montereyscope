"use client";

import { useState } from "react";
import { Database, Trash2 } from "lucide-react";

import {
  clearFeedMetadataAction,
  clearTranscriptCacheAction,
  clearTweetCacheAction,
} from "@/app/actions/maintenance";
import { saveCacheTranscriptsAction, saveRecentItemsPerTabAction } from "@/app/actions/settings";
import { AiBackendSetting } from "@/app/settings/ai-backend-setting";
import { XConnectionCard } from "@/app/settings/x-connection-card";
import type { XConnectionStatus } from "@/lib/x/model";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { DesktopInfoSection } from "./desktop-info";
import { ThemeSetting } from "./theme-setting";
import type { AiBackendId } from "@/lib/ai/backend-id";
import type { AiAuthSnapshot } from "@/lib/ai/auth-types";
import type { AiChatModeSettings } from "@/lib/ai/model-catalog";

interface SettingsFormProps {
  currentValue: number;
  cacheTranscriptsEnabled: boolean;
  cachedTranscriptCount: number;
  cachedVideoCount: number;
  cachedTweetCount: number;
  aiBackend: AiBackendId;
  aiChatModeSettings: AiChatModeSettings;
  aiAuthStatus: AiAuthSnapshot | null;
  xStatus: XConnectionStatus;
  /** Host platform, forwarded to AI provider install instructions. */
  platform: string;
}

type ToastTone = "success" | "error" | "info";

/**
 * Application settings: the stage 3 feed window, stage 4 transcript
 * preferences, and the stage 5 local-cache controls plus appearance. The
 * stage 9 AI backend section lives above the form — it saves through its own
 * action and carries its own server-rendered auth status.
 */
export function SettingsForm({
  currentValue,
  cacheTranscriptsEnabled,
  cachedTranscriptCount,
  cachedVideoCount,
  cachedTweetCount,
  aiBackend,
  aiChatModeSettings,
  aiAuthStatus,
  xStatus,
  platform,
}: SettingsFormProps) {
  const [value, setValue] = useState(String(currentValue));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { showToast, toastElement } = useToast();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    setPending(true);
    const outcome = await saveRecentItemsPerTabAction(value);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "The setting could not be saved.");
      return;
    }
    setValue(String(outcome.savedValue ?? value));
    showToast(
      `Saved. Future refreshes will fetch up to ${outcome.savedValue} items per tab.`,
      "success",
    );
  };

  return (
    <>
      <AiBackendSetting
        initialBackend={aiBackend}
        initialModeSettings={aiChatModeSettings}
        initialStatus={aiAuthStatus}
        platform={platform}
      />

      <form onSubmit={(event) => void handleSubmit(event)} className="mt-6 flex flex-col gap-6">
        <section
          aria-labelledby="recent-items-heading"
          className="rounded-xl border bg-card p-5 shadow-sm sm:p-6"
        >
          <h2 id="recent-items-heading" className="text-base font-semibold tracking-tight">
            Feed refresh window
          </h2>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            How many recent items to fetch per channel tab when you press{" "}
            <strong>Refresh feed</strong>. Larger numbers reach further back but make refreshes
            slower. Everything already fetched stays saved locally — older entries accumulate across
            refreshes instead of being replaced.
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <label htmlFor="recent-items-per-tab" className="text-sm font-medium">
              Recent items per tab
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <input
                id="recent-items-per-tab"
                name="recentItemsPerTab"
                type="number"
                inputMode="numeric"
                min={5}
                max={300}
                step={1}
                value={value}
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "recent-items-error" : "recent-items-hint"}
                className="h-10 w-24 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
              />
              <Button type="submit" disabled={pending} aria-busy={pending}>
                Save setting
              </Button>
            </div>
            {error ? (
              <p id="recent-items-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : (
              <p id="recent-items-hint" className="text-xs text-muted-foreground">
                A whole number between 5 and 300. Default: 30.
              </p>
            )}
          </div>
        </section>

        <TranscriptSettingsSection
          initiallyCached={cacheTranscriptsEnabled}
          showToast={showToast}
        />
      </form>

      <XConnectionCard initialStatus={xStatus} cachedTweetCount={cachedTweetCount} />

      <LocalCacheSection
        initialTranscriptCount={cachedTranscriptCount}
        initialVideoCount={cachedVideoCount}
        initialTweetCount={cachedTweetCount}
        showToast={showToast}
      />

      <section
        aria-labelledby="appearance-heading"
        className="mt-6 rounded-xl border bg-card p-5 shadow-sm sm:p-6"
      >
        <h2 id="appearance-heading" className="text-base font-semibold tracking-tight">
          Appearance
        </h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Follow this machine&apos;s light or dark preference, or pin one for scope.
        </p>
        <ThemeSetting />
      </section>

      <DesktopInfoSection />

      {toastElement}
    </>
  );
}

function TranscriptSettingsSection({
  initiallyCached,
  showToast,
}: {
  initiallyCached: boolean;
  showToast: (message: string, tone: ToastTone) => void;
}) {
  const [cached, setCached] = useState(initiallyCached);
  const [pending, setPending] = useState(false);

  const saveCaching = async (next: boolean): Promise<void> => {
    setPending(true);
    const outcome = await saveCacheTranscriptsAction(next);
    setPending(false);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The setting could not be saved.", "error");
      return;
    }
    setCached(outcome.savedValue ?? next);
    showToast(
      outcome.savedValue
        ? "Successful transcripts will be cached locally."
        : "Transcripts will no longer be cached.",
      "success",
    );
  };

  return (
    <section
      aria-labelledby="transcripts-heading"
      className="rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <h2 id="transcripts-heading" className="text-base font-semibold tracking-tight">
        Transcripts
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        How scope picks a caption track when you press <strong>Get transcript</strong> on a video.
      </p>

      <div className="mt-4 rounded-lg border bg-background p-4">
        <p className="text-sm font-medium">English captions only</p>
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
          Scope uses human-made English captions when available, otherwise original English
          auto-generated captions. Automatic translations are excluded. Use Refresh transcript to
          replace an older cached transcript.
        </p>
      </div>

      <div className="mt-6 flex flex-col gap-2">
        <span className="text-sm font-medium">Cache transcripts</span>
        <label htmlFor="cache-transcripts" className="flex max-w-prose items-start gap-3 text-sm">
          <input
            id="cache-transcripts"
            type="checkbox"
            checked={cached}
            onChange={(event) => void saveCaching(event.target.checked)}
            disabled={pending}
            aria-busy={pending}
            className="mt-0.5 size-4 accent-current"
          />
          <span>
            Keep successful transcripts in the local database so reopening a video is instant.
            Failed extractions never change or remove cached transcripts either way.
          </span>
        </label>
      </div>
    </section>
  );
}

function LocalCacheSection({
  initialTranscriptCount,
  initialVideoCount,
  initialTweetCount,
  showToast,
}: {
  initialTranscriptCount: number;
  initialVideoCount: number;
  initialTweetCount: number;
  showToast: (message: string, tone: ToastTone) => void;
}) {
  const [transcriptCount, setTranscriptCount] = useState(initialTranscriptCount);
  const [videoCount, setVideoCount] = useState(initialVideoCount);
  const [tweetCount, setTweetCount] = useState(initialTweetCount);
  const [confirming, setConfirming] = useState<"transcripts" | "feeds" | "tweets" | null>(null);
  const [busy, setBusy] = useState<"transcripts" | "feeds" | "tweets" | null>(null);

  const closeConfirm = (): void => {
    setConfirming(null);
  };

  const clearTranscripts = async (): Promise<void> => {
    setBusy("transcripts");
    const outcome = await clearTranscriptCacheAction();
    setBusy(null);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The transcript cache could not be cleared.", "error");
      return;
    }
    setTranscriptCount(0);
    setConfirming(null);
    showToast(
      outcome.deletedCount === 0
        ? "Nothing to clear — no transcripts are cached."
        : `Cleared ${outcome.deletedCount} cached ${outcome.deletedCount === 1 ? "transcript" : "transcripts"}.`,
      "success",
    );
  };

  const clearFeeds = async (): Promise<void> => {
    setBusy("feeds");
    const outcome = await clearFeedMetadataAction();
    setBusy(null);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The cached feed metadata could not be cleared.", "error");
      return;
    }
    setVideoCount(0);
    setConfirming(null);
    showToast(
      outcome.deletedCount === 0
        ? "Nothing to clear — no feed metadata is cached."
        : `Cleared cached entries for ${outcome.deletedCount} ${outcome.deletedCount === 1 ? "video" : "videos"}. Saved creators were kept.`,
      "success",
    );
  };

  const clearTweets = async (): Promise<void> => {
    setBusy("tweets");
    const outcome = await clearTweetCacheAction();
    setBusy(null);
    if (!outcome.ok) {
      showToast(outcome.message ?? "The tweet cache could not be cleared.", "error");
      return;
    }
    setTweetCount(0);
    setConfirming(null);
    showToast(
      outcome.deletedCount === 0
        ? "Nothing to clear — no posts are cached."
        : `Cleared ${outcome.deletedCount} cached ${outcome.deletedCount === 1 ? "post" : "posts"}. Saved creators were kept.`,
      "success",
    );
  };

  return (
    <section
      aria-labelledby="local-cache-heading"
      className="mt-6 rounded-xl border bg-card p-5 shadow-sm sm:p-6"
    >
      <h2 id="local-cache-heading" className="text-base font-semibold tracking-tight">
        Local cache
      </h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Everything below lives only in the local database on this machine. Clearing is permanent for
        the cleared scope — saved creators are always kept.
      </p>

      <ul className="mt-4 flex flex-col divide-y divide-border rounded-lg border">
        <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm">
            <p className="font-medium">Cached transcripts</p>
            <p className="text-muted-foreground">
              {transcriptCount === 0
                ? "None stored right now."
                : `${transcriptCount} ${transcriptCount === 1 ? "transcript" : "transcripts"} stored.`}{" "}
              Clearing means pressing <strong>Get transcript</strong> fetches captions again with
              yt-dlp.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setConfirming("transcripts")}
            disabled={busy !== null}
            className="shrink-0 self-start sm:self-auto"
          >
            <Trash2 aria-hidden="true" />
            Clear…
          </Button>
        </li>
        <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm">
            <p className="font-medium">Cached feed metadata</p>
            <p className="text-muted-foreground">
              {videoCount === 0
                ? "No video entries stored right now."
                : `${videoCount} ${videoCount === 1 ? "entry" : "entries"} stored across all channels.`}{" "}
              Clearing empties channel pages until you press <strong>Refresh feed</strong>, which
              fetches metadata again. Saved creators stay.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setConfirming("feeds")}
            disabled={busy !== null}
            className="shrink-0 self-start sm:self-auto"
          >
            <Trash2 aria-hidden="true" />
            Clear…
          </Button>
        </li>
        <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-sm">
            <p className="font-medium">Cached X posts</p>
            <p className="text-muted-foreground">
              {tweetCount === 0
                ? "No posts stored right now."
                : `${tweetCount} ${tweetCount === 1 ? "post" : "posts"} stored across all saved accounts.`}{" "}
              Clearing empties creator timelines until you press{" "}
              <strong>Fetch recent tweets</strong> again. Saved creators stay, and old reports keep
              their own evidence snapshots.
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => setConfirming("tweets")}
            disabled={busy !== null}
            className="shrink-0 self-start sm:self-auto"
          >
            <Trash2 aria-hidden="true" />
            Clear…
          </Button>
        </li>
      </ul>

      <ConfirmDialog
        open={confirming === "transcripts"}
        onClose={closeConfirm}
        busy={busy === "transcripts"}
        busyLabel="Clearing…"
        onConfirm={() => void clearTranscripts()}
        title="Clear all cached transcripts?"
        description="This permanently deletes cached transcripts from the local database on this machine."
        confirmLabel="Clear transcripts"
        cancelLabel="Keep transcripts"
        destructive
      >
        <p className="text-sm text-muted-foreground">
          This removes all {transcriptCount} stored{" "}
          {transcriptCount === 1 ? "transcript" : "transcripts"}. Your saved creators, their cached
          video lists, and your settings are kept. The next time you press{" "}
          <strong>Get transcript</strong> on a video, scope fetches captions again with yt-dlp and
          caches the result if caching is enabled.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "feeds"}
        onClose={closeConfirm}
        busy={busy === "feeds"}
        busyLabel="Clearing…"
        onConfirm={() => void clearFeeds()}
        title="Clear all cached feed metadata?"
        description="This permanently deletes cached video entries from the local database on this machine."
        confirmLabel="Clear feed metadata"
        cancelLabel="Keep feed metadata"
        destructive
      >
        <p className="text-sm text-muted-foreground">
          This removes all {videoCount} cached {videoCount === 1 ? "entry" : "entries"} and resets
          every creator&apos;s last-refreshed time. Your saved creators and settings are kept, but
          channel pages will show nothing until you press <strong>Refresh feed</strong> again — that
          refetches titles, thumbnails, dates, and durations with yt-dlp. Cached transcripts go with
          their videos.
        </p>
        <p className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Database aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Saved creators are never deleted by this action.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "tweets"}
        onClose={closeConfirm}
        busy={busy === "tweets"}
        busyLabel="Clearing…"
        onConfirm={() => void clearTweets()}
        title="Clear all cached X posts?"
        description="This permanently deletes cached posts and timeline state from the local database on this machine."
        confirmLabel="Clear posts"
        cancelLabel="Keep posts"
        destructive
      >
        <p className="text-sm text-muted-foreground">
          This removes all {tweetCount} cached {tweetCount === 1 ? "post" : "posts"}. Saved X
          creators and categories are kept, and reports that already ran stay readable because their
          evidence was snapshotted into their own job directories. Creator timelines stay empty
          until you press <strong>Fetch recent tweets</strong> again.
        </p>
      </ConfirmDialog>
    </section>
  );
}
