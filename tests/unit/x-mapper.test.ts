import { describe, expect, it } from "vitest";

import { XProviderError } from "@/lib/x/model";
import { mapXTweet, mapXTimelinePage, mapXUser, mapXUserLookup } from "@/lib/x/mapper";

const AUTHOR = {
  userId: "1234567890123456789",
  handle: "@fixture",
  displayName: "Fixture",
  avatarUrl: "https://pbs.twimg.com/profile_images/a_normal.png",
};

describe("mapXTweet", () => {
  it("normalizes a full payload and keeps ids as strings", () => {
    const tweet = mapXTweet({
      id: "1234567890123456789",
      author: AUTHOR,
      text: "Hello 🌍\n\nLine two",
      language: "en",
      publishedAt: "2026-09-16T10:00:00Z",
      replyCount: 3,
      repostCount: 0,
      likeCount: 17,
      media: [
        { kind: "photo", url: "https://pbs.twimg.com/media/x.jpg", altText: "chart" },
        { kind: "photo", url: "https://evil.example/tracker.png" },
      ],
      quoted: {
        tweetId: "42",
        handle: "other",
        name: "Other",
        text: "quoted body",
        url: "https://x.com/other/status/42",
      },
    });
    expect(tweet).not.toBeNull();
    expect(tweet?.id).toBe("1234567890123456789");
    expect(tweet?.author.handle).toBe("fixture");
    expect(tweet?.text).toContain("🌍");
    expect(tweet?.publishedAt).toBe("2026-09-16T10:00:00.000Z");
    expect(tweet?.repostCount).toBe(0);
    expect(tweet?.likeCount).toBe(17);
    // Off-host media URLs are dropped rather than stored.
    expect(tweet?.media).toHaveLength(1);
    expect(tweet?.quoted?.text).toBe("quoted body");
  });

  it("treats numeric ids as strings and rejects unsafe numbers", () => {
    // A JS number beyond the safe integer range must not become a tweet id.
    const unsafe = mapXTweet({ id: 9_007_199_254_740_993, author: AUTHOR, text: "x" });
    expect(unsafe).toBeNull();
  });

  it("marks missing text unavailable and missing metrics null", () => {
    const tweet = mapXTweet({ id: "42", author: AUTHOR, text: "" });
    expect(tweet?.contentStatus).toBe("unavailable");
    expect(tweet?.replyCount).toBeNull();
    expect(tweet?.repostCount).toBeNull();
  });

  it("honors an explicit summary status for truncated previews", () => {
    const tweet = mapXTweet({
      id: "42",
      author: AUTHOR,
      text: "short preview",
      contentStatus: "summary",
    });
    expect(tweet?.contentStatus).toBe("summary");
  });

  it("returns null for payloads that cannot be a tweet", () => {
    expect(mapXTweet(null)).toBeNull();
    expect(mapXTweet({ text: "no id" })).toBeNull();
    expect(mapXTweet({ id: "42" })).toBeNull();
  });
});

describe("mapXTimelinePage", () => {
  it("collapses duplicate ids, counts skips, and reads the cursor", () => {
    const page = mapXTimelinePage({
      items: [
        { tweet: { id: "1", author: AUTHOR, text: "a" } },
        { tweet: { id: "1", author: AUTHOR, text: "duplicate" } },
        { tweet: { id: "2", author: AUTHOR, text: "b" }, timelineKind: "repost" },
        { nope: true },
      ],
      nextCursor: "2",
    });
    expect(page.items).toHaveLength(2);
    expect(page.skipped).toBe(2);
    expect(page.nextCursor).toBe("2");
    expect(page.exhausted).toBe(false);
    expect(page.items[1].timelineKind).toBe("repost");
  });

  it("throws a typed error on structurally broken payloads", () => {
    expect(() => mapXTimelinePage({ items: "nope" })).toThrowError(XProviderError);
  });

  it("treats a missing cursor as exhaustion", () => {
    const page = mapXTimelinePage({ items: [] });
    expect(page.exhausted).toBe(true);
    expect(page.nextCursor).toBeNull();
  });
});

describe("mapXUser / mapXUserLookup", () => {
  it("maps identity and rejects incomplete users", () => {
    expect(mapXUser(AUTHOR)?.handle).toBe("fixture");
    expect(mapXUser({ handle: "no-id" })).toBeNull();
    const lookup = mapXUserLookup({ user: AUTHOR, pinnedTweetId: "42" });
    expect(lookup.pinnedTweetId).toBe("42");
    expect(() => mapXUserLookup({})).toThrowError(XProviderError);
  });
});
