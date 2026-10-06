"use client";

import { useMemo, useState } from "react";
import { Check, FolderPlus, Pencil, Search, Settings2, Trash2 } from "lucide-react";

import {
  createCategoryAction,
  deleteCategoryAction,
  setCategoryCreatorsAction,
  updateCategoryAction,
} from "@/app/actions/categories";
import { CategoryFormFields } from "@/components/categories/category-form-fields";
import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  CATEGORY_COLOR_STYLES,
  type CategoryColor,
  type CategorySummary,
  type CreatorCategory,
} from "@/lib/categories";
import { cn } from "@/lib/utils";

interface ManagerCreator {
  id: number;
  displayName: string;
  handle: string | null;
  categories: CreatorCategory[];
}

export function ManageCategoriesDialog({
  categories,
  creators,
}: {
  categories: readonly CategorySummary[];
  creators: readonly ManagerCreator[];
}) {
  const [open, setOpen] = useState(false);
  const [localCategories, setLocalCategories] = useState<CategorySummary[]>([...categories]);
  const [selectedId, setSelectedId] = useState<number | "new" | null>(categories[0]?.id ?? null);
  const [name, setName] = useState(categories[0]?.name ?? "");
  const [color, setColor] = useState<CategoryColor>(categories[0]?.color ?? "sky");
  const [creatorIds, setCreatorIds] = useState<ReadonlySet<number>>(
    () =>
      new Set(
        categories[0]
          ? creators
              .filter((creator) =>
                creator.categories.some((category) => category.id === categories[0].id),
              )
              .map((creator) => creator.id)
          : [],
      ),
  );
  const [memberships, setMemberships] = useState<Map<number, ReadonlySet<number>>>(
    () =>
      new Map(
        categories.map((category) => [
          category.id,
          new Set(
            creators
              .filter((creator) => creator.categories.some((entry) => entry.id === category.id))
              .map((creator) => creator.id),
          ),
        ]),
      ),
  );
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { showToast, toastElement } = useToast();

  const visibleCreators = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? creators.filter(
          (creator) =>
            creator.displayName.toLowerCase().includes(needle) ||
            creator.handle?.toLowerCase().includes(needle),
        )
      : creators;
  }, [creators, query]);

  const selectCategory = (category: CategorySummary): void => {
    setSelectedId(category.id);
    setName(category.name);
    setColor(category.color);
    setCreatorIds(new Set(memberships.get(category.id) ?? []));
    setError(null);
    setConfirmDelete(false);
    setQuery("");
  };

  const startNew = (): void => {
    setSelectedId("new");
    setName("");
    setColor("sky");
    setCreatorIds(new Set());
    setError(null);
    setConfirmDelete(false);
    setQuery("");
  };

  const save = async (): Promise<void> => {
    if (selectedId === null) {
      return;
    }
    setPending(true);
    setError(null);
    const categoryOutcome =
      selectedId === "new"
        ? await createCategoryAction(name, color)
        : await updateCategoryAction(selectedId, name, color);
    if (!categoryOutcome.ok || !categoryOutcome.category) {
      setPending(false);
      setError(categoryOutcome.message ?? "The category could not be saved.");
      return;
    }
    const saved = categoryOutcome.category;
    const memberOutcome = await setCategoryCreatorsAction(saved.id, [...creatorIds]);
    setPending(false);
    if (!memberOutcome.ok) {
      setError(memberOutcome.message ?? "The creator selection could not be saved.");
      return;
    }
    setLocalCategories((current) => {
      const next = current.filter((category) => category.id !== saved.id);
      next.push({ ...saved, creatorCount: creatorIds.size });
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    setMemberships((current) => new Map(current).set(saved.id, new Set(creatorIds)));
    setSelectedId(saved.id);
    showToast(selectedId === "new" ? `Created ${saved.name}.` : `Saved ${saved.name}.`, "success");
  };

  const remove = async (): Promise<void> => {
    if (typeof selectedId !== "number") {
      return;
    }
    setPending(true);
    const outcome = await deleteCategoryAction(selectedId);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "The category could not be deleted.");
      return;
    }
    const remaining = localCategories.filter((category) => category.id !== selectedId);
    setLocalCategories(remaining);
    setMemberships((current) => {
      const next = new Map(current);
      next.delete(selectedId);
      return next;
    });
    setConfirmDelete(false);
    if (remaining[0]) {
      selectCategory(remaining[0]);
    } else {
      setSelectedId(null);
      setName("");
      setCreatorIds(new Set());
    }
    showToast("Category deleted. Its creators and cached content were kept.", "success");
  };

  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          const nextMemberships = new Map<number, ReadonlySet<number>>(
            categories.map((category) => [
              category.id,
              new Set(
                creators
                  .filter((creator) => creator.categories.some((entry) => entry.id === category.id))
                  .map((creator) => creator.id),
              ),
            ]),
          );
          setLocalCategories([...categories]);
          setMemberships(nextMemberships);
          if (categories[0]) {
            setSelectedId(categories[0].id);
            setName(categories[0].name);
            setColor(categories[0].color);
            setCreatorIds(new Set(nextMemberships.get(categories[0].id) ?? []));
          } else {
            setSelectedId(null);
            setName("");
            setCreatorIds(new Set());
          }
          setOpen(true);
        }}
      >
        <Settings2 aria-hidden="true" />
        Manage categories
      </Button>

      <AppDialog
        open={open}
        onClose={() => setOpen(false)}
        busy={pending}
        title="Manage categories"
        description="Build reusable creator groups for your library and AI research."
        className="max-w-4xl"
      >
        <div className="grid min-h-[31rem] gap-5 md:grid-cols-[14rem_1fr]">
          <aside className="flex min-h-0 flex-col rounded-xl border bg-muted/25 p-2">
            <Button variant="ghost" className="mb-1 justify-start" onClick={startNew}>
              <FolderPlus aria-hidden="true" />
              New category
            </Button>
            <div className="min-h-0 space-y-1 overflow-y-auto">
              {localCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  aria-pressed={selectedId === category.id}
                  onClick={() => selectCategory(category)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                    selectedId === category.id ? "bg-card shadow-sm" : "hover:bg-card/70",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2.5 shrink-0 rounded-full",
                      CATEGORY_COLOR_STYLES[category.color].dot,
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">{category.name}</span>
                  <span className="text-xs text-muted-foreground">{category.creatorCount}</span>
                </button>
              ))}
              {localCategories.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No categories yet. Create one to get started.
                </p>
              ) : null}
            </div>
          </aside>

          <section className="min-w-0">
            {selectedId === null ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed text-center">
                <FolderPlus aria-hidden="true" className="size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Create your first category.</p>
                <Button onClick={startNew}>New category</Button>
              </div>
            ) : (
              <div className="flex h-full flex-col">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 font-semibold">
                    {selectedId === "new" ? (
                      <FolderPlus aria-hidden="true" className="size-4" />
                    ) : (
                      <Pencil aria-hidden="true" className="size-4" />
                    )}
                    {selectedId === "new" ? "Create category" : "Edit category"}
                  </h3>
                  {typeof selectedId === "number" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </Button>
                  ) : null}
                </div>

                <div className="mt-4">
                  <CategoryFormFields
                    name={name}
                    color={color}
                    onNameChange={setName}
                    onColorChange={setColor}
                  />
                </div>

                <div className="mt-5 flex min-h-0 flex-1 flex-col border-t pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="text-sm font-medium">Creators</h4>
                      <p className="text-xs text-muted-foreground">
                        {creatorIds.size} {creatorIds.size === 1 ? "creator" : "creators"} selected
                      </p>
                    </div>
                    {creators.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setCreatorIds(
                            creatorIds.size === creators.length
                              ? new Set()
                              : new Set(creators.map((creator) => creator.id)),
                          )
                        }
                      >
                        {creatorIds.size === creators.length ? "Clear all" : "Select all"}
                      </Button>
                    ) : null}
                  </div>
                  <div className="relative mt-3">
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
                      className="h-9 w-full rounded-md border border-input bg-background pr-3 pl-9 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <div className="mt-2 max-h-44 overflow-y-auto rounded-lg border">
                    {visibleCreators.map((creator) => {
                      const checked = creatorIds.has(creator.id);
                      return (
                        <button
                          key={creator.id}
                          type="button"
                          aria-pressed={checked}
                          onClick={() => {
                            const next = new Set(creatorIds);
                            if (checked) next.delete(creator.id);
                            else next.add(creator.id);
                            setCreatorIds(next);
                          }}
                          className={cn(
                            "flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent/30",
                            checked && "bg-accent/40",
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
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {creator.displayName}
                          </span>
                          {creator.handle ? (
                            <span className="max-w-36 truncate text-xs text-muted-foreground">
                              @{creator.handle.replace(/^@/, "")}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                    {visibleCreators.length === 0 ? (
                      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                        No creators match that search.
                      </p>
                    ) : null}
                  </div>
                </div>

                {confirmDelete ? (
                  <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                    <p className="text-sm font-medium">Delete this category?</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Creators, feeds, and transcripts stay safely in your library.
                    </p>
                    <div className="mt-3 flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                        Keep category
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => void remove()}>
                        Delete category
                      </Button>
                    </div>
                  </div>
                ) : null}

                {error ? (
                  <p role="alert" className="mt-3 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
                <div className="mt-5 flex justify-end gap-2 border-t pt-4">
                  <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                    Done
                  </Button>
                  <Button
                    onClick={() => void save()}
                    disabled={pending || name.trim().length === 0}
                  >
                    {pending
                      ? "Saving…"
                      : selectedId === "new"
                        ? "Create category"
                        : "Save changes"}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      </AppDialog>
      {toastElement}
    </>
  );
}
