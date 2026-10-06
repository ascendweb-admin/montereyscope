"use client";

import { useState } from "react";

import { setCreatorCategoriesAction } from "@/app/actions/categories";
import { CategoryMultiSelect } from "@/components/categories/category-multi-select";
import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

export function EditCreatorCategoriesDialog({
  open,
  onClose,
  creator,
  categories,
}: {
  open: boolean;
  onClose: () => void;
  creator: { id: number; displayName: string; categories: CreatorCategory[] };
  categories: readonly CategorySummary[];
}) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(
    () => new Set(creator.categories.map((category) => category.id)),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast, toastElement } = useToast();

  const close = (): void => {
    if (pending) {
      return;
    }
    setSelected(new Set(creator.categories.map((category) => category.id)));
    setError(null);
    onClose();
  };

  const save = async (): Promise<void> => {
    setPending(true);
    setError(null);
    const outcome = await setCreatorCategoriesAction(creator.id, [...selected]);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "The category selection could not be saved.");
      return;
    }
    onClose();
    showToast(`Updated categories for ${creator.displayName}.`, "success");
  };

  return (
    <>
      <AppDialog
        open={open}
        onClose={close}
        busy={pending}
        title={`Organize ${creator.displayName}`}
        description="A creator can belong to as many categories as you like."
      >
        <div className="flex flex-col gap-5">
          <CategoryMultiSelect
            categories={categories}
            selected={selected}
            onChange={setSelected}
            emptyMessage="Create your first category from Manage categories in the library."
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={pending}>
              {pending ? "Saving…" : "Save categories"}
            </Button>
          </div>
        </div>
      </AppDialog>
      {toastElement}
    </>
  );
}
