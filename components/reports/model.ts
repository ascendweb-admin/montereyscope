/**
 * Client-side shape of a report row (mirrors PublicReport from lib/ai/reports)
 * plus the pure helpers the Reports page uses to name, group, filter, and
 * order reports. No React here, so the rules are easy to test on their own.
 */
import type { CategoryColor } from "@/lib/categories/model";

export interface ReportVideoSummary {
  id: string;
  title: string;
  creatorId: number;
  creatorName: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
}

export interface ReportSourceSummary {
  kind: "video" | "tweet";
  id: string;
  title: string;
  creatorId: number;
  creatorName: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  url: string;
  durationSeconds: number | null;
  /** Video only: people featured on someone else's channel (`creatorName` is the channel's owner). */
  featuredNames?: string[];
}

export type ReportStatus = "queued" | "running" | "done" | "failed";

/** Where a report came from (see PublicReport.origin). */
export type ReportOrigin = "report" | "x-dashboard" | "x-research";

export type ReportPlatform = "youtube" | "rumble" | "x";

/** One person behind a report's sources, across their platform accounts. */
export interface ReportCreatorSummary {
  /** Creator profile id. */
  id: number;
  name: string;
  avatarCreatorId: number | null;
  avatarUrl: string | null;
  sourceCount: number;
}

export interface ReportCategorySummary {
  id: number;
  name: string;
  color: CategoryColor;
}

/** A section (h2) or subsection (h3) of a finished report. */
export interface ReportOutlineEntry {
  /** The heading's element id in the embedded document. */
  id: string;
  text: string;
  level: 2 | 3;
}

export interface ReportSummary {
  id: number;
  status: ReportStatus;
  /** Headline extracted from the finished report (or a rename); null before. */
  title: string | null;
  /** Standfirst extracted from the finished report; null before that. */
  dek: string | null;
  videoIds: string[];
  videoCount: number;
  /** Mixed source count across videos and X posts. */
  sourceCount: number;
  sourceCountKnown?: boolean;
  /** Sources resolved against the local cache, in request order. */
  sources: ReportSourceSummary[];
  /** The video sources only; kept for compatibility. */
  videos: ReportVideoSummary[];
  /** Depth profile the report runs with (brief | balanced | deep). */
  profile: string;
  /** Visual style the report is written in (editorial | terminal | swiss). */
  style: string;
  /** The report's location on disk once done (loopback-only app). */
  filePath: string | null;
  /** URL the finished report is served from, or null while it runs. */
  fileUrl: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  origin: ReportOrigin;
  /** The X Dashboard list a saved insight covered; null otherwise. */
  scopeLabel: string | null;
  /** The people behind the sources, most-cited first. */
  creators: ReportCreatorSummary[];
  categories: ReportCategorySummary[];
  platforms: ReportPlatform[];
  /** The finished document's sections; empty until the page has indexed it. */
  outline: ReportOutlineEntry[];
  wordCount: number | null;
  readingMinutes: number | null;
}

/** The list's status filter; "active" covers queued and running jobs. */
export type ReportFilter = "all" | "ready" | "active" | "failed";

export function isActive(report: ReportSummary): boolean {
  return report.status === "queued" || report.status === "running";
}

export function matchesFilter(report: ReportSummary, filter: ReportFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "ready":
      return report.status === "done";
    case "active":
      return isActive(report);
    case "failed":
      return report.status === "failed";
  }
}

/**
 * The report's sources, falling back to the legacy video-only list for rows
 * written before mixed sources existed.
 */
export function reportSources(report: ReportSummary): ReportSourceSummary[] {
  if (report.sources.length > 0) {
    return report.sources;
  }
  return report.videos.map((video) => ({
    kind: "video" as const,
    id: video.id,
    title: video.title,
    creatorId: video.creatorId,
    creatorName: video.creatorName,
    thumbnailUrl: video.thumbnailUrl,
    publishedAt: video.publishedAt,
    url: `/channels/${video.creatorId}/videos/${video.id}`,
    durationSeconds: video.durationSeconds,
  }));
}

/** How many sources the report drew on, resolved or not. */
export function sourceTotal(report: ReportSummary): number {
  return Math.max(report.sourceCount, reportSources(report).length);
}

export function sourceCountLabel(count: number): string {
  return count === 1 ? "1 source" : `${count} sources`;
}

/**
 * The best name the list can give a report without an extracted one: the
 * single source's title, the first source plus a count, or the report id.
 */
export function deriveReportTitle(report: ReportSummary): string {
  if (report.title !== null && report.title.length > 0) {
    return report.title;
  }
  const sources = reportSources(report);
  const [first] = sources;
  if (first) {
    return sources.length > 1 ? `${first.title} +${sources.length - 1} more` : first.title;
  }
  if (report.sourceCount > 1) {
    return `${report.sourceCount}-source analysis`;
  }
  return `Report #${report.id}`;
}

/**
 * Case-insensitive match against the title, standfirst, creators, and
 * sources. The document text itself is searched on the server (see
 * /api/ai/reports/search); the page shows the union of both.
 */
export function matchesQuery(report: ReportSummary, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const haystack = [
    deriveReportTitle(report),
    report.dek ?? "",
    report.profile,
    report.style,
    report.scopeLabel ?? "",
    ...report.creators.map((creator) => creator.name),
    ...reportSources(report).flatMap((source) => [source.title, source.creatorName]),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * How many jobs run before a queued report: the running one plus every
 * queued report requested earlier (the queue is strict FIFO by id).
 */
export function jobsAhead(report: ReportSummary, reports: readonly ReportSummary[]): number {
  return reports.filter(
    (other) =>
      other.id !== report.id &&
      (other.status === "running" || (other.status === "queued" && other.id < report.id)),
  ).length;
}

export interface ReportGroup {
  label: string;
  reports: ReportSummary[];
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** A calendar bucket for the list: Today, Yesterday, This week, or the month. */
export function dateGroupLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "Earlier";
  }
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return date.toLocaleDateString(undefined, {
    month: "long",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Splits an already-ordered list into consecutive date buckets. */
export function groupReportsByDate(
  reports: readonly ReportSummary[],
  now = new Date(),
): ReportGroup[] {
  const groups: ReportGroup[] = [];
  for (const report of reports) {
    const label = dateGroupLabel(report.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.reports.push(report);
    } else {
      groups.push({ label, reports: [report] });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Who and where: row labels
// ---------------------------------------------------------------------------

/**
 * Names who a report is about in one short phrase: the X list a saved
 * insight covered, else its most-cited person, a pair, or the first person
 * and how many others. Null when no source resolves to a known creator.
 */
export function creatorLabel(report: ReportSummary): string | null {
  if (report.scopeLabel) {
    return report.scopeLabel;
  }
  const [first, second] = report.creators;
  if (!first) {
    return null;
  }
  if (!second) {
    return first.name;
  }
  if (report.creators.length === 2) {
    return `${first.name} & ${second.name}`;
  }
  return `${first.name} +${report.creators.length - 1}`;
}

/**
 * A row-sized age — "5m", "3h", "2d", "3w", "2mo", "1y" — for the rail,
 * where the day group already says roughly when. Null for a bad timestamp.
 */
export function compactAge(iso: string, nowMs = Date.now()): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return null;
  }
  const minutes = Math.max(0, Math.round((nowMs - then) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.round(days / 7)}w`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

/** The label for a report that was saved rather than written as a report. */
export function originLabel(origin: ReportOrigin): string | null {
  switch (origin) {
    case "x-dashboard":
      return "X Dashboard brief";
    case "x-research":
      return "Research brief";
    case "report":
      return null;
  }
}

export const PLATFORM_LABELS: Record<ReportPlatform, string> = {
  youtube: "YouTube",
  rumble: "Rumble",
  x: "X posts",
};

/** Library order: the same order the creator library lists platforms in. */
const PLATFORM_ORDER: Record<ReportPlatform, number> = { youtube: 0, rumble: 1, x: 2 };

// ---------------------------------------------------------------------------
// Facet filters: creator, category, source type
// ---------------------------------------------------------------------------

/**
 * The rail's filter popover. Within a facet any picked value matches (a
 * union); across facets every facet must match. Empty facets match all.
 */
export interface ReportFacets {
  creators: readonly number[];
  categories: readonly number[];
  platforms: readonly ReportPlatform[];
}

export const NO_FACETS: ReportFacets = { creators: [], categories: [], platforms: [] };

export function activeFacetCount(facets: ReportFacets): number {
  return facets.creators.length + facets.categories.length + facets.platforms.length;
}

export function matchesFacets(report: ReportSummary, facets: ReportFacets): boolean {
  if (
    facets.creators.length > 0 &&
    !report.creators.some((creator) => facets.creators.includes(creator.id))
  ) {
    return false;
  }
  if (
    facets.categories.length > 0 &&
    !report.categories.some((category) => facets.categories.includes(category.id))
  ) {
    return false;
  }
  if (
    facets.platforms.length > 0 &&
    !report.platforms.some((platform) => facets.platforms.includes(platform))
  ) {
    return false;
  }
  return true;
}

/** Toggles one value in a facet list, keeping the rest in order. */
export function toggleFacet<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export interface FacetOptions {
  /** Most reports first, then by name. */
  creators: Array<ReportCreatorSummary & { reportCount: number }>;
  /** By name. */
  categories: Array<ReportCategorySummary & { reportCount: number }>;
  /** Library order. */
  platforms: Array<{ id: ReportPlatform; reportCount: number }>;
}

/** Every value the reports can be filtered by, with how many reports have it. */
export function facetOptions(reports: readonly ReportSummary[]): FacetOptions {
  const creators = new Map<number, ReportCreatorSummary & { reportCount: number }>();
  const categories = new Map<number, ReportCategorySummary & { reportCount: number }>();
  const platforms = new Map<ReportPlatform, number>();
  for (const report of reports) {
    for (const creator of report.creators) {
      const known = creators.get(creator.id);
      if (known) {
        known.reportCount += 1;
      } else {
        creators.set(creator.id, { ...creator, reportCount: 1 });
      }
    }
    for (const category of report.categories) {
      const known = categories.get(category.id);
      if (known) {
        known.reportCount += 1;
      } else {
        categories.set(category.id, { ...category, reportCount: 1 });
      }
    }
    for (const platform of report.platforms) {
      platforms.set(platform, (platforms.get(platform) ?? 0) + 1);
    }
  }
  return {
    creators: [...creators.values()].sort(
      (a, b) => b.reportCount - a.reportCount || a.name.localeCompare(b.name),
    ),
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    platforms: [...platforms.entries()]
      .map(([id, reportCount]) => ({ id, reportCount }))
      .sort((a, b) => PLATFORM_ORDER[a.id] - PLATFORM_ORDER[b.id]),
  };
}

// ---------------------------------------------------------------------------
// Search snippets
// ---------------------------------------------------------------------------

/** The markers /api/ai/reports/search wraps matched terms in. */
const MATCH_START = "\u0002";
const MATCH_END = "\u0003";

/** Characters of context kept before a snippet's first match. */
const SNIPPET_LEAD = 32;

/**
 * Trims a snippet's opening so its first match sits near the start: the rail
 * shows two lines, and a hit pushed past them would be no hit at all. Cuts
 * at a word boundary and marks the cut with an ellipsis.
 */
export function focusSnippet(snippet: string, lead = SNIPPET_LEAD): string {
  const first = snippet.indexOf(MATCH_START);
  if (first <= lead) {
    return snippet;
  }
  const from = snippet.indexOf(" ", first - lead);
  const start = from === -1 || from >= first ? first : from + 1;
  return `…${snippet.slice(start)}`;
}

/** Splits a search snippet into plain and matched runs, for highlighting. */
export function splitSnippet(snippet: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  for (const [index, chunk] of snippet.split(MATCH_START).entries()) {
    if (index === 0) {
      if (chunk) parts.push({ text: chunk, match: false });
      continue;
    }
    const end = chunk.indexOf(MATCH_END);
    const matched = end === -1 ? chunk : chunk.slice(0, end);
    const rest = end === -1 ? "" : chunk.slice(end + MATCH_END.length);
    if (matched) parts.push({ text: matched, match: true });
    if (rest) parts.push({ text: rest, match: false });
  }
  return parts;
}
