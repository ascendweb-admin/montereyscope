import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * An on/off switch: a native checkbox exposed with `role="switch"`, so it
 * keeps the browser's keyboard and form behaviour. Put it in a `<label>` with
 * its text; extra classes (such as a top margin) go in `className`.
 */
export function Switch({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "role">) {
  return (
    <input
      type="checkbox"
      role="switch"
      className={cn(
        "peer relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full border border-input bg-muted transition-colors outline-none before:absolute before:top-0.5 before:left-0.5 before:size-3.5 before:rounded-full before:bg-background before:shadow-sm before:transition-transform before:content-[''] checked:border-primary checked:bg-primary checked:before:translate-x-4 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:before:transition-none",
        className,
      )}
      {...props}
    />
  );
}
