"use client";

import { useState } from "react";
import { XInlineConnect } from "./x-inline-connect";
import { FolderPlus, UserPlus } from "lucide-react";

import { resolveCreatorAction, saveCreatorAction } from "@/app/actions/creators";
import { createCategoryAction } from "@/app/actions/categories";
import { refreshCreatorTweetsAction } from "@/components/background/operations";
import { CategoryFormFields } from "@/components/categories/category-form-fields";
import { CategoryMultiSelect } from "@/components/categories/category-multi-select";
import { CreatorCard } from "@/components/library/creator-card";
import { AlertNote } from "@/components/ui/alert-note";
import { AppDialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PendingIndicator } from "@/components/ui/pending";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { YtDlpSetupNote } from "@/components/ui/yt-dlp-setup-note";
import { useToast } from "@/components/ui/toast";
import type { CategoryColor, CategorySummary } from "@/lib/categories";
import type { CreatorSummary } from "@/lib/creators/service";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { cn } from "@/lib/utils";

interface ResolvedPreview {
  platform: "youtube" | "rumble" | "x";
  platformUserId: string | null;
  displayName: string;
  handle: string | null;
  channelUrl: string;
  avatarUrl: string | null;
  youtubeChannelId: string | null;
  followerCount: number | null;
  videoTitle: string | null;
  videoId: string | null;
  videoUrl: string | null;
  tweetId?: string | null;
  tweetText?: string | null;
  tweetUrl?: string | null;
  tweetPublishedAt?: string | null;
}

type DialogPhase = "input" | "confirming" | "saving";

const PLATFORM_OPTIONS = [
  { value: "youtube", label: "YouTube", icon: YouTubeLogo },
  { value: "rumble", label: "Rumble", icon: RumbleLogo },
  { value: "x", label: "X", icon: XLogo },
] as const;

const PLATFORM_HINTS: Record<CreatorPlatform, string> = {
  youtube: "Supported forms: youtube.com/@handle and youtube.com/channel/<channel ID>.",
  rumble:
    "Supported forms: rumble.com/c/<name>, rumble.com/user/<name>, and rumble.com/v… video links.",
  x: "Supported forms: x.com/@handle, twitter.com/@handle, @handle, and x.com/@handle/status/<id> post links.",
};

const PLATFORM_PLACEHOLDERS: Record<CreatorPlatform, string> = {
  youtube: "https://www.youtube.com/@handle",
  rumble: "https://rumble.com/c/name",
  x: "https://x.com/handle",
};

interface AddCreatorDialogProps {
  /** Visual weight of the trigger button. */
  size?: "default" | "sm" | "lg";
  /** Visual weight override for the trigger button. */
  variant?: "default" | "outline" | "secondary";
  /** Extra classes on the trigger button. */
  className?: string;
  categories: readonly CategorySummary[];
  initialPlatform?: CreatorPlatform;
  lockPlatform?: boolean;
  fetchAfterSave?: boolean;
  onSaved?: (creator: CreatorSummary) => Promise<void> | void;
}

/**
 * Paste-friendly add flow: resolve the pasted link on the server (pending
 * state), show the resolved creator for confirmation, then save. The saved
 * list refreshes via revalidation and a success toast confirms the result.
 * While a step is running every control disables, so double presses can
 * never start a second yt-dlp job or save twice.
 */
export function AddCreatorDialog({
  size = "default",
  variant = "default",
  className,
  categories,
  initialPlatform = "youtube",
  lockPlatform = false,
  fetchAfterSave = true,
  onSaved,
}: AddCreatorDialogProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DialogPhase>("input");
  const [platform, setPlatform] = useState<CreatorPlatform>(initialPlatform);
  const [urlInput, setUrlInput] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  const [availableCategories, setAvailableCategories] = useState<CategorySummary[]>([
    ...categories,
  ]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryColor, setCategoryColor] = useState<CategoryColor>("sky");
  const [categoryPending, setCategoryPending] = useState(false);
  const { showToast, toastElement } = useToast();

  const busy = phase !== "input";

  const closeAndReset = (): void => {
    setOpen(false);
    // Let the closing animation finish before clearing state.
    window.setTimeout(() => {
      setUrlInput("");
      setPlatform(initialPlatform);
      setInlineError(null);
      setErrorCode(null);
      setPreview(null);
      setSelectedCategoryIds(new Set());
      setCreatingCategory(false);
      setCategoryName("");
      setCategoryColor("sky");
      setPhase("input");
    }, 150);
  };

  const handleResolve = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setInlineError(null);
    setErrorCode(null);
    setPhase("confirming");
    const outcome = await resolveCreatorAction(urlInput, platform);
    if (!outcome.ok || !outcome.creator) {
      setInlineError(outcome.message ?? "That link could not be resolved.");
      setErrorCode(outcome.errorCode ?? null);
      setPhase("input");
      return;
    }
    setPreview(outcome.creator);
    setPhase("input");
  };

  const handleSave = async (): Promise<void> => {
    if (!preview || busy) {
      return;
    }
    setPhase("saving");
    const outcome = await saveCreatorAction(preview, [...selectedCategoryIds]);
    if (!outcome.ok) {
      setInlineError(outcome.message ?? "The creator could not be saved.");
      setPhase("input");
      return;
    }
    try {
      if (outcome.creator) await onSaved?.(outcome.creator);
    } catch (error) {
      setInlineError(
        error instanceof Error
          ? error.message
          : "The creator was saved, but could not be added to this list. Try again.",
      );
      setPhase("input");
      return;
    }
    const isX = preview.platform === "x";
    const name = outcome.creator?.displayName ?? "creator";
    const alreadySaved = outcome.status === "already_saved";
    closeAndReset();

    if (isX && outcome.creator && fetchAfterSave) {
      void refreshCreatorTweetsAction(outcome.creator.id, "recent", 20);
      showToast(
        `${alreadySaved ? `${name} was already in your library` : `Added ${name}`}. Fetching recent posts in the background.`,
        "success",
      );
      return;
    }

    showToast(
      alreadySaved ? `${name} was already in your library.` : `Added ${name} to your library.`,
      "success",
    );
  };

  const handleCreateCategory = async (): Promise<void> => {
    if (categoryPending || categoryName.trim().length === 0) {
      return;
    }
    setCategoryPending(true);
    setInlineError(null);
    const outcome = await createCategoryAction(categoryName, categoryColor);
    setCategoryPending(false);
    if (!outcome.ok || !outcome.category) {
      setInlineError(outcome.message ?? "The category could not be created.");
      return;
    }
    setAvailableCategories((current) =>
      [...current, outcome.category as CategorySummary].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
    setSelectedCategoryIds((current) => new Set([...current, outcome.category!.id]));
    setCategoryName("");
    setCategoryColor("sky");
    setCreatingCategory(false);
  };

  const isXConnectionError =
    errorCode !== null &&
    ["not_connected", "unsupported_runtime", "session_expired"].includes(errorCode);

  const showError =
    inlineError !== null ? (
      errorCode === "ytdlp_missing" ? (
        <YtDlpSetupNote />
      ) : isXConnectionError ? (
        <AlertNote tone="warning" politeness="polite" title="X needs a connection first.">
          <XInlineConnect
            onConnected={() => {
              setInlineError(null);
              setErrorCode(null);
            }}
          />
        </AlertNote>
      ) : (
        <p id="creator-url-error" role="alert" className="text-sm text-destructive">
          {inlineError}
        </p>
      )
    ) : null;

  return (
    <>
      <Button
        size={size}
        variant={variant}
        className={className}
        onClick={() => {
          setAvailableCategories([...categories]);
          setOpen(true);
        }}
      >
        <UserPlus aria-hidden="true" />
        Add creator
      </Button>

      <AppDialog
        open={open}
        onClose={closeAndReset}
        busy={busy || categoryPending}
        title="Add a creator"
        description="Pick a platform, then paste the link — scope looks up the creator's identity and saves it locally. Rumble video links and X post links also import that one item."
      >
        {!preview && !busy ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleResolve();
            }}
            className="flex flex-col gap-4"
          >
            <fieldset className="flex flex-col gap-1.5">
              <legend className="text-sm font-medium">Platform</legend>
              <div
                role="radiogroup"
                aria-label="Creator platform"
                className="flex w-fit items-center rounded-lg border bg-muted/40 p-0.5"
              >
                {PLATFORM_OPTIONS.filter(
                  (option) => !lockPlatform || option.value === initialPlatform,
                ).map((option) => {
                  const Icon = option.icon;
                  const active = platform === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setPlatform(option.value);
                        setInlineError(null);
                        setErrorCode(null);
                      }}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon aria-hidden="true" className="size-3.5" />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="creator-url" className="text-sm font-medium">
                {platform === "x" ? "Profile or post link" : "Channel or video URL"}
              </label>
              <input
                id="creator-url"
                name="url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                placeholder={PLATFORM_PLACEHOLDERS[platform]}
                value={urlInput}
                onChange={(event) => {
                  setUrlInput(event.target.value);
                  setInlineError(null);
                  setErrorCode(null);
                }}
                aria-invalid={inlineError ? true : undefined}
                aria-describedby={
                  inlineError && errorCode !== "ytdlp_missing"
                    ? "creator-url-error"
                    : "creator-url-hint"
                }
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
              />
              {showError ?? (
                <p id="creator-url-hint" className="text-xs text-muted-foreground">
                  {PLATFORM_HINTS[platform]}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={closeAndReset}>
                Cancel
              </Button>
              <Button type="submit" disabled={urlInput.trim().length === 0}>
                Look up creator
              </Button>
            </div>
          </form>
        ) : null}

        {preview && !busy ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Does this look right? Confirm to save it to your library.
            </p>
            <div className="rounded-lg border bg-muted/30 p-2">
              <CreatorCard
                creator={{
                  displayName: preview.displayName,
                  handle: preview.handle,
                  avatarUrl: preview.avatarUrl,
                  href: null,
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className="gap-1.5 font-mono text-xs">
                {preview.platform === "x" ? (
                  <XLogo aria-hidden="true" className="size-3 text-foreground" />
                ) : null}
                {preview.platform === "x"
                  ? "X"
                  : preview.platform === "rumble"
                    ? "Rumble"
                    : "YouTube"}
              </Badge>
              {preview.youtubeChannelId ? (
                <Badge variant="secondary" className="w-fit break-all font-mono text-xs">
                  ID {preview.youtubeChannelId}
                </Badge>
              ) : null}
              {preview.platform === "x" && preview.platformUserId ? (
                <Badge variant="secondary" className="w-fit break-all font-mono text-xs">
                  User ID {preview.platformUserId}
                </Badge>
              ) : null}
              {preview.platform === "rumble" && preview.followerCount !== null ? (
                <Badge variant="secondary" className="w-fit font-mono text-xs">
                  {preview.followerCount.toLocaleString()} followers
                </Badge>
              ) : null}
            </div>
            {preview.platform === "rumble" && preview.videoTitle ? (
              <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Saving this also imports the video “{preview.videoTitle}” so its transcript can be
                fetched right away.
              </p>
            ) : null}
            {preview.platform === "x" && preview.tweetId ? (
              <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Saving also imports this post so it is cached right away
                {preview.tweetText
                  ? `: “${preview.tweetText.replace(/\s+/g, " ").slice(0, 160)}${preview.tweetText.length > 160 ? "…" : ""}”`
                  : "."}
              </p>
            ) : null}
            <div className="rounded-lg border bg-background p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Categories</p>
                  <p className="text-xs text-muted-foreground">Optional — choose as many as fit.</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCreatingCategory((value) => !value)}
                >
                  <FolderPlus aria-hidden="true" />
                  New category
                </Button>
              </div>
              {creatingCategory ? (
                <div className="mt-4 rounded-lg border border-dashed bg-muted/20 p-3">
                  <CategoryFormFields
                    name={categoryName}
                    color={categoryColor}
                    onNameChange={setCategoryName}
                    onColorChange={setCategoryColor}
                    autoFocus
                  />
                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCreatingCategory(false)}
                      disabled={categoryPending}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void handleCreateCategory()}
                      disabled={categoryPending || categoryName.trim().length === 0}
                    >
                      {categoryPending ? "Creating…" : "Create and select"}
                    </Button>
                  </div>
                </div>
              ) : (
                <CategoryMultiSelect
                  className="mt-3"
                  categories={availableCategories}
                  selected={selectedCategoryIds}
                  onChange={setSelectedCategoryIds}
                  emptyMessage="No categories yet. You can create one here or organize this creator later."
                />
              )}
            </div>
            {inlineError ? (
              <p role="alert" className="text-sm text-destructive">
                {inlineError}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                onClick={() => {
                  setPreview(null);
                  setInlineError(null);
                  setErrorCode(null);
                }}
              >
                Back
              </Button>
              <Button onClick={() => void handleSave()}>
                {preview.platform === "x" && fetchAfterSave
                  ? "Add and fetch recent tweets"
                  : "Save to library"}
              </Button>
            </div>
          </div>
        ) : null}

        {busy ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 py-6 text-center">
            <PendingIndicator
              label={
                phase === "confirming"
                  ? "Looking up this link's identity…"
                  : "Saving to your library…"
              }
              hint="This can take up to a minute."
              className="border-none bg-transparent px-0"
            />
            <p className="text-xs text-muted-foreground">
              The dialog stays open until this step finishes.
            </p>
          </div>
        ) : null}
      </AppDialog>

      {toastElement}
    </>
  );
}
