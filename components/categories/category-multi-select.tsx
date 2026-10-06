"use client";

import { Check } from "lucide-react";

import { CATEGORY_COLOR_STYLES, type CategorySummary } from "@/lib/categories";
import { cn } from "@/lib/utils";

export function CategoryMultiSelect({
  categories,
  selected,
  onChange,
  emptyMessage = "No categories yet.",
  className,
}: {
  categories: readonly CategorySummary[];
  selected: ReadonlySet<number>;
  onChange: (next: ReadonlySet<number>) => void;
  emptyMessage?: string;
  className?: string;
}) {
  if (categories.length === 0) {
    return (
      <div className={cn("rounded-lg border border-dashed px-4 py-5 text-center", className)}>
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {categories.map((category) => {
        const checked = selected.has(category.id);
        return (
          <button
            key={category.id}
            type="button"
            aria-pressed={checked}
            onClick={() => {
              const next = new Set(selected);
              if (checked) {
                next.delete(category.id);
              } else {
                next.add(category.id);
              }
              onChange(next);
            }}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              checked
                ? CATEGORY_COLOR_STYLES[category.color].selected
                : "bg-card hover:bg-accent/50",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 items-center justify-center rounded-full",
                checked ? "bg-white/20" : CATEGORY_COLOR_STYLES[category.color].soft,
              )}
            >
              {checked ? <Check className="size-3" /> : null}
            </span>
            {category.name}
          </button>
        );
      })}
    </div>
  );
}
