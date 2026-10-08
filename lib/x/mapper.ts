/**
 * Defensive normalization of worker/provider output into the Scope X model.
 * Provider output is untrusted input: every field is probed, missing values
 * become nulls (never crashes), and payloads that cannot be a tweet at all
 * are rejected as `invalid_response`.
 *
 * X ids arrive as strings and must stay strings — they exceed JavaScript's
 * safe integer range. Numbers are only accepted where a value is inherently
 * numeric (metrics), and only when finite.
 */
import {
  XProviderError,
  type XContentStatus,
  type XQuotedTweet,
  type XTimelineItem,
  type XTimelineKind,
  type XTimelinePage,
  type XTweetAuthor,
  type XTweetDraft,
  type XTweetMedia,
  type XUserIdentity,
  type XUserLookup,
  type XUserSearchResult,
} from "./model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asIdString(value: unknown): string | null {
  if (typeof value === "string" && /^\d{1,20}$/.test(value.trim())) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  return null;
}

function asFiniteCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function asIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** X media CDN hosts a media URL may point at. */
const MEDIA_HOST_PATTERN = /(^|\.)(twimg\.com|twitter\.com|x\.com)$/;

function asMediaUrl(value: unknown): string | null {
  const url = asTrimmedString(value);
  if (url === null || !url.startsWith("https://")) {
    return null;
  }
  try {
    return MEDIA_HOST_PATTERN.test(new URL(url).hostname) ? url : null;
  } catch {
    return null;
  }
}

function mapMediaKind(value: unknown): XTweetMedia["kind"] {
  return value === "video" || value === "gif" ? value : "photo";
}

export function mapXMedia(value: unknown): XTweetMedia[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const media: XTweetMedia[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const url = asMediaUrl(entry.url) ?? asMediaUrl(entry.previewUrl);
    if (url === null) {
      continue;
    }
    media.push({
      kind: mapMediaKind(entry.kind ?? entry.type),
      url,
      previewUrl: asMediaUrl(entry.previewUrl),
      altText: typeof entry.altText === "string" ? entry.altText.slice(0, 1000) : null,
    });
  }
  return media;
}

export function mapXAuthor(value: unknown): XTweetAuthor | null {
  if (!isRecord(value)) {
    return null;
  }
  const userId = asIdString(value.userId ?? value.id);
  const handle = asTrimmedString(value.handle ?? value.username);
  const displayName = asTrimmedString(value.displayName ?? value.name) ?? handle;
  if (userId === null || handle === null || displayName === null) {
    return null;
  }
  return {
    userId,
    handle: handle.replace(/^@/, ""),
    displayName: displayName.slice(0, 100),
    avatarUrl: asMediaUrl(value.avatarUrl),
  };
}

export function mapXUser(value: unknown): XUserIdentity | null {
  const author = mapXAuthor(value);
  if (author === null) {
    return null;
  }
  const description =
    typeof value === "object" && value !== null && "description" in value
      ? (value as Record<string, unknown>).description
      : null;
  return {
    ...author,
    description: typeof description === "string" ? description.slice(0, 500) : null,
  };
}

function mapQuoted(value: unknown): XQuotedTweet | null {
  if (!isRecord(value)) {
    return null;
  }
  const tweetId = asIdString(value.tweetId ?? value.id);
  const text = asTrimmedString(value.text);
  if (tweetId === null || text === null) {
    return null;
  }
  const handle = asTrimmedString(value.handle ?? value.username);
  return {
    tweetId,
    userId: asIdString(value.userId),
    handle: handle === null ? null : handle.replace(/^@/, ""),
    name: asTrimmedString(value.name ?? value.displayName),
    text: text.slice(0, 20_000),
    url: asTrimmedString(value.url) ?? `https://x.com/${handle ?? "i"}/status/${tweetId}`,
  };
}

/**
 * Normalizes one tweet. Returns null when the payload could not be a tweet
 * (no id or no author); callers skip such entries rather than failing a
 * whole timeline — partial metadata is expected from list endpoints.
 */
export function mapXTweet(
  value: unknown,
  options: { complete?: boolean } = {},
): XTweetDraft | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asIdString(value.id ?? value.tweetId);
  const author = mapXAuthor(value.author ?? value.user ?? value);
  if (id === null || author === null) {
    return null;
  }
  const rawText = asTrimmedString(value.text ?? value.fullText ?? value.summary);
  const rawStatus = asTrimmedString(value.contentStatus);
  const contentStatus: XContentStatus =
    rawStatus === "summary" || rawStatus === "unavailable" || rawStatus === "complete"
      ? rawStatus
      : options.complete === true
        ? "complete"
        : value.truncated === true
          ? "summary"
          : "complete";
  const text = rawText ?? "";

  const repostedByHandle = asTrimmedString(value.repostedByHandle ?? value.retweetedByHandle);
  const isRepost = value.isRepost === true || repostedByHandle !== null;

  const handle = author.handle;
  const url = asTrimmedString(value.url) ?? `https://x.com/${handle}/status/${id}`;

  return {
    id,
    author,
    text,
    language: asTrimmedString(value.language),
    publishedAt: asIsoTimestamp(value.publishedAt ?? value.createdAt),
    url: url.startsWith("https://") ? url : `https://x.com/${handle}/status/${id}`,
    replyCount: asFiniteCount(value.replyCount),
    repostCount: asFiniteCount(value.repostCount),
    likeCount: asFiniteCount(value.likeCount),
    quoteCount: asFiniteCount(value.quoteCount),
    contentStatus: text.length === 0 ? "unavailable" : contentStatus,
    isRepost,
    repostedByUserId: asIdString(value.repostedByUserId),
    repostedByHandle: repostedByHandle === null ? null : repostedByHandle.replace(/^@/, ""),
    conversationId: asIdString(value.conversationId),
    inReplyToTweetId: asIdString(value.inReplyToTweetId),
    inReplyToUserId: asIdString(value.inReplyToUserId),
    inReplyToHandle: (() => {
      const raw = asTrimmedString(value.inReplyToHandle);
      return raw === null ? null : raw.replace(/^@/, "");
    })(),
    quoted: mapQuoted(value.quoted),
    media: mapXMedia(value.media),
  };
}

function mapTimelineKind(value: unknown): XTimelineKind {
  return value === "repost" || value === "reply" ? value : "post";
}

export function mapXTimelineItem(
  value: unknown,
  options: { complete?: boolean } = {},
): XTimelineItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const tweetPayload = isRecord(value.tweet) ? value.tweet : value;
  const tweet = mapXTweet(tweetPayload, options);
  if (tweet === null) {
    return null;
  }
  const timelineKind = mapTimelineKind(value.timelineKind ?? value.kind);
  return {
    tweet,
    timelineKind,
    // A repost's publication date belongs to the original author, not the
    // sharing event. Missing event time must remain unknown for date filters.
    timelineAt:
      asIsoTimestamp(value.timelineAt) ?? (timelineKind === "repost" ? null : tweet.publishedAt),
  };
}

export interface RawTimelinePage {
  items?: unknown;
  nextCursor?: unknown;
  exhausted?: unknown;
}

export function mapXTimelinePage(
  value: unknown,
  options: { complete?: boolean } = {},
): XTimelinePage {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new XProviderError("invalid_response");
  }
  const items: XTimelineItem[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const entry of value.items) {
    const item = mapXTimelineItem(entry, options);
    if (item === null || seen.has(item.tweet.id)) {
      skipped += 1;
      continue;
    }
    seen.add(item.tweet.id);
    items.push(item);
  }
  const nextCursor = asTrimmedString(value.nextCursor);
  return {
    items,
    nextCursor: nextCursor ?? null,
    exhausted: value.exhausted === true || nextCursor === null,
    skipped,
  };
}

export function mapXUserLookup(value: unknown): XUserLookup {
  if (!isRecord(value)) {
    throw new XProviderError("invalid_response");
  }
  const user = mapXUser(value.user ?? value);
  if (user === null) {
    throw new XProviderError("invalid_response");
  }
  return { user, pinnedTweetId: asIdString(value.pinnedTweetId) };
}

/**
 * Normalizes a people-search payload (`{ users: [...] }`). Unusable entries
 * are skipped; a payload without a users array is an invalid response.
 */
export function mapXUserSearch(value: unknown): XUserSearchResult[] {
  if (!isRecord(value) || !Array.isArray(value.users)) {
    throw new XProviderError("invalid_response");
  }
  const results: XUserSearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of value.users) {
    const user = mapXUser(entry);
    if (user === null || seen.has(user.userId) || !/^[0-9A-Za-z_]{1,15}$/.test(user.handle)) {
      continue;
    }
    seen.add(user.userId);
    const record = entry as Record<string, unknown>;
    results.push({
      ...user,
      verified: record.verified === true,
      protected: record.protected === true,
    });
    if (results.length >= 10) {
      break;
    }
  }
  return results;
}
