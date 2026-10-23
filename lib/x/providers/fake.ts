/**
 * Deterministic X provider for offline development and tests. It never
 * touches the network and is only selected when SCOPE_X_FAKE_PROVIDER=1 in a
 * non-production runtime (see providers/index.ts) — it must never make a
 * packaged build look connected.
 *
 * The fixture generator is deliberately adversarial: long-note text, emoji,
 * RTL text, a repost, a reply, a quote, null metrics, and an unavailable
 * payload all appear in every account's timeline.
 */
import {
  XProviderError,
  type XProvider,
  type XConnectionStatus,
  type XTimelineItem,
  type XTimelinePage,
  type XTweetDraft,
  type XUserIdentity,
  type XUserLookup,
  type XUserSearchResult,
} from "../model";

const FIXTURE_COUNT = 24;

/** Stable fake ids derived from the handle; no real X data is involved. */
function fakeUserId(handle: string): string {
  let hash = 7;
  for (const char of handle) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000_000_007;
  }
  // 15 digits keeps the derived status id (userId + 4 digits) inside the
  // 20-digit bound real X ids observe.
  return `9${hash.toString().padStart(14, "0")}`;
}

const AVATAR_COLORS = ["3b82f6", "22c55e", "f59e0b", "ec4899", "8b5cf6"];

function fakeAvatar(handle: string): string {
  let hash = 0;
  for (const char of handle) {
    hash = (hash + char.charCodeAt(0)) % AVATAR_COLORS.length;
  }
  const color = AVATAR_COLORS[hash];
  return `https://pbs.twimg.com/profile_images/${fakeUserId(handle).slice(-8)}/${encodeURIComponent(handle)}_${color}_normal.png`;
}

function fakeName(handle: string): string {
  return handle
    .split(/[_.]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function buildTweet(
  handle: string,
  index: number,
  overrides: Partial<XTweetDraft> = {},
): XTweetDraft {
  const userId = fakeUserId(handle);
  // Concatenation keeps the fake status id a long numeric string without
  // BigInt literals (the project targets an older ES lib).
  const id = `${userId}${String(1_000 + index)}`;
  const publishedAt = new Date(Date.UTC(2026, 8, 16, 12, 0, 0) - index * 3_600_000).toISOString();
  return {
    id,
    author: {
      userId,
      handle,
      displayName: fakeName(handle) || handle,
      avatarUrl: fakeAvatar(handle),
    },
    text: `Post ${index + 1} from @${handle}: a short unremarkable update.`,
    language: "en",
    publishedAt,
    url: `https://x.com/${handle}/status/${id}`,
    replyCount: index * 3,
    repostCount: index * 5,
    likeCount: index * 17,
    quoteCount: index,
    contentStatus: "complete",
    isRepost: false,
    repostedByUserId: null,
    repostedByHandle: null,
    conversationId: id,
    inReplyToTweetId: null,
    inReplyToUserId: null,
    inReplyToHandle: null,
    quoted: null,
    media: [],
    ...overrides,
  };
}

/** Builds the deterministic timeline for one handle. */
export function buildFakeTimeline(handle: string, count = FIXTURE_COUNT): XTimelineItem[] {
  const items: XTimelineItem[] = [];
  for (let index = 0; index < count; index += 1) {
    let tweet: XTweetDraft;
    switch (index) {
      case 0:
        tweet = buildTweet(handle, index, {
          text:
            `A long-form post from @${handle}. ` +
            "This one is deliberately much longer than a regular post so the timeline clamp, " +
            "the full-text detail view, and the byte-budget materializer all get exercised with " +
            "realistic long-note content: numbers (42% CAGR), dashes, and a trailing link " +
            "https://example.com/research that must survive normalization. ".repeat(2),
        });
        break;
      case 1:
        tweet = buildTweet(handle, index, {
          text: "Unicode check: 東京の市場はどうなる？ 📈 émojis, élans, and RTL: مرحبا بالعالم — all in one post.",
          language: "ja",
          media: [
            {
              kind: "photo",
              url: `https://pbs.twimg.com/media/fixture_${handle}_1.jpg`,
              previewUrl: `https://pbs.twimg.com/media/fixture_${handle}_1?format=jpg&name=small`,
              altText: "A market chart going up and to the right",
            },
          ],
        });
        break;
      case 2:
        tweet = buildTweet(handle, index, {
          isRepost: true,
          repostedByUserId: fakeUserId(handle),
          repostedByHandle: handle,
          author: {
            userId: fakeUserId("marketwatch"),
            handle: "marketwatch",
            displayName: "Market Watch",
            avatarUrl: fakeAvatar("marketwatch"),
          },
          text: "Reposted commentary that belongs to someone else and must stay attributed to them.",
        });
        break;
      case 3:
        tweet = buildTweet(handle, index, {
          inReplyToTweetId: buildTweet(handle, 10).id,
          inReplyToUserId: fakeUserId("analyst"),
          inReplyToHandle: "analyst",
          text: "@analyst I disagree with the margin math here — the mix shifts next quarter.",
        });
        break;
      case 4:
        tweet = buildTweet(handle, index, {
          text: "Quoting the report that started this thread:",
          quoted: {
            tweetId: buildTweet("somebody", 7).id,
            userId: fakeUserId("somebody"),
            handle: "somebody",
            name: "Somebody Else",
            text: "Original claim: demand is infinite.",
            url: `https://x.com/somebody/status/${buildTweet("somebody", 7).id}`,
          },
        });
        break;
      case 5:
        tweet = buildTweet(handle, index, {
          replyCount: null,
          repostCount: null,
          likeCount: null,
          quoteCount: null,
          text: "Metrics are unavailable on this post — the UI must show nothing, not zeroes.",
        });
        break;
      case 6:
        tweet = buildTweet(handle, index, {
          contentStatus: "unavailable",
          text: "",
        });
        break;
      default:
        tweet = buildTweet(handle, index);
        break;
    }
    const timelineKind = tweet.isRepost ? "repost" : tweet.inReplyToTweetId !== null ? "reply" : "post";
    items.push({
      tweet,
      timelineKind,
      timelineAt: tweet.publishedAt,
    });
  }
  return items;
}

/**
 * Live mode (SCOPE_X_FAKE_LIVE=1, development only): every account posts on
 * its own schedule relative to the real clock, so new posts keep arriving,
 * and reads behave like X through the worker: they take about a second
 * (SCOPE_X_FAKE_LATENCY_MS), return ~20 posts a page, and share a timeline
 * quota of SCOPE_X_FAKE_QUOTA (50) reads per SCOPE_X_FAKE_WINDOW_SEC (900)
 * seconds, reported with each page and enforced with 429s.
 */
interface LiveConfig {
  latencyMs: number;
  quota: number;
  windowMs: number;
}
function liveConfig(): LiveConfig | null {
  if (process.env.SCOPE_X_FAKE_LIVE !== "1") return null;
  const number = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    latencyMs: number("SCOPE_X_FAKE_LATENCY_MS", 900),
    quota: Math.max(1, number("SCOPE_X_FAKE_QUOTA", 50)),
    windowMs: Math.max(1, number("SCOPE_X_FAKE_WINDOW_SEC", 900)) * 1000,
  };
}
const LIVE_PAGE = 20;
const LIVE_HISTORY_DAYS = 120;
function handleHash(handle: string): number {
  let hash = 17;
  for (const char of handle) hash = (hash * 131 + char.charCodeAt(0)) % 1_000_003;
  return hash;
}
/** Minutes between this account's posts: a few busy accounts, most a few times a day. */
function livePeriodMinutes(handle: string): number {
  const hash = handleHash(handle);
  return hash % 3 === 0 ? 4 + (hash % 9) : 45 + (hash % 400);
}
/** The live timeline: newest first, post `k` published k periods before the latest slot. */
function liveItem(handle: string, k: number, now: number): XTimelineItem | null {
  const period = livePeriodMinutes(handle) * 60_000;
  const phase = (handleHash(handle) % livePeriodMinutes(handle)) * 60_000;
  const newest = Math.floor((now - phase) / period) * period + phase;
  const at = newest - k * period;
  if (at < now - LIVE_HISTORY_DAYS * 86_400_000) return null;
  const minute = Math.floor(at / 60_000);
  const id = `${String(handleHash(handle)).padStart(7, "0")}${minute}`;
  const kind = minute % 7 === 0 ? "repost" : minute % 5 === 0 ? "reply" : "post";
  const topics = ["ETH", "BTC", "SOL", "rates", "the election", "AI chips", "oil", "the dollar"];
  const topic = topics[minute % topics.length];
  const tweet = buildTweet(handle, 0, {
    id,
    publishedAt: new Date(at).toISOString(),
    url: `https://x.com/${handle}/status/${id}`,
    conversationId: id,
    text:
      kind === "reply"
        ? `@analyst On ${topic}: I see it differently, the next few weeks decide it.`
        : `${topic} update from @${handle} (${new Date(at).toISOString().slice(11, 16)} UTC): watching this closely.`,
    replyCount: minute % 40,
    repostCount: minute % 25,
    likeCount: minute % 300,
    quoteCount: minute % 6,
    media: [],
    ...(kind === "reply" ? { inReplyToTweetId: "1", inReplyToUserId: fakeUserId("analyst"), inReplyToHandle: "analyst" } : {}),
    ...(kind === "repost"
      ? {
          isRepost: true,
          repostedByUserId: fakeUserId(handle),
          repostedByHandle: handle,
          author: { userId: fakeUserId("marketwatch"), handle: "marketwatch", displayName: "Market Watch", avatarUrl: fakeAvatar("marketwatch") },
        }
      : {}),
  });
  return { tweet, timelineKind: kind, timelineAt: tweet.publishedAt };
}

export interface FakeXProviderOptions {
  /** Handle the fake session is connected as. */
  sessionHandle?: string;
  /** Start with an active session (tests that only read). */
  connected?: boolean;
}

class FakeXProvider implements XProvider {
  readonly id = "fake";
  readonly canConnect = true;
  private session: XUserIdentity | null = null;
  private readonly sessionHandle: string;
  /**
   * Handles whose fixtures this process has served. getTweet searches these
   * (plus the fixed cross-account fixtures) so a post listed earlier in the
   * same run can be hydrated without inventing a lookup index.
   */
  private readonly knownHandles = new Set<string>();

  constructor(options: FakeXProviderOptions = {}) {
    this.sessionHandle = options.sessionHandle ?? "scope_dev";
    this.knownHandles.add(this.sessionHandle);
    for (const handle of ["marketwatch", "somebody", "analyst"]) {
      this.knownHandles.add(handle);
    }
    if (options.connected === true) {
      this.session = this.identityFor(this.sessionHandle);
    }
  }

  private identityFor(handle: string): XUserIdentity {
    return {
      userId: fakeUserId(handle),
      handle,
      displayName: fakeName(handle) || handle,
      avatarUrl: fakeAvatar(handle),
      description: `Deterministic development account for @${handle}.`,
    };
  }

  async status(): Promise<XConnectionStatus> {
    return this.session === null
      ? {
          capability: "disconnected",
          providerId: this.id,
          user: null,
          errorCode: null,
          sessionOnly: true,
        }
      : {
          capability: "connected",
          providerId: this.id,
          user: this.session,
          errorCode: null,
          sessionOnly: true,
        };
  }

  async connect(): Promise<XConnectionStatus> {
    this.session = this.identityFor(this.sessionHandle);
    return this.status();
  }

  async disconnect(): Promise<void> {
    this.session = null;
  }

  private requireSession(): XUserIdentity {
    if (this.session === null) {
      throw new XProviderError("not_connected");
    }
    return this.session;
  }

  async resolveUser(handle: string): Promise<XUserLookup> {
    this.requireSession();
    const live = liveConfig();
    if (live) await this.liveRead(live, false);
    const normalized = handle.replace(/^@/, "").toLowerCase() || "scope_dev";
    return { user: { ...this.identityFor(normalized), userId: fakeUserId(normalized) }, pinnedTweetId: null };
  }

  /**
   * Deterministic people search: the query itself as a verified account,
   * plus two look-alikes so result lists, verified badges, and protected
   * accounts can be exercised offline.
   */
  async searchUsers(query: string): Promise<XUserSearchResult[]> {
    this.requireSession();
    const base = query
      .replace(/^@/, "")
      .toLowerCase()
      .replace(/[^0-9a-z_]/g, "")
      .slice(0, 9);
    if (base.length === 0) {
      return [];
    }
    return [
      { ...this.identityFor(base), verified: true, protected: false },
      { ...this.identityFor(`${base}_clips`), verified: false, protected: false },
      { ...this.identityFor(`the_${base}`), verified: false, protected: true },
    ];
  }

  private liveReads: number[] = [];
  private liveWindowStart = 0;

  /** Waits like a real read and spends the simulated quota; throws 429 when it is gone. */
  private async liveRead(live: LiveConfig, timeline: boolean) {
    await new Promise((resolve) => setTimeout(resolve, live.latencyMs));
    if (!timeline) return null;
    const now = Date.now();
    if (now - this.liveWindowStart >= live.windowMs) {
      this.liveWindowStart = now;
      this.liveReads = [];
    }
    const reset = Math.ceil((this.liveWindowStart + live.windowMs) / 1000);
    if (this.liveReads.length >= live.quota)
      throw new XProviderError("rate_limited", undefined, Math.max(1, reset - Math.floor(now / 1000)));
    this.liveReads.push(now);
    return { limit: live.quota, remaining: live.quota - this.liveReads.length, reset };
  }

  async listUserTweets(input: {
    userId: string;
    handle: string;
    cursor?: string | null;
    limit: number;
  }): Promise<XTimelinePage> {
    this.requireSession();
    const handle = input.handle.replace(/^@/, "").toLowerCase();
    this.knownHandles.add(handle);
    const live = liveConfig();
    if (live) {
      const rateLimit = await this.liveRead(live, true);
      const now = Date.now();
      const start = Number(input.cursor ?? 0) || 0;
      const items: XTimelineItem[] = [];
      for (let k = start; items.length < LIVE_PAGE; k++) {
        const next = liveItem(handle, k, now);
        if (!next) break;
        items.push(next);
      }
      const end = start + items.length;
      const more = liveItem(handle, end, now) !== null;
      return { items, nextCursor: more ? String(end) : null, exhausted: !more, skipped: 0, rateLimit };
    }
    const all = buildFakeTimeline(handle);
    const offset = input.cursor === null || input.cursor === undefined ? 0 : Number(input.cursor);
    const start = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const slice = all.slice(start, start + Math.max(1, input.limit));
    const next = start + slice.length;
    const exhausted = next >= all.length;
    return {
      items: slice,
      nextCursor: exhausted ? null : String(next),
      exhausted,
      skipped: 0,
    };
  }

  async getTweet(tweetId: string, authorHandle?: string | null): Promise<XTweetDraft | null> {
    this.requireSession();
    if (authorHandle) {
      this.knownHandles.add(authorHandle.replace(/^@/, "").toLowerCase());
    }
    for (const handle of this.knownHandles) {
      const match = buildFakeTimeline(handle).find((item) => item.tweet.id === tweetId);
      if (match) {
        return { ...match.tweet, contentStatus: match.tweet.text.length > 0 ? "complete" : "unavailable" };
      }
    }
    return null;
  }
}

/** One fake session per process, so dev-server restarts reset the connection. */
const fakeState = globalThis as typeof globalThis & { __scopeFakeXProvider?: XProvider };

export function createFakeXProvider(options?: FakeXProviderOptions): XProvider {
  return new FakeXProvider(options);
}

export function getSharedFakeXProvider(): XProvider {
  // Next compiles Route Handlers and Server Actions into separate bundles.
  // Share the development session across both entry points and HMR reloads.
  return fakeState.__scopeFakeXProvider ??= new FakeXProvider();
}
