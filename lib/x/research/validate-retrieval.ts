import { createHash } from "node:crypto";
import { XProviderError, type XProvider, type XTimelineItem } from "../model";

export interface RetrievalProbeOptions {
  evidence?: "live" | "fixture";
  handle: string;
  since: string;
  until: string;
  maxPages?: number;
  maxDurationMs?: number;
  replyId?: string;
  longPostId?: string;
}

function observation(item: XTimelineItem, since: number, until: number) {
  // Publication and sharing events are separate clocks. Never infer a repost event.
  const at = item.timelineKind === "repost" ? item.timelineAt : item.tweet.publishedAt;
  const time = at === null ? NaN : Date.parse(at);
  return {
    id: item.tweet.id,
    kind: item.timelineKind,
    publishedAt: item.tweet.publishedAt,
    timelineAt: item.timelineAt,
    range: !Number.isFinite(time)
      ? "unknown"
      : time < since
        ? "before"
        : time >= until
          ? "after"
          : "inside",
    contentStatus: item.tweet.contentStatus,
    characters: item.tweet.text.length,
    textSha256: createHash("sha256").update(item.tweet.text).digest("hex"),
  };
}

/** Manual, read-only validation. No archive writes, retries or date-based early stop. */
export async function validateXRetrieval(
  provider: XProvider,
  options: RetrievalProbeOptions,
  exclusive: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
) {
  const since = Date.parse(options.since);
  const until = Date.parse(options.until);
  const maxPages = options.maxPages ?? 5;
  const maxDurationMs = options.maxDurationMs ?? 180_000;
  if (
    !/^[A-Za-z0-9_]{1,15}$/.test(options.handle) ||
    ![options.since, options.until].every((date) => /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(date)) ||
    !Number.isFinite(since) ||
    !Number.isFinite(until) ||
    since >= until ||
    !Number.isInteger(maxPages) ||
    maxPages < 2 ||
    maxPages > 20 ||
    !Number.isInteger(maxDurationMs) ||
    maxDurationMs < 1_000 ||
    maxDurationMs > 600_000 ||
    [options.replyId, options.longPostId].some((id) => id !== undefined && !/^\d{1,20}$/.test(id))
  ) {
    throw new Error("Invalid retrieval probe options");
  }

  const report = {
    schemaVersion: 1,
    evidence: options.evidence ?? "fixture",
    startedAt: new Date().toISOString(),
    finishedAt: null as string | null,
    provider: provider.id,
    request: {
      handle: options.handle,
      since: new Date(since).toISOString(),
      until: new Date(until).toISOString(),
      maxPages,
      maxDurationMs,
      pageSize: 100,
    },
    creatorId: null as string | null,
    pinnedTweetId: null as string | null,
    pages: [] as Array<{
      number: number;
      skipped: number;
      hasNextCursor: boolean;
      entries: ReturnType<typeof observation>[];
    }>,
    details: [] as Array<{
      id: string;
      found: boolean;
      authoredByCreator: boolean;
      isReply: boolean;
      contentStatus: string | null;
      characters: number;
      matchesTimeline: boolean | null;
    }>,
    stopReason: "page_budget" as
      | "page_budget"
      | "provider_end"
      | "cursor_stall"
      | "time_budget"
      | "not_connected"
      | "provider_error",
    errorCode: null as string | null,
    retryAfterSeconds: null as number | null,
    duplicateIds: [] as string[],
    orderingInversions: [] as Array<{ previousId: string; nextId: string }>,
    boundaryObserved: false,
    observedBounds: { oldest: null as string | null, newest: null as string | null },
    unpinnedBounds: { oldest: null as string | null, newest: null as string | null },
    checks: { pagination: false, boundary: false, reply: false, longText: false },
    limitations: [
      "Observed posts only; neither a date boundary nor a missing cursor proves exhaustive history.",
      "Pinned/reordered posts are recorded; this probe never stops at the first old or familiar post.",
      "A timeline/detail text match is adapter consistency, not independent verification against X's rendered post.",
      "Remote search is deferred; attached media, Articles, links and full conversation context are not analyzed.",
    ],
  };
  const signal = AbortSignal.timeout(maxDurationMs);
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        exclusive(() => {
          signal.throwIfAborted();
          return operation();
        }),
        aborted,
      ]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const items = new Map<string, XTimelineItem>();
  let previous: XTimelineItem | null = null;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  try {
    const status = await read(() => provider.status(signal));
    if (!status.user || !["connected", "session_only"].includes(status.capability)) {
      report.stopReason = "not_connected";
      report.errorCode = status.errorCode ?? "not_connected";
      return report;
    }
    const lookup = await read(() => provider.resolveUser(options.handle, signal));
    report.creatorId = lookup.user.userId;
    report.pinnedTweetId = lookup.pinnedTweetId;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
      const page = await read(() =>
        provider.listUserTweets(
          { userId: lookup.user.userId, handle: lookup.user.handle, cursor, limit: 100 },
          signal,
        ),
      );
      report.pages.push({
        number: pageNumber,
        skipped: page.skipped,
        hasNextCursor: page.nextCursor !== null,
        entries: page.items.map((item) => observation(item, since, until)),
      });
      for (const item of page.items) {
        if (items.has(item.tweet.id)) report.duplicateIds.push(item.tweet.id);
        items.set(item.tweet.id, item);
        const entry = observation(item, since, until);
        if (entry.range === "before" && item.tweet.id !== lookup.pinnedTweetId) {
          report.boundaryObserved = true;
        }
        const at = item.timelineKind === "repost" ? item.timelineAt : item.tweet.publishedAt;
        if (at !== null && Number.isFinite(Date.parse(at))) {
          if (
            report.observedBounds.oldest === null ||
            Date.parse(at) < Date.parse(report.observedBounds.oldest)
          )
            report.observedBounds.oldest = at;
          if (
            report.observedBounds.newest === null ||
            Date.parse(at) > Date.parse(report.observedBounds.newest)
          )
            report.observedBounds.newest = at;
          if (item.tweet.id !== lookup.pinnedTweetId) {
            if (
              report.unpinnedBounds.oldest === null ||
              Date.parse(at) < Date.parse(report.unpinnedBounds.oldest)
            )
              report.unpinnedBounds.oldest = at;
            if (
              report.unpinnedBounds.newest === null ||
              Date.parse(at) > Date.parse(report.unpinnedBounds.newest)
            )
              report.unpinnedBounds.newest = at;
          }
        }
        if (previous) {
          const prevAt =
            previous.timelineKind === "repost" ? previous.timelineAt : previous.tweet.publishedAt;
          if (at !== null && prevAt !== null && Date.parse(at) > Date.parse(prevAt)) {
            report.orderingInversions.push({
              previousId: previous.tweet.id,
              nextId: item.tweet.id,
            });
          }
        }
        previous = item;
      }
      if (page.nextCursor === null) {
        report.stopReason = "provider_end";
        break;
      }
      if (page.nextCursor === cursor || cursors.has(page.nextCursor)) {
        report.stopReason = "cursor_stall";
        break;
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    const authored = [...items.values()].filter(
      (item) => item.tweet.author.userId === lookup.user.userId && item.timelineKind !== "repost",
    );
    const replyId =
      options.replyId ?? authored.find((item) => item.timelineKind === "reply")?.tweet.id;
    const longId =
      options.longPostId ??
      authored
        .filter((item) => item.tweet.text.length > 280)
        .sort((a, b) => b.tweet.text.length - a.tweet.text.length)[0]?.tweet.id;
    for (const id of new Set([replyId, longId].filter((id): id is string => id !== undefined))) {
      const detail = await read(() => provider.getTweet(id, lookup.user.handle, signal));
      const cached = items.get(id);
      report.details.push({
        id,
        found: detail !== null,
        authoredByCreator: detail?.author.userId === lookup.user.userId,
        isReply: detail?.inReplyToTweetId != null,
        contentStatus: detail?.contentStatus ?? null,
        characters: detail?.text.length ?? 0,
        matchesTimeline: !detail || !cached ? null : detail.text === cached.tweet.text,
      });
    }
    report.checks.pagination =
      report.pages.length >= 2 &&
      report.pages[1].entries.some(
        (entry) => !report.pages[0].entries.some((first) => first.id === entry.id),
      ) &&
      report.stopReason !== "cursor_stall";
    report.checks.boundary =
      report.boundaryObserved &&
      report.pages.some((page) => page.entries.some((entry) => entry.range === "inside"));
    report.checks.reply = report.details.some(
      (detail) =>
        detail.id === replyId &&
        detail.authoredByCreator &&
        detail.isReply &&
        items.get(detail.id)?.timelineKind === "reply",
    );
    report.checks.longText = report.details.some(
      (detail) =>
        detail.id === longId &&
        detail.authoredByCreator &&
        detail.characters > 280 &&
        detail.contentStatus === "complete" &&
        detail.matchesTimeline === true &&
        items.get(detail.id)?.tweet.contentStatus === "complete",
    );
  } catch (error) {
    report.stopReason = signal.aborted ? "time_budget" : "provider_error";
    report.errorCode =
      error instanceof XProviderError
        ? error.code
        : signal.aborted
          ? "timeout"
          : "invalid_response";
    report.retryAfterSeconds = error instanceof XProviderError ? error.retryAfterSeconds : null;
  } finally {
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
