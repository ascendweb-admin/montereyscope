import type { ScopeDatabase } from "@/lib/db/connection";
import { getTweetById, getTweetForCreator } from "@/lib/x/repository";
import { toTweetViewModel } from "@/lib/x/view-model";
import {
  POST_TYPES,
  type CachedFeed,
  type ExactSearch,
  type ResearchList,
  type ResearchPostType,
} from "./model";
import { exactSearchExpression, literalPhrase, parseExactSearch } from "./search";
import { ResearchInputError } from "./input";
export { ResearchInputError } from "./input";

export function parseId(value: unknown): number {
  const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new ResearchInputError("Choose a valid list or creator.");
  return id;
}
export function creatorIds(db: ScopeDatabase, value: unknown): number[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new ResearchInputError("Choose up to 1,000 X creators.");
  const ids = [...new Set(value.map(parseId))];
  const find = db.prepare("SELECT id FROM creators WHERE id = ? AND platform = 'x'");
  if (ids.some((id) => !find.get(id)))
    throw new ResearchInputError("An X creator in this selection no longer exists.");
  return ids;
}
export function listResearchLists(db: ScopeDatabase): ResearchList[] {
  const rows = db
    .prepare("SELECT * FROM x_research_lists ORDER BY name COLLATE NOCASE, id")
    .all() as Array<{
    id: number;
    name: string;
    description: string;
    created_at: string;
    updated_at: string;
  }>;
  const members = db.prepare(
    "SELECT creator_id FROM x_research_list_members WHERE list_id = ? ORDER BY creator_id",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    creatorIds: (members.all(r.id) as Array<{ creator_id: number }>).map((m) => m.creator_id),
  }));
}
export function getResearchList(db: ScopeDatabase, id: number): ResearchList {
  const list = listResearchLists(db).find((l) => l.id === id);
  if (!list) throw new ResearchInputError("This list no longer exists. Choose another list.", 404);
  return list;
}
export function saveResearchList(
  db: ScopeDatabase,
  input: { id?: unknown; name?: unknown; description?: unknown; creatorIds?: unknown },
): ResearchList {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!name || name.length > 100 || description.length > 1000)
    throw new ResearchInputError(
      "Use a list name of 1–100 characters and a description of at most 1,000 characters.",
    );
  return db.transaction(() => {
    const ids = creatorIds(db, input.creatorIds ?? []);
    let id: number;
    if (input.id !== undefined) {
      id = parseId(input.id);
      getResearchList(db, id);
      db.prepare(
        "UPDATE x_research_lists SET name = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      ).run(name, description, id);
    } else
      id = Number(
        db
          .prepare("INSERT INTO x_research_lists(name, description) VALUES (?, ?)")
          .run(name, description).lastInsertRowid,
      );
    // Keep unchanged membership timestamps; removing membership only touches this relation.
    const remove = db.prepare(
      "DELETE FROM x_research_list_members WHERE list_id = ? AND creator_id = ?",
    );
    for (const member of getResearchList(db, id).creatorIds)
      if (!ids.includes(member)) remove.run(id, member);
    const add = db.prepare(
      "INSERT OR IGNORE INTO x_research_list_members(list_id, creator_id) VALUES (?, ?)",
    );
    for (const member of ids) add.run(id, member);
    return getResearchList(db, id);
  })();
}
export function deleteResearchList(db: ScopeDatabase, id: number): void {
  getResearchList(db, id);
  db.prepare("DELETE FROM x_research_lists WHERE id = ?").run(id);
}

export interface CachedFeedQuery {
  creatorIds: number[];
  since: string;
  until: string;
  types: ResearchPostType[];
  page?: number;
  search?: ExactSearch;
}
export function readCachedFeed(db: ScopeDatabase, query: CachedFeedQuery): CachedFeed {
  // Counts, text and provenance come from one SQLite read snapshot, including
  // when another desktop/server connection is committing a retrieval page.
  return db.transaction(() => readCachedFeedSnapshot(db, query))();
}
function readCachedFeedSnapshot(db: ScopeDatabase, query: CachedFeedQuery): CachedFeed {
  const ids = creatorIds(db, query.creatorIds);
  if (query.types.some((type) => !POST_TYPES.includes(type)))
    throw new ResearchInputError("Choose valid post types.");
  if (
    !Number.isFinite(Date.parse(query.since)) ||
    !Number.isFinite(Date.parse(query.until)) ||
    query.since >= query.until
  )
    throw new ResearchInputError("Choose a valid date range.");
  const requestedPage = query.page ?? 1;
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 1000000)
    throw new ResearchInputError("Choose a valid page.");
  const search = query.search
    ? parseExactSearch({
        terms: query.search.terms.join("\n"),
        aliases: query.search.aliases.join("\n"),
        exclusions: query.search.exclusions.join("\n"),
      })
    : undefined;
  const params = {
    ids: JSON.stringify(ids),
    types: JSON.stringify(query.types),
    since: query.since,
    until: query.until,
    ...(search ? { match: exactSearchExpression(search) } : {}),
  };
  // Scope memberships BEFORE deduplication. Repost state on the canonical tweet
  // may come from an unrelated timeline, so classify using the membership.
  const scoped = researchScopeSql(Boolean(search));
  const scopeStats = db
    .prepare(
      `${scoped} SELECT COUNT(DISTINCT tweet_id) AS n,
    COUNT(DISTINCT CASE WHEN content_status <> 'complete' OR text = '' THEN tweet_id END) AS incomplete
    FROM eligible`,
    )
    .get(params) as { n: number; incomplete: number };
  const total = (
    db.prepare(`${scoped} SELECT COUNT(*) AS n FROM grouped`).get(params) as { n: number }
  ).n;
  // Hydrated/revised text can remove matches while a later page is open.
  // Keep the remaining results reachable instead of returning a false empty state.
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / 30)));
  const unknownDates = (
    db
      .prepare(
        `${scoped} SELECT COUNT(DISTINCT tweet_id) AS n FROM scoped WHERE julianday(event_at) IS NULL AND post_type IN (SELECT value FROM json_each(@types))`,
      )
      .get(params) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `${scoped} SELECT * FROM grouped ORDER BY julianday(event_at) DESC, tweet_id DESC LIMIT 30 OFFSET @offset`,
    )
    .all({ ...params, offset: (page - 1) * 30 }) as Array<{ tweet_id: string; event_at: string }>;
  const provenance = db.prepare(
    `${scoped} SELECT creator_id, handle, display_name, timeline_kind, event_at, post_type FROM eligible WHERE tweet_id = @tweetId ORDER BY julianday(event_at) DESC, creator_id`,
  );
  const aliasMatch = search?.aliases.length
    ? db.prepare(`SELECT 1 FROM x_tweet_text WHERE x_tweet_text MATCH ?
        AND rowid = (SELECT rowid FROM tweets WHERE id = ?)`)
    : null;
  const posts = rows.map((row) => {
    const links = provenance.all({ ...params, tweetId: row.tweet_id }) as Array<{
      creator_id: number;
      handle: string | null;
      display_name: string;
      timeline_kind: "post" | "reply" | "repost";
      event_at: string;
      post_type: ResearchPostType;
    }>;
    const primary = links[0];
    const record = getTweetForCreator(db, primary.creator_id, row.tweet_id)!;
    const tweet = toTweetViewModel(record, primary.creator_id);
    tweet.timelineKind = primary.post_type === "reply" ? "reply" : primary.timeline_kind;
    tweet.isRepost = primary.timeline_kind === "repost";
    tweet.repostedByHandle = tweet.isRepost ? primary.handle : null;
    return {
      tweet,
      eventAt: row.event_at,
      postType: primary.post_type,
      provenance: links.map((l) => ({
        creatorId: l.creator_id,
        handle: l.handle,
        name: l.display_name,
        kind: l.timeline_kind,
        eventAt: l.event_at,
      })),
      parentCached:
        record.tweet.inReplyToTweetId !== null &&
        getTweetById(db, record.tweet.inReplyToTweetId) !== null,
      ...(search
        ? {
            match: {
              terms: search.terms,
              aliases: search.aliases.filter((alias) =>
                aliasMatch?.get(`text : ${literalPhrase(alias)}`, row.tweet_id),
              ),
            },
          }
        : {}),
    };
  });
  const coverage = db
    .prepare(
      `SELECT c.id, c.display_name, COUNT(ct.tweet_id) AS n,
      MIN(CASE WHEN ct.timeline_kind = 'repost' THEN ct.timeline_at ELSE t.published_at END) AS oldest,
      MAX(CASE WHEN ct.timeline_kind = 'repost' THEN ct.timeline_at ELSE t.published_at END) AS newest,
      fs.last_refreshed_at, fs.last_error
    FROM creators c LEFT JOIN creator_tweets ct ON ct.creator_id = c.id LEFT JOIN tweets t ON t.id = ct.tweet_id
    LEFT JOIN x_feed_state fs ON fs.creator_id = c.id
    WHERE c.id IN (SELECT value FROM json_each(@ids)) GROUP BY c.id ORDER BY c.display_name COLLATE NOCASE`,
    )
    .all({ ids: params.ids }) as Array<{
    id: number;
    display_name: string;
    n: number;
    oldest: string | null;
    newest: string | null;
    last_refreshed_at: string | null;
    last_error: string | null;
  }>;
  return {
    posts,
    total,
    page,
    pageSize: 30,
    unknownDates,
    scopeTotal: scopeStats.n,
    incompleteText: scopeStats.incomplete,
    bounds: { since: query.since, until: query.until },
    ...(search ? { search } : {}),
    coverage: coverage.map((r) => {
      const checkpoint = db
        .prepare(
          "SELECT state_json FROM x_retrieval_checkpoints WHERE creator_id = ? AND lane = 'head' ORDER BY rowid DESC LIMIT 1",
        )
        .get(r.id) as { state_json: string } | undefined;
      const head = checkpoint
        ? (JSON.parse(checkpoint.state_json) as {
            lastSuccessfulRefresh: string | null;
            pendingTask: string | null;
          })
        : null;
      return {
        creatorId: r.id,
        name: r.display_name,
        cachedPosts: r.n,
        oldest: r.oldest,
        newest: r.newest,
        lastRefreshedAt: head ? head.lastSuccessfulRefresh : r.last_refreshed_at,
        hasError: r.last_error !== null,
        pendingHead: head?.pendingTask != null,
      };
    }),
  };
}

/** Shared membership-first scope for feed and immutable corpus resolution. */
export function researchScopeSql(exact = false): string {
  return `WITH scoped AS (
    SELECT ct.*, c.handle, c.display_name, t.rowid AS text_rowid,
      t.content_status, t.text,
      CASE WHEN ct.timeline_kind = 'repost' THEN ct.timeline_at ELSE t.published_at END AS event_at,
      CASE WHEN ct.timeline_kind = 'repost' THEN 'repost'
        WHEN ct.timeline_kind = 'reply' OR t.in_reply_to_tweet_id IS NOT NULL THEN 'reply'
        WHEN t.quoted_tweet_id IS NOT NULL THEN 'quote' ELSE 'original' END AS post_type
    FROM creator_tweets ct JOIN tweets t ON t.id = ct.tweet_id JOIN creators c ON c.id = ct.creator_id
    WHERE ct.creator_id IN (SELECT value FROM json_each(@ids))
  ), eligible AS (
    SELECT * FROM scoped WHERE post_type IN (SELECT value FROM json_each(@types))
      AND julianday(event_at) >= julianday(@since) AND julianday(event_at) < julianday(@until)
  ), grouped AS (
    SELECT tweet_id, MAX(event_at) AS event_at FROM eligible
      ${exact ? "WHERE text_rowid IN (SELECT rowid FROM x_tweet_text WHERE x_tweet_text MATCH @match)" : ""}
      GROUP BY tweet_id
  )`;
}
