"use client";

import { useMemo, useState } from "react";
import { Check, Link2, Search, Sparkles, X } from "lucide-react";

import { linkProfilesAction } from "@/app/actions/creators";
import {
  PLATFORM_LABELS,
  PlatformLogo,
  PlatformMarks,
  ProfileAvatar,
  handleSummary,
  joinPlatformNames,
  platformsOf,
} from "@/components/creators/profile-ui";
import { AppDialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CreatorAccountSummary, CreatorProfileSummary } from "@/lib/creators/profile-service";
import { identitiesMatch } from "@/lib/creators/profile-match";
import { cn } from "@/lib/utils";

/** The slice of a person the dialog needs; library and page models both fit. */
export interface LinkableProfile extends Pick<
  CreatorProfileSummary,
  "id" | "displayName" | "avatarUrl" | "avatarCreatorId"
> {
  accounts: readonly Pick<CreatorAccountSummary, "platform" | "handle" | "displayName">[];
}

interface LinkCreatorsDialogProps {
  open: boolean;
  onClose: () => void;
  /** The person the chosen creators are linked into. */
  target: LinkableProfile;
  /** Everyone in the library; the target itself is skipped. */
  profiles: readonly LinkableProfile[];
  /** Creators ticked when the dialog opens (e.g. from a suggestion). */
  preselectedIds?: readonly number[];
  /**
   * Likely matches from the library's suggestions (which remember "not the
   * same" answers). Omitted, matches are judged by name and handle here.
   */
  suggestedIds?: readonly number[];
  /** Called after a successful link with a confirmation message to show. */
  onLinked?: (message: string) => void;
}

function identityOf(profile: LinkableProfile) {
  return {
    displayName: profile.displayName,
    handles: profile.accounts.flatMap((account) => [account.handle, account.displayName]),
  };
}

/**
 * Links other creators into one person. Likely matches (same name or a
 * shared handle) float to the top with a "Suggested" mark, and the header
 * previews the person the link produces — name, avatar, and every platform —
 * so the result is clear before anything moves.
 */
export function LinkCreatorsDialog({
  open,
  onClose,
  target,
  profiles,
  preselectedIds = [],
  suggestedIds,
  onLinked,
}: LinkCreatorsDialogProps) {
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={`Link accounts to ${target.displayName}`}
      description="Pick the creators that are the same person. Their platforms, cached videos and posts, and categories join this creator — nothing is deleted, and any account can be unlinked again later."
      className="max-w-xl sm:mt-[10dvh] sm:max-h-[calc(90dvh-1rem)]"
    >
      {open ? (
        <LinkCreatorsBody
          key={`${target.id}:${preselectedIds.join(",")}`}
          onClose={onClose}
          target={target}
          profiles={profiles}
          preselectedIds={preselectedIds}
          suggestedIds={suggestedIds}
          onLinked={onLinked}
        />
      ) : null}
    </AppDialog>
  );
}

function LinkCreatorsBody({
  onClose,
  target,
  profiles,
  preselectedIds = [],
  suggestedIds,
  onLinked,
}: Omit<LinkCreatorsDialogProps, "open">) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(preselectedIds));
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetIdentity = useMemo(() => identityOf(target), [target]);
  const candidates = useMemo(() => {
    const others = profiles
      .filter((profile) => profile.id !== target.id)
      .map((profile) => ({
        profile,
        suggested: suggestedIds
          ? suggestedIds.includes(profile.id)
          : identitiesMatch(targetIdentity, identityOf(profile)),
      }));
    // Suggestions first, each half alphabetical.
    return others.sort(
      (a, b) =>
        Number(b.suggested) - Number(a.suggested) ||
        a.profile.displayName.localeCompare(b.profile.displayName, undefined, {
          sensitivity: "base",
        }),
    );
  }, [profiles, target.id, targetIdentity, suggestedIds]);

  const needle = query.trim().toLowerCase();
  const visible = needle
    ? candidates.filter(
        ({ profile }) =>
          profile.displayName.toLowerCase().includes(needle) ||
          profile.accounts.some(
            (account) =>
              account.handle?.toLowerCase().includes(needle) ||
              account.displayName.toLowerCase().includes(needle),
          ),
      )
    : candidates;

  const chosen = candidates
    .filter(({ profile }) => selected.has(profile.id))
    .map(({ profile }) => profile);
  const resultAccounts = [...target.accounts, ...chosen.flatMap((profile) => profile.accounts)];
  const resultPlatforms = platformsOf(resultAccounts);

  const toggle = (id: number): void => {
    setError(null);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const link = async (): Promise<void> => {
    if (selected.size === 0 || pending) {
      return;
    }
    setPending(true);
    setError(null);
    const outcome = await linkProfilesAction(target.id, [...selected]);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "Those creators could not be linked.");
      return;
    }
    onClose();
    const sameName = chosen.every(
      (profile) =>
        profile.displayName.trim().toLowerCase() === target.displayName.trim().toLowerCase(),
    );
    onLinked?.(
      sameName
        ? `${target.displayName} now has ${joinPlatformNames(resultPlatforms)} on one card.`
        : `Linked ${chosen.length === 1 ? chosen[0].displayName : `${chosen.length} creators`} into ${target.displayName}.`,
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-label="After linking"
        className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3"
      >
        <ProfileAvatar
          name={target.displayName}
          avatarUrl={target.avatarUrl}
          avatarCreatorId={target.avatarCreatorId}
          className="size-11 text-sm"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{target.displayName}</p>
          <p className="truncate text-xs text-muted-foreground">
            {resultAccounts.length} {resultAccounts.length === 1 ? "account" : "accounts"}
            {chosen.length > 0 ? " after linking" : ""}
          </p>
        </div>
        <ul aria-label="Platforms" className="flex shrink-0 flex-wrap justify-end gap-1">
          {resultPlatforms.map((platform) => (
            <li key={platform}>
              <Badge variant="outline" className="gap-1.5 bg-background">
                <PlatformLogo platform={platform} className="size-3" />
                {PLATFORM_LABELS[platform]}
              </Badge>
            </li>
          ))}
        </ul>
      </section>

      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          aria-label="Search creators to link"
          placeholder="Search creators…"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-9 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          There are no other creators in your library yet. Add this person&apos;s other platforms
          with <span className="font-medium text-foreground">Add platform</span> on their page.
        </p>
      ) : (
        <ul
          aria-label="Creators"
          className="max-h-[min(20rem,40dvh)] overflow-y-auto overscroll-contain rounded-lg border"
        >
          {visible.map(({ profile, suggested }) => {
            const checked = selected.has(profile.id);
            const handles = handleSummary(profile.accounts);
            return (
              <li key={profile.id} className="border-b last:border-b-0">
                <button
                  type="button"
                  aria-pressed={checked}
                  onClick={() => toggle(profile.id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                    checked ? "bg-accent/50" : "hover:bg-accent/30",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center rounded-md border",
                      checked && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {checked ? <Check className="size-3.5" /> : null}
                  </span>
                  <ProfileAvatar
                    name={profile.displayName}
                    avatarUrl={profile.avatarUrl}
                    avatarCreatorId={profile.avatarCreatorId}
                    className="size-9 text-xs"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">{profile.displayName}</span>
                      {suggested ? (
                        <Badge
                          variant="secondary"
                          className="shrink-0 gap-1 px-1.5 py-0 text-[10px] font-medium"
                        >
                          <Sparkles aria-hidden="true" className="size-2.5" />
                          Suggested
                        </Badge>
                      ) : null}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <PlatformMarks platforms={platformsOf(profile.accounts)} />
                      {handles ? <span className="truncate">{handles}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {visible.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No creators match that search.
            </li>
          ) : null}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-end">
        <p className="text-xs text-muted-foreground sm:mr-auto">
          {selected.size === 0
            ? "Nothing selected yet."
            : `${selected.size} ${selected.size === 1 ? "creator" : "creators"} selected`}
        </p>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={() => void link()} disabled={selected.size === 0 || pending}>
          <Link2 aria-hidden="true" />
          {pending
            ? "Linking…"
            : selected.size > 1
              ? `Link ${selected.size} creators`
              : "Link creator"}
        </Button>
      </div>
    </div>
  );
}
