"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

export type SelectionCheckboxProps = Omit<React.ComponentProps<"input">, "type">;

/**
 * The app's selection checkbox (stage 5): a styled native input so keyboard
 * and screen-reader behavior stay free, with a check mark overlaid through
 * the peer pattern. Used by the feed card overlay and the research rows.
 */
export function SelectionCheckbox({ className, ...props }: SelectionCheckboxProps) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <input
        type="checkbox"
        className="peer size-5 cursor-pointer appearance-none rounded-md border border-input bg-card/90 shadow-sm outline-none transition-colors checked:border-primary checked:bg-primary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        {...props}
      />
      <Check
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 m-auto size-3.5 text-primary-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}
