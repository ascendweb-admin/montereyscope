"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ListFilter, Search, X } from "lucide-react";

import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { RumbleLogo, XLogo, YouTubeLogo } from "@/components/ui/platform-logos";
import {
  activeFacetCount,
  NO_FACETS,
  PLATFORM_LABELS,
  toggleFacet,
  type FacetOptions,
  type ReportCreatorSummary,
  type ReportFacets,
  type ReportPlatform,
} from "@/components/reports/model";
import { CATEGORY_COLOR_STYLES } from "@/lib/categories/model";
import { cn } from "@/lib/utils";

/** Creators listed before the popover offers a name filter. */
const CREATOR_SEARCH_THRESHOLD = 8;

/** A platform's mark at text size: the YouTube and Rumble logos, the X glyph. */
export function PlatformMark({
  platform,
  className,
}: {
  platform: ReportPlatform;
  className?: string;
}) {
  const Logo = platform === "youtube" ? YouTubeLogo : platform === "rumble" ? RumbleLogo : XLogo;
  return <Logo className={cn("size-3 shrink-0", className)} />;
}

/** A person's avatar through the local proxy, with an initials fallback. */
export function ReportCreatorAvatar({
  creator,
  className,
}: {
  creator: ReportCreatorSummary;
  className?: string;
}) {
  return (
    <CreatorAvatar
      creator={{
        id: creator.avatarCreatorId ?? 0,
        displayName: creator.name,
        avatarUrl: creator.avatarCreatorId === null ? null : creator.avatarUrl,
      }}
      className={className}
    />
  );
}

/** Overlapping avatars of a report's people, most-cited first. */
export function ReportAvatarStack({
  creators,
  max = 3,
  className,
}: {
  creators: readonly ReportCreatorSummary[];
  max?: number;
  className?: string;
}) {
  if (creators.length === 0) {
    return null;
  }
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center", className)}>
      {creators.slice(0, max).map((creator) => (
        <ReportCreatorAvatar
          key={creator.id}
          creator={creator}
          className="-ml-1 size-4 border border-card text-[7px] first:ml-0"
        />
      ))}
    </span>
  );
}

function FilterSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-1.5 pt-2.5 pb-1">
      <h3 className="px-1 pb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

const pill =
  "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

/**
 * The rail's Filter button and its popover: source type (platform),
 * category, and creator, each a multi-select whose values come from the
 * reports themselves, with how many reports carry each. Sections with
 * nothing to tell apart stay hidden, and so does the button when no
 * section is left. Escape or a click outside closes it.
 */
export function ReportFilterMenu({
  options,
  facets,
  onFacets,
  matching,
  total,
}: {
  options: FacetOptions;
  facets: ReportFacets;
  onFacets: (next: ReportFacets) => void;
  /** Reports the current search and filters leave in view. */
  matching: number;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const [creatorQuery, setCreatorQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const active = activeFacetCount(facets);

  const showPlatforms = options.platforms.length > 1;
  const showCategories = options.categories.length > 0;
  const showCreators = options.creators.length > 1;

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button, input")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  if (!showPlatforms && !showCategories && !showCreators && active === 0) {
    return null;
  }

  const close = (): void => {
    setOpen(false);
    trigger.current?.focus();
  };
  const needle = creatorQuery.trim().toLowerCase();
  const creators = needle
    ? options.creators.filter((creator) => creator.name.toLowerCase().includes(needle))
    : options.creators;

  return (
    <div
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label={active > 0 ? `Filters, ${active} active` : "Filters"}
        title="Filter by creator, category, or source type"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-full border outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
          active > 0 || open
            ? "border-foreground/25 bg-accent text-foreground"
            : "bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <ListFilter aria-hidden="true" className="size-3.5" />
        {active > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] leading-none font-semibold text-background tabular-nums"
          >
            {active}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panel}
          id={panelId}
          role="dialog"
          aria-label="Filter reports"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}
          className="absolute inset-x-0 top-full z-50 mt-2 flex max-h-[min(32rem,calc(100dvh-10rem))] flex-col rounded-2xl border bg-popover text-popover-foreground shadow-[0_16px_48px_-12px_rgb(0_0_0/0.45),0_4px_12px_-4px_rgb(0_0_0/0.2)]"
        >
          <div className="flex shrink-0 items-center justify-between border-b px-3.5 py-2.5">
            <h2 className="text-sm font-semibold">Filter reports</h2>
            {active > 0 ? (
              <button
                type="button"
                onClick={() => onFacets(NO_FACETS)}
                className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear all
              </button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto pb-1.5">
            {showPlatforms ? (
              <FilterSection title="Source type">
                <div className="flex flex-wrap gap-1.5 px-1">
                  {options.platforms.map((option) => {
                    const pressed = facets.platforms.includes(option.id);
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() =>
                          onFacets({
                            ...facets,
                            platforms: toggleFacet(facets.platforms, option.id),
                          })
                        }
                        className={cn(
                          pill,
                          pressed
                            ? "border-foreground bg-foreground text-background"
                            : "bg-background hover:bg-accent",
                        )}
                      >
                        <PlatformMark platform={option.id} className="size-3.5" />
                        {PLATFORM_LABELS[option.id]}
                        <span
                          className={cn(
                            "tabular-nums",
                            pressed ? "text-background/70" : "text-muted-foreground",
                          )}
                        >
                          {option.reportCount}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </FilterSection>
            ) : null}

            {showCategories ? (
              <FilterSection title="Category">
                <div className="flex flex-wrap gap-1.5 px-1">
                  {options.categories.map((option) => {
                    const pressed = facets.categories.includes(option.id);
                    const styles = CATEGORY_COLOR_STYLES[option.color];
                    return (
                      <button
                        key={option.id}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() =>
                          onFacets({
                            ...facets,
                            categories: toggleFacet(facets.categories, option.id),
                          })
                        }
                        className={cn(
                          pill,
                          pressed ? styles.selected : "bg-background hover:bg-accent",
                        )}
                      >
                        {pressed ? null : (
                          <span
                            aria-hidden="true"
                            className={cn("size-1.5 shrink-0 rounded-full", styles.dot)}
                          />
                        )}
                        <span className="truncate">{option.name}</span>
                        <span className="tabular-nums opacity-70">{option.reportCount}</span>
                      </button>
                    );
                  })}
                </div>
              </FilterSection>
            ) : null}

            {showCreators ? (
              <FilterSection title="Creator">
                {options.creators.length > CREATOR_SEARCH_THRESHOLD ? (
                  <label className="relative mx-1 mb-1.5 block">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-2.5 size-3 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      type="search"
                      value={creatorQuery}
                      aria-label="Find a creator"
                      placeholder="Find a creator"
                      onChange={(event) => setCreatorQuery(event.target.value)}
                      className="h-7 w-full rounded-md border bg-background pr-2 pl-7 text-xs outline-none placeholder:text-muted-foreground focus:border-foreground/30 [&::-webkit-search-cancel-button]:hidden"
                    />
                  </label>
                ) : null}
                <ul className="space-y-px">
                  {creators.map((creator) => {
                    const checked = facets.creators.includes(creator.id);
                    return (
                      <li key={creator.id}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={checked}
                          onClick={() =>
                            onFacets({
                              ...facets,
                              creators: toggleFacet(facets.creators, creator.id),
                            })
                          }
                          className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent motion-reduce:transition-none"
                        >
                          <ReportCreatorAvatar creator={creator} className="size-6 text-[9px]" />
                          <span className="min-w-0 flex-1 truncate text-sm">{creator.name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {creator.reportCount}
                          </span>
                          <span
                            aria-hidden="true"
                            className={cn(
                              "flex size-4 shrink-0 items-center justify-center rounded border",
                              checked
                                ? "border-foreground bg-foreground text-background"
                                : "border-input bg-background",
                            )}
                          >
                            {checked ? <Check className="size-3" /> : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                  {creators.length === 0 ? (
                    <li className="px-2 py-2 text-xs text-muted-foreground">
                      No creator by that name.
                    </li>
                  ) : null}
                </ul>
              </FilterSection>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3.5 py-2">
            <span className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {matching === total ? `${total} reports` : `${matching} of ${total} reports`}
            </span>
            <button
              type="button"
              onClick={close}
              className="h-7 rounded-full bg-foreground px-3 text-xs font-medium text-background outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The filters in force, one removable chip each, under the search box — so
 * a filtered rail always says why it is short.
 */
export function ActiveFacetChips({
  options,
  facets,
  onFacets,
}: {
  options: FacetOptions;
  facets: ReportFacets;
  onFacets: (next: ReportFacets) => void;
}) {
  if (activeFacetCount(facets) === 0) {
    return null;
  }
  const chips: Array<{ key: string; label: string; icon: ReactNode; remove: () => void }> = [];
  for (const id of facets.platforms) {
    chips.push({
      key: `platform:${id}`,
      label: PLATFORM_LABELS[id],
      icon: <PlatformMark platform={id} />,
      remove: () => onFacets({ ...facets, platforms: toggleFacet(facets.platforms, id) }),
    });
  }
  for (const id of facets.categories) {
    const category = options.categories.find((option) => option.id === id);
    chips.push({
      key: `category:${id}`,
      label: category?.name ?? "Category",
      icon: (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            category ? CATEGORY_COLOR_STYLES[category.color].dot : "bg-muted-foreground",
          )}
        />
      ),
      remove: () => onFacets({ ...facets, categories: toggleFacet(facets.categories, id) }),
    });
  }
  for (const id of facets.creators) {
    const creator = options.creators.find((option) => option.id === id);
    chips.push({
      key: `creator:${id}`,
      label: creator?.name ?? "Creator",
      icon: creator ? (
        <ReportCreatorAvatar creator={creator} className="size-4 text-[7px]" />
      ) : null,
      remove: () => onFacets({ ...facets, creators: toggleFacet(facets.creators, id) }),
    });
  }

  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-1">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-background pr-0.5 pl-2 text-[11px] font-medium"
        >
          {chip.icon}
          <span className="truncate">{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove filter: ${chip.label}`}
            onClick={chip.remove}
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={() => onFacets(NO_FACETS)}
          className="h-6 rounded-full px-2 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
