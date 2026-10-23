"use client";

import { useMemo, useState } from "react";
import { Check, Search, Sparkles, UserPlus, Users } from "lucide-react";

import { CategoryChip } from "@/components/categories/category-chip";
import {
  PlatformMarks,
  ProfileAvatar,
  handleSummary,
  joinPlatformNames,
  platformsOf,
} from "@/components/creators/profile-ui";
import type { CreatorProfileSummary } from "@/lib/creators/profile-service";
import { identitiesMatch, normalizeIdentity } from "@/lib/creators/profile-match";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { cn } from "@/lib/utils";

export type SaveTarget = { mode: "new" } | { mode: "existing"; profileId: number };

export interface TargetCandidate {
  displayName: string;
  handle: string | null;
  platform: CreatorPlatform;
}

function identityOf(profile: CreatorProfileSummary) {
  return {
    displayName: profile.displayName,
    handles: profile.accounts.flatMap((account) => [account.handle, account.displayName]),
  };
}

/** True when the person already has this exact account (same platform and handle). */
function holdsAccount(profile: CreatorProfileSummary, candidate: TargetCandidate): boolean {
  const handle = normalizeIdentity(candidate.handle);
  return (
    handle.length > 0 &&
    profile.accounts.some(
      (account) =>
        account.platform === candidate.platform && normalizeIdentity(account.handle) === handle,
    )
  );
}

/**
 * People in the library who look like the account being added (same name
 * or a shared handle), best first: those not yet on this platform lead,
 * since a second account on the same platform is the rarer case.
 */
export function suggestTargets(
  profiles: readonly CreatorProfileSummary[],
  candidate: TargetCandidate,
): CreatorProfileSummary[] {
  const identity = { displayName: candidate.displayName, handles: [candidate.handle] };
  return profiles
    .filter((profile) => !holdsAccount(profile, candidate))
    .filter((profile) => identitiesMatch(identity, identityOf(profile)))
    .sort(
      (a, b) =>
        Number(a.accounts.some((account) => account.platform === candidate.platform)) -
          Number(b.accounts.some((account) => account.platform === candidate.platform)) ||
        b.accounts.length - a.accounts.length,
    );
}

/** The automatic choice before the user picks: the best match, else a new creator. */
export function defaultTarget(
  profiles: readonly CreatorProfileSummary[] | null,
  candidate: TargetCandidate,
): SaveTarget {
  const [best] = profiles ? suggestTargets(profiles, candidate) : [];
  return best ? { mode: "existing", profileId: best.id } : { mode: "new" };
}

/**
 * A searchable list of the people in the library, one choice selected. Shared
 * by the account picker below and the video branch of the add dialog. People in
 * `suggestions` lead the list and carry a sparkle; everyone else follows
 * alphabetically. Typing filters by name or handle.
 */
export function ProfileSearchList({
  profiles,
  suggestions = [],
  selectedId,
  onSelect,
  searchLabel,
  placeholder = "Find a creator in your library…",
  disabled = false,
}: {
  /** Everyone in the library; null while loading. */
  profiles: readonly CreatorProfileSummary[] | null;
  suggestions?: readonly CreatorProfileSummary[];
  selectedId: number | null;
  onSelect: (profileId: number) => void;
  /** Accessible name of the search box. */
  searchLabel: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const suggestedIds = new Set(suggestions.map((profile) => profile.id));
  const needle = query.trim().toLowerCase();
  const options = useMemo(() => {
    if (!profiles) {
      return [];
    }
    const ordered = [
      ...suggestions,
      ...profiles
        .filter((profile) => !suggestedIds.has(profile.id))
        .sort((a, b) =>
          a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
        ),
    ];
    return needle
      ? ordered.filter(
          (profile) =>
            profile.displayName.toLowerCase().includes(needle) ||
            profile.accounts.some((account) => account.handle?.toLowerCase().includes(needle)),
        )
      : ordered;
    // suggestedIds is derived from suggestions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, suggestions, needle]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          aria-label={searchLabel}
          placeholder={placeholder}
          value={query}
          disabled={disabled}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&::-webkit-search-cancel-button]:hidden"
        />
      </div>
      <ul
        role="listbox"
        aria-label="Creators in your library"
        className="max-h-44 overflow-y-auto overscroll-contain rounded-lg border"
      >
        {options.map((profile) => {
          const selected = selectedId === profile.id;
          const handles = handleSummary(profile.accounts);
          return (
            <li key={profile.id} role="option" aria-selected={selected}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(profile.id)}
                className={cn(
                  "flex w-full items-center gap-3 border-b px-3 py-2 text-left outline-none transition-colors last:border-b-0 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed motion-reduce:transition-none",
                  selected ? "bg-accent/60" : "hover:bg-accent/30",
                )}
              >
                <ProfileAvatar
                  name={profile.displayName}
                  avatarUrl={profile.avatarUrl}
                  avatarCreatorId={profile.avatarCreatorId}
                  className="size-8 text-[11px]"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{profile.displayName}</span>
                    {suggestedIds.has(profile.id) ? (
                      <Sparkles
                        role="img"
                        aria-label="Suggested match"
                        className="size-3 shrink-0 text-sky-600 dark:text-sky-400"
                      />
                    ) : null}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <PlatformMarks platforms={platformsOf(profile.accounts)} />
                    {handles ? <span className="truncate">{handles}</span> : null}
                  </span>
                </span>
                {selected ? (
                  <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                ) : null}
              </button>
            </li>
          );
        })}
        {options.length === 0 ? (
          <li className="px-3 py-5 text-center text-sm text-muted-foreground">
            {profiles === null
              ? "Loading your library…"
              : profiles.length === 0
                ? "Your library is empty."
                : "No creators match that search."}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/**
 * The add flow's "who is this?" step: save the account as a new creator, or
 * add it to someone already in the library so every platform shares one
 * card. A likely match is preselected and called out; any other person can
 * be searched for.
 */
export function ProfileTargetPicker({
  profiles,
  candidate,
  value,
  onChange,
}: {
  /** Everyone in the library; null while loading. */
  profiles: readonly CreatorProfileSummary[] | null;
  candidate: TargetCandidate;
  value: SaveTarget;
  onChange: (target: SaveTarget) => void;
}) {
  const suggestions = useMemo(
    () => (profiles ? suggestTargets(profiles, candidate) : []),
    [profiles, candidate],
  );
  const chosen =
    value.mode === "existing"
      ? (profiles?.find((profile) => profile.id === value.profileId) ?? null)
      : null;

  const hasLibrary = profiles !== null && profiles.length > 0;
  const topSuggestion = suggestions[0] ?? null;
  const firstProfile = profiles
    ? ([...profiles].sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
      )[0] ?? null)
    : null;

  const choiceClass = (active: boolean) =>
    cn(
      "flex flex-1 items-start gap-2.5 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
      active ? "border-foreground/30 bg-accent/60 shadow-sm" : "bg-background hover:bg-accent/30",
    );

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="sr-only">Save as</legend>

      {topSuggestion && !(value.mode === "existing" && value.profileId === topSuggestion.id) ? (
        <div className="flex items-center gap-3 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2.5 dark:border-sky-900/70 dark:bg-sky-950/30">
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-sky-600 dark:text-sky-400" />
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Looks like{" "}
            <span className="font-medium text-foreground">{topSuggestion.displayName}</span>,
            already in your library on {joinPlatformNames(platformsOf(topSuggestion.accounts))}.
          </p>
          <button
            type="button"
            onClick={() => onChange({ mode: "existing", profileId: topSuggestion.id })}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-sky-700 outline-none hover:bg-sky-100 focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-300 dark:hover:bg-sky-900/40"
          >
            Add to them
          </button>
        </div>
      ) : null}

      <div role="radiogroup" aria-label="Save as" className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          role="radio"
          aria-checked={value.mode === "new"}
          onClick={() => onChange({ mode: "new" })}
          className={choiceClass(value.mode === "new")}
        >
          <UserPlus aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">New creator</span>
            <span className="block text-xs text-muted-foreground">Gets a card of its own.</span>
          </span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={value.mode === "existing"}
          disabled={!hasLibrary}
          onClick={() =>
            onChange({
              mode: "existing",
              profileId: chosen?.id ?? topSuggestion?.id ?? firstProfile?.id ?? 0,
            })
          }
          className={cn(
            choiceClass(value.mode === "existing"),
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Users aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span className="block text-sm font-medium">Add to an existing creator</span>
            <span className="block text-xs text-muted-foreground">
              {hasLibrary ? "Same person on another platform." : "Your library is empty."}
            </span>
          </span>
        </button>
      </div>

      {value.mode === "existing" ? (
        <div className="flex flex-col gap-2">
          <ProfileSearchList
            profiles={profiles}
            suggestions={suggestions}
            selectedId={value.profileId}
            onSelect={(profileId) => onChange({ mode: "existing", profileId })}
            searchLabel="Find the creator to add this account to"
          />
          {chosen && chosen.categories.length > 0 ? (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              Filed under {chosen.displayName}&apos;s categories:
              {chosen.categories.map((category) => (
                <CategoryChip key={category.id} category={category} className="max-w-28" />
              ))}
            </p>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
