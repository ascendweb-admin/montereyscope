"use client";

import { useState } from "react";
import { Check, Search, Trash2 } from "lucide-react";

import { AddCreatorDialog } from "@/components/library/add-creator-dialog";
import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { requestJson } from "@/components/x-dashboard/use-dashboard-data";
import type { CreatorSummary } from "@/lib/creators/service";
import type { DashboardCreator, DashboardList } from "@/lib/x/dashboard/model";
import { cn } from "@/lib/utils";

const input =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring/40 motion-reduce:transition-none";

export function ListEditor({
  list,
  creators,
  categories,
  initialMembers,
  onClose,
  onSaved,
  onDeleted,
  onCreatorAdded,
}: {
  /** The list being edited, or null to create one. */
  list: DashboardList | null;
  creators: DashboardCreator[];
  categories: Array<{ id: number; name: string }>;
  initialMembers: number[];
  onClose: () => void;
  onSaved: (list: DashboardList) => void;
  onDeleted: (id: number) => void;
  onCreatorAdded: (creator: DashboardCreator) => void;
}) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [members, setMembers] = useState<number[]>(initialMembers);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const usedCategories = categories.filter((category) =>
    creators.some((c) => c.categoryIds.includes(category.id)),
  );
  const needle = query.trim().toLowerCase().replace(/^@/, "");
  const visible = creators
    .filter((c) => !needle || `${c.displayName} ${c.handle ?? ""}`.toLowerCase().includes(needle))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const allVisibleSelected = visible.length > 0 && visible.every((c) => members.includes(c.id));

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim(), creatorIds: members };
      const { list: saved } = await requestJson<{ list: DashboardList }>(
        list ? `/api/x-dashboard/lists/${list.id}` : "/api/x-dashboard/lists",
        { method: list ? "PATCH" : "POST", body },
      );
      onSaved({
        id: saved.id,
        name: saved.name,
        description: saved.description,
        creatorIds: saved.creatorIds,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save this list.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!list) return;
    setBusy(true);
    try {
      await requestJson(`/api/x-dashboard/lists/${list.id}`, { method: "DELETE" });
      onDeleted(list.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete this list.");
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AppDialog
        open
        onClose={onClose}
        busy={busy}
        title={list ? "Edit list" : "New list"}
        description="Group the X accounts you want to read and analyze together."
        className="max-w-lg"
      >
        {/* Not a <form>: the Add creator dialog inside renders its own form. */}
        <div className="space-y-4">
          <div className="space-y-2">
            <input
              className={cn(input, "text-base font-medium")}
              value={name}
              maxLength={100}
              required
              autoFocus
              placeholder="List name, e.g. Crypto traders"
              aria-label="List name"
              onKeyDown={(event) => {
                if (event.key === "Enter" && name.trim()) {
                  event.preventDefault();
                  void save();
                }
              }}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <input
              className={input}
              value={description}
              maxLength={1000}
              placeholder="Description (optional)"
              aria-label="Description"
              onChange={(event) => setDescription(event.target.value)}
              disabled={busy}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-sm font-medium">
                Accounts <span className="text-muted-foreground tabular-nums">· {members.length} selected</span>
              </p>
              {visible.length > 1 ? (
                <button
                  type="button"
                  className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
                  onClick={() =>
                    setMembers((current) =>
                      allVisibleSelected
                        ? current.filter((id) => !visible.some((c) => c.id === id))
                        : [...new Set([...current, ...visible.map((c) => c.id)])],
                    )
                  }
                >
                  {allVisibleSelected ? "Deselect all" : "Select all"}
                </button>
              ) : null}
            </div>
            {creators.length > 6 ? (
              <label className="relative mb-2 block">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  className={cn(input, "h-9 pl-9")}
                  value={query}
                  placeholder="Search your X accounts"
                  aria-label="Search your X accounts"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
            ) : null}
            {usedCategories.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {usedCategories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    onClick={() =>
                      setMembers((current) => [
                        ...new Set([
                          ...current,
                          ...creators.filter((c) => c.categoryIds.includes(category.id)).map((c) => c.id),
                        ]),
                      ])
                    }
                    className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                  >
                    + {category.name}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="max-h-72 overflow-y-auto rounded-xl border">
              {visible.length ? (
                <ul className="divide-y">
                  {visible.map((creator) => {
                    const checked = members.includes(creator.id);
                    return (
                      <li key={creator.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          disabled={busy}
                          onClick={() =>
                            setMembers((current) =>
                              checked ? current.filter((id) => id !== creator.id) : [...current, creator.id],
                            )
                          }
                          className={cn(
                            "flex w-full items-center gap-3 px-3 py-2 text-left outline-none transition-colors focus-visible:bg-accent motion-reduce:transition-none",
                            checked ? "bg-accent/60" : "hover:bg-accent/50",
                          )}
                        >
                          <CreatorAvatar creator={creator} className="size-9" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{creator.displayName}</span>
                            <span className="block truncate text-xs text-muted-foreground">@{creator.handle ?? "unknown"}</span>
                          </span>
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-5 items-center justify-center rounded-full border-2 transition-colors motion-reduce:transition-none",
                              checked ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/35",
                            )}
                          >
                            {checked ? <Check className="size-3" strokeWidth={3} /> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {creators.length ? "No accounts match." : "No X accounts yet. Add your first one below."}
                </p>
              )}
            </div>
            <div className="mt-2">
              <AddCreatorDialog
                size="sm"
                variant="outline"
                className="w-full"
                categories={[]}
                initialPlatform="x"
                lockPlatform
                fetchAfterSave={false}
                onSaved={(creator: CreatorSummary) => {
                  onCreatorAdded({
                    id: creator.id,
                    displayName: creator.displayName,
                    handle: creator.handle,
                    avatarUrl: creator.avatarUrl,
                    categoryIds: creator.categories.map((c) => c.id),
                  });
                  setMembers((current) => [...new Set([...current, creator.id])]);
                }}
              />
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center gap-2 pt-1">
            {list ? (
              <Button
                variant="ghost"
                className="mr-auto text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </Button>
            ) : (
              <span className="mr-auto" />
            )}
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={busy || !name.trim()} onClick={() => void save()}>
              {busy ? "Saving…" : list ? "Save" : "Create list"}
            </Button>
          </div>
        </div>
      </AppDialog>
      {list ? (
        <ConfirmDialog
          open={confirmDelete}
          onClose={() => setConfirmDelete(false)}
          title={`Delete “${list.name}”?`}
          description="Only the list is removed. The accounts and their saved posts stay in Scope."
          confirmLabel="Delete list"
          destructive
          busy={busy}
          busyLabel="Deleting…"
          onConfirm={() => void remove()}
        />
      ) : null}
    </>
  );
}
