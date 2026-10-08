/**
 * Client-safe shapes for the X Dashboard: feed windows and filters, sync
 * state, and AI insights. No server imports — the dashboard UI and the route
 * handlers share these.
 */
import type { ResearchPost, ResearchPostType } from "@/lib/x/research/model";

export const PERIODS = ["24h", "7d", "30d", "90d", "all"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<Period, string> = {
  "24h": "24h",
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};
const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};
/** X launched in 2006; nothing in the archive is older. */
const EPOCH = Date.UTC(2006, 0, 1);

/** Rolling window ending now (exclusive end a minute ahead absorbs clock skew). */
export function periodBounds(period: Period, now = Date.now()): { since: string; until: string } {
  const since = period === "all" ? EPOCH : now - PERIOD_DAYS[period] * 86_400_000;
  return { since: new Date(since).toISOString(), until: new Date(now + 60_000).toISOString() };
}

export const SHOW_FILTERS = ["posts", "replies", "everything"] as const;
export type ShowFilter = (typeof SHOW_FILTERS)[number];
export const SHOW_LABELS: Record<ShowFilter, string> = {
  posts: "Posts",
  replies: "Posts & replies",
  everything: "Everything",
};
export const SHOW_HINTS: Record<ShowFilter, string> = {
  posts: "Original posts and quotes",
  replies: "Adds replies to other people",
  everything: "Adds reposts of other accounts",
};
export function showTypes(show: ShowFilter): ResearchPostType[] {
  if (show === "posts") return ["original", "quote"];
  if (show === "replies") return ["original", "quote", "reply"];
  return ["original", "quote", "reply", "repost"];
}

export const isPeriod = (value: unknown): value is Period => PERIODS.includes(value as Period);
export const isShowFilter = (value: unknown): value is ShowFilter =>
  SHOW_FILTERS.includes(value as ShowFilter);

export interface DashboardCreator {
  id: number;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  categoryIds: number[];
}
export interface DashboardList {
  id: number;
  name: string;
  description: string;
  creatorIds: number[];
}

export interface FeedPage {
  posts: ResearchPost[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Posts in the window before any search, for "N matches in M posts". */
  scopeTotal: number;
  query: string | null;
}

/** Unread posts per dashboard scope key ("all" or "list:<id>"). */
export type UnreadCounts = Record<string, number>;
export const scopeKey = (listId: number | null) => (listId === null ? "all" : `list:${listId}`);

/**
 * "paused": X kept rate limiting until Scope stopped retrying for now; the next sync after
 * `retryAt` tries again.
 */
export type SyncState =
  "idle" | "syncing" | "waiting" | "paused" | "error" | "disconnected" | "never";
export interface SyncCreatorState {
  creatorId: number;
  state: SyncState;
  lastSyncedAt: string | null;
  retryAt: string | null;
  message: string | null;
  newPosts: number;
  /** True while this is the creator's first sync. */
  firstSync: boolean;
  /** Older posts still importing in the background after the recent ones arrived. */
  olderPosts: { since: string; waiting: boolean } | null;
}
export interface SyncSnapshot {
  state: SyncState;
  lastSyncedAt: string | null;
  /** Creators whose recent posts are still being read. */
  pending: number;
  total: number;
  retryAt: string | null;
  message: string | null;
  /** New posts saved by the most recent sync run of this scope. */
  newPosts: number;
  /** Creators still importing older posts in the background (not counted in `pending`). */
  backfilling: number;
  creators: SyncCreatorState[];
}

export interface InsightScope {
  label: string;
  listId: number | null;
  creatorIds: number[];
  period: Period;
  show: ShowFilter;
  since: string;
  until: string;
  query?: string | null;
  tweetIds?: string[];
}
export type InsightStatus = "running" | "complete" | "failed" | "cancelled";
export interface InsightSummary {
  id: string;
  title: string;
  preset: string | null;
  listId: number | null;
  scope: InsightScope;
  postCount: number;
  status: InsightStatus;
  backend: string;
  model: string;
  error: string | null;
  reportId: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface InsightMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  status: InsightStatus;
  createdAt: string;
}
export interface InsightSource {
  id: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string | null;
  creatorId: number;
  text: string;
  url: string;
  publishedAt: string | null;
}
export interface InsightDetail extends InsightSummary {
  messages: InsightMessage[];
  /** Every post the insight cites, keyed by post id. */
  sources: Record<string, InsightSource>;
}

/** The citation token the model is asked to write after each supported claim. */
export const CITATION_PATTERN = /\[post:(\d{1,20})\]/g;

export interface InsightPreset {
  id: string;
  label: string;
  description: string;
  prompt: string;
}
export const INSIGHT_PRESETS: readonly InsightPreset[] = [
  {
    id: "brief",
    label: "Brief me",
    description: "The biggest stories and takes, TL;DR first",
    prompt:
      "Write a brief of what these accounts posted in this window. Start with a TL;DR of 3–5 bullets, then cover the main stories and notable takes under short headings, newest and most-discussed first. Flag anything time-sensitive.",
  },
  {
    id: "narratives",
    label: "Top narratives",
    description: "Themes ranked by attention, and who drives them",
    prompt:
      "Identify the main narratives and themes in these posts, ranked by how much attention they get. For each: a one-line summary, who is driving it, the strongest arguments, and how it developed over the window.",
  },
  {
    id: "tickers",
    label: "Tickers & calls",
    description: "Every asset mentioned, with direction and targets",
    prompt:
      "List every asset, token, ticker, company or project mentioned, most-discussed first. Give each one a `###` heading with labelled bullets: **Who**, **Stance** (bullish / bearish / neutral), **Call or target**, **Timeframe**. Group repeated mentions, and add a short note at the end on the most-discussed ones.",
  },
  {
    id: "consensus",
    label: "Agree vs disagree",
    description: "Where these voices align and where they clash",
    prompt:
      "Compare these creators: where do they agree, and where do they clearly disagree? For each disagreement, give each side's position and reasoning. End with the topics where there is no clear consensus.",
  },
  {
    id: "creators",
    label: "Per creator",
    description: "Each account's focus, mood and standout post",
    prompt:
      "Give a short profile of each creator for this window: what they focused on, their overall sentiment, any notable calls or changes of mind, and their single most important post.",
  },
  {
    id: "actionable",
    label: "Actionable ideas",
    description: "Concrete ideas, risks and warnings",
    prompt:
      "Extract concrete, actionable ideas from these posts: trade ideas, opportunities, risks and warnings. Give each idea a `###` heading that states it in one line, then labelled bullets: **Who**, **Reasoning**, **Conditions or invalidation**, **Timeframe**. Do not add ideas that are not in the posts.",
  },
];
export const presetById = (id: string | null | undefined) =>
  INSIGHT_PRESETS.find((preset) => preset.id === id) ?? null;
