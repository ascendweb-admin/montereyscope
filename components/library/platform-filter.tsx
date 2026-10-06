"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Layers3 } from "lucide-react";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import type { CreatorPlatform } from "@/lib/creators/repository";
import { cn } from "@/lib/utils";

const options = [
  {
    value: "all",
    label: "All platforms",
    description: "Your entire creator library",
    icon: Layers3,
    color: "bg-muted text-foreground",
  },
  {
    value: "youtube",
    label: "YouTube",
    description: "Creators on YouTube",
    icon: YouTubeLogo,
    color: "bg-[#FF0000]/10",
  },
  {
    value: "rumble",
    label: "Rumble",
    description: "Creators on Rumble",
    icon: RumbleLogo,
    color: "bg-[#85C742]/10",
  },
  {
    value: "x",
    label: "X",
    description: "Accounts on X (Twitter)",
    icon: XLogo,
    color: "bg-foreground/10",
  },
] as const;

type Platform = CreatorPlatform | "all";

export function PlatformFilter({
  value,
  onChange,
}: {
  value: Platform;
  onChange: (value: Platform) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];
  const Icon = selected.icon;

  useEffect(() => {
    if (!open) return;
    items.current[selectedIndex]?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open, selectedIndex]);

  return (
    <div
      ref={root}
      className="relative sm:w-44 sm:shrink-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={`Filter by platform: ${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex h-9 w-full items-center gap-2.5 rounded-lg border bg-background px-3 text-sm shadow-sm outline-none transition-colors hover:border-ring/50 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          open && "border-ring/50 bg-accent/50",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            "shrink-0",
            value === "all"
              ? "size-4 text-muted-foreground"
              : value === "youtube"
                ? "size-5"
                : "size-[18px]",
          )}
        />
        <span className="flex-1 text-left">{selected.label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Filter by platform"
          className="absolute top-full left-0 z-50 mt-2 w-72 max-w-[calc(100vw-3rem)] rounded-2xl border bg-popover p-1.5 text-popover-foreground shadow-[0_16px_48px_-12px_rgb(0_0_0/0.5),0_4px_12px_-4px_rgb(0_0_0/0.2)]"
          onKeyDown={(event) => {
            const index = items.current.indexOf(document.activeElement as HTMLButtonElement);
            let next: number | undefined;
            if (event.key === "ArrowDown") next = (index + 1) % options.length;
            if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = options.length - 1;
            if (event.key.length === 1 && /\S/.test(event.key)) {
              const match = options.findIndex((option) =>
                option.label.toLowerCase().startsWith(event.key.toLowerCase()),
              );
              if (match >= 0) next = match;
            }
            if (next !== undefined) {
              event.preventDefault();
              items.current[next]?.focus();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <p className="px-3 pt-2 pb-2.5 text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
            Filter by platform
          </p>
          {options.map((option, index) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  items.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={value === option.value}
                tabIndex={-1}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50 motion-reduce:transition-none",
                  value === option.value && "bg-accent/60",
                )}
              >
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-lg",
                    option.color,
                  )}
                >
                  <OptionIcon
                    aria-hidden="true"
                    className={
                      option.value === "youtube"
                        ? "size-6"
                        : option.value === "rumble"
                          ? "size-5"
                          : "size-[18px]"
                    }
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {value === option.value && (
                  <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
