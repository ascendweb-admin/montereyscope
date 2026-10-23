"use client";

import { useState } from "react";

import { setProfileCategoriesAction } from "@/app/actions/categories";
import { CategoryMultiSelect } from "@/components/categories/category-multi-select";
import { AppDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

/**
 * Files a person under categories. `creator.id` is the creator profile id:
 * categories describe the person, so every linked account shares them.
 */
export function EditCreatorCategoriesDialog({
  open,
  onClose,
  creator,
  categories,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  creator: { id: number; displayName: string; categories: CreatorCategory[] };
  categories: readonly CategorySummary[];
  /** Shows the confirmation in the parent (which outlives this dialog); defaults to a local toast. */
  onSaved?: (message: string) => void;
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
    const outcome = await setProfileCategoriesAction(creator.id, [...selected]);
    setPending(false);
    if (!outcome.ok) {
      setError(outcome.message ?? "The category selection could not be saved.");
      return;
    }
    onClose();
    const message = `Updated categories for ${creator.displayName}.`;
    if (onSaved) {
      onSaved(message);
    } else {
      showToast(message, "success");
    }
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
