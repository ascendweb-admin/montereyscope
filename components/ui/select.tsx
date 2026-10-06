"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SelectOption {
  value: string;
  label: string;
  /** Secondary line shown under the label inside the menu. */
  description?: string;
  disabled?: boolean;
}

/**
 * The app's styled dropdown, hand-rolled on the same pattern as the model
 * picker: a bordered trigger showing the current value and a popover listbox
 * with full keyboard navigation and a check on the selection. Replaces raw
 * <select> elements so the X research controls match the rest of the tool.
 * The trigger renders the matching option's label, or `renderValue` when the
 * caller must show a value that is absent from `options`.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  renderValue,
  size = "md",
  className,
  disabled = false,
}: {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Accessible name for the trigger. */
  label: string;
  /** Overrides the trigger text when the selected value has no option row. */
  renderValue?: (value: string) => string;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const keyboardNavRef = useRef(false);
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (index: number) => `${reactId}-option-${index}`;

  const selected = options.find((option) => option.value === value) ?? null;
  const usable = options.filter((option) => !option.disabled);
  const activeSafeIndex = usable.length === 0 ? -1 : Math.min(activeIndex, usable.length - 1);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) {
      triggerRef.current?.focus();
    }
  };

  const openMenu = (): void => {
    if (disabled) {
      return;
    }
    const start = options.findIndex((option) => option.value === value && !option.disabled);
    keyboardNavRef.current = true;
    setActiveIndex(start >= 0 ? start : 0);
    const estimatedHeight = 48 + Math.min(options.length, 6) * 40 + 16;
    const rect = triggerRef.current?.getBoundingClientRect();
    setDropUp(
      rect !== undefined &&
        window.innerHeight - rect.bottom < estimatedHeight &&
        rect.top > estimatedHeight,
    );
    setOpen(true);
  };

  const choose = (option: SelectOption): void => {
    if (option.disabled) {
      return;
    }
    if (option.value !== value) {
      onChange(option.value);
    }
    close(true);
  };

  useEffect(() => {
    if (open) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  useEffect(() => {
    if (!open || !keyboardNavRef.current) {
      return;
    }
    keyboardNavRef.current = false;
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[data-active="true"]');
    if (!list || !active) {
      return;
    }
    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.top < listRect.top) {
      list.scrollTop += activeRect.top - listRect.top;
    } else if (activeRect.bottom > listRect.bottom) {
      list.scrollTop += activeRect.bottom - listRect.bottom;
    }
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: React.KeyboardEvent): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!open) {
          openMenu();
          break;
        }
        if (usable.length > 0) {
          keyboardNavRef.current = true;
          setActiveIndex((index) => (index + 1) % usable.length);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!open) {
          openMenu();
          break;
        }
        if (usable.length > 0) {
          keyboardNavRef.current = true;
          setActiveIndex((index) => (index - 1 + usable.length) % usable.length);
        }
        break;
      case "Home":
      case "End":
        if (!open) {
          return;
        }
        event.preventDefault();
        keyboardNavRef.current = true;
        setActiveIndex(event.key === "Home" ? 0 : Math.max(0, usable.length - 1));
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (!open) {
          openMenu();
        } else {
          const option = usable[activeSafeIndex];
          if (option) {
            choose(option);
          }
        }
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          close(true);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`${label}: ${selected?.label ?? renderValue?.(value) ?? value}`}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background text-left shadow-sm outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3 text-sm",
        )}
      >
        <span className="min-w-0 flex-1 truncate font-medium">
          {selected?.label ?? renderValue?.(value) ?? value}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={label}
          className={cn(
            "absolute inset-x-0 z-40 max-h-72 overflow-y-auto overscroll-contain rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg",
            dropUp ? "bottom-full mb-1.5" : "top-full mt-1.5",
          )}
        >
          {options.map((option) => {
            const isSelected = option.value === value;
            const flatIndex = usable.indexOf(option);
            return (
              <li
                key={option.value}
                id={optionId(flatIndex)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                data-active={flatIndex === activeSafeIndex || undefined}
                onClick={() => choose(option)}
                onPointerMove={() => {
                  keyboardNavRef.current = false;
                  setActiveIndex(flatIndex);
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none",
                  option.disabled && "cursor-not-allowed opacity-50",
                  flatIndex === activeSafeIndex && "bg-accent",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{option.label}</span>
                  {option.description ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
                {isSelected ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
