"use client";

import { useMemo, useState } from "react";
import { FolderCog, Search, X } from "lucide-react";

import {
  CategoryFilterBar,
  UNCATEGORIZED_FILTER,
} from "@/components/categories/category-filter-bar";
import { EditCreatorCategoriesDialog } from "@/components/categories/edit-creator-categories-dialog";
import { PlatformFilter } from "@/components/library/platform-filter";
import { CreatorCard } from "@/components/library/creator-card";
import { RefreshAllButton } from "@/components/library/refresh-all-button";
import { RemoveCreatorButton } from "@/components/library/remove-creator-dialog";
import { Button } from "@/components/ui/button";
import type { CreatorPlatform } from "@/lib/creators/repository";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

export interface LibraryCreator {
  platform: CreatorPlatform;
  id: number;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  categories: CreatorCategory[];
  researchListNames?: string[];
}

export function CreatorLibrary({
  creators,
  categories,
}: {
  creators: readonly LibraryCreator[];
  categories: readonly CategorySummary[];
}) {
  const [filters, setFilters] = useState<ReadonlySet<number | typeof UNCATEGORIZED_FILTER>>(
    () => new Set(),
  );
  const [platform, setPlatform] = useState<CreatorPlatform | "all">("all");
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  const uncategorizedCount = creators.filter((creator) => creator.categories.length === 0).length;
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
        creator.handle?.toLowerCase().includes(needle);
      return categoryMatch && queryMatch && (platform === "all" || creator.platform === platform);
    });
  }, [creators, filters, query, platform]);

  const editingCreator = creators.find((creator) => creator.id === editingId) ?? null;

  return (
    <section aria-label="Creator collection">
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
              placeholder="Search creators…"
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
            {filters.size > 1 ? " across the selected categories" : ""}
          </p>
          <RefreshAllButton creators={creators} />
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
                  ...creator,
                  href: `/channels/${creator.id}`,
                }}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground"
                      aria-label={`Edit categories for ${creator.displayName}`}
                      onClick={() => setEditingId(creator.id)}
                    >
                      <FolderCog aria-hidden="true" />
                    </Button>
                    <RemoveCreatorButton
                      creatorId={creator.id}
                      displayName={creator.displayName}
                      researchListNames={creator.researchListNames}
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
        />
      ) : null}
    </section>
  );
}
