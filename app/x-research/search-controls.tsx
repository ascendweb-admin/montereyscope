"use client";

import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface SearchFields {
  terms: string;
  aliases: string;
  exclusions: string;
}

const textareaField =
  "min-h-20 w-full min-w-0 rounded-md border border-input bg-background p-2.5 text-sm shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

/**
 * The feed's search bar: a quick exact-terms input that searches the archive
 * as you press Enter, with an advanced panel for alias groups and exclusions.
 * An active search shows a result header with a clear action; clearing
 * returns to the plain chronological feed via `onFeed`.
 */
export function SearchControls({
  search,
  onSearch,
  onFeed,
}: {
  search: SearchFields | null;
  onSearch: (fields: SearchFields) => void;
  onFeed: () => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fields, setFields] = useState<SearchFields>({ terms: "", aliases: "", exclusions: "" });
  const [quick, setQuick] = useState(search?.terms.split("\n")[0] ?? "");
  const [seenSearch, setSeenSearch] = useState(search);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the quick input in sync when the active search changes from outside
  // (adjust-during-render so a parent-driven clear/search updates the input).
  if (seenSearch !== search) {
    setSeenSearch(search);
    setQuick(search?.terms.split("\n")[0] ?? "");
  }

  useEffect(() => {
    if (!showAdvanced) {
      return;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setShowAdvanced(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showAdvanced]);

  const openAdvanced = (): void => {
    setFields(search ? { ...search } : { terms: quick, aliases: "", exclusions: "" });
    setShowAdvanced((current) => !current);
  };

  const clear = (): void => {
    setQuick("");
    setFields({ terms: "", aliases: "", exclusions: "" });
    onFeed();
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div
        className={cn(
          "flex h-10 items-center gap-2 rounded-xl border border-input bg-background px-3 shadow-sm transition-colors focus-within:ring-2 focus-within:ring-ring motion-reduce:transition-none",
          search && "border-ring/50",
        )}
      >
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search the archive for exact terms"
          placeholder="Search the archive — one exact word or phrase"
          value={quick}
          maxLength={2000}
          onChange={(event) => setQuick(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              const terms = quick.trim();
              if (terms) {
                onSearch({ terms, aliases: "", exclusions: "" });
              }
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {search ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search and return to the feed"
            className="rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />
        <button
          type="button"
          onClick={openAdvanced}
          aria-label="Advanced search: required terms, aliases and exclusions"
          aria-expanded={showAdvanced}
          className={cn(
            "rounded-md p-1.5 text-muted-foreground outline-none transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
            (showAdvanced || (search && (search.aliases.trim() || search.exclusions.trim()))) &&
              "bg-accent text-foreground",
          )}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
        </button>
      </div>

      {showAdvanced ? (
        <div className="absolute inset-x-0 top-full z-30 mt-2 space-y-3 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Case-insensitive whole words and consecutive word sequences, one literal phrase per
            line. Punctuation separates words; <span className="font-mono">$</span> stays in
            tickers. Quoted text is excluded — no operators or wildcards.
          </p>
          <div className="grid gap-3 md:grid-cols-3">
            {(
              [
                ["terms", "Required terms or phrases", "Match every line", "ETH\nbase layer"],
                ["aliases", "Alias group", "Match at least one line", "ETH\nEthereum\n$ETH"],
                ["exclusions", "Exclude terms or phrases", "Exclude any matching line", "memecoin"],
              ] as const
            ).map(([key, labelText, hint, placeholder]) => (
              <label key={key} className="min-w-0 space-y-1 text-xs font-medium">
                <span className="block">{labelText}</span>
                <textarea
                  className={textareaField}
                  value={fields[key]}
                  maxLength={2000}
                  placeholder={placeholder}
                  onChange={(event) =>
                    setFields((current) => ({ ...current, [key]: event.target.value }))
                  }
                />
                <span className="block font-normal text-muted-foreground">{hint}.</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onSearch({ ...fields });
                setShowAdvanced(false);
              }}
            >
              <Search aria-hidden="true" />
              Search archive
            </Button>
            {search ? (
              <Button type="button" size="sm" variant="outline" onClick={clear}>
                Clear search
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
