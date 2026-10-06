"use client";

import { useState } from "react";
import { FolderCog } from "lucide-react";

import { EditCreatorCategoriesDialog } from "./edit-creator-categories-dialog";
import { Button } from "@/components/ui/button";
import type { CategorySummary, CreatorCategory } from "@/lib/categories";

export function CreatorCategoryEditorButton({
  creator,
  categories,
}: {
  creator: { id: number; displayName: string; categories: CreatorCategory[] };
  categories: readonly CategorySummary[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setOpen(true)}>
        <FolderCog aria-hidden="true" />
        Edit categories
      </Button>
      <EditCreatorCategoriesDialog
        open={open}
        onClose={() => setOpen(false)}
        creator={creator}
        categories={categories}
      />
    </>
  );
}
