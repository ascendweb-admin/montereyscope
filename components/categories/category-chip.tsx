import { Tag } from "lucide-react";

import { CATEGORY_COLOR_STYLES, type CreatorCategory } from "@/lib/categories";
import { cn } from "@/lib/utils";

export function CategoryChip({
  category,
  className,
}: {
  category: CreatorCategory;
  className?: string;
}) {
  return (
    <span
      title={category.name}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
        CATEGORY_COLOR_STYLES[category.color].chip,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", CATEGORY_COLOR_STYLES[category.color].dot)}
      />
      <span className="truncate">{category.name}</span>
    </span>
  );
}

export function UncategorizedChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Tag aria-hidden="true" className="size-3" />
      Uncategorized
    </span>
  );
}
