/**
 * Server-side feed reads for the X Dashboard: rolling windows over the local
 * archive, a plain-language search box, and per-scope unread counts. Reading
 * never touches X.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import { readCachedFeed, researchScopeSql } from "@/lib/x/research/repository";
import { ResearchInputError } from "@/lib/x/research/input";
import { parseExactSearch } from "@/lib/x/research/search";
import type { ExactSearch } from "@/lib/x/research/model";
import {
  periodBounds,
  scopeKey,
  showTypes,
  type DashboardList,
  type FeedPage,
  type Period,
  type ShowFilter,
  type UnreadCounts,
} from "./model";

/**
 * Turns a search box value into exact archive terms: "quoted phrases" stay
 * together, every other word is required. `-word` excludes a word.
 */
export function parseSearchBox(value: string): ExactSearch | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const terms: string[] = [];
  const exclusions: string[] = [];
  for (const match of trimmed.matchAll(/(-?)"([^"]+)"|(-?)(\S+)/g)) {
    const negative = Boolean(match[1] || match[3]);
    const phrase = (match[2] ?? match[4] ?? "").trim();
    if (!/[\p{L}\p{N}]/u.test(phrase)) continue;
    (negative ? exclusions : terms).push(phrase.slice(0, 150));
  }
  if (!terms.length) {
    if (exclusions.length)
      throw new ResearchInputError("Add at least one word to search for, not only exclusions.");
    return null;
  }
  return parseExactSearch({
    terms: [...new Set(terms)].slice(0, 12).join("\n"),
    exclusions: [...new Set(exclusions)].slice(0, 12).join("\n"),
  });
}

export interface DashboardFeedQuery {
  creatorIds: number[];
  period: Period;
  show: ShowFilter;
  query?: string | null;
  page?: number;
  now?: number;
}

export function readDashboardFeed(db: ScopeDatabase, input: DashboardFeedQuery): FeedPage {
  const query = input.query?.trim() || null;
  if (!input.creatorIds.length)
    return { posts: [], total: 0, page: 1, pageSize: 30, hasMore: false, scopeTotal: 0, query };
  const search = query ? parseSearchBox(query) : null;
  const feed = readCachedFeed(db, {
    creatorIds: input.creatorIds,
    ...periodBounds(input.period, input.now),
    types: showTypes(input.show),
    page: input.page ?? 1,
    ...(search ? { search } : {}),
  });
  return {
    posts: feed.posts,
    total: feed.total,
    page: feed.page,
    pageSize: feed.pageSize,
    hasMore: feed.page * feed.pageSize < feed.total,
    scopeTotal: feed.scopeTotal,
    query,
  };
}

/** Counts posts newer than each scope's last visit. Never-visited scopes report 0. */
export function unreadCounts(
  db: ScopeDatabase,
  lists: DashboardList[],
  allCreatorIds: number[],
): UnreadCounts {
  const seen = new Map(
    (
      db.prepare("SELECT scope_key, seen_at FROM x_dashboard_seen").all() as Array<{
        scope_key: string;
        seen_at: string;
      }>
    ).map((row) => [row.scope_key, row.seen_at]),
  );
  const count = db.prepare(`${researchScopeSql()} SELECT COUNT(*) AS n FROM grouped`);
  const types = JSON.stringify(showTypes("replies"));
  const until = new Date(Date.now() + 60_000).toISOString();
  const result: UnreadCounts = {};
  const scopes: Array<[string, number[]]> = [
    [scopeKey(null), allCreatorIds],
    ...lists.map((list): [string, number[]] => [scopeKey(list.id), list.creatorIds]),
  ];
  for (const [key, ids] of scopes) {
    const since = seen.get(key);
    result[key] =
      since && ids.length
        ? (count.get({ ids: JSON.stringify(ids), types, since, until }) as { n: number }).n
        : 0;
  }
  return result;
}

export function markSeen(db: ScopeDatabase, listId: number | null, at = new Date()): void {
  db.prepare(
    `INSERT INTO x_dashboard_seen (scope_key, seen_at) VALUES (?, ?)
     ON CONFLICT (scope_key) DO UPDATE SET seen_at = MAX(seen_at, excluded.seen_at)`,
  ).run(scopeKey(listId), at.toISOString());
}
