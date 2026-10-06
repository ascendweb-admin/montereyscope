"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search, SearchX } from "lucide-react";

import { ChatGptLogo, ClaudeLogo, OpenCodeLogo } from "@/components/ai/provider-logos";
import { useModelCatalog } from "@/components/ai/model-catalog-provider";
import type { AiBackendId } from "@/lib/ai/backend-id";
import { cn } from "@/lib/utils";

/**
 * Model families shown as grouped sections in the picker, matched by model
 * id prefix. Purely presentational — the catalog stays flat; anything that
 * does not match a rule falls into "Other".
 */
const MODEL_FAMILIES: readonly { prefix: string; label: string }[] = [
  { prefix: "claude", label: "Claude" },
  { prefix: "gpt", label: "GPT" },
  { prefix: "deepseek", label: "DeepSeek" },
  { prefix: "glm", label: "GLM" },
  { prefix: "grok", label: "Grok" },
  { prefix: "hy", label: "Hy" },
  { prefix: "kimi", label: "Kimi" },
  { prefix: "longcat", label: "LongCat" },
  { prefix: "mimo", label: "MiMo" },
  { prefix: "minimax", label: "MiniMax" },
  { prefix: "muse", label: "Muse" },
  { prefix: "omen", label: "Omen" },
  { prefix: "qwen", label: "Qwen" },
];

function modelFamily(id: string, label: string): string {
  const haystack = `${id.toLowerCase()} ${label.toLowerCase()}`;
  return MODEL_FAMILIES.find((family) => haystack.includes(family.prefix))?.label ?? "Other";
}

function ProviderLogo({ provider, className }: { provider: AiBackendId; className?: string }) {
  if (provider === "codex") {
    return <ChatGptLogo className={className} />;
  }
  if (provider === "claude") {
    return <ClaudeLogo className={className} />;
  }
  return <OpenCodeLogo className={className} />;
}

/** One picker row, derived from a catalog model by the caller. */
export interface ModelPickerOption {
  id: string;
  label: string;
  description: string;
  /** True for models first discovered after the initial catalog baseline. */
  isNew?: boolean;
  /** False when the installed runtime cannot resolve the model. */
  usable?: boolean;
  /** Short explanation shown for non-usable entries. */
  note?: string;
}

/**
 * Searchable model picker in the style of a command palette: a trigger that
 * shows the current model, and a popover with a search field, models grouped
 * by family, full keyboard navigation, and a check on the selection. Hand
 * rolled on plain React — no popover dependency.
 *
 * The trigger renders whatever `value` the caller holds, even when that model
 * is absent from `models` (an unavailable saved selection must stay visible);
 * refreshed results never move focus or clear the selection.
 */
export function ModelPicker({
  provider,
  models,
  value,
  onChange,
  label,
  className,
}: {
  provider: AiBackendId;
  models: readonly ModelPickerOption[];
  /** The currently selected model id. */
  value: string;
  onChange: (modelId: string) => void;
  /** Accessible name for the trigger and the search field. */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  /** Open upward when there is not enough room below the trigger. */
  const [dropUp, setDropUp] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /**
   * Whether the latest activeIndex change came from the keyboard (or an
   * open/filter reset). Hovering must never scroll the list, so the
   * scroll-into-view effect only acts when this flag is set.
   */
  const keyboardNavRef = useRef(false);
  const reactId = useId();
  const listboxId = `${reactId}-listbox`;
  const optionId = (index: number) => `${reactId}-option-${index}`;

  const selected = models.find((model) => model.id === value) ?? null;
  const { ensureFresh } = useModelCatalog();

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return models;
    }
    return models.filter((model) =>
      `${model.label} ${model.id} ${model.description}`.toLowerCase().includes(needle),
    );
  }, [models, query]);

  /** Filtered models grouped into consecutive family sections. */
  const groups = useMemo(() => {
    const sections: Array<{
      label: string;
      entries: Array<{ model: ModelPickerOption; index: number }>;
    }> = [];
    filtered.forEach((model, index) => {
      const family = modelFamily(model.id, model.label);
      const section = sections[sections.length - 1];
      if (section && section.label === family) {
        section.entries.push({ model, index });
      } else {
        sections.push({ label: family, entries: [{ model, index }] });
      }
    });
    return sections;
  }, [filtered]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    setQuery("");
    if (refocus) {
      triggerRef.current?.focus();
    }
  };

  const openPicker = (): void => {
    const selectedIndex = models.findIndex((model) => model.id === value);
    setQuery("");
    keyboardNavRef.current = true;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    // Opening the picker is a freshness checkpoint: stale catalogs refresh in
    // the background while the cached list stays fully usable.
    ensureFresh();
    // Rough height of the popover (search bar + capped list + padding).
    const estimatedHeight = 40 + 320 + 16;
    const rect = triggerRef.current?.getBoundingClientRect();
    setDropUp(
      rect !== undefined &&
        window.innerHeight - rect.bottom < estimatedHeight &&
        rect.top > estimatedHeight,
    );
    setOpen(true);
  };

  const select = (model: ModelPickerOption): void => {
    if (model.usable === false) {
      return;
    }
    onChange(model.id);
    close(true);
  };

  // Focus the search field once the popover mounts. Focus must not scroll:
  // the popover is absolutely positioned, so a focus-driven scroll would move
  // the whole settings page (and the popover with it) when the trigger was
  // near the viewport edge.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  /** A refresh can shrink the list; clamp without moving the selection. */
  const activeSafeIndex = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1);

  // Keep the keyboard highlight visible while arrowing through the list.
  // Pointer-driven highlight changes must not scroll, so only keyboard
  // navigation (and open/filter resets) trigger scrolling. Adjusting the
  // list's own scrollTop scrolls only the popover; scrollIntoView would also
  // scroll ancestor scrollports and visibly jump the settings page.
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

  // Click outside closes the popover.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (filtered.length > 0) {
          keyboardNavRef.current = true;
          setActiveIndex((index) => (index + 1) % filtered.length);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (filtered.length > 0) {
          keyboardNavRef.current = true;
          setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
        }
        break;
      case "Home":
        event.preventDefault();
        keyboardNavRef.current = true;
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        keyboardNavRef.current = true;
        setActiveIndex(Math.max(0, filtered.length - 1));
        break;
      case "Enter": {
        event.preventDefault();
        const option = filtered[activeSafeIndex];
        if (option) {
          select(option);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        setOpen(false);
        setQuery("");
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : openPicker())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={`${label}: ${selected?.label ?? value}`}
        className="flex h-10 w-full items-center gap-2.5 rounded-md border border-input bg-background px-3 text-left shadow-sm outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <ProviderLogo provider={provider} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {selected?.label ?? value}
        </span>
        <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open ? (
        <div
          className={cn(
            "absolute inset-x-0 z-40 overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg",
            dropUp ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              role="combobox"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                keyboardNavRef.current = true;
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
              placeholder="Search models…"
              aria-label="Search models"
              aria-expanded
              aria-controls={listboxId}
              aria-activedescendant={activeSafeIndex >= 0 ? optionId(activeSafeIndex) : undefined}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
              <SearchX aria-hidden="true" className="size-5 text-muted-foreground" />
              <p className="text-sm font-medium">No models found</p>
              <p className="text-xs text-muted-foreground">
                {query.trim().length > 0 ? (
                  <>Nothing matches “{query.trim()}”.</>
                ) : (
                  <>No models are available with the installed CLI right now.</>
                )}
              </p>
            </div>
          ) : (
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={label}
              className="max-h-80 overflow-y-auto overscroll-contain p-1.5"
            >
              {groups.map((section) => (
                <Fragment key={`${section.label}-${section.entries[0]?.model.id}`}>
                  <li
                    role="presentation"
                    className="px-2 pb-1 pt-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                  >
                    {section.label}
                  </li>
                  {section.entries.map(({ model, index }) => {
                    const isSelected = model.id === value;
                    const usable = model.usable !== false;
                    return (
                      <li
                        key={model.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isSelected}
                        aria-disabled={!usable || undefined}
                        data-active={index === activeSafeIndex || undefined}
                        onClick={() => select(model)}
                        onPointerMove={() => setActiveIndex(index)}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 outline-none",
                          usable ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                          index === activeSafeIndex && "bg-accent",
                        )}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{model.label}</span>
                            {model.isNew ? (
                              <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-primary">
                                New
                              </span>
                            ) : null}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {!usable && model.note ? model.note : model.description}
                          </span>
                        </span>
                        {isSelected ? (
                          <Check aria-hidden="true" className="size-4 shrink-0" />
                        ) : null}
                      </li>
                    );
                  })}
                </Fragment>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
