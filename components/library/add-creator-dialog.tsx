"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { XInlineConnect } from "./x-inline-connect";
import { ArrowRight, BadgeCheck, FolderPlus, Link2, Search, UserPlus, X } from "lucide-react";

import {
  followVideoChannelAction,
  listProfilesAction,
  resolveCreatorAction,
  saveCreatorAction,
} from "@/app/actions/creators";
import { importVideosAction, previewVideoLinkAction } from "@/app/actions/videos";
import { createCategoryAction } from "@/app/actions/categories";
import { refreshCreatorTweetsAction } from "@/components/background/operations";
import { CategoryFormFields } from "@/components/categories/category-form-fields";
import { CategoryMultiSelect } from "@/components/categories/category-multi-select";
import {
  ProfileTargetPicker,
  defaultTarget,
  type SaveTarget,
} from "@/components/creators/profile-target-picker";
import { ProfileAvatar } from "@/components/creators/profile-ui";
import {
  CreatorSearchResults,
  SearchAvatar,
  SearchResultsSkeleton,
  creatorMetaLine,
} from "@/components/library/creator-search-results";
import {
  VideoLinkConfirm,
  effectiveVideoChoice,
  type VideoChoice,
} from "@/components/library/video-link-confirm";
import { AlertNote } from "@/components/ui/alert-note";
import { AppDialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PendingIndicator } from "@/components/ui/pending";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import { YtDlpSetupNote } from "@/components/ui/yt-dlp-setup-note";
import { useToast } from "@/components/ui/toast";
import type { CategoryColor, CategorySummary } from "@/lib/categories";
import type { CreatorProfileSummary } from "@/lib/creators/profile-service";
import type { CreatorSummary } from "@/lib/creators/service";
import type { CreatorPlatform } from "@/lib/creators/repository";
import {
  classifyCreatorInput,
  expandCreatorLink,
  type CreatorSearchError,
  type CreatorSearchResult,
} from "@/lib/creators/search/model";
import type { VideoPreview } from "@/lib/videos/import/service";
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
  /** Search results only: the platform's verified badge. */
  verified?: boolean;
  tweetId?: string | null;
  tweetText?: string | null;
  tweetUrl?: string | null;
  tweetPublishedAt?: string | null;
}

type DialogPhase = "input" | "confirming" | "saving";

type SearchState =
  | { status: "idle" }
  | { status: "loading"; query: string; platform: CreatorPlatform }
  | { status: "done"; query: string; platform: CreatorPlatform; results: CreatorSearchResult[] }
  | { status: "error"; query: string; platform: CreatorPlatform; error: CreatorSearchError };

const PLATFORM_OPTIONS = [
  { value: "youtube", label: "YouTube", icon: YouTubeLogo },
  { value: "rumble", label: "Rumble", icon: RumbleLogo },
  { value: "x", label: "X", icon: XLogo },
] as const;

const PLATFORM_NAMES: Record<CreatorPlatform, string> = {
  youtube: "YouTube",
  rumble: "Rumble",
  x: "X",
};

const PLATFORM_HINTS: Record<CreatorPlatform, string> = {
  youtube: "Search by channel name, or paste a channel link like youtube.com/@handle.",
  rumble: "Search by channel name, or paste a rumble.com channel link.",
  x: "Search by name, type an exact @handle, or paste a profile or post link.",
};

const PLATFORM_PLACEHOLDERS: Record<CreatorPlatform, string> = {
  youtube: "Search YouTube or paste a channel or video link",
  rumble: "Search Rumble or paste a channel or video link",
  x: "Search X or paste a profile link",
};

/** The toast line for a long title. */
function shortTitle(title: string): string {
  return title.length > 70 ? `${title.slice(0, 69)}…` : title;
}

const X_CONNECTION_CODES = new Set(["not_connected", "unsupported_runtime", "session_expired"]);

function previewFromResult(result: CreatorSearchResult): ResolvedPreview {
  return {
    platform: result.platform,
    platformUserId: result.platformUserId,
    displayName: result.displayName,
    handle: result.handle,
    channelUrl: result.channelUrl,
    avatarUrl: result.avatarUrl,
    youtubeChannelId: result.youtubeChannelId,
    followerCount: result.followerCount,
    verified: result.verified,
    tweetId: null,
    tweetText: null,
    tweetUrl: null,
    tweetPublishedAt: null,
  };
}

/** The person a creator page adds a platform to. */
export interface AddCreatorTarget {
  id: number;
  displayName: string;
  avatarUrl: string | null;
  avatarCreatorId: number | null;
}

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
  /**
   * Adds every saved account to this person (a creator page's "Add
   * platform"). Without it the confirm step asks whether the account is a
   * new creator or someone already in the library.
   */
  targetProfile?: AddCreatorTarget;
  /** Trigger text; defaults to "Add creator" (or "Add platform" with a target). */
  triggerLabel?: string;
}

/**
 * Add flow with one input that takes either a name or a link:
 * - A name searches the selected platform; each result can be added
 *   straight to the confirm step (no extra lookup), and after saving the
 *   dialog returns to the results so several creators can be added in a row.
 * - A link resolves on the server (pending state), shows the resolved
 *   creator for confirmation, then saves and closes.
 * While a resolve or save runs every control disables, so double presses
 * can never start a second yt-dlp job or save twice. Searches stay
 * cancellable: a new search, a platform switch, or closing aborts them.
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
  targetProfile,
  triggerLabel,
}: AddCreatorDialogProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<DialogPhase>("input");
  const [platform, setPlatform] = useState<CreatorPlatform>(initialPlatform);
  const [urlInput, setUrlInput] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  /** The search result being confirmed; null when the preview came from a link. */
  const [chosenResultId, setChosenResultId] = useState<string | null>(null);
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [notice, setNotice] = useState<string | null>(null);
  const [addedCount, setAddedCount] = useState(0);
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
  /** Everyone in the library, for "add to an existing creator"; null until loaded. */
  const [profiles, setProfiles] = useState<CreatorProfileSummary[] | null>(null);
  /** The user's explicit save target; null follows the suggested default. */
  const [targetChoice, setTargetChoice] = useState<SaveTarget | null>(null);
  /** A pasted video link, once looked up: the dialog is then deciding where it goes. */
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  const [videoChoice, setVideoChoice] = useState<VideoChoice>("person");
  const [videoProfileId, setVideoProfileId] = useState<number | null>(null);
  const [followHost, setFollowHost] = useState(false);
  const { showToast, toastElement } = useToast();
  const searchAbort = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = phase !== "input";
  const classified = classifyCreatorInput(urlInput, platform);
  // A dialog locked to one platform (the X Dashboard's) is not for video links.
  const inputKind = lockPlatform && classified === "video" ? "link" : classified;
  const lockedVideoPerson = targetProfile
    ? {
        id: targetProfile.id,
        displayName: targetProfile.displayName,
        avatarUrl: targetProfile.avatarUrl,
        avatarCreatorId: targetProfile.avatarCreatorId,
      }
    : undefined;

  useEffect(() => () => searchAbort.current?.abort(), []);

  const closeAndReset = (): void => {
    searchAbort.current?.abort();
    setOpen(false);
    // Let the closing animation finish before clearing state.
    window.setTimeout(() => {
      setUrlInput("");
      setPlatform(initialPlatform);
      setInlineError(null);
      setErrorCode(null);
      setPreview(null);
      setChosenResultId(null);
      setSearch({ status: "idle" });
      setNotice(null);
      setAddedCount(0);
      setSelectedCategoryIds(new Set());
      setCreatingCategory(false);
      setCategoryName("");
      setCategoryColor("sky");
      setTargetChoice(null);
      setVideoPreview(null);
      setVideoChoice("person");
      setVideoProfileId(null);
      setFollowHost(false);
      setProfiles(null);
      setPhase("input");
    }, 150);
  };

  const openDialog = (): void => {
    setAvailableCategories([...categories]);
    if (targetProfile && urlInput.length === 0) {
      // Most people use the same name everywhere: start the search with it.
      setUrlInput(targetProfile.displayName);
    }
    setOpen(true);
    if (!targetProfile) {
      void listProfilesAction().then(setProfiles);
    }
  };

  const clearFeedback = (): void => {
    setInlineError(null);
    setErrorCode(null);
  };

  const runSearch = async (text: string, target: CreatorPlatform): Promise<void> => {
    const query = text.trim().replace(/\s+/g, " ");
    if (query.length === 0) {
      return;
    }
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    clearFeedback();
    setNotice(null);
    setSearch({ status: "loading", query, platform: target });
    try {
      const params = new URLSearchParams({ platform: target, q: query });
      const response = await fetch(`/api/creators/search?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        results?: CreatorSearchResult[];
        error?: CreatorSearchError;
      };
      if (controller.signal.aborted) {
        return;
      }
      if (!response.ok || !Array.isArray(body.results)) {
        setSearch({
          status: "error",
          query,
          platform: target,
          error: body.error ?? {
            code: "unexpected_response",
            message: "The search could not finish. Please try again.",
          },
        });
        return;
      }
      setSearch({ status: "done", query, platform: target, results: body.results });
    } catch {
      if (controller.signal.aborted) {
        return;
      }
      setSearch({
        status: "error",
        query,
        platform: target,
        error: {
          code: "network",
          message: "scope's local server did not answer. Check that the app is still running.",
        },
      });
    }
  };

  const handleResolve = async (): Promise<void> => {
    if (busy) {
      return;
    }
    searchAbort.current?.abort();
    clearFeedback();
    setNotice(null);
    setPhase("confirming");
    const outcome = await resolveCreatorAction(expandCreatorLink(urlInput, platform), platform);
    if (!outcome.ok || !outcome.creator) {
      setInlineError(outcome.message ?? "That link could not be resolved.");
      setErrorCode(outcome.errorCode ?? null);
      setPhase("input");
      return;
    }
    setPreview(outcome.creator);
    setChosenResultId(null);
    setTargetChoice(null);
    setPhase("input");
  };

  /** Looks a pasted video link up (and checks it for English captions) before asking where it goes. */
  const handleResolveVideo = async (): Promise<void> => {
    if (busy) {
      return;
    }
    searchAbort.current?.abort();
    clearFeedback();
    setNotice(null);
    setPhase("confirming");
    const outcome = await previewVideoLinkAction(
      expandCreatorLink(urlInput, platform),
      targetProfile?.id,
    ).catch(() => null);
    if (outcome === null || !outcome.ok) {
      setInlineError(outcome?.message ?? "scope could not check that link. Please try again.");
      setErrorCode(outcome?.code ?? null);
      setPhase("input");
      return;
    }
    setVideoPreview(outcome.preview);
    setVideoChoice("person");
    setVideoProfileId(targetProfile?.id ?? null);
    setFollowHost(false);
    setPhase("input");
  };

  const handleSubmit = (): void => {
    if (inputKind === "video") {
      void handleResolveVideo();
    } else if (inputKind === "link") {
      void handleResolve();
    } else if (inputKind === "search") {
      void runSearch(urlInput, platform);
    }
  };

  const handleChoose = (result: CreatorSearchResult): void => {
    clearFeedback();
    setNotice(null);
    setPreview(previewFromResult(result));
    setChosenResultId(result.id);
    setTargetChoice(null);
  };

  const returnToInput = (): void => {
    setPreview(null);
    setVideoPreview(null);
    setChosenResultId(null);
    setTargetChoice(null);
    clearFeedback();
    setCreatingCategory(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const candidate = useMemo(
    () =>
      preview
        ? { displayName: preview.displayName, handle: preview.handle, platform: preview.platform }
        : null,
    [preview],
  );
  const saveTarget: SaveTarget = targetProfile
    ? { mode: "existing", profileId: targetProfile.id }
    : (targetChoice ?? (candidate ? defaultTarget(profiles, candidate) : { mode: "new" }));
  const targetName =
    saveTarget.mode === "existing"
      ? (targetProfile?.displayName ??
        profiles?.find((profile) => profile.id === saveTarget.profileId)?.displayName ??
        null)
      : null;

  const handleSave = async (): Promise<void> => {
    if (!preview || busy) {
      return;
    }
    setPhase("saving");
    const intoProfile = saveTarget.mode === "existing" ? saveTarget.profileId : null;
    const outcome = await saveCreatorAction(
      preview,
      intoProfile === null ? [...selectedCategoryIds] : [],
      intoProfile,
    );
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
    const fetchingPosts = isX && outcome.creator !== undefined && fetchAfterSave;
    if (fetchingPosts && outcome.creator) {
      void refreshCreatorTweetsAction(outcome.creator.id, "recent", 20);
    }
    const platformName = PLATFORM_NAMES[preview.platform];
    const savedMessage =
      targetName !== null
        ? outcome.status === "linked"
          ? `Moved ${name} on ${platformName} into ${targetName}`
          : alreadySaved
            ? `${name} on ${platformName} was already part of ${targetName}`
            : `Added ${name} on ${platformName} to ${targetName}`
        : alreadySaved
          ? `${name} was already in your library`
          : `Added ${name} to your library`;
    const message = `${savedMessage}.${fetchingPosts ? " Fetching recent posts in the background." : ""}`;

    if (chosenResultId !== null && search.status === "done" && outcome.creator) {
      // Back to the results so the next creator is one click away; the
      // saved row flips to "Added".
      const savedId = outcome.creator.id;
      setSearch({
        ...search,
        results: search.results.map((result) =>
          result.id === chosenResultId ? { ...result, savedCreatorId: savedId } : result,
        ),
      });
      setPreview(null);
      setChosenResultId(null);
      setSelectedCategoryIds(new Set());
      setCreatingCategory(false);
      setTargetChoice(null);
      // A new creator now exists; let the next pick find it.
      if (!targetProfile) {
        void listProfilesAction().then(setProfiles);
      }
      setNotice(message);
      setAddedCount((count) => count + 1);
      setPhase("input");
      return;
    }

    closeAndReset();
    showToast(message, "success");
  };

  const videoDestination = effectiveVideoChoice(videoChoice, profiles, lockedVideoPerson);
  const videoPersonName = targetProfile
    ? targetProfile.displayName
    : (profiles?.find((profile) => profile.id === videoProfileId)?.displayName ?? null);

  /** Adds the looked-up video to a person, or follows its channel as a creator. */
  const handleSaveVideo = async (): Promise<void> => {
    if (!videoPreview || busy) {
      return;
    }
    const title = shortTitle(videoPreview.title);
    clearFeedback();

    if (videoDestination === "person") {
      if (videoProfileId === null || videoPersonName === null) {
        return;
      }
      setPhase("saving");
      const outcome = await importVideosAction([videoPreview.url], {
        profileId: videoProfileId,
        followHost,
      }).catch(() => ({
        ok: false as const,
        message: "The video could not be added. Please try again.",
      }));
      const row = outcome.ok ? outcome.results[0] : undefined;
      if (!outcome.ok || !row || row.status === "rejected") {
        setInlineError(
          outcome.ok
            ? (row?.error?.message ?? "scope did not report back on this video. Try again.")
            : outcome.message,
        );
        setErrorCode(row?.error?.code ?? null);
        setPhase("input");
        return;
      }
      const followed = followHost && row.hostFollowedBefore === false;
      const message =
        row.status === "already_attached"
          ? `“${title}” was already in ${videoPersonName}'s Other videos.`
          : `Added “${title}” to ${videoPersonName}'s Other videos.${
              followed ? ` ${videoPreview.hostName} is in your library now too.` : ""
            }`;
      closeAndReset();
      showToast(message, "success");
      return;
    }

    setPhase("saving");
    const outcome = await followVideoChannelAction(videoPreview.url, [
      ...selectedCategoryIds,
    ]).catch(() => ({
      ok: false as const,
      code: "unexpected_response",
      message: "The channel could not be added. Please try again.",
      retryable: false,
    }));
    if (!outcome.ok) {
      setInlineError(outcome.message);
      setErrorCode(outcome.code);
      setPhase("input");
      return;
    }
    try {
      await onSaved?.(outcome.creator);
    } catch (error) {
      setInlineError(
        error instanceof Error
          ? error.message
          : "The creator was saved, but could not be added to this list. Try again.",
      );
      setPhase("input");
      return;
    }
    const name = outcome.creator.displayName;
    closeAndReset();
    showToast(
      outcome.status === "already_saved"
        ? `Added “${title}” under ${name}, who was already in your library.`
        : `Added ${name} to your library, with “${title}”.`,
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

  const switchPlatform = (next: CreatorPlatform): void => {
    if (next === platform) {
      return;
    }
    setPlatform(next);
    clearFeedback();
    setNotice(null);
    // Re-run the current name search on the new platform so comparing
    // platforms takes one click.
    if (search.status !== "idle" && classifyCreatorInput(urlInput, next) === "search") {
      void runSearch(urlInput, next);
    } else {
      searchAbort.current?.abort();
      setSearch({ status: "idle" });
    }
  };

  const isXConnectionError = errorCode !== null && X_CONNECTION_CODES.has(errorCode);

  const linkError =
    inlineError !== null ? (
      errorCode === "ytdlp_missing" ? (
        <YtDlpSetupNote />
      ) : isXConnectionError ? (
        <AlertNote tone="warning" politeness="polite" title="X needs a connection first.">
          <XInlineConnect onConnected={clearFeedback} />
        </AlertNote>
      ) : (
        <p id="creator-url-error" role="alert" className="text-sm text-destructive">
          {inlineError}
        </p>
      )
    ) : null;

  const categoriesSection = (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Categories</p>
          <p className="text-xs text-muted-foreground">Optional — choose as many as fit.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setCreatingCategory((value) => !value)}>
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
  );

  const searchPanel = (() => {
    if (search.status === "idle") {
      return null;
    }
    if (search.status === "loading") {
      return <SearchResultsSkeleton platform={search.platform} />;
    }
    if (search.status === "error") {
      const { error } = search;
      if (error.code === "ytdlp_missing") {
        return <YtDlpSetupNote />;
      }
      if (X_CONNECTION_CODES.has(error.code)) {
        return (
          <AlertNote tone="warning" politeness="polite" title="X needs a connection first.">
            <XInlineConnect
              purpose="search"
              onConnected={() => void runSearch(search.query, search.platform)}
            />
          </AlertNote>
        );
      }
      return (
        <AlertNote
          tone={error.code === "desktop_required" ? "info" : "danger"}
          politeness={error.code === "desktop_required" ? "polite" : "assertive"}
          action={
            error.code === "desktop_required" ? null : (
              <Button
                size="sm"
                variant="outline"
                className="bg-background"
                onClick={() => void runSearch(search.query, search.platform)}
              >
                Try again
              </Button>
            )
          }
        >
          {error.message}
        </AlertNote>
      );
    }
    return (
      <CreatorSearchResults
        platform={search.platform}
        query={search.query}
        results={search.results}
        onAdd={handleChoose}
      />
    );
  })();

  const previewMeta = preview
    ? creatorMetaLine(preview.platform, preview.handle, preview.followerCount)
    : "";

  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={openDialog}>
        <UserPlus aria-hidden="true" />
        {triggerLabel ?? (targetProfile ? "Add platform" : "Add creator")}
      </Button>

      <AppDialog
        open={open}
        onClose={closeAndReset}
        busy={busy || categoryPending}
        title={targetProfile ? `Add a platform to ${targetProfile.displayName}` : "Add a creator"}
        description={
          targetProfile
            ? `Find ${targetProfile.displayName} on another platform by name, or paste a link. The account joins their page, feed, and AI chat. A video link adds just that video to their Other videos.`
            : lockPlatform
              ? `Search ${PLATFORM_NAMES[initialPlatform]} by name or paste a link.${initialPlatform === "x" ? " X post links also import that one post." : ""}`
              : "Search by name or paste a link. Paste a YouTube or Rumble video link to add just that video to someone; an X post link imports that one post."
        }
        // Top-anchored so the search box stays put while results load in.
        className="max-w-xl sm:mt-[10dvh] sm:max-h-[calc(90dvh-1rem)]"
      >
        {!preview && !videoPreview && !busy ? (
          <div className="flex flex-col gap-4">
            <form
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                handleSubmit();
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
                        onClick={() => switchPlatform(option.value)}
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
                  Find a creator
                </label>
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    {inputKind === "link" || inputKind === "video" ? (
                      <Link2
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                      />
                    ) : (
                      <Search
                        aria-hidden="true"
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                      />
                    )}
                    <input
                      ref={inputRef}
                      id="creator-url"
                      name="url"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      enterKeyHint={inputKind === "link" || inputKind === "video" ? "go" : "search"}
                      placeholder={PLATFORM_PLACEHOLDERS[platform]}
                      value={urlInput}
                      onChange={(event) => {
                        setUrlInput(event.target.value);
                        clearFeedback();
                      }}
                      aria-invalid={inlineError ? true : undefined}
                      aria-describedby={
                        inlineError && errorCode !== "ytdlp_missing"
                          ? "creator-url-error"
                          : "creator-url-hint"
                      }
                      className="h-10 w-full rounded-md border border-input bg-background pr-9 pl-9 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-destructive"
                    />
                    {urlInput.length > 0 ? (
                      <button
                        type="button"
                        aria-label="Clear"
                        onClick={() => {
                          setUrlInput("");
                          clearFeedback();
                          inputRef.current?.focus();
                        }}
                        className="absolute top-1/2 right-1.5 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X aria-hidden="true" className="size-3.5" />
                      </button>
                    ) : null}
                  </div>
                  <Button type="submit" className="h-10" disabled={inputKind === "empty"}>
                    {inputKind === "link" || inputKind === "video" ? (
                      <>
                        Look up
                        <ArrowRight aria-hidden="true" />
                      </>
                    ) : (
                      "Search"
                    )}
                  </Button>
                </div>
                {linkError ?? (
                  <p id="creator-url-hint" className="text-xs text-muted-foreground">
                    {inputKind === "video"
                      ? "Video link detected. scope will check it for English captions, then you choose where it goes."
                      : inputKind === "link"
                        ? urlInput.trim().startsWith("@")
                          ? `Exact handle. scope will look up ${urlInput.trim()} directly.`
                          : "Link detected. scope will look up this creator directly."
                        : PLATFORM_HINTS[platform]}
                  </p>
                )}
              </div>
            </form>

            {notice ? (
              <AlertNote tone="success" politeness="polite">
                {notice}
              </AlertNote>
            ) : null}

            {searchPanel}

            <div
              className={cn(
                "flex items-center justify-end gap-2",
                // Keep Done/Cancel reachable while long result lists scroll.
                search.status !== "idle" &&
                  "sticky bottom-0 -mx-6 -mb-5 border-t bg-card px-6 py-3",
              )}
            >
              {addedCount > 0 ? (
                <p className="mr-auto text-xs text-muted-foreground">
                  {addedCount}{" "}
                  {targetProfile
                    ? addedCount === 1
                      ? "account"
                      : "accounts"
                    : addedCount === 1
                      ? "creator"
                      : "creators"}{" "}
                  added
                </p>
              ) : null}
              <Button variant={addedCount > 0 ? "default" : "ghost"} onClick={closeAndReset}>
                {addedCount > 0 ? "Done" : "Cancel"}
              </Button>
            </div>
          </div>
        ) : null}

        {preview && !busy ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              {targetProfile
                ? `Does this look right? Confirm to add it to ${targetProfile.displayName}.`
                : chosenResultId !== null
                  ? "Choose where it belongs, then save it to your library."
                  : "Does this look right? Confirm to save it to your library."}
            </p>
            <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
              <SearchAvatar
                name={preview.displayName}
                src={preview.avatarUrl}
                className="size-12"
              />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1 font-semibold">
                  <span className="truncate">{preview.displayName}</span>
                  {preview.verified ? (
                    <BadgeCheck
                      role="img"
                      aria-label="Verified"
                      className="size-4 shrink-0 text-sky-500"
                    />
                  ) : null}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {previewMeta || (preview.platform === "x" ? "X account" : "Channel")}
                </p>
              </div>
              <Badge variant="outline" className="shrink-0 gap-1.5">
                {preview.platform === "x" ? (
                  <XLogo aria-hidden="true" className="size-3 text-foreground" />
                ) : preview.platform === "rumble" ? (
                  <RumbleLogo aria-hidden="true" className="size-3" />
                ) : (
                  <YouTubeLogo aria-hidden="true" className="size-3" />
                )}
                {PLATFORM_NAMES[preview.platform]}
              </Badge>
            </div>
            {preview.platform === "x" && preview.tweetId ? (
              <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                Saving also imports this post so it is cached right away
                {preview.tweetText
                  ? `: “${preview.tweetText.replace(/\s+/g, " ").slice(0, 160)}${preview.tweetText.length > 160 ? "…" : ""}”`
                  : "."}
              </p>
            ) : null}
            {targetProfile ? (
              <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5">
                <ProfileAvatar
                  name={targetProfile.displayName}
                  avatarUrl={targetProfile.avatarUrl}
                  avatarCreatorId={targetProfile.avatarCreatorId}
                  className="size-8 text-[11px]"
                />
                <p className="min-w-0 text-sm text-muted-foreground">
                  Joins{" "}
                  <span className="font-medium text-foreground">{targetProfile.displayName}</span>{" "}
                  and shares their categories.
                </p>
              </div>
            ) : candidate ? (
              <ProfileTargetPicker
                profiles={profiles}
                candidate={candidate}
                value={saveTarget}
                onChange={setTargetChoice}
              />
            ) : null}
            {saveTarget.mode === "new" ? categoriesSection : null}
            {inlineError ? (
              <p role="alert" className="text-sm text-destructive">
                {inlineError}
              </p>
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={returnToInput}>
                {chosenResultId !== null ? "Back to results" : "Back"}
              </Button>
              <Button
                onClick={() => void handleSave()}
                disabled={saveTarget.mode === "existing" && targetName === null}
              >
                {targetName !== null
                  ? `Add to ${targetName}`
                  : preview.platform === "x" && fetchAfterSave
                    ? "Add and fetch recent tweets"
                    : "Save to library"}
              </Button>
            </div>
          </div>
        ) : null}

        {videoPreview && !busy ? (
          <div className="flex flex-col gap-4">
            <VideoLinkConfirm
              preview={videoPreview}
              profiles={profiles}
              lockedPerson={lockedVideoPerson}
              choice={videoChoice}
              onChoice={setVideoChoice}
              profileId={videoProfileId}
              onProfileId={setVideoProfileId}
              followHost={followHost}
              onFollowHost={setFollowHost}
              categories={categoriesSection}
            />
            {linkError}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
              <Button variant="ghost" onClick={returnToInput}>
                Back
              </Button>
              <Button
                onClick={() => void handleSaveVideo()}
                disabled={videoDestination === "person" && videoPersonName === null}
                // With the person fixed there is nothing to choose, so this is the next step.
                autoFocus={lockedVideoPerson !== undefined}
              >
                {videoDestination === "person"
                  ? videoPersonName !== null
                    ? `Add video to ${videoPersonName}`
                    : "Add video"
                  : `Follow ${videoPreview.hostName}`}
              </Button>
            </div>
          </div>
        ) : null}

        {busy ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 py-6 text-center">
            <PendingIndicator
              label={
                phase === "confirming"
                  ? inputKind === "video"
                    ? "Checking the video and its captions…"
                    : "Looking up this link's identity…"
                  : videoPreview
                    ? "Adding the video…"
                    : "Saving to your library…"
              }
              hint={phase === "confirming" ? "This can take up to a minute." : undefined}
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
