import { describe, expect, it, vi } from "vitest";
import {
  XProviderError,
  type XProvider,
  type XTimelineItem,
  type XTimelinePage,
} from "@/lib/x/model";
import { mapXTimelineItem } from "@/lib/x/mapper";
import { validateXRetrieval } from "@/lib/x/research/validate-retrieval";

const options = { handle: "author", since: "2026-09-24T00:00:00Z", until: "2026-10-01T00:00:00Z" };
function item(id: string, at: string | null, extra = {}): XTimelineItem {
  return mapXTimelineItem({
    tweet: {
      id,
      author: { userId: "123", handle: "author", displayName: "Author" },
      text: "short",
      publishedAt: at,
      contentStatus: "complete",
      ...extra,
    },
    timelineKind: extra && "inReplyToTweetId" in extra ? "reply" : "post",
    timelineAt: at,
  })!;
}
function provider(pages: XTimelinePage[]): XProvider {
  const entries = pages.flatMap((page) => page.items);
  return {
    id: "worker",
    canConnect: false,
    status: vi.fn(async () => ({
      capability: "connected" as const,
      providerId: "worker",
      user: { userId: "1", handle: "test", displayName: "Test", avatarUrl: null },
      errorCode: null,
      sessionOnly: false,
    })),
    resolveUser: vi.fn(async () => ({
      user: { userId: "123", handle: "author", displayName: "Author", avatarUrl: null },
      pinnedTweetId: "10",
    })),
    listUserTweets: vi.fn().mockImplementation(async () => pages.shift()),
    getTweet: vi.fn(async (id) => entries.find((entry) => entry.tweet.id === id)?.tweet ?? null),
  };
}
function page(items: XTimelineItem[], nextCursor: string | null): XTimelinePage {
  return { items, nextCursor, exhausted: nextCursor === null, skipped: 0 };
}

describe("bounded retrieval validation", () => {
  it("continues past an old pinned post and records ordering, overlap, replies and long text", async () => {
    const pinned = item("10", "2026-01-01T00:00:00Z");
    const reply = item("11", "2026-09-30T00:00:00Z", { inReplyToTweetId: "9" });
    const long = item("12", "2026-09-29T00:00:00Z", { text: "long 📈 text ".repeat(100) });
    const source = provider([
      page([pinned, reply], "private-cursor"),
      page([reply, long, item("13", null), item("14", "2026-09-23T00:00:00Z")], null),
    ]);
    const exclusive = vi.fn(async (operation: () => Promise<unknown>) => operation());
    const report = await validateXRetrieval(
      source,
      options,
      exclusive as Parameters<typeof validateXRetrieval>[2],
    );
    expect(report.evidence).toBe("fixture");
    expect(report.checks).toEqual({
      pagination: true,
      boundary: true,
      reply: true,
      longText: true,
    });
    expect(report.stopReason).toBe("provider_end");
    expect(report.duplicateIds).toEqual(["11"]);
    expect(report.orderingInversions[0]).toEqual({ previousId: "10", nextId: "11" });
    expect(report.pages[1].entries[2].range).toBe("unknown");
    expect(exclusive).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(report)).not.toContain("private-cursor");
    expect(JSON.stringify(report)).not.toContain(long.tweet.text);
  });

  it("keeps all successful observations when a later page is rate limited", async () => {
    const source = provider([page([item("11", "2026-09-30T00:00:00Z")], "next")]);
    vi.mocked(source.listUserTweets)
      .mockImplementationOnce(async () => page([item("11", "2026-09-30T00:00:00Z")], "next"))
      .mockRejectedValueOnce(new XProviderError("rate_limited", "secret diagnostic", 60));
    const report = await validateXRetrieval(source, options);
    expect(report.stopReason).toBe("provider_error");
    expect(report.errorCode).toBe("rate_limited");
    expect(report.retryAfterSeconds).toBe(60);
    expect(report.pages).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("secret diagnostic");
  });

  it("detects cyclic cursors without claiming exhaustion", async () => {
    const source = provider([page([], "one"), page([], "two"), page([], "one")]);
    const report = await validateXRetrieval(source, options);
    expect(report.stopReason).toBe("cursor_stall");
    expect(report.pages).toHaveLength(3);
    expect(report.checks.pagination).toBe(false);
  });

  it("does not treat an old pinned post alone as date-window validation", async () => {
    const source = provider([
      page([item("10", "2026-01-01T00:00:00Z")], "next"),
      page([], "older"),
    ]);
    const report = await validateXRetrieval(source, { ...options, maxPages: 2 });
    expect(report.boundaryObserved).toBe(false);
    expect(report.checks.boundary).toBe(false);
    expect(report.stopReason).toBe("page_budget");
  });

  it("records a known reply accessible by detail but absent from the timeline", async () => {
    const source = provider([page([], null)]);
    vi.mocked(source.getTweet).mockResolvedValue(
      item("11", "2026-09-30T00:00:00Z", { inReplyToTweetId: "9" }).tweet,
    );
    const report = await validateXRetrieval(source, { ...options, replyId: "11" });
    expect(report.details[0].isReply).toBe(true);
    expect(report.checks.reply).toBe(false);
  });

  it("refuses timeline reads without a verified connection", async () => {
    const source = provider([]);
    vi.mocked(source.status).mockResolvedValue({
      capability: "disconnected",
      user: null,
      providerId: "worker",
      errorCode: "session_expired",
      sessionOnly: false,
    });
    const report = await validateXRetrieval(source, options);
    expect(report.stopReason).toBe("not_connected");
    expect(source.listUserTweets).not.toHaveBeenCalled();
  });

  it("rejects invalid bounds before any provider call", async () => {
    const source = provider([]);
    await expect(validateXRetrieval(source, { ...options, since: options.until })).rejects.toThrow(
      "Invalid retrieval probe options",
    );
    expect(source.status).not.toHaveBeenCalled();
  });

  it("uses inclusive start, exclusive end and an independent repost event clock", async () => {
    const repost = item("14", "2026-09-23T00:00:00Z");
    repost.timelineKind = "repost";
    repost.timelineAt = "2026-09-25T00:00:00Z";
    const unknownRepost = { ...repost, tweet: { ...repost.tweet, id: "15" }, timelineAt: null };
    const source = provider([
      page([item("11", options.since), item("12", options.until), repost, unknownRepost], null),
    ]);
    const report = await validateXRetrieval(source, options);
    expect(report.pages[0].entries.map((entry) => entry.range)).toEqual([
      "inside",
      "after",
      "inside",
      "unknown",
    ]);
    expect(report.checks.boundary).toBe(false);
    await expect(validateXRetrieval(source, { ...options, since: "2026-09-24" })).rejects.toThrow();
  });

  it("does not validate a long preview whose detail text differs", async () => {
    const long = item("12", "2026-09-29T00:00:00Z", {
      text: "preview ".repeat(100),
      contentStatus: "summary",
    });
    const source = provider([page([long], null)]);
    vi.mocked(source.getTweet).mockResolvedValue({
      ...long.tweet,
      contentStatus: "complete",
      text: "full text ".repeat(100),
    });
    const report = await validateXRetrieval(source, options);
    expect(report.details[0].matchesTimeline).toBe(false);
    expect(report.checks.longText).toBe(false);
  });

  it("enforces its deadline even while waiting for the provider mutex", async () => {
    const source = provider([]);
    const report = await validateXRetrieval(
      source,
      { ...options, maxDurationMs: 1000 },
      () => new Promise(() => {}),
    );
    expect(report.stopReason).toBe("time_budget");
    expect(source.status).not.toHaveBeenCalled();
  });
});
