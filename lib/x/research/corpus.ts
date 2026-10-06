import { createHash, randomUUID } from "node:crypto";
import type { ScopeDatabase } from "@/lib/db/connection";
import { getTweetForCreator, getTweetById } from "@/lib/x/repository";
import { toTweetViewModel } from "@/lib/x/view-model";
import { POST_TYPES, type ResearchPostType } from "./model";
import {
  creatorIds,
  getResearchList,
  parseId,
  readCachedFeed,
  researchScopeSql,
} from "./repository";
import { calendarBounds } from "./dates";
import { parseExactSearch, exactSearchExpression } from "./search";
import { ResearchInputError } from "./input";
import type {
  CorpusScope,
  CorpusPost,
  CorpusRequest,
  CorpusSummary,
  Exclusion,
} from "./analysis-model";

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function resolveCorpusRequest(
  db: ScopeDatabase,
  input: Record<string, unknown>,
): CorpusRequest {
  const listId = input.listId == null ? null : parseId(input.listId);
  const list = listId === null ? null : getResearchList(db, listId);
  const ids = creatorIds(db, input.creatorIds ?? list?.creatorIds ?? []);
  if (!ids.length) throw new ResearchInputError("Choose at least one X creator.");
  if (list && ids.some((id) => !list.creatorIds.includes(id)))
    throw new ResearchInputError("Choose creators belonging to this list.");
  const timezone = input.timezone === undefined ? "UTC" : String(input.timezone);
  let dates: { since: string; until: string };
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    dates =
      input.period === "24h"
        ? { since: new Date(Date.now() - 86400000).toISOString(), until: new Date().toISOString() }
        : calendarBounds(String(input.start ?? ""), String(input.end ?? ""), timezone);
  } catch {
    throw new ResearchInputError("Choose valid inclusive calendar dates and an IANA timezone.");
  }
  const types = input.types ?? ["original", "quote", "reply"];
  if (!Array.isArray(types) || !types.length || types.some((type) => !POST_TYPES.includes(type)))
    throw new ResearchInputError("Choose valid post types.");
  const selection = input.selection ?? { kind: "all" };
  if (!selection || typeof selection !== "object" || Array.isArray(selection))
    throw new ResearchInputError("Choose a valid question scope.");
  const fields = selection as Record<string, unknown>;
  let resolved: CorpusRequest["selection"];
  if (fields.kind === "all") resolved = { kind: "all" };
  else if (fields.kind === "exact") {
    if (!fields.search || typeof fields.search !== "object" || Array.isArray(fields.search))
      throw new ResearchInputError("Provide exact search controls.");
    resolved = {
      kind: "exact",
      search: parseExactSearch(fields.search as Record<string, unknown>),
    };
  } else if (fields.kind === "selected") {
    const tweets = fields.tweetIds;
    if (
      !Array.isArray(tweets) ||
      !tweets.length ||
      tweets.length > 1000 ||
      tweets.some((id) => typeof id !== "string" || !/^\d{1,30}$/.test(id))
    )
      throw new ResearchInputError("Select 1–1,000 valid post ids, or ask about the whole scope.");
    resolved = { kind: "selected", tweetIds: [...new Set(tweets)] };
  } else throw new ResearchInputError("Choose all posts, exact results or selected posts.");
  return {
    listId,
    creatorIds: ids,
    timezone,
    ...dates,
    types: [...new Set(types)] as ResearchPostType[],
    selection: resolved,
  };
}
export function getCorpusScope(db: ScopeDatabase, id: string): CorpusScope {
  const row = db.prepare("SELECT * FROM x_research_scopes WHERE id = ?").get(id) as
    { id: string; request_json: string; summary_json: string; created_at: string } | undefined;
  if (!row) throw new ResearchInputError("This research scope does not exist.", 404);
  return {
    id: row.id,
    request: JSON.parse(row.request_json),
    summary: JSON.parse(row.summary_json),
    createdAt: row.created_at,
  };
}
export function getCorpusPost(db: ScopeDatabase, scopeId: string, tweetId: string): CorpusPost {
  const row = db
    .prepare("SELECT snapshot_json FROM x_research_scope_posts WHERE scope_id = ? AND tweet_id = ?")
    .get(scopeId, tweetId) as { snapshot_json: string } | undefined;
  if (!row) throw new ResearchInputError("This post is not in the saved research scope.", 404);
  return JSON.parse(row.snapshot_json);
}
export function corpusPosts(
  db: ScopeDatabase,
  scopeId: string,
  eligibleOnly = true,
): Iterable<CorpusPost> {
  const rows = db
    .prepare(
      `SELECT snapshot_json FROM x_research_scope_posts WHERE scope_id = ? ${eligibleOnly ? "AND exclusion IS NULL" : ""} ORDER BY creator_id, julianday(event_at), tweet_id`,
    )
    .iterate(scopeId) as Iterable<{ snapshot_json: string }>;
  return (function* () {
    for (const row of rows) yield JSON.parse(row.snapshot_json) as CorpusPost;
  })();
}
/** One atomic, local-only snapshot. Never hold this transaction across an AI call. */
export function freezeCorpus(
  db: ScopeDatabase,
  input: Record<string, unknown>,
  maxBytes: number,
): CorpusScope {
  return db.transaction(() => {
    const request = resolveCorpusRequest(db, input);
    const { selection } = request;
    const params = {
      ids: JSON.stringify(request.creatorIds),
      types: JSON.stringify(request.types),
      since: request.since,
      until: request.until,
      ...(selection.kind === "exact" ? { match: exactSearchExpression(selection.search) } : {}),
    };
    const sql = researchScopeSql(selection.kind === "exact");
    // Include unknown-dated memberships as exclusions, never presume they lie in range.
    const links = db
      .prepare(
        `${sql} SELECT * FROM scoped
      WHERE post_type IN (SELECT value FROM json_each(@types))
      AND (julianday(event_at) IS NULL OR (julianday(event_at) >= julianday(@since) AND julianday(event_at) < julianday(@until)))
      ${selection.kind === "exact" ? "AND text_rowid IN (SELECT rowid FROM x_tweet_text WHERE x_tweet_text MATCH @match)" : ""}
      ORDER BY creator_id, julianday(event_at), tweet_id`,
      )
      .all(params) as Array<{
      tweet_id: string;
      creator_id: number;
      handle: string | null;
      display_name: string;
      timeline_kind: "post" | "reply" | "repost";
      event_at: string | null;
      post_type: ResearchPostType;
    }>;
    const grouped = new Map<string, typeof links>();
    const selected = selection.kind === "selected" ? new Set(selection.tweetIds) : null;
    for (const link of links) {
      if (selected && !selected.has(link.tweet_id)) continue;
      const group = grouped.get(link.tweet_id) ?? [];
      group.push(link);
      grouped.set(link.tweet_id, group);
    }
    if (selected && selected.size !== grouped.size)
      throw new ResearchInputError("A selected post is outside the creator/date/type scope.");
    const feed = readCachedFeed(db, {
      ...request,
      search: selection.kind === "exact" ? selection.search : undefined,
    });
    const summary: CorpusSummary = {
      total: grouped.size,
      eligible: 0,
      excluded: { missing_date: 0, incomplete_text: 0, missing_text: 0 },
      bytes: 0,
      creators: db
        .prepare(
          "SELECT id, display_name AS name, handle FROM creators WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id",
        )
        .all(params.ids) as CorpusSummary["creators"],
      coverage: feed.coverage,
      retrieval: (
        db
          .prepare(
            "SELECT creator_id AS creatorId, config_key AS config, lane, state_json FROM x_retrieval_checkpoints WHERE creator_id IN (SELECT value FROM json_each(?)) ORDER BY creator_id, config_key, lane",
          )
          .all(params.ids) as Array<{
          creatorId: number;
          config: string;
          lane: string;
          state_json: string;
        }>
      ).map(({ state_json, ...row }) => ({ ...row, state: JSON.parse(state_json) })),
      limitations: [
        "Cached text only; provider history and reply coverage are not exhaustive.",
        "Quoted speech and reposts are not evidence of the selected creator's endorsement.",
        "Media, charts, videos, Articles and linked pages are not analyzed.",
        "Parent posts are context only, never counted as in-range evidence.",
        "Full scan measures processing coverage, not perfect semantic recall.",
      ],
    };
    const id = randomUUID(),
      createdAt = new Date().toISOString();
    // Parent row exists before its snapshots; update never allowed, so compute first.
    const snapshots: Array<{ post: CorpusPost; json: string }> = [];
    for (const [tweetId, memberships] of grouped) {
      const dated = memberships.filter(
        (m) => m.event_at && Number.isFinite(Date.parse(m.event_at)),
      );
      const provenance = dated.length ? dated : memberships;
      provenance.sort(
        (a, b) => (b.event_at ?? "").localeCompare(a.event_at ?? "") || a.creator_id - b.creator_id,
      );
      const primary = provenance[0];
      const record = getTweetForCreator(db, primary.creator_id, tweetId)!;
      const tweet = toTweetViewModel(record, primary.creator_id);
      tweet.timelineKind = primary.post_type === "reply" ? "reply" : primary.timeline_kind;
      tweet.isRepost = primary.timeline_kind === "repost";
      tweet.repostedByHandle = tweet.isRepost ? primary.handle : null;
      const parent = record.tweet.inReplyToTweetId
        ? getTweetById(db, record.tweet.inReplyToTweetId)
        : null;
      const exclusion: Exclusion | null =
        !primary.event_at || !Number.isFinite(Date.parse(primary.event_at))
          ? "missing_date"
          : !tweet.text.trim()
            ? "missing_text"
            : !tweet.readyForAnalysis
              ? "incomplete_text"
              : null;
      if (exclusion) summary.excluded[exclusion]++;
      else summary.eligible++;
      const body = {
        tweet,
        eventAt: primary.event_at ?? "",
        postType: primary.post_type,
        provenance: provenance.map((m) => ({
          creatorId: m.creator_id,
          name: m.display_name,
          handle: m.handle,
          kind: m.timeline_kind,
          eventAt: m.event_at,
        })),
        parentCached: Boolean(parent),
        exclusion,
        context:
          parent && parent.contentStatus === "complete"
            ? {
                id: parent.id,
                author: parent.author.handle,
                text: parent.text,
                publishedAt: parent.publishedAt,
                role: "context_only" as const,
              }
            : null,
      };
      const post: CorpusPost = { ...body, version: digest(body) };
      const json = JSON.stringify(post);
      summary.bytes += Buffer.byteLength(json);
      if (summary.bytes > maxBytes)
        throw new ResearchInputError(
          "The snapshot exceeds the configured disk budget. Increase the budget or explicitly narrow the scope.",
          413,
        );
      snapshots.push({ post, json });
    }
    db.prepare("INSERT INTO x_research_scopes VALUES (?, ?, ?, ?)").run(
      id,
      JSON.stringify(request),
      JSON.stringify(summary),
      createdAt,
    );
    const insert = db.prepare("INSERT INTO x_research_scope_posts VALUES (?, ?, ?, ?, ?, ?, ?)");
    const membership = db.prepare("INSERT INTO x_research_scope_memberships VALUES (?, ?, ?)");
    for (const { post, json } of snapshots) {
      insert.run(
        id,
        post.tweet.id,
        post.tweet.creatorId,
        post.eventAt || null,
        post.version,
        post.exclusion,
        json,
      );
      for (const source of post.provenance) membership.run(id, post.tweet.id, source.creatorId);
    }
    return { id, createdAt, request, summary };
  })();
}
