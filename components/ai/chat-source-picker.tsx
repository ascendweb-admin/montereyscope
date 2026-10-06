"use client";

import { useMemo, useState } from "react";
import { FileText, Filter, Search, TriangleAlert, X } from "lucide-react";

import {
  CategoryFilterBar,
  UNCATEGORIZED_FILTER,
} from "@/components/categories/category-filter-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AppDialog } from "@/components/ui/dialog";
import { XLogo } from "@/components/ui/platform-logos";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { MAX_SCOPE_SOURCES, formatScopeCapMessage } from "@/lib/ai/scope-selection";
import { sourceKey, type SourceRef } from "@/lib/content/model";
import { cn } from "@/lib/utils";
import type { CategorySummary } from "@/lib/categories";

/**
 * The source picker for fresh conversations in the full-screen chat
 * workspace. Where the collapsed panel inherits its scope from the page it
 * opens on (one video, a channel selection, a research selection), the
 * workspace can start anywhere — so it picks its own sources here: any
 * cached videos and X posts across the whole library, capped like every
 * other selection surface at MAX_SCOPE_SOURCES, with content readiness
 * spelled out per row instead of skipped silently.
 */

export interface PickerVideo {
  id: string;
  creatorId: number;
  title: string;
  creatorName: string;
  categoryIds: number[];
  hasTranscript: boolean;
}

export interface PickerTweet {
  id: string;
  creatorId: number;
  authorHandle: string;
  authorName: string;
  text: string;
  categoryIds: number[];
  readyForAnalysis: boolean;
}

export interface ChatSourcePickerProps {
  open: boolean;
  onClose: () => void;
  videos: readonly PickerVideo[];
  tweets?: readonly PickerTweet[];
  categories: readonly CategorySummary[];
  /** Currently committed selection keys (`video:<id>` / `tweet:<id>`). */
  selected: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClear: () => void;
  /** Receives the confirmed references in list order (stable conversation key). */
  onConfirm: (sources: SourceRef[]) => void;
}

interface PickerItem {
  kind: "video" | "tweet";
  id: string;
  label: string;
  creatorId: number;
  creatorName: string;
  categoryIds: number[];
  ready: boolean;
}

/** One creator block in the picker: their sources, newest first per list. */
interface PickerGroup {
  creatorId: number;
  creatorName: string;
  categoryIds: number[];
  items: PickerItem[];
}

function toItems(
  videos: readonly PickerVideo[],
  tweets: readonly PickerTweet[],
): PickerItem[] {
  return [
    ...videos.map((video) => ({
      kind: "video" as const,
      id: video.id,
      label: video.title,
      creatorId: video.creatorId,
      creatorName: video.creatorName,
      categoryIds: video.categoryIds,
      ready: video.hasTranscript,
    })),
    ...tweets.map((tweet) => ({
      kind: "tweet" as const,
      id: tweet.id,
      label: tweet.text.split(/\r?\n/)[0]?.slice(0, 120) || "X post",
      creatorId: tweet.creatorId,
      creatorName: tweet.authorName,
      categoryIds: tweet.categoryIds,
      ready: tweet.readyForAnalysis,
    })),
  ];
}

function groupByCreator(items: readonly PickerItem[]): PickerGroup[] {
  const groups = new Map<number, PickerItem[]>();
  for (const item of items) {
    const group = groups.get(item.creatorId);
    if (group) {
      group.push(item);
    } else {
      groups.set(item.creatorId, [item]);
    }
  }
  return [...groups.entries()].map(([creatorId, groupItems]) => ({
    creatorId,
    creatorName: groupItems[0]?.creatorName ?? "Creator",
    categoryIds: groupItems[0]?.categoryIds ?? [],
    items: groupItems,
  }));
}

export function ChatSourcePicker({
  open,
  onClose,
  videos,
  tweets = [],
  categories,
  selected,
  onToggle,
  onClear,
  onConfirm,
}: ChatSourcePickerProps) {
  const [query, setQuery] = useState("");
  const [capNote, setCapNote] = useState(false);
  const [categoryFilters, setCategoryFilters] = useState<
    ReadonlySet<number | typeof UNCATEGORIZED_FILTER>
  >(() => new Set());
  const [readyOnly, setReadyOnly] = useState(true);

  const items = useMemo(() => toItems(videos, tweets), [videos, tweets]);

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = items.filter((item) => {
      if (readyOnly && !item.ready) {
        return false;
      }
      const categoryMatch =
        categoryFilters.size === 0 ||
        (categoryFilters.has(UNCATEGORIZED_FILTER) && item.categoryIds.length === 0) ||
        item.categoryIds.some((id) => categoryFilters.has(id));
      if (!categoryMatch) {
        return false;
      }
      return (
        needle.length === 0 ||
        item.label.toLowerCase().includes(needle) ||
        item.creatorName.toLowerCase().includes(needle)
      );
    });
    return groupByCreator(filtered);
  }, [items, query, categoryFilters, readyOnly]);

  const uncategorizedCount = useMemo(
    () => new Set(items.filter((item) => item.categoryIds.length === 0).map((item) => item.creatorId))
      .size,
    [items],
  );

  const selectedReadyCount = useMemo(
    () =>
      [...selected].filter((key) => items.some((item) => sourceKey(item) === key && item.ready))
        .length,
    [selected, items],
  );

  const toggleItem = (key: string): void => {
    // The analysis cap is enforced at selection time: the next tick is
    // refused with a note instead of silently breaking a later chat.
    if (!selected.has(key) && selectedReadyCount >= MAX_SCOPE_SOURCES) {
      setCapNote(true);
      return;
    }
    setCapNote(false);
    onToggle(key);
  };

  const confirm = (): void => {
    if (selectedReadyCount === 0) {
      return;
    }
    // List order, not click order, so the same selection always produces the
    // same conversation key (the same rule the channel selection follows).
    onConfirm(
      items
        .filter((item) => selected.has(sourceKey(item)))
        .map((item) => ({ kind: item.kind, id: item.id })),
    );
  };

  const canConfirm = selectedReadyCount > 0;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Choose sources"
      description="Every answer is grounded in the cached content of the videos and X posts you pick — across your whole library."
      className="max-w-2xl"
    >
      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          aria-label="Search sources"
          placeholder="Search titles, posts, or creators…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background pr-8 pl-9 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="mt-3 rounded-lg border bg-muted/20 p-3">
        <CategoryFilterBar
          categories={categories}
          selected={categoryFilters}
          onChange={setCategoryFilters}
          uncategorizedCount={uncategorizedCount}
          compact
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            aria-pressed={readyOnly}
            onClick={() => setReadyOnly((value) => !value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              readyOnly
                ? "border-ring bg-accent text-accent-foreground"
                : "bg-card text-muted-foreground",
            )}
          >
            <Filter aria-hidden="true" className="size-3.5" />
            Ready for analysis
          </button>
          <p className="text-xs text-muted-foreground">
            {groups.reduce((count, group) => count + group.items.length, 0)} sources shown
          </p>
        </div>
      </div>

      <div className="mt-4 max-h-[45vh] min-h-40 overflow-y-auto rounded-lg border bg-background/50 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        {items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            Nothing cached yet. Save a creator and fetch content first — chats work over the
            sources you already store locally.
          </p>
        ) : groups.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No sources match the search.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.creatorId} aria-label={group.creatorName}>
              <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted/60 px-3 py-2 backdrop-blur-sm">
                <span className="truncate text-xs font-semibold tracking-wide text-foreground/80 uppercase">
                  {group.creatorName}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {group.items.length} {group.items.length === 1 ? "source" : "sources"}
                </span>
              </div>
              <ul>
                {group.items.map((item) => {
                  const key = sourceKey(item);
                  const checked = selected.has(key);
                  const selectable = item.ready;
                  return (
                    <li
                      key={key}
                      className={cn(
                        "flex items-center gap-3 border-b px-3 py-2 last:border-b-0 transition-colors motion-reduce:transition-none",
                        checked ? "bg-accent/40" : "hover:bg-accent/20",
                      )}
                    >
                      <SelectionCheckbox
                        checked={checked}
                        disabled={!selectable}
                        onChange={() => toggleItem(key)}
                        aria-label={`Select ${item.label}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            "block truncate text-sm [overflow-wrap:anywhere]",
                            selectable ? "font-medium" : "text-muted-foreground",
                          )}
                        >
                          {item.label}
                        </span>
                      </span>
                      {item.kind === "tweet" ? (
                        <Badge variant="outline" className="shrink-0 gap-1 text-muted-foreground">
                          <XLogo aria-hidden="true" className="size-3 text-foreground" />
                          Post
                        </Badge>
                      ) : null}
                      {selectable ? (
                        <Badge variant="secondary" className="shrink-0 gap-1">
                          <FileText aria-hidden="true" className="size-3" />
                          {item.kind === "video" ? "Transcript" : "Text cached"}
                        </Badge>
                      ) : (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          No cached content
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm">
            {selectedReadyCount === 0
              ? "Nothing selected"
              : `${selectedReadyCount} of ${MAX_SCOPE_SOURCES} sources selected`}
          </p>
          <Button variant="ghost" size="sm" onClick={onClear} disabled={selected.size === 0}>
            Clear
          </Button>
        </div>
        {capNote ? (
          <p role="status" className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <span>{formatScopeCapMessage(MAX_SCOPE_SOURCES + 1)}</span>
          </p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!canConfirm}>
            {selectedReadyCount === 0
              ? "Use sources"
              : selectedReadyCount === 1
                ? "Use 1 source"
                : `Use ${selectedReadyCount} sources`}
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
