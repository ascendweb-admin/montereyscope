export const CATEGORY_COLORS = ["slate", "rose", "amber", "emerald", "sky", "violet"] as const;

export type CategoryColor = (typeof CATEGORY_COLORS)[number];

export interface CategorySummary {
  id: number;
  name: string;
  color: CategoryColor;
  creatorCount: number;
}

export interface CreatorCategory {
  id: number;
  name: string;
  color: CategoryColor;
}

/** Static Tailwind strings keep palette generation deterministic. */
export const CATEGORY_COLOR_STYLES: Record<
  CategoryColor,
  { dot: string; chip: string; selected: string; soft: string }
> = {
  slate: {
    dot: "bg-slate-500",
    chip: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-950/60 dark:text-slate-300",
    selected: "border-slate-500 bg-slate-700 text-white dark:bg-slate-200 dark:text-slate-950",
    soft: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  },
  rose: {
    dot: "bg-rose-500",
    chip: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-300",
    selected: "border-rose-600 bg-rose-600 text-white dark:border-rose-400 dark:bg-rose-500",
    soft: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  },
  amber: {
    dot: "bg-amber-500",
    chip: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-300",
    selected: "border-amber-500 bg-amber-400 text-amber-950 dark:bg-amber-500",
    soft: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  },
  emerald: {
    dot: "bg-emerald-500",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
    selected:
      "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-400 dark:bg-emerald-500",
    soft: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  sky: {
    dot: "bg-sky-500",
    chip: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-300",
    selected: "border-sky-600 bg-sky-600 text-white dark:border-sky-400 dark:bg-sky-500",
    soft: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  },
  violet: {
    dot: "bg-violet-500",
    chip: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/60 dark:text-violet-300",
    selected:
      "border-violet-600 bg-violet-600 text-white dark:border-violet-400 dark:bg-violet-500",
    soft: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  },
};

export function isCategoryColor(value: unknown): value is CategoryColor {
  return typeof value === "string" && CATEGORY_COLORS.includes(value as CategoryColor);
}
