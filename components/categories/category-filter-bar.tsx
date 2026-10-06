"use client";

import { Layers3, Tag } from "lucide-react";

import { CATEGORY_COLOR_STYLES, type CategorySummary } from "@/lib/categories";
import { cn } from "@/lib/utils";

export const UNCATEGORIZED_FILTER = "uncategorized";

interface CategoryFilterBarProps {
  categories: readonly CategorySummary[];
  selected: ReadonlySet<number | typeof UNCATEGORIZED_FILTER>;
  onChange: (next: ReadonlySet<number | typeof UNCATEGORIZED_FILTER>) => void;
  uncategorizedCount?: number;
  className?: string;
  compact?: boolean;
}

/**
 * Reusable inclusive category filter. Picking several categories shows the
 * union; All is a real, explicit reset target instead of a hidden empty state.
 */
export function CategoryFilterBar({
  categories,
  selected,
  onChange,
  uncategorizedCount = 0,
  className,
  compact = false,
}: CategoryFilterBarProps) {
  const all = selected.size === 0;
  const toggle = (id: number | typeof UNCATEGORIZED_FILTER): void => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange(next);
  };

  return (
    <div
      aria-label="Filter by category"
      className={cn(
        "flex items-center gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={all}
        onClick={() => onChange(new Set())}
        className={cn(
          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          compact ? "h-8 text-xs" : "h-9 text-sm",
          all
            ? "border-foreground bg-foreground text-background"
            : "bg-card text-muted-foreground shadow-sm hover:text-foreground",
        )}
      >
        <Layers3 aria-hidden="true" className="size-3.5" />
        All
      </button>

      {categories.map((category) => {
        const active = selected.has(category.id);
        return (
          <button
            key={category.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(category.id)}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              compact ? "h-8 text-xs" : "h-9 text-sm",
              active
                ? CATEGORY_COLOR_STYLES[category.color].selected
                : "bg-card text-foreground shadow-sm hover:bg-accent/50",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 rounded-full",
                active ? "bg-current opacity-70" : CATEGORY_COLOR_STYLES[category.color].dot,
              )}
            />
            {category.name}
            <span className={cn("text-[11px]", active ? "opacity-80" : "text-muted-foreground")}>
              {category.creatorCount}
            </span>
          </button>
        );
      })}

      {uncategorizedCount > 0 ? (
        <button
          type="button"
          aria-pressed={selected.has(UNCATEGORIZED_FILTER)}
          onClick={() => toggle(UNCATEGORIZED_FILTER)}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-dashed px-3 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            compact ? "h-8 text-xs" : "h-9 text-sm",
            selected.has(UNCATEGORIZED_FILTER)
              ? "border-foreground bg-foreground text-background"
              : "bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          <Tag aria-hidden="true" className="size-3.5" />
          Uncategorized
          <span className="text-[11px] opacity-75">{uncategorizedCount}</span>
        </button>
      ) : null}
    </div>
  );
}
