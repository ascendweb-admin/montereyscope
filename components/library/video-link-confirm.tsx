"use client";

import type { ReactNode } from "react";
import { Clock3, ListVideo, UserPlus } from "lucide-react";

import { ProfileSearchList } from "@/components/creators/profile-target-picker";
import { ProfileAvatar } from "@/components/creators/profile-ui";
import { VideoPreviewSummary } from "@/components/creators/video-preview-card";
import { Switch } from "@/components/ui/switch";
import type { CreatorProfileSummary } from "@/lib/creators/profile-service";
import type { VideoPreview } from "@/lib/videos/import/service";
import { cn } from "@/lib/utils";

/** What to do with a pasted video link. */
export type VideoChoice = "person" | "follow";

/** The person the dialog was opened for ("Add platform"): the only place the video can go. */
export interface LockedVideoPerson {
  id: number;
  displayName: string;
  avatarUrl: string | null;
  avatarCreatorId: number | null;
}

interface VideoLinkConfirmProps {
  preview: VideoPreview;
  /** Everyone in the library; null while loading. */
  profiles: readonly CreatorProfileSummary[] | null;
  lockedPerson?: LockedVideoPerson;
  choice: VideoChoice;
  onChoice: (choice: VideoChoice) => void;
  /** The person chosen from the list (the locked person when there is one). */
  profileId: number | null;
  onProfileId: (profileId: number) => void;
  /** "Also follow {host}" while adding to a person. */
  followHost: boolean;
  onFollowHost: (followHost: boolean) => void;
  /** The categories picker, shown with "Follow {host} as a creator". */
  categories: ReactNode;
}

/**
 * The choice that applies: a locked person always receives the video, and with
 * an empty library there is nobody to add it to, so following the channel is
 * the only way in.
 */
export function effectiveVideoChoice(
  choice: VideoChoice,
  profiles: readonly CreatorProfileSummary[] | null,
  lockedPerson: LockedVideoPerson | undefined,
): VideoChoice {
  if (lockedPerson !== undefined) {
    return "person";
  }
  return profiles !== null && profiles.length === 0 ? "follow" : choice;
}

const choiceClass = (active: boolean): string =>
  cn(
    "flex flex-1 items-start gap-2.5 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
    active ? "border-foreground/30 bg-accent/60 shadow-sm" : "bg-background hover:bg-accent/30",
  );

/**
 * The Add creator dialog's step for a pasted video link: what the video is,
 * then where it goes. Either into a person's Other videos (optionally
 * following its channel too), or as a followed creator whose channel joins the
 * library with this one video. The dialog owns the state and the buttons.
 */
export function VideoLinkConfirm({
  preview,
  profiles,
  lockedPerson,
  choice,
  onChoice,
  profileId,
  onProfileId,
  followHost,
  onFollowHost,
  categories,
}: VideoLinkConfirmProps) {
  const hasLibrary = profiles !== null && profiles.length > 0;
  const toPerson = effectiveVideoChoice(choice, profiles, lockedPerson) === "person";

  const followSwitch = (
    <label className="flex items-start gap-2.5 text-sm">
      <Switch
        checked={followHost}
        onChange={(event) => onFollowHost(event.target.checked)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        Also follow {preview.hostName}
        <span className="block text-xs text-muted-foreground">
          Adds the channel to your library, with its own feed.
        </span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border bg-muted/30 p-3">
        <VideoPreviewSummary preview={preview} />
      </div>

      {preview.alreadyAttached && lockedPerson ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock3 aria-hidden="true" className="size-3.5 shrink-0" />
          Already in {lockedPerson.displayName}&apos;s Other videos.
        </p>
      ) : null}

      {lockedPerson ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5">
            <ProfileAvatar
              name={lockedPerson.displayName}
              avatarUrl={lockedPerson.avatarUrl}
              avatarCreatorId={lockedPerson.avatarCreatorId}
              className="size-8 text-[11px]"
            />
            <p className="min-w-0 text-sm text-muted-foreground">
              Goes to{" "}
              <span className="font-medium text-foreground">{lockedPerson.displayName}</span>
              &apos;s Other videos.
            </p>
          </div>
          {followSwitch}
        </div>
      ) : (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="sr-only">What to do with this video</legend>
          <div
            role="radiogroup"
            aria-label="What to do with this video"
            className="flex flex-col gap-2 sm:flex-row"
          >
            <button
              type="button"
              role="radio"
              aria-checked={toPerson}
              disabled={profiles !== null && !hasLibrary}
              // The step replaces the input that had focus, so keyboard users start here.
              autoFocus={toPerson}
              onClick={() => onChoice("person")}
              className={choiceClass(toPerson)}
            >
              <ListVideo
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Add to a person</span>
                <span className="block text-xs text-muted-foreground">
                  {profiles !== null && !hasLibrary
                    ? "Your library is empty."
                    : "Joins their Other videos."}
                </span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!toPerson}
              autoFocus={!toPerson}
              onClick={() => onChoice("follow")}
              className={choiceClass(!toPerson)}
            >
              <UserPlus
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  Follow {preview.hostName} as a creator
                </span>
                <span className="block text-xs text-muted-foreground">
                  Adds the channel and this video.
                </span>
              </span>
            </button>
          </div>

          {toPerson ? (
            <>
              <ProfileSearchList
                profiles={profiles}
                selectedId={profileId}
                onSelect={onProfileId}
                searchLabel="Find the person to add this video to"
              />
              {followSwitch}
            </>
          ) : (
            categories
          )}
        </fieldset>
      )}
    </div>
  );
}
