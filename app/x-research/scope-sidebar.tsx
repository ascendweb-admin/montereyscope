"use client";

import { ListPlus, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";

import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { creatorAvatarStyle } from "@/components/library/creator-card";
import { SelectionCheckbox } from "@/components/ui/selection-checkbox";
import { Button } from "@/components/ui/button";
import type { CreatorSummary } from "@/lib/creators/service";
import type { ResearchCreator, ResearchList } from "@/lib/x/research/model";
import { cn } from "@/lib/utils";

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The scope panel: research lists (saved recurring scopes plus one ad hoc
 * custom scope) and the creators currently in scope. Selection state lives
 * in the parent view; this is a presentational column.
 */
export function ScopeSidebar({
  lists,
  activeId,
  activeList,
  creators,
  selected,
  onChooseList,
  onToggleCreator,
  onSelectAllCreators,
  onClearCreators,
  onNewList,
  onEditList,
  onDeleteList,
  onSavedCreator,
}: {
  lists: ResearchList[];
  activeId: number | null;
  activeList: ResearchList | undefined;
  creators: ResearchCreator[];
  selected: number[];
  onChooseList: (id: number | null) => void;
  onToggleCreator: (id: number, checked: boolean) => void;
  onSelectAllCreators: () => void;
  onClearCreators: () => void;
  onNewList: () => void;
  onEditList: () => void;
  onDeleteList: () => void;
  onSavedCreator: (creator: CreatorSummary) => Promise<void> | void;
}) {
  return (
    <aside aria-label="Research scope" className="min-w-0 space-y-5">
      <section aria-label="Research lists" className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Lists
          </h2>
          <Button variant="ghost" size="sm" className="size-7 p-0" aria-label="New list" onClick={onNewList}>
            <ListPlus aria-hidden="true" className="!size-4" />
          </Button>
        </div>

        <div role="group" aria-label="Research lists" className="flex flex-col gap-1">
          <button
            type="button"
            aria-pressed={activeId === null}
            onClick={() => onChooseList(null)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              activeId === null
                ? "bg-secondary font-medium text-secondary-foreground hover:bg-secondary/80"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <SlidersHorizontal aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Ad hoc selection</span>
          </button>
          {lists.map((list) => {
            const active = list.id === activeId;
            return (
              <button
                key={list.id}
                type="button"
                aria-pressed={active}
                onClick={() => onChooseList(list.id)}
                className={cn(
                  "group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  active
                    ? "bg-secondary font-medium text-secondary-foreground hover:bg-secondary/80"
                    : "text-foreground/90 hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{list.name}</span>
                {active ? (
                  <span className="flex shrink-0 items-center gap-0.5">
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Edit ${list.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onEditList();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          onEditList();
                        }
                      }}
                      className="rounded-sm p-1 text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Pencil aria-hidden="true" className="size-3.5" />
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Delete ${list.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteList();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          onDeleteList();
                        }
                      }}
                      className="rounded-sm p-1 text-muted-foreground outline-none hover:bg-background hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </span>
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
                    {list.creatorIds.length}
                  </span>
                )}
              </button>
            );
          })}
          {!lists.length && (
            <p className="px-2.5 pb-1 text-xs leading-relaxed text-muted-foreground">
              No lists yet. Save a recurring group of X creators to revisit it in one click.
            </p>
          )}
        </div>
      </section>

      <section aria-label="Creators in scope" className="space-y-2">
        <div className="flex items-center justify-between px-0.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Creators
          </h2>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {selected.length}/{creators.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onSelectAllCreators}
          >
            Select all
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={onClearCreators}
          >
            Clear
          </Button>
        </div>
        <div className="-mx-1 max-h-[24rem] space-y-0.5 overflow-y-auto overscroll-contain px-1">
          {creators.map((creator) => {
            const checked = selected.includes(creator.id);
            return (
              <label
                key={creator.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 outline-none transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring motion-reduce:transition-none",
                  checked ? "bg-accent/60 hover:bg-accent/70" : "hover:bg-accent/30",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-semibold",
                    creatorAvatarStyle(creator.displayName),
                  )}
                >
                  {initialsOf(creator.displayName)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium leading-tight">
                    {creator.displayName}
                  </span>
                  <span className="block truncate text-xs leading-tight text-muted-foreground">
                    @{creator.handle ?? "unknown"}
                  </span>
                </span>
                <SelectionCheckbox
                  aria-label={`Include ${creator.displayName} in scope`}
                  checked={checked}
                  onChange={(event) => onToggleCreator(creator.id, event.target.checked)}
                />
              </label>
            );
          })}
          {!creators.length && (
            <p className="px-2 py-1 text-xs leading-relaxed text-muted-foreground">
              {activeList
                ? "This list has no creators yet. Edit the list or add one to the shared library."
                : "No X creators saved yet. Add one to the shared library to start browsing."}
            </p>
          )}
        </div>
        <AddCreatorDialog
          size="sm"
          variant="outline"
          className="w-full"
          categories={[]}
          initialPlatform="x"
          lockPlatform
          fetchAfterSave={false}
          onSaved={onSavedCreator}
        />
      </section>
    </aside>
  );
}
