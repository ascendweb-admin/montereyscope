"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActionMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Secondary line under the label. */
  hint?: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Present for a mutually exclusive menu choice. */
  checked?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

/**
 * A compact overflow menu ("⋯") for secondary actions. Keyboard behavior
 * follows the menu-button pattern: arrows move between items, Home/End jump,
 * Escape closes and returns focus to the trigger, and a click outside
 * dismisses. Styled like the platform filter's popover.
 */
export function ActionMenu({
  label,
  items,
  align = "end",
  triggerClassName,
  size = "icon",
  icon = <MoreHorizontal aria-hidden="true" />,
  variant = "outline",
  menuClassName,
}: {
  /** Accessible name of the trigger, e.g. "More actions for Jane Doe". */
  label: string;
  items: readonly ActionMenuItem[];
  align?: "start" | "end";
  triggerClassName?: string;
  size?: "icon" | "sm";
  /** The trigger's glyph; "⋯" unless the menu reads as part of a split button. */
  icon?: ReactNode;
  variant?: "outline" | "ghost";
  /** Extra classes on the menu panel, e.g. a narrower width where space is tight. */
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const enabled = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.disabled)
    .map(({ index }) => index);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[enabled[0] ?? 0]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
    // Focus the first item only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      ref={root}
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <Button
        ref={trigger}
        variant={variant}
        size={size === "icon" ? "icon" : "sm"}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(open && "bg-accent", triggerClassName)}
      >
        {icon}
      </Button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cn(
            "absolute top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-[0_16px_48px_-12px_rgb(0_0_0/0.45),0_4px_12px_-4px_rgb(0_0_0/0.2)]",
            align === "end" ? "right-0" : "left-0",
            menuClassName,
          )}
          onKeyDown={(event) => {
            const current = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement);
            const position = enabled.indexOf(current);
            let next: number | undefined;
            if (event.key === "ArrowDown") next = enabled[(position + 1) % enabled.length];
            if (event.key === "ArrowUp")
              next = enabled[(position - 1 + enabled.length) % enabled.length];
            if (event.key === "Home") next = enabled[0];
            if (event.key === "End") next = enabled[enabled.length - 1];
            if (next !== undefined) {
              event.preventDefault();
              itemRefs.current[next]?.focus();
            }
            if (event.key === "Escape" || event.key === "Tab") {
              if (event.key === "Escape") event.preventDefault();
              close();
            }
          }}
        >
          {items.map((item, index) => (
            <div key={item.id}>
              {item.separated ? <div role="separator" className="my-1.5 h-px bg-border" /> : null}
              <button
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                tabIndex={-1}
                disabled={item.disabled}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0",
                  item.destructive
                    ? "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10"
                    : "text-foreground",
                )}
              >
                {item.icon ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 flex",
                      item.destructive ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {item.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.label}</span>
                  {item.hint ? (
                    <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                      {item.hint}
                    </span>
                  ) : null}
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
