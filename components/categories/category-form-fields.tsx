"use client";

import { useId } from "react";
import { Check } from "lucide-react";

import { CATEGORY_COLORS, CATEGORY_COLOR_STYLES, type CategoryColor } from "@/lib/categories";
import { cn } from "@/lib/utils";

export const CATEGORY_COLOR_LABELS: Record<CategoryColor, string> = {
  slate: "Slate",
  rose: "Rose",
  amber: "Amber",
  emerald: "Emerald",
  sky: "Sky",
  violet: "Violet",
};

export function CategoryFormFields({
  name,
  color,
  onNameChange,
  onColorChange,
  autoFocus = false,
}: {
  name: string;
  color: CategoryColor;
  onNameChange: (name: string) => void;
  onColorChange: (color: CategoryColor) => void;
  autoFocus?: boolean;
}) {
  const nameId = useId();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          Name
        </label>
        <input
          id={nameId}
          type="text"
          maxLength={40}
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder="e.g. Markets, Interviews, Design"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <fieldset>
        <legend className="text-sm font-medium">Accent</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {CATEGORY_COLORS.map((option) => (
            <button
              key={option}
              type="button"
              aria-label={CATEGORY_COLOR_LABELS[option]}
              aria-pressed={color === option}
              onClick={() => onColorChange(option)}
              className={cn(
                "flex size-9 items-center justify-center rounded-full border-2 bg-card outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                color === option ? "border-foreground" : "border-transparent",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-white",
                  CATEGORY_COLOR_STYLES[option].dot,
                )}
              >
                {color === option ? <Check aria-hidden="true" className="size-3.5" /> : null}
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
