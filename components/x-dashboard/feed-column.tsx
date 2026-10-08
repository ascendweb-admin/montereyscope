"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Check, ChevronDown, CloudDownload, Inbox, Search, SearchX, UsersRound, WifiOff, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/pending";
import { CreatorAvatar } from "@/components/x-dashboard/avatars";
import { PostCard, PostSkeleton } from "@/components/x-dashboard/post-card";
import {
  PERIOD_LABELS,
  PERIODS,
  SHOW_FILTERS,
  SHOW_HINTS,
  SHOW_LABELS,
  type DashboardCreator,
  type Period,
  type ShowFilter,
} from "@/lib/x/dashboard/model";
import type { ResearchPost } from "@/lib/x/research/model";
import { cn } from "@/lib/utils";

const SHORT_PERIOD: Record<Period, string> = { "24h": "24h", "7d": "7d", "30d": "30d", "90d": "90d", all: "All" };

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node))
        close();
    };
    document.addEventListener("pointerdown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("pointerdown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [open, close]);
  return ref;
}

const chip =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-background px-3 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

function ShowMenu({ value, onChange }: { value: ShowFilter; onChange: (value: ShowFilter) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={chip}>
        {SHOW_LABELS[value]}
        <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
      </button>
      {open ? (
        <ul role="listbox" aria-label="Show" className="absolute top-full left-0 z-30 mt-1.5 w-60 rounded-xl border bg-popover p-1 shadow-lg">
          {SHOW_FILTERS.map((option) => (
            <li key={option} role="none">
              <button
                type="button"
                role="option"
                aria-selected={option === value}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-accent focus-visible:bg-accent"
              >
                <Check aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", option !== value && "invisible")} />
                <span>
                  <span className="block text-sm font-medium">{SHOW_LABELS[option]}</span>
                  <span className="block text-xs text-muted-foreground">{SHOW_HINTS[option]}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AccountFilter({
  creators,
  value,
  onChange,
}: {
  creators: DashboardCreator[];
  value: number[] | null;
  onChange: (value: number[] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const active = value?.length ? creators.filter((c) => value.includes(c.id)) : [];
  if (creators.length < 2) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(chip, active.length && "border-foreground/30 bg-accent text-foreground")}
      >
        <UsersRound aria-hidden="true" className="size-3.5" />
        {active.length === 1
          ? `@${active[0].handle ?? active[0].displayName}`
          : active.length
            ? `${active.length} accounts`
            : "All accounts"}
        <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
      </button>
      {active.length ? (
        <button
          type="button"
          aria-label="Show all accounts"
          onClick={() => onChange(null)}
          className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full bg-foreground text-background"
        >
          <X aria-hidden="true" className="size-2.5" />
        </button>
      ) : null}
      {open ? (
        <div role="dialog" aria-label="Filter accounts" className="absolute top-full left-0 z-30 mt-1.5 w-72 rounded-xl border bg-popover p-1 shadow-lg">
          <ul className="max-h-80 overflow-y-auto">
            {creators.map((creator) => {
              const checked = Boolean(value?.includes(creator.id));
              return (
                <li key={creator.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => {
                      const next = checked ? (value ?? []).filter((id) => id !== creator.id) : [...(value ?? []), creator.id];
                      onChange(next.length ? next : null);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
                  >
                    <CreatorAvatar creator={creator} className="size-7 text-[10px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{creator.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">@{creator.handle}</span>
                    </span>
                    <Check aria-hidden="true" className={cn("size-4 text-foreground", !checked && "invisible")} />
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-1 flex justify-between border-t px-2 pt-1.5 pb-0.5">
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onChange(null)}>
              Show all
            </button>
            <button type="button" className="text-xs font-medium hover:underline" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 350);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && !target.isContentEditable) {
        event.preventDefault();
        ref.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return (
    <label className="relative block min-w-40 flex-1">
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        ref={ref}
        type="search"
        value={draft}
        aria-label="Search posts"
        placeholder="Search posts"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onChange(draft);
          if (event.key === "Escape" && draft) {
            event.stopPropagation();
            setDraft("");
            onChange("");
          }
        }}
        className="h-8 w-full rounded-full border bg-muted/40 pr-8 pl-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground/30 focus:bg-background [&::-webkit-search-cancel-button]:hidden motion-reduce:transition-none"
      />
      {draft ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setDraft("");
            onChange("");
          }}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X aria-hidden="true" className="size-3.5" />
        </button>
      ) : (
        <kbd className="pointer-events-none absolute top-1/2 right-2.5 hidden -translate-y-1/2 rounded border px-1 font-mono text-[10px] text-muted-foreground sm:block">
          /
        </kbd>
      )}
    </label>
  );
}

export function FilterBar({
  period,
  onPeriod,
  show,
  onShow,
  query,
  onQuery,
  creators,
  creatorFilter,
  onCreatorFilter,
}: {
  period: Period;
  onPeriod: (value: Period) => void;
  show: ShowFilter;
  onShow: (value: ShowFilter) => void;
  query: string;
  onQuery: (value: string) => void;
  creators: DashboardCreator[];
  creatorFilter: number[] | null;
  onCreatorFilter: (value: number[] | null) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3 sm:px-5">
      <div role="group" aria-label="Time range" className="flex h-8 shrink-0 items-center rounded-full bg-muted/70 p-0.5">
        {PERIODS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={period === option}
            title={PERIOD_LABELS[option]}
            onClick={() => onPeriod(option)}
            className={cn(
              "h-7 rounded-full px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
              period === option ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {SHORT_PERIOD[option]}
          </button>
        ))}
      </div>
      <ShowMenu value={show} onChange={onShow} />
      <AccountFilter creators={creators} value={creatorFilter} onChange={onCreatorFilter} />
      <SearchBox value={query} onChange={onQuery} />
    </div>
  );
}

function dayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: days < 7 ? "long" : undefined,
    month: "long",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-20 text-center">
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">{icon}</span>
      <h3 className="mt-4 text-base font-semibold">{title}</h3>
      <div className="mt-1.5 max-w-sm text-sm text-balance text-muted-foreground">{children}</div>
    </div>
  );
}

export function FeedList({
  posts,
  total,
  hasMore,
  loadingMore,
  initialLoading,
  stale,
  error,
  terms,
  selection,
  syncing,
  neverSynced,
  xConnected,
  hasCreators,
  query,
  period,
  scrollRoot,
  onLoadMore,
  onRetry,
  onToggleSelect,
  onAsk,
  onOpen,
  onPeriod,
  onClearQuery,
  onEditList,
  onSync,
}: {
  posts: ResearchPost[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  initialLoading: boolean;
  stale: boolean;
  error: string | null;
  terms: string[];
  selection: string[];
  syncing: boolean;
  neverSynced: boolean;
  xConnected: boolean;
  hasCreators: boolean;
  query: string;
  period: Period;
  scrollRoot: React.RefObject<HTMLElement | null>;
  onLoadMore: () => void;
  onRetry: () => void;
  onToggleSelect: (id: string) => void;
  onAsk: (post: ResearchPost) => void;
  onOpen: (post: ResearchPost) => void;
  onPeriod: (period: Period) => void;
  onClearQuery: () => void;
  onEditList: (() => void) | null;
  onSync: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root: scrollRoot.current, rootMargin: "800px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, scrollRoot, posts.length]);

  if (!hasCreators)
    return (
      <EmptyState icon={<UsersRound className="size-6" />} title="No accounts in this list yet">
        Add the X accounts you want to follow, then their posts show up here.
        {onEditList ? (
          <div className="mt-4">
            <Button size="sm" onClick={onEditList}>
              Add accounts
            </Button>
          </div>
        ) : null}
      </EmptyState>
    );
  if (error && !posts.length)
    return (
      <EmptyState icon={<SearchX className="size-6" />} title="Couldn't load posts">
        {error}
        <div className="mt-4">
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </EmptyState>
    );
  if (initialLoading)
    return (
      <div role="status" aria-label="Loading posts" className="divide-y">
        {Array.from({ length: 6 }, (_, i) => (
          <PostSkeleton key={i} />
        ))}
      </div>
    );
  if (!posts.length) {
    if (query)
      return (
        <EmptyState icon={<SearchX className="size-6" />} title={`No posts match “${query}”`}>
          Try other words, or a longer time range.
          <div className="mt-4 flex justify-center gap-2">
            {period !== "all" ? (
              <Button size="sm" variant="outline" onClick={() => onPeriod("all")}>
                Search all time
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={onClearQuery}>
              Clear search
            </Button>
          </div>
        </EmptyState>
      );
    if (syncing)
      return (
        <EmptyState icon={<Spinner className="size-6" />} title="Fetching posts from X…">
          New posts appear here as they arrive. The first sync of an account can take a minute or two.
        </EmptyState>
      );
    if (neverSynced)
      return xConnected ? (
        <EmptyState icon={<CloudDownload className="size-6" />} title="No posts yet">
          Sync to bring in the latest posts from these accounts.
          <div className="mt-4">
            <Button size="sm" onClick={onSync}>
              Sync now
            </Button>
          </div>
        </EmptyState>
      ) : (
        <EmptyState icon={<WifiOff className="size-6" />} title="Connect X to start">
          Scope reads posts through your own X account. Connect it once and posts sync automatically.
          <div className="mt-4">
            <Link href="/settings" className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
              Connect X in Settings
            </Link>
          </div>
        </EmptyState>
      );
    return (
      <EmptyState icon={<Inbox className="size-6" />} title={period === "24h" ? "Nothing in the last 24 hours" : `Nothing in the last ${PERIOD_LABELS[period].toLowerCase()}`}>
        These accounts haven&apos;t posted in this time range, or their posts aren&apos;t synced yet.
        {period !== "all" ? (
          <div className="mt-4 flex justify-center gap-2">
            <Button size="sm" variant="outline" onClick={() => onPeriod(period === "24h" ? "7d" : period === "7d" ? "30d" : "all")}>
              Show {period === "24h" ? "7 days" : period === "7d" ? "30 days" : "all time"}
            </Button>
          </div>
        ) : null}
      </EmptyState>
    );
  }

  const groups: Array<{ label: string; posts: ResearchPost[] }> = [];
  for (const post of posts) {
    const label = dayLabel(post.eventAt);
    if (groups.at(-1)?.label !== label) groups.push({ label, posts: [] });
    groups.at(-1)!.posts.push(post);
  }
  const selecting = selection.length > 0;
  return (
    <div aria-busy={stale || undefined} className={cn("transition-opacity motion-reduce:transition-none", stale && "opacity-50 delay-200")}>
      {query ? (
        <p className="border-b px-5 py-2 text-xs text-muted-foreground tabular-nums">
          {total.toLocaleString()} post{total === 1 ? "" : "s"} matching “{query}”
        </p>
      ) : null}
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <h3 className="sticky top-[var(--feed-header-height,0px)] z-[5] border-b bg-background/90 px-5 py-1.5 text-xs font-semibold text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-background/75">
            {group.label}
          </h3>
          <div className="divide-y border-b">
            {group.posts.map((post) => (
              <PostCard
                key={post.tweet.id}
                post={post}
                terms={terms}
                selected={selection.includes(post.tweet.id)}
                selecting={selecting}
                onToggleSelect={onToggleSelect}
                onAsk={onAsk}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
      <div ref={sentinel} className="flex h-20 items-center justify-center text-xs text-muted-foreground">
        {hasMore ? (
          loadingMore ? (
            <Spinner />
          ) : (
            <button type="button" onClick={onLoadMore} className="hover:text-foreground hover:underline">
              Load more
            </button>
          )
        ) : (
          <span>
            {period === "all" ? "That's everything saved so far." : (
              <>
                End of the last {PERIOD_LABELS[period].toLowerCase()} ·{" "}
                <button type="button" className="font-medium hover:text-foreground hover:underline" onClick={() => onPeriod(period === "24h" ? "7d" : period === "7d" ? "30d" : period === "30d" ? "90d" : "all")}>
                  Show more
                </button>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
