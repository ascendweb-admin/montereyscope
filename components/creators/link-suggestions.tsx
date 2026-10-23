"use client";

import { useState } from "react";
import { ChevronDown, Link2, Sparkles } from "lucide-react";

import { dismissLinkSuggestionAction } from "@/app/actions/creators";
import {
  PlatformMarks,
  ProfileAvatar,
  joinPlatformNames,
  platformsOf,
} from "@/components/creators/profile-ui";
import { Button } from "@/components/ui/button";
import type { ToastTone } from "@/components/ui/toast";
import type { ProfileLinkSuggestion } from "@/lib/creators/profile-suggestions";
import type { CreatorPlatform } from "@/lib/creators/repository";

interface SuggestionCreator {
  id: number;
  displayName: string;
  avatarUrl: string | null;
  avatarCreatorId: number | null;
  accounts: readonly { platform: CreatorPlatform }[];
}

const INITIALLY_SHOWN = 2;

/** "Jane Doe", "Jane Doe & Jane", "Jane Doe, Jane & J. Doe". */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/**
 * The library's "same person?" prompt: creators whose names or handles
 * match are offered for linking, one group per row. Review opens the link
 * dialog with the group preselected; "Not the same" remembers the answer so
 * the group is never suggested again.
 */
export function LinkSuggestions({
  suggestions,
  creators,
  onReview,
  onMessage,
}: {
  suggestions: readonly ProfileLinkSuggestion[];
  creators: readonly SuggestionCreator[];
  onReview: (suggestion: ProfileLinkSuggestion) => void;
  onMessage: (message: string, tone: ToastTone) => void;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState(false);
  const byId = new Map(creators.map((creator) => [creator.id, creator]));

  const groups = suggestions
    .filter((suggestion) => !dismissed.has(suggestion.profileIds.join("-")))
    .map((suggestion) => ({
      suggestion,
      members: suggestion.profileIds
        .map((id) => byId.get(id))
        .filter((creator): creator is SuggestionCreator => creator !== undefined),
    }))
    .filter((group) => group.members.length > 1);

  if (groups.length === 0) {
    return null;
  }

  const shown = expanded ? groups : groups.slice(0, INITIALLY_SHOWN);
  const hiddenCount = groups.length - shown.length;

  const dismiss = async (suggestion: ProfileLinkSuggestion): Promise<void> => {
    const key = suggestion.profileIds.join("-");
    setDismissed((current) => new Set(current).add(key));
    const outcome = await dismissLinkSuggestionAction(suggestion.profileIds);
    if (!outcome.ok) {
      setDismissed((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
      onMessage(outcome.message ?? "The suggestion could not be dismissed.", "error");
    }
  };

  return (
    <section
      aria-labelledby="link-suggestions-heading"
      className="mb-4 rounded-xl border border-sky-200 bg-sky-50/60 p-3 sm:p-4 dark:border-sky-900/70 dark:bg-sky-950/20"
    >
      <div className="flex items-start gap-2.5">
        <Sparkles
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400"
        />
        <div className="min-w-0">
          <h2 id="link-suggestions-heading" className="text-sm font-semibold">
            Same person on different platforms?
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These creators share a name or handle. Linking puts every platform on one card, and AI
            research treats their videos and posts as one person&apos;s.
          </p>
        </div>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {shown.map(({ suggestion, members }) => {
          const platforms = platformsOf(members.flatMap((member) => member.accounts));
          const names = joinNames([...new Set(members.map((member) => member.displayName))]);
          return (
            <li
              key={suggestion.profileIds.join("-")}
              className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-2.5 shadow-sm sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="flex shrink-0 -space-x-2.5">
                  {members.slice(0, 3).map((member) => (
                    <ProfileAvatar
                      key={member.id}
                      name={member.displayName}
                      avatarUrl={member.avatarUrl}
                      avatarCreatorId={member.avatarCreatorId}
                      className="size-8 text-[11px] ring-2 ring-card"
                    />
                  ))}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium" title={names}>
                    {names}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <PlatformMarks platforms={platforms} />
                    <span className="truncate">
                      {members.length} creators on {joinPlatformNames(platforms)}
                    </span>
                  </span>
                </span>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => void dismiss(suggestion)}
                >
                  Not the same
                </Button>
                <Button variant="outline" size="sm" onClick={() => onReview(suggestion)}>
                  <Link2 aria-hidden="true" />
                  Review &amp; link
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-2 inline-flex items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown aria-hidden="true" className="size-3.5" />
          Show {hiddenCount} more {hiddenCount === 1 ? "suggestion" : "suggestions"}
        </button>
      ) : null}
    </section>
  );
}
