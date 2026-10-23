"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FolderCog, Link2, Search, X } from "lucide-react";

import {
  CategoryFilterBar,
  UNCATEGORIZED_FILTER,
} from "@/components/categories/category-filter-bar";
import { EditCreatorCategoriesDialog } from "@/components/categories/edit-creator-categories-dialog";
import { LinkCreatorsDialog } from "@/components/creators/link-creators-dialog";
import { LinkSuggestions } from "@/components/creators/link-suggestions";
import { PLATFORM_LABELS } from "@/components/creators/profile-ui";
import { PlatformFilter } from "@/components/library/platform-filter";
import { CreatorCard } from "@/components/library/creator-card";
import { RefreshAllButton } from "@/components/library/refresh-all-button";
import { RemoveProfileButton } from "@/components/library/remove-creator-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { CreatorAccountSummary } from "@/lib/creators/profile-service";
import type { ProfileLinkSuggestion } from "@/lib/creators/profile-suggestions";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

export interface LibraryAccount
  extends
    Pick<CreatorAccountSummary, "id" | "platform" | "displayName" | "handle">,
    // When known: the refresh menu shows how stale each platform is.
    Partial<Pick<CreatorAccountSummary, "lastRefreshedAt">> {
  researchListNames?: string[];
}

/** One person in the library, with every platform account linked to them. */
export interface LibraryCreator {
  /** The creator profile id. */
  id: number;
  displayName: string;
  avatarUrl: string | null;
  avatarCreatorId: number | null;
  accounts: LibraryAccount[];
  categories: CreatorCategory[];
}

/** The other people suggested alongside `profileId`, if any. */
export function suggestedFor(
  suggestions: readonly ProfileLinkSuggestion[],
  profileId: number,
): number[] {
  return (
    suggestions
      .find((suggestion) => suggestion.profileIds.includes(profileId))
      ?.profileIds.filter((id) => id !== profileId) ?? []
  );
}

export function creatorHref(profileId: number, accountId?: number): string {
  return accountId === undefined
    ? `/creators/${profileId}`
    : `/creators/${profileId}?account=${accountId}`;
}

export function CreatorLibrary({
  creators,
  categories,
  linkSuggestions = [],
}: {
  creators: readonly LibraryCreator[];
  categories: readonly CategorySummary[];
  linkSuggestions?: readonly ProfileLinkSuggestion[];
}) {
  const [filters, setFilters] = useState<ReadonlySet<number | typeof UNCATEGORIZED_FILTER>>(
    () => new Set(),
  );
  const [platform, setPlatform] = useState<CreatorPlatform | "all">("all");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [linking, setLinking] = useState<{ targetId: number; preselected: number[] } | null>(null);
  const { showToast, toastElement } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // A creator page that removed its creator lands here with a one-time note.
  const removedName = searchParams.get("removed");
  useEffect(() => {
    if (removedName) {
      showToast(`${removedName} was removed from your library.`, "success");
      router.replace(pathname, { scroll: false });
    }
    // showToast is stable in behavior; only a new note should fire this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removedName]);

  const uncategorizedCount = creators.filter((creator) => creator.categories.length === 0).length;
  const accountCount = creators.reduce((count, creator) => count + creator.accounts.length, 0);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return creators.filter((creator) => {
      const categoryMatch =
        filters.size === 0 ||
        (filters.has(UNCATEGORIZED_FILTER) && creator.categories.length === 0) ||
        creator.categories.some((category) => filters.has(category.id));
      const queryMatch =
        needle.length === 0 ||
        creator.displayName.toLowerCase().includes(needle) ||
        creator.accounts.some(
          (account) =>
            account.handle?.toLowerCase().includes(needle) ||
            account.displayName.toLowerCase().includes(needle),
        );
      const platformMatch =
        platform === "all" || creator.accounts.some((account) => account.platform === platform);
      return categoryMatch && queryMatch && platformMatch;
    });
  }, [creators, filters, query, platform]);

  // Refresh works per account: every platform feed of every person.
  const refreshTargets = useMemo(
    () =>
      creators.flatMap((creator) =>
        creator.accounts.map((account) => ({
          id: account.id,
          displayName:
            creator.accounts.length > 1
              ? `${creator.displayName} (${PLATFORM_LABELS[account.platform]})`
              : creator.displayName,
          platform: account.platform,
          updatedAt: account.lastRefreshedAt,
        })),
      ),
    [creators],
  );

  const editingCreator = creators.find((creator) => creator.id === editingId) ?? null;
  const linkTarget = linking
    ? (creators.find((creator) => creator.id === linking.targetId) ?? null)
    : null;

  return (
    <section aria-label="Creator collection">
      <LinkSuggestions
        suggestions={linkSuggestions}
        creators={creators}
        onReview={(suggestion) =>
          setLinking({
            targetId: suggestion.targetId,
            preselected: suggestion.profileIds.filter((id) => id !== suggestion.targetId),
          })
        }
        onMessage={showToast}
      />

      <div className="rounded-xl border bg-muted/20 p-3 sm:p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative sm:w-64 sm:shrink-0">
            <Search
              aria-hidden="true"
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              aria-label="Search creators"
              placeholder="Search names or handles…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-9 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear creator search"
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
          </div>
          <PlatformFilter value={platform} onChange={setPlatform} />
          <CategoryFilterBar
            categories={categories}
            selected={filters}
            onChange={setFilters}
            uncategorizedCount={uncategorizedCount}
            compact
            className="min-w-0 flex-1"
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p role="status" className="text-xs text-muted-foreground">
            Showing {visible.length} of {creators.length}{" "}
            {creators.length === 1 ? "creator" : "creators"}
            {accountCount > creators.length ? ` · ${accountCount} platform accounts` : ""}
            {filters.size > 1 ? " across the selected categories" : ""}
          </p>
          <RefreshAllButton
            creators={refreshTargets}
            platformMenu
            scope={platform}
            peopleCount={creators.length}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">No creators match these filters.</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFilters(new Set());
              setQuery("");
              setPlatform("all");
            }}
          >
            Show all creators
          </Button>
        </div>
      ) : (
        <ul
          aria-label="Saved creators"
          className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {visible.map((creator) => (
            <li key={creator.id}>
              <CreatorCard
                creator={{
                  displayName: creator.displayName,
                  avatarUrl: creator.avatarUrl,
                  avatarCreatorId: creator.avatarCreatorId,
                  href: creatorHref(creator.id),
                  categories: creator.categories,
                  accounts: creator.accounts.map((account) => ({
                    platform: account.platform,
                    handle: account.handle,
                    href: creatorHref(creator.id, account.id),
                  })),
                }}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground"
                      aria-label={`Link other accounts to ${creator.displayName}`}
                      title="Link accounts"
                      onClick={() => setLinking({ targetId: creator.id, preselected: [] })}
                    >
                      <Link2 aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground"
                      aria-label={`Edit categories for ${creator.displayName}`}
                      title="Edit categories"
                      onClick={() => setEditingId(creator.id)}
                    >
                      <FolderCog aria-hidden="true" />
                    </Button>
                    <RemoveProfileButton
                      profileId={creator.id}
                      displayName={creator.displayName}
                      accounts={creator.accounts}
                      onRemoved={(message) => showToast(message, "success")}
                      onError={(message) => showToast(message, "error")}
                    />
                  </>
                }
              />
            </li>
          ))}
        </ul>
      )}

      {editingCreator ? (
        <EditCreatorCategoriesDialog
          key={`${editingCreator.id}-${editingCreator.categories.map((category) => category.id).join("-")}`}
          open
          onClose={() => setEditingId(null)}
          creator={editingCreator}
          categories={categories}
          onSaved={(message) => showToast(message, "success")}
        />
      ) : null}

      {linkTarget && linking ? (
        <LinkCreatorsDialog
          open
          onClose={() => setLinking(null)}
          target={linkTarget}
          profiles={creators}
          preselectedIds={linking.preselected}
          suggestedIds={suggestedFor(linkSuggestions, linking.targetId)}
          onLinked={(message) => showToast(message, "success")}
        />
      ) : null}

      {toastElement}
    </section>
  );
}
