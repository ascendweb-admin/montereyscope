"use client";

import Link from "next/link";
import { Pencil, Plus, Settings2, UsersRound } from "lucide-react";

import { XLogo } from "@/components/ui/platform-logos";
import { AvatarStack } from "@/components/x-dashboard/avatars";
import { scopeKey, type DashboardCreator, type DashboardList, type UnreadCounts } from "@/lib/x/dashboard/model";
import { cn } from "@/lib/utils";

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <span className="ml-auto min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-center text-[11px] leading-5 font-semibold text-primary-foreground tabular-nums">
      {count > 99 ? "99+" : count}
      <span className="sr-only"> new posts</span>
    </span>
  );
}

const rowClass =
  "flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none";

export function ListRail({
  lists,
  creatorsById,
  totalCreators,
  activeListId,
  unread,
  autoSyncMinutes,
  onSelect,
  onNew,
  onEdit,
}: {
  lists: DashboardList[];
  creatorsById: Map<number, DashboardCreator>;
  totalCreators: number;
  activeListId: number | null;
  unread: UnreadCounts;
  autoSyncMinutes: number;
  onSelect: (id: number | null) => void;
  onNew: () => void;
  onEdit: (list: DashboardList) => void;
}) {
  const members = (list: DashboardList) =>
    list.creatorIds.map((id) => creatorsById.get(id)).filter((c): c is DashboardCreator => Boolean(c));
  return (
    <nav aria-label="Lists" className="flex h-full min-h-0 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <span className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background">
          <XLogo className="size-3.5" />
        </span>
        <span className="text-sm font-semibold tracking-tight">X Dashboard</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <button
          type="button"
          aria-current={activeListId === null ? "page" : undefined}
          onClick={() => onSelect(null)}
          className={cn(
            rowClass,
            activeListId === null ? "bg-accent font-semibold" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <span className="flex w-10 shrink-0">
            <span className="flex size-6 items-center justify-center rounded-full bg-muted">
              <UsersRound aria-hidden="true" className="size-3.5" />
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate">All accounts</span>
          {activeListId !== null ? (
            <UnreadBadge count={unread[scopeKey(null)] ?? 0} />
          ) : (
            <span className="text-xs font-normal text-muted-foreground tabular-nums">{totalCreators}</span>
          )}
        </button>

        <div className="mt-4 mb-1 flex items-center justify-between px-2.5">
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Lists</h2>
          <button
            type="button"
            onClick={onNew}
            aria-label="New list"
            title="New list"
            className="rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <Plus aria-hidden="true" className="size-4" />
          </button>
        </div>
        <ul className="space-y-0.5">
          {lists.map((list) => {
            const active = list.id === activeListId;
            const people = members(list);
            return (
              <li key={list.id} className="group/list relative">
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelect(list.id)}
                  className={cn(
                    rowClass,
                    "pr-9",
                    active ? "bg-accent font-semibold" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {people.length ? (
                    <AvatarStack creators={people} max={2} size="sm" showRest={false} className="w-10 shrink-0" />
                  ) : (
                    <span className="flex w-10 shrink-0"><span className="size-6 rounded-full border border-dashed" aria-hidden="true" /></span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{list.name}</span>
                  {active ? null : <UnreadBadge count={unread[scopeKey(list.id)] ?? 0} />}
                </button>
                <button
                  type="button"
                  aria-label={`Edit ${list.name}`}
                  title="Edit list"
                  onClick={() => onEdit(list)}
                  className={cn(
                    "absolute top-1/2 right-1.5 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground opacity-0 outline-none transition-opacity group-hover/list:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                    active && "opacity-100",
                    !active && (unread[scopeKey(list.id)] ?? 0) > 0 && "group-hover/list:bg-accent",
                  )}
                >
                  <Pencil aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          onClick={onNew}
          className={cn(
            rowClass,
            "mt-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <span className="flex w-10 shrink-0">
            <span className="flex size-6 items-center justify-center rounded-full border border-dashed">
              <Plus aria-hidden="true" className="size-3.5" />
            </span>
          </span>
          {lists.length ? "New list" : "Create your first list"}
        </button>
      </div>
      <div className="shrink-0 border-t px-4 py-3">
        <Link
          href="/settings"
          className="flex items-center gap-2 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          <Settings2 aria-hidden="true" className="size-3.5" />
          {autoSyncMinutes
            ? `Auto-sync every ${autoSyncMinutes >= 60 ? `${autoSyncMinutes / 60} h` : `${autoSyncMinutes} min`}`
            : "Auto-sync is off"}
        </Link>
      </div>
    </nav>
  );
}
