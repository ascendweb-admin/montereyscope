import type { TweetViewModel } from "@/lib/x/view-model";

export const POST_TYPES = ["original", "quote", "reply", "repost"] as const;
export type ResearchPostType = (typeof POST_TYPES)[number];
export interface ExactSearch {
  terms: string[];
  aliases: string[];
  exclusions: string[];
}
export interface ResearchList {
  id: number;
  name: string;
  description: string;
  creatorIds: number[];
  createdAt: string;
  updatedAt: string;
}
export interface ResearchCreator {
  id: number;
  displayName: string;
  handle: string | null;
  categoryIds: number[];
}
export interface ResearchPost {
  tweet: TweetViewModel;
  eventAt: string;
  postType: ResearchPostType;
  provenance: Array<{
    creatorId: number;
    handle: string | null;
    name: string;
    kind: string;
    eventAt: string | null;
  }>;
  parentCached: boolean;
  match?: { terms: string[]; aliases: string[] };
}
export interface CachedFeed {
  posts: ResearchPost[];
  total: number;
  page: number;
  pageSize: number;
  unknownDates: number;
  scopeTotal: number;
  incompleteText: number;
  bounds: { since: string; until: string };
  search?: ExactSearch;
  coverage: Array<{
    creatorId: number;
    name: string;
    cachedPosts: number;
    oldest: string | null;
    newest: string | null;
    lastRefreshedAt: string | null;
    hasError: boolean;
    pendingHead: boolean;
  }>;
}
