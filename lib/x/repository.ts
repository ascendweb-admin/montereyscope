/**
 * SQLite-backed cache of X posts and creator timelines. Server-only.
 *
 * Posts are stored once (keyed by the canonical status id) and linked to
 * creator timelines through `creator_tweets`, so a repost or a post that
 * appears in several timelines never duplicates the underlying text. Reads
 * are strictly local; nothing here ever contacts X.
 */
import type { ScopeDatabase } from "@/lib/db/connection";

import type {
  XContentStatus,
  XQuotedTweet,
  XTimelineItem,
  XTimelineKind,
  XTweetDraft,
  XTweetMedia,
} from "./model";

/** One cached post as linked into a creator's timeline. */
export interface CreatorTweetRecord {
  tweet: XTweetDraft;
  timelineKind: XTimelineKind;
  timelineAt: string | null;
  savedAt: string;
  fetchedAt: string;
  textFetchedAt?: string | null;
  availability?: "unknown" | "observed" | "not_retrievable";
  availabilityCheckedAt?: string | null;
}

interface TweetRow {
  id: string;
  author_user_id: string;
  author_handle: string;
  author_name: string;
  author_avatar_url: string | null;
  url: string;
  text: string;
  language: string | null;
  published_at: string | null;
  fetched_at: string;
  text_fetched_at: string | null;
  availability_status: "unknown" | "observed" | "not_retrievable";
  availability_checked_at: string | null;
  reply_count: number | null;
  repost_count: number | null;
  like_count: number | null;
  quote_count: number | null;
  content_status: XContentStatus;
  is_repost: number;
  reposted_by_user_id: string | null;
  reposted_by_handle: string | null;
  conversation_id: string | null;
  in_reply_to_tweet_id: string | null;
  in_reply_to_user_id: string | null;
  in_reply_to_handle: string | null;
  quoted_tweet_id: string | null;
  quoted_user_id: string | null;
  quoted_handle: string | null;
  quoted_name: string | null;
  quoted_text: string | null;
  quoted_url: string | null;
  media_json: string | null;
}

interface CreatorTweetRow extends TweetRow {
  timeline_kind: XTimelineKind;
  timeline_at: string | null;
  saved_at: string;
}

function parseMedia(json: string | null): XTweetMedia[] {
  if (json === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is XTweetMedia =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as XTweetMedia).url === "string" &&
        typeof (entry as XTweetMedia).kind === "string",
    );
  } catch {
    return [];
  }
}

function parseQuoted(row: TweetRow): XQuotedTweet | null {
  if (row.quoted_tweet_id === null || row.quoted_text === null) {
    return null;
  }
  return {
    tweetId: row.quoted_tweet_id,
    userId: row.quoted_user_id,
    handle: row.quoted_handle,
    name: row.quoted_name,
    text: row.quoted_text,
    url: row.quoted_url ?? `https://x.com/i/status/${row.quoted_tweet_id}`,
  };
}

function toTweetDraft(row: TweetRow): XTweetDraft {
  return {
    id: row.id,
    author: {
      userId: row.author_user_id,
      handle: row.author_handle,
      displayName: row.author_name,
      avatarUrl: row.author_avatar_url,
    },
    text: row.text,
    language: row.language,
    publishedAt: row.published_at,
    url: row.url,
    replyCount: row.reply_count === null ? null : Number(row.reply_count),
    repostCount: row.repost_count === null ? null : Number(row.repost_count),
    likeCount: row.like_count === null ? null : Number(row.like_count),
    quoteCount: row.quote_count === null ? null : Number(row.quote_count),
    contentStatus: row.content_status,
    isRepost: Number(row.is_repost) === 1,
    repostedByUserId: row.reposted_by_user_id,
    repostedByHandle: row.reposted_by_handle,
    conversationId: row.conversation_id,
    inReplyToTweetId: row.in_reply_to_tweet_id,
    inReplyToUserId: row.in_reply_to_user_id,
    inReplyToHandle: row.in_reply_to_handle,
    quoted: parseQuoted(row),
    media: parseMedia(row.media_json),
  };
}

function toCreatorTweetRecord(row: CreatorTweetRow): CreatorTweetRecord {
  return {
    tweet: toTweetDraft(row),
    timelineKind: row.timeline_kind,
    timelineAt: row.timeline_at,
    savedAt: row.saved_at,
    fetchedAt: row.fetched_at,
    textFetchedAt: row.text_fetched_at ?? null,
    availability: row.availability_status ?? "unknown",
    availabilityCheckedAt: row.availability_checked_at ?? null,
  };
}

/** Number of cached posts across the whole cache. */
export function countAllTweets(db: ScopeDatabase): number {
  const row = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM tweets").get();
  return row ? Number(row.n) : 0;
}

/** Number of posts linked to one creator's timeline. */
export function countCreatorTweets(db: ScopeDatabase, creatorId: number): number {
  const row = db
    .prepare<[number], { n: number }>(
      "SELECT COUNT(*) AS n FROM creator_tweets WHERE creator_id = ?",
    )
    .get(creatorId);
  return row ? Number(row.n) : 0;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

const UPSERT_TWEET_SQL = `
  INSERT INTO tweets (
    id, author_user_id, author_handle, author_name, author_avatar_url, url, text,
    language, published_at, reply_count, repost_count, like_count, quote_count,
    content_status, is_repost, reposted_by_user_id, reposted_by_handle,
    conversation_id, in_reply_to_tweet_id, in_reply_to_user_id, in_reply_to_handle,
    quoted_tweet_id, quoted_user_id, quoted_handle, quoted_name, quoted_text, quoted_url,
    media_json, fetched_at, text_fetched_at, availability_status, availability_checked_at
  )
  VALUES (
    @id, @author_user_id, @author_handle, @author_name, @author_avatar_url, @url, @text,
    @language, @published_at, @reply_count, @repost_count, @like_count, @quote_count,
    @content_status, @is_repost, @reposted_by_user_id, @reposted_by_handle,
    @conversation_id, @in_reply_to_tweet_id, @in_reply_to_user_id, @in_reply_to_handle,
    @quoted_tweet_id, @quoted_user_id, @quoted_handle, @quoted_name, @quoted_text, @quoted_url,
    @media_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    CASE WHEN @text <> '' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
    CASE WHEN @content_status <> 'unavailable' AND @text <> '' THEN 'observed' ELSE 'unknown' END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
  ON CONFLICT (id) DO UPDATE SET
    author_user_id = excluded.author_user_id,
    author_handle = excluded.author_handle,
    author_name = excluded.author_name,
    author_avatar_url = COALESCE(excluded.author_avatar_url, tweets.author_avatar_url),
    url = excluded.url,
    -- A payload that lost text (e.g. an unavailable refresh) must never erase
    -- cached text: the stored complete body wins.
    text = CASE
      WHEN tweets.content_status = 'complete' AND excluded.content_status <> 'complete' THEN tweets.text
      WHEN excluded.content_status = 'unavailable' AND tweets.text <> '' THEN tweets.text
      WHEN excluded.text = '' AND tweets.text <> '' THEN tweets.text
      ELSE excluded.text
    END,
    language = COALESCE(excluded.language, tweets.language),
    published_at = COALESCE(tweets.published_at, excluded.published_at),
    reply_count = COALESCE(excluded.reply_count, tweets.reply_count),
    repost_count = COALESCE(excluded.repost_count, tweets.repost_count),
    like_count = COALESCE(excluded.like_count, tweets.like_count),
    quote_count = COALESCE(excluded.quote_count, tweets.quote_count),
    content_status = CASE
      WHEN excluded.content_status = 'complete' THEN 'complete'
      WHEN tweets.content_status = 'complete' THEN 'complete'
      ELSE excluded.content_status
    END,
    is_repost = MAX(tweets.is_repost, excluded.is_repost),
    reposted_by_user_id = COALESCE(excluded.reposted_by_user_id, tweets.reposted_by_user_id),
    reposted_by_handle = COALESCE(excluded.reposted_by_handle, tweets.reposted_by_handle),
    conversation_id = COALESCE(excluded.conversation_id, tweets.conversation_id),
    in_reply_to_tweet_id = COALESCE(excluded.in_reply_to_tweet_id, tweets.in_reply_to_tweet_id),
    in_reply_to_user_id = COALESCE(excluded.in_reply_to_user_id, tweets.in_reply_to_user_id),
    in_reply_to_handle = COALESCE(excluded.in_reply_to_handle, tweets.in_reply_to_handle),
    quoted_tweet_id = COALESCE(excluded.quoted_tweet_id, tweets.quoted_tweet_id),
    quoted_user_id = COALESCE(excluded.quoted_user_id, tweets.quoted_user_id),
    quoted_handle = COALESCE(excluded.quoted_handle, tweets.quoted_handle),
    quoted_name = COALESCE(excluded.quoted_name, tweets.quoted_name),
    quoted_text = COALESCE(excluded.quoted_text, tweets.quoted_text),
    quoted_url = COALESCE(excluded.quoted_url, tweets.quoted_url),
    media_json = CASE
      WHEN excluded.media_json IS NOT NULL AND excluded.media_json <> '[]' THEN excluded.media_json
      ELSE tweets.media_json
    END,
    text_fetched_at = CASE
      WHEN tweets.content_status = 'complete' AND excluded.content_status <> 'complete' THEN tweets.text_fetched_at
      WHEN excluded.content_status = 'unavailable' AND tweets.text <> '' THEN tweets.text_fetched_at
      WHEN excluded.text = '' THEN tweets.text_fetched_at
      ELSE excluded.text_fetched_at
    END,
    availability_status = excluded.availability_status,
    availability_checked_at = excluded.availability_checked_at,
    fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
`;

interface TweetParams {
  [key: string]: string | number | null;
}

function tweetParams(draft: XTweetDraft): TweetParams {
  return {
    id: draft.id,
    author_user_id: draft.author.userId,
    author_handle: draft.author.handle,
    author_name: draft.author.displayName,
    author_avatar_url: draft.author.avatarUrl,
    url: draft.url,
    text: draft.text,
    language: draft.language,
    published_at: draft.publishedAt,
    reply_count: draft.replyCount,
    repost_count: draft.repostCount,
    like_count: draft.likeCount,
    quote_count: draft.quoteCount,
    content_status: draft.contentStatus,
    is_repost: draft.isRepost ? 1 : 0,
    reposted_by_user_id: draft.repostedByUserId,
    reposted_by_handle: draft.repostedByHandle,
    conversation_id: draft.conversationId,
    in_reply_to_tweet_id: draft.inReplyToTweetId,
    in_reply_to_user_id: draft.inReplyToUserId,
    in_reply_to_handle: draft.inReplyToHandle,
    quoted_tweet_id: draft.quoted?.tweetId ?? null,
    quoted_user_id: draft.quoted?.userId ?? null,
    quoted_handle: draft.quoted?.handle ?? null,
    quoted_name: draft.quoted?.name ?? null,
    quoted_text: draft.quoted?.text ?? null,
    quoted_url: draft.quoted?.url ?? null,
    media_json: draft.media.length > 0 ? JSON.stringify(draft.media) : "[]",
  };
}

/** Upserts one post. Callers wrap batches in a transaction. */
export function upsertTweet(db: ScopeDatabase, draft: XTweetDraft): void {
  db.prepare(UPSERT_TWEET_SQL).run(tweetParams(draft));
}

/** A null detail response establishes only that this read could not retrieve the post. */
export function recordTweetNotRetrievable(db: ScopeDatabase, tweetId: string): void {
  db.prepare(
    "UPDATE tweets SET availability_status = 'not_retrievable', availability_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
  ).run(tweetId);
}

export interface LinkTimelineInput {
  creatorId: number;
  tweetId: string;
  timelineKind: XTimelineKind;
  timelineAt: string | null;
  source?: "timeline" | "import";
}

/** Links a post into a creator's timeline; repeated links are no-ops. */
export function linkCreatorTweet(db: ScopeDatabase, input: LinkTimelineInput): void {
  db.prepare(
    `INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at, source)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (creator_id, tweet_id) DO UPDATE SET
       timeline_kind = excluded.timeline_kind,
       timeline_at = COALESCE(excluded.timeline_at, creator_tweets.timeline_at)`,
  ).run(
    input.creatorId,
    input.tweetId,
    input.timelineKind,
    input.timelineAt,
    input.source ?? "timeline",
  );
}

/**
 * Atomically merges a fetched timeline page and its posts into the cache.
 * Additive only: existing posts are updated in place, and anything that fell
 * outside the fetched window stays cached.
 */
export function mergeCreatorTimeline(
  db: ScopeDatabase,
  creatorId: number,
  items: readonly XTimelineItem[],
): { mergedCount: number } {
  const merge = db.transaction((pageItems: readonly XTimelineItem[]): { mergedCount: number } => {
    for (const item of pageItems) {
      upsertTweet(db, item.tweet);
      linkCreatorTweet(db, {
        creatorId,
        tweetId: item.tweet.id,
        timelineKind: item.timelineKind,
        timelineAt: item.timelineAt,
      });
    }
    return { mergedCount: pageItems.length };
  });
  return merge(items);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CreatorTimelineQuery {
  includeReplies?: boolean;
  includeReposts?: boolean;
  limit: number;
  offset?: number;
}

const TIMELINE_SELECT = `
  SELECT t.*, ct.timeline_kind, ct.timeline_at, ct.saved_at
  FROM creator_tweets ct
  JOIN tweets t ON t.id = ct.tweet_id
  WHERE ct.creator_id = @creatorId
    AND (@includeReplies = 1 OR t.in_reply_to_tweet_id IS NULL)
    AND (@includeReposts = 1 OR t.is_repost = 0)
  ORDER BY COALESCE(ct.timeline_at, t.published_at) DESC, t.id DESC
  LIMIT @limit OFFSET @offset
`;

/**
 * Cached timeline for one creator, newest first. Filters narrow the cached
 * window only — they never trigger a fetch.
 */
export function listCreatorTweets(
  db: ScopeDatabase,
  creatorId: number,
  query: CreatorTimelineQuery,
): CreatorTweetRecord[] {
  const rows = db.prepare<Record<string, number>, CreatorTweetRow>(TIMELINE_SELECT).all({
    creatorId,
    includeReplies: query.includeReplies === true ? 1 : 0,
    includeReposts: query.includeReposts === true ? 1 : 0,
    limit: Math.max(1, query.limit),
    offset: Math.max(0, query.offset ?? 0),
  });
  return rows.map(toCreatorTweetRecord);
}

export function countCreatorTweetsFiltered(
  db: ScopeDatabase,
  creatorId: number,
  query: Pick<CreatorTimelineQuery, "includeReplies" | "includeReposts">,
): number {
  const row = db
    .prepare<Record<string, number>, { n: number }>(
      `SELECT COUNT(*) AS n
       FROM creator_tweets ct
       JOIN tweets t ON t.id = ct.tweet_id
       WHERE ct.creator_id = @creatorId
         AND (@includeReplies = 1 OR t.in_reply_to_tweet_id IS NULL)
         AND (@includeReposts = 1 OR t.is_repost = 0)`,
    )
    .get({
      creatorId,
      includeReplies: query.includeReplies === true ? 1 : 0,
      includeReposts: query.includeReposts === true ? 1 : 0,
    });
  return row ? Number(row.n) : 0;
}

export function getTweetForCreator(
  db: ScopeDatabase,
  creatorId: number,
  tweetId: string,
): CreatorTweetRecord | null {
  const row = db
    .prepare<[number, string], CreatorTweetRow>(
      `SELECT t.*, ct.timeline_kind, ct.timeline_at, ct.saved_at
       FROM creator_tweets ct
       JOIN tweets t ON t.id = ct.tweet_id
       WHERE ct.creator_id = ? AND ct.tweet_id = ?
       LIMIT 1`,
    )
    .get(creatorId, tweetId);
  return row ? toCreatorTweetRecord(row) : null;
}

export function getTweetById(db: ScopeDatabase, tweetId: string): XTweetDraft | null {
  const row = db
    .prepare<[string], TweetRow>("SELECT * FROM tweets WHERE id = ? LIMIT 1")
    .get(tweetId);
  return row ? toTweetDraft(row) : null;
}

/**
 * True when `avatarUrl` is the stored avatar of any author cached in this
 * creator's timeline. A repost surfaces another author's avatar on the
 * creator's timeline, so the avatar proxy must serve those URLs too —
 * while only ever accepting URLs the cache already holds.
 */
export function hasCreatorTweetAuthorAvatar(
  db: ScopeDatabase,
  creatorId: number,
  avatarUrl: string,
): boolean {
  const row = db
    .prepare<[number, string], { one: number }>(
      `SELECT 1 AS one
       FROM creator_tweets ct
       JOIN tweets t ON t.id = ct.tweet_id
       WHERE ct.creator_id = ? AND t.author_avatar_url = ?
       LIMIT 1`,
    )
    .get(creatorId, avatarUrl);
  return row !== undefined;
}

/** One cached post with its creator, for the shared feed. */
export interface FeedTweetRecord extends CreatorTweetRecord {
  creatorId: number;
  creatorName: string;
  creatorAvatarUrl: string | null;
}

/**
 * Every cached post across all creator timelines, newest first. A post that
 * appears in several timelines is attributed to the first (oldest) creator
 * row so the feed never lists the same post twice.
 */
export function listFeedTweets(db: ScopeDatabase): FeedTweetRecord[] {
  const rows = db
    .prepare<
      [],
      CreatorTweetRow & {
        feed_creator_id: number;
        creator_name: string;
        creator_avatar_url: string | null;
      }
    >(
      `SELECT t.*, ct.timeline_kind, ct.timeline_at, ct.saved_at,
              ct.creator_id AS feed_creator_id,
              c.display_name AS creator_name,
              c.avatar_url AS creator_avatar_url
       FROM creator_tweets ct
       JOIN tweets t ON t.id = ct.tweet_id
       JOIN creators c ON c.id = ct.creator_id
       WHERE ct.creator_id = (
         SELECT MIN(ct2.creator_id) FROM creator_tweets ct2 WHERE ct2.tweet_id = ct.tweet_id
       )
       ORDER BY COALESCE(ct.timeline_at, t.published_at) DESC, t.id DESC`,
    )
    .all();
  return rows.map((row) => ({
    ...toCreatorTweetRecord(row),
    creatorId: Number(row.feed_creator_id),
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
  }));
}

// ---------------------------------------------------------------------------
// Feed state
// ---------------------------------------------------------------------------

export interface XFeedStateRecord {
  creatorId: number;
  configKey: string;
  lastRefreshedAt: string | null;
  olderCursor: string | null;
  exhausted: boolean;
  lastError: string | null;
}

interface XFeedStateRow {
  creator_id: number;
  config_key: string;
  last_refreshed_at: string | null;
  older_cursor: string | null;
  exhausted: number;
  last_error: string | null;
}

function toFeedState(row: XFeedStateRow): XFeedStateRecord {
  return {
    creatorId: Number(row.creator_id),
    configKey: row.config_key,
    lastRefreshedAt: row.last_refreshed_at,
    olderCursor: row.older_cursor,
    exhausted: Number(row.exhausted) === 1,
    lastError: row.last_error,
  };
}

export function getXFeedState(db: ScopeDatabase, creatorId: number): XFeedStateRecord | null {
  const row = db
    .prepare<[number], XFeedStateRow>("SELECT * FROM x_feed_state WHERE creator_id = ?")
    .get(creatorId);
  return row ? toFeedState(row) : null;
}

export interface UpsertXFeedStateInput {
  creatorId: number;
  configKey: string;
  lastRefreshedAt?: string | null;
  olderCursor?: string | null;
  exhausted?: boolean;
  lastError?: string | null;
}

/** Starts (or resets) a creator's X feed state for a configuration. */
export function upsertXFeedState(db: ScopeDatabase, input: UpsertXFeedStateInput): void {
  db.prepare(
    `INSERT INTO x_feed_state (creator_id, config_key, last_refreshed_at, older_cursor, exhausted, last_error)
     VALUES (@creatorId, @configKey, @lastRefreshedAt, @olderCursor, @exhausted, @lastError)
     ON CONFLICT (creator_id) DO UPDATE SET
       config_key = excluded.config_key,
       last_refreshed_at = COALESCE(excluded.last_refreshed_at, x_feed_state.last_refreshed_at),
       older_cursor = excluded.older_cursor,
       exhausted = excluded.exhausted,
       last_error = excluded.last_error`,
  ).run({
    creatorId: input.creatorId,
    configKey: input.configKey,
    lastRefreshedAt: input.lastRefreshedAt ?? null,
    olderCursor: input.olderCursor ?? null,
    exhausted: input.exhausted === true ? 1 : 0,
    lastError: input.lastError ?? null,
  });
}

/** Clears a creator's cursor state without touching cached posts. */
export function resetXFeedState(db: ScopeDatabase, creatorId: number, configKey: string): void {
  db.prepare("DELETE FROM x_feed_state WHERE creator_id = ?").run(creatorId);
  upsertXFeedState(db, { creatorId, configKey });
}

/**
 * Removes one creator's timeline links and any posts no longer referenced by
 * any timeline. Used by explicit cache clears; report snapshots on disk are
 * unaffected.
 */
export function clearCreatorTweetTimeline(db: ScopeDatabase, creatorId: number): number {
  const clear = db.transaction((): number => {
    const result = db.prepare("DELETE FROM creator_tweets WHERE creator_id = ?").run(creatorId);
    db.prepare("DELETE FROM x_feed_state WHERE creator_id = ?").run(creatorId);
    db.prepare("DELETE FROM x_retrieval_checkpoints WHERE creator_id = ?").run(creatorId);
    db.prepare("DELETE FROM x_retrieval_tasks WHERE creator_id = ?").run(creatorId);
    deleteOrphanTweets(db);
    return Number(result.changes);
  });
  return clear();
}

/** Deletes every cached timeline link, post, and feed state in one transaction. */
export function clearAllCachedTweets(db: ScopeDatabase): number {
  const clear = db.transaction((): number => {
    const links = db.prepare("SELECT COUNT(*) AS n FROM creator_tweets").get() as { n: number };
    db.prepare("DELETE FROM creator_tweets").run();
    db.prepare("DELETE FROM x_feed_state").run();
    db.prepare("DELETE FROM tweets").run();
    db.prepare("DELETE FROM x_retrieval_checkpoints").run();
    db.prepare("DELETE FROM x_retrieval_tasks").run();
    db.prepare("DELETE FROM x_retrieval_jobs").run();
    return Number(links.n);
  });
  return clear();
}

/**
 * Removes posts that no timeline references anymore. Called after creator
 * timeline deletion so shared posts stay while orphaned text is reclaimed.
 */
export function deleteOrphanTweets(db: ScopeDatabase): number {
  const result = db
    .prepare("DELETE FROM tweets WHERE id NOT IN (SELECT DISTINCT tweet_id FROM creator_tweets)")
    .run();
  return Number(result.changes);
}
