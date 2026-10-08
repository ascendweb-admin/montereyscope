import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { addCreator } from "@/lib/creators/repository";
import {
  classifyCreatorInput,
  expandCreatorLink,
  formatFollowerCount,
  normalizeSearchQuery,
  type CreatorSearchResult,
} from "@/lib/creators/search/model";
import { searchCreators } from "@/lib/creators/search/service";
import {
  buildYouTubeSearchArgs,
  parseYouTubeSearchPayload,
  searchYouTubeChannels,
} from "@/lib/creators/search/youtube";
import type { ScopeDatabase } from "@/lib/db/connection";
import { ALL_MIGRATIONS } from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import {
  fetchRumbleChannelSearch,
  parseRumbleChannelSearch,
  searchRumbleChannels,
} from "@/lib/rumble/channel-search";
import { connectX, disconnectX } from "@/lib/x";
import { searchXUsers } from "@/lib/x/service";
import { mapXUserSearch } from "@/lib/x/mapper";
import { XProviderError, type XProvider } from "@/lib/x/model";
import * as providers from "@/lib/x/providers";
import { resetXProvider } from "@/lib/x/providers";

const FIXTURES = path.join(__dirname, "..", "fixtures");
const youtubeFixture = JSON.parse(
  readFileSync(path.join(FIXTURES, "youtube-channel-search.fixture.json"), "utf8"),
) as unknown;
const rumbleFixture = readFileSync(
  path.join(FIXTURES, "rumble-channel-search.fixture.html"),
  "utf8",
);
const rumbleEmptyFixture = readFileSync(
  path.join(FIXTURES, "rumble-channel-search-empty.fixture.html"),
  "utf8",
);

describe("creator input classification", () => {
  it("treats names as searches and links, handles, and channel IDs as lookups", () => {
    expect(classifyCreatorInput("  ", "youtube")).toBe("empty");
    expect(classifyCreatorInput("PewDiePie", "youtube")).toBe("search");
    expect(classifyCreatorInput("dan bongino", "rumble")).toBe("search");
    expect(classifyCreatorInput("https://www.youtube.com/@PewDiePie", "youtube")).toBe("link");
    expect(classifyCreatorInput("youtube.com/@PewDiePie", "youtube")).toBe("link");
    expect(classifyCreatorInput("rumble.com/c/Bongino", "rumble")).toBe("link");
    expect(classifyCreatorInput("@MrBeast", "youtube")).toBe("link");
    expect(classifyCreatorInput("UC-lHJZR3Gqxm24_Vd_AJ5Yw", "youtube")).toBe("link");
    expect(classifyCreatorInput("@elonmusk", "x")).toBe("link");
    // Rumble has no @handle shorthand, so it stays a name search.
    expect(classifyCreatorInput("@bongino", "rumble")).toBe("search");
    // A name that merely mentions a site is still a name.
    expect(classifyCreatorInput("youtube compilations", "youtube")).toBe("search");
  });

  it("expands shorthand links into the URLs the resolvers accept", () => {
    expect(expandCreatorLink("@MrBeast", "youtube")).toBe("https://www.youtube.com/@MrBeast");
    expect(expandCreatorLink("UC-lHJZR3Gqxm24_Vd_AJ5Yw", "youtube")).toBe(
      "https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw",
    );
    expect(expandCreatorLink("rumble.com/c/Bongino", "rumble")).toBe(
      "https://rumble.com/c/Bongino",
    );
    expect(expandCreatorLink("@elonmusk", "x")).toBe("@elonmusk");
    expect(expandCreatorLink(" https://x.com/a ", "x")).toBe("https://x.com/a");
  });

  it("normalizes queries and rejects empty or oversized ones", () => {
    expect(normalizeSearchQuery("  dan \n  bongino\t")).toBe("dan bongino");
    expect(normalizeSearchQuery("   ")).toBeNull();
    expect(normalizeSearchQuery("x".repeat(101))).toBeNull();
    expect(normalizeSearchQuery(42)).toBeNull();
  });

  it("formats audience sizes compactly", () => {
    expect(formatFollowerCount(109_000_000)).toBe("109M");
    expect(formatFollowerCount(1_230_000)).toBe("1.2M");
    expect(formatFollowerCount(26_300)).toBe("26.3K");
    expect(formatFollowerCount(532)).toBe("532");
  });
});

describe("YouTube channel search", () => {
  it("builds a channel-filtered flat search with a bounded result count", () => {
    const args = buildYouTubeSearchArgs("dan bongino & co");
    expect(args).toContain("--flat-playlist");
    expect(args).toContain("1-12");
    const url = new URL(args[args.length - 1]);
    expect(url.hostname).toBe("www.youtube.com");
    expect(url.searchParams.get("search_query")).toBe("dan bongino & co");
    expect(url.searchParams.get("sp")).toBe("EgIQAg==");
  });

  it("maps search entries into result rows with https avatars", () => {
    const results = parseYouTubeSearchPayload(youtubeFixture);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results[0]).toMatchObject({
      platform: "youtube",
      id: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
      displayName: "PewDiePie",
      handle: "pewdiepie",
      channelUrl: "https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw",
      followerCount: 109_000_000,
      verified: true,
      youtubeChannelId: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
      savedCreatorId: null,
    });
    expect(results[0].avatarUrl).toMatch(/^https:\/\/yt3\.ggpht\.com\/.+s176/);
    expect(results[1].verified).toBe(false);
  });

  it("skips non-channel entries and duplicates", () => {
    const results = parseYouTubeSearchPayload({
      entries: [
        { id: "dQw4w9WgXcQ", title: "A video", ie_key: "Youtube" },
        { id: "UC-lHJZR3Gqxm24_Vd_AJ5Yw", title: "PewDiePie" },
        { id: "UC-lHJZR3Gqxm24_Vd_AJ5Yw", title: "PewDiePie again" },
        { id: "UCQ4zIVlfhsmvds7WuKeL2Bw" },
        "garbage",
      ],
    });
    expect(results.map((result) => result.displayName)).toEqual(["PewDiePie"]);
    expect(parseYouTubeSearchPayload(null)).toEqual([]);
  });

  it("maps yt-dlp failures to user-safe errors", async () => {
    const missing = await searchYouTubeChannels("x", {
      run: async () => ({ ok: false, kind: "missing_executable", stderrTail: "" }),
    });
    expect(missing).toMatchObject({ ok: false, error: { code: "ytdlp_missing" } });
    const timeout = await searchYouTubeChannels("x", {
      run: async () => ({ ok: false, kind: "timeout", stderrTail: "" }),
    });
    expect(timeout).toMatchObject({ ok: false, error: { code: "timeout" } });
    const network = await searchYouTubeChannels("x", {
      run: async () => ({
        ok: false,
        kind: "nonzero_exit",
        stderrTail: "ERROR: getaddrinfo failed /home/me",
      }),
    });
    expect(network).toMatchObject({ ok: false, error: { code: "network" } });
    expect(JSON.stringify(network)).not.toContain("/home/me");
    const garbage = await searchYouTubeChannels("x", {
      run: async () => ({ ok: true, stdout: "not json", stderr: "" }),
    });
    expect(garbage).toMatchObject({ ok: false, error: { code: "unexpected_response" } });
    const ok = await searchYouTubeChannels("pewdiepie", {
      run: async () => ({ ok: true, stdout: JSON.stringify(youtubeFixture), stderr: "" }),
    });
    expect(ok.ok && ok.results[0].displayName).toBe("PewDiePie");
  });
});

describe("Rumble channel search parsing", () => {
  it("reads name, slug, followers, verified badge, bio, and avatar", () => {
    const parsed = parseRumbleChannelSearch(rumbleFixture);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.results).toHaveLength(8);
    expect(parsed.results[0]).toMatchObject({
      platform: "rumble",
      id: "c/bongino",
      displayName: "The Dan Bongino Show",
      handle: "bongino",
      channelUrl: "https://rumble.com/c/bongino",
      verified: true,
      avatarUrl: "https://hugh.cdn.rumble.cloud/video/z8/U/K/d/b/UKdba.baa.4-bongino-t8rqq7.jpeg",
    });
    expect(parsed.results[0].followerCount).toBeGreaterThan(3_000_000);
    expect(parsed.results[0].description).toMatch(/^The official channel/);
    expect(parsed.results[1]).toMatchObject({
      id: "user/bonginoreport",
      channelUrl: "https://rumble.com/user/BonginoReport",
    });
    // Rumble sometimes prints a singular "Follower" label; counts still parse.
    const magroins = parsed.results.find((result) => result.id === "c/bonginoarmymagroins");
    expect(magroins).toMatchObject({ verified: true, followerCount: 1_787 });
    // Numeric slugs (c-1234567) are kept, and unverified channels say so.
    expect(parsed.results.find((result) => result.id === "c/c-7087445")).toMatchObject({
      verified: false,
      handle: "c-7087445",
      channelUrl: "https://rumble.com/c/c-7087445",
    });
  });

  it("treats Rumble's empty-state page as no results", () => {
    expect(parseRumbleChannelSearch(rumbleEmptyFixture)).toEqual({ ok: true, results: [] });
  });

  it("does not report a blocked or unrelated page as an empty search", () => {
    const challenge = "<html><head><title>Just a moment...</title></head><body></body></html>";
    expect(parseRumbleChannelSearch(challenge)).toEqual({ ok: false, reason: "unrecognized_page" });
  });

  it("drops avatars from hosts outside the image allowlist and decodes entities", () => {
    const html = `<style>i.user-image--img--id-0 { background-image: url(https://evil.example/a.png); }</style>
      <main><a href="/search/channel?q=x">Channels</a>
      <article class="flex"><a href="/c/Tom_s-Show?e9s=1"><i class='user-image user-image--img--id-0'></i></a>
      <h3><span class="block truncate">Tom&#39;s &amp; Jerry&apos;s</span></h3>
      <span>1.2K&nbsp; Followers</span></article></main>`;
    const parsed = parseRumbleChannelSearch(html);
    expect(parsed.ok && parsed.results[0]).toMatchObject({
      displayName: "Tom's & Jerry's",
      avatarUrl: null,
      followerCount: 1_200,
      handle: "tom_s-show",
      description: null,
    });
  });
});

describe("Rumble channel search fetching", () => {
  it("uses the desktop broker when it is configured", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ query: "bongino" });
      expect((init?.headers as Record<string, string>)["x-scope-rumble-search"]).toBe("secret");
      return Response.json({ ok: true, html: rumbleFixture });
    });
    const outcome = await searchRumbleChannels("bongino", {
      brokerOrigin: "http://127.0.0.1:4567",
      brokerToken: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4567/", expect.anything());
    expect(outcome.ok && outcome.results[0].displayName).toBe("The Dan Bongino Show");
  });

  it("maps broker failures and refuses non-loopback broker origins", async () => {
    const throttled = await searchRumbleChannels("bongino", {
      brokerOrigin: "http://127.0.0.1:4567",
      brokerToken: "secret",
      fetchImpl: (async () =>
        Response.json({ ok: false, error: { code: "throttled" } })) as unknown as typeof fetch,
    });
    expect(throttled).toMatchObject({ ok: false, error: { code: "throttled" } });
    const remote = await fetchRumbleChannelSearch("bongino", {
      brokerOrigin: "http://example.com:4567",
      brokerToken: "secret",
    });
    expect(remote).toEqual({ ok: false, reason: "network" });
  });

  it("reports desktop_required when the web fallback is refused by Rumble's edge", async () => {
    const outcome = await searchRumbleChannels("bongino", {
      brokerOrigin: null,
      brokerToken: null,
      fetchPage: async () => ({ ok: false, reason: "throttled" }),
    });
    expect(outcome).toMatchObject({ ok: false, error: { code: "desktop_required" } });
    const fallback = await searchRumbleChannels("bongino", {
      brokerOrigin: null,
      brokerToken: null,
      fetchPage: async () => ({
        ok: true,
        body: rumbleEmptyFixture,
        finalUrl: "https://rumble.com/",
      }),
    });
    expect(fallback).toEqual({ ok: true, results: [] });
  });
});

describe("X people search", () => {
  beforeAll(() => {
    process.env.SCOPE_X_FAKE_PROVIDER = "1";
    resetXProvider();
  });
  afterAll(() => {
    delete process.env.SCOPE_X_FAKE_PROVIDER;
    resetXProvider();
  });
  afterEach(() => vi.restoreAllMocks());

  it("normalizes worker search payloads and skips unusable users", () => {
    expect(
      mapXUserSearch({
        users: [
          { userId: "1", handle: "real", displayName: "Real", verified: true },
          { userId: "1", handle: "real", displayName: "Duplicate" },
          { userId: "2", handle: "bad handle", displayName: "Bad" },
          { handle: "no_id" },
          { userId: "3", handle: "locked", protected: true },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ userId: "1", handle: "real", verified: true, protected: false }),
      expect.objectContaining({
        userId: "3",
        handle: "locked",
        displayName: "locked",
        protected: true,
      }),
    ]);
    expect(() => mapXUserSearch({})).toThrow(XProviderError);
  });

  it("requires a connected session", async () => {
    await disconnectX();
    const outcome = await searchXUsers("pewdiepie");
    expect(outcome).toMatchObject({ ok: false, error: { code: "not_connected" } });
  });

  it("returns the provider's ranked accounts", async () => {
    await connectX();
    const outcome = await searchXUsers("PewDiePie");
    expect(outcome.ok && outcome.users.map((user) => user.handle)).toEqual([
      "pewdiepie",
      "pewdiepie_clips",
      "the_pewdiepie",
    ]);
  });

  function stubProvider(overrides: Partial<XProvider>): XProvider {
    return {
      id: "stub",
      canConnect: false,
      status: vi.fn(),
      resolveUser: vi.fn(async (handle: string) => ({
        user: { userId: "42", handle, displayName: "Exact", avatarUrl: null },
        pinnedTweetId: null,
      })),
      searchUsers: vi.fn(async () => []),
      listUserTweets: vi.fn(),
      getTweet: vi.fn(),
      ...overrides,
    } as XProvider;
  }

  it("falls back to an exact handle lookup when the people search finds nothing", async () => {
    const provider = stubProvider({});
    vi.spyOn(providers, "getXProvider").mockReturnValue(provider);
    const outcome = await searchXUsers("pewdiepie");
    expect(provider.resolveUser).toHaveBeenCalledWith("pewdiepie", undefined);
    expect(outcome.ok && outcome.users).toEqual([
      expect.objectContaining({ userId: "42", handle: "pewdiepie", verified: false }),
    ]);
  });

  it("falls back when the people search response is unreadable, but not on rate limits", async () => {
    const broken = stubProvider({
      searchUsers: vi.fn(async () => {
        throw new XProviderError("invalid_response");
      }),
    });
    vi.spyOn(providers, "getXProvider").mockReturnValue(broken);
    expect((await searchXUsers("@pewdiepie")).ok).toBe(true);
    expect(broken.resolveUser).toHaveBeenCalledWith("pewdiepie", undefined);

    const limited = stubProvider({
      searchUsers: vi.fn(async () => {
        throw new XProviderError("rate_limited", undefined, 30);
      }),
    });
    vi.spyOn(providers, "getXProvider").mockReturnValue(limited);
    expect(await searchXUsers("pewdiepie")).toMatchObject({
      ok: false,
      error: { code: "rate_limited", retryAfterSeconds: 30 },
    });
    expect(limited.resolveUser).not.toHaveBeenCalled();
  });

  it("does not look up names that cannot be handles, and treats a missing handle as no results", async () => {
    const provider = stubProvider({
      resolveUser: vi.fn(async () => {
        throw new XProviderError("not_found");
      }),
    });
    vi.spyOn(providers, "getXProvider").mockReturnValue(provider);
    expect(await searchXUsers("dan bongino")).toEqual({ ok: true, users: [] });
    expect(provider.resolveUser).not.toHaveBeenCalled();
    expect(await searchXUsers("nobody_here")).toEqual({ ok: true, users: [] });
  });
});

describe("searchCreators", () => {
  const tempDirs: string[] = [];
  let db: ScopeDatabase;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(tmpdir(), "scope-creator-search-"));
    tempDirs.push(dir);
    db = new Database(path.join(dir, "test.db"));
    db.pragma("foreign_keys = ON");
    runMigrations(db, ALL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function result(overrides: Partial<CreatorSearchResult>): CreatorSearchResult {
    return {
      platform: "youtube",
      id: "id",
      displayName: "Name",
      handle: null,
      channelUrl: "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx",
      avatarUrl: null,
      followerCount: null,
      verified: false,
      protectedAccount: false,
      description: null,
      youtubeChannelId: null,
      platformUserId: null,
      savedCreatorId: null,
      ...overrides,
    };
  }

  it("rejects empty queries before searching", async () => {
    const youtube = vi.fn();
    const outcome = await searchCreators(db, "youtube", "   ", { deps: { youtube } });
    expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_query" } });
    expect(youtube).not.toHaveBeenCalled();
  });

  it("marks results that are already saved in the library", async () => {
    const youtubeSaved = addCreator(db, {
      youtubeChannelId: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
      handle: "pewdiepie",
      displayName: "PewDiePie",
      channelUrl: "https://www.youtube.com/channel/UC-lHJZR3Gqxm24_Vd_AJ5Yw",
      avatarUrl: null,
      platform: "youtube",
    }).creator;
    const rumbleSaved = addCreator(db, {
      youtubeChannelId: null,
      handle: "bongino",
      displayName: "Bongino",
      channelUrl: "https://rumble.com/c/Bongino",
      avatarUrl: null,
      platform: "rumble",
    }).creator;

    const youtube = await searchCreators(db, "youtube", "pewdiepie", {
      deps: {
        youtube: async () => ({
          ok: true,
          results: [
            result({
              id: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
              youtubeChannelId: "UC-lHJZR3Gqxm24_Vd_AJ5Yw",
            }),
            result({
              id: "UCQ4zIVlfhsmvds7WuKeL2Bw",
              youtubeChannelId: "UCQ4zIVlfhsmvds7WuKeL2Bw",
            }),
          ],
        }),
      },
    });
    expect(youtube.ok && youtube.results.map((row) => row.savedCreatorId)).toEqual([
      youtubeSaved.id,
      null,
    ]);

    const rumble = await searchCreators(db, "rumble", "bongino", {
      deps: {
        rumble: async () => ({
          ok: true,
          results: [
            result({
              platform: "rumble",
              id: "c/bongino",
              channelUrl: "https://rumble.com/c/bongino",
            }),
          ],
        }),
      },
    });
    expect(rumble.ok && rumble.results[0].savedCreatorId).toBe(rumbleSaved.id);
  });

  it("maps X accounts into rows and passes connection errors through", async () => {
    const found = await searchCreators(db, "x", "pewdiepie", {
      deps: {
        x: async () => ({
          ok: true,
          users: [
            {
              userId: "123",
              handle: "PewDiePie",
              displayName: "PewDiePie",
              avatarUrl: null,
              description: "bio",
              verified: true,
              protected: false,
            },
          ],
        }),
      },
    });
    expect(found.ok && found.results[0]).toMatchObject({
      platform: "x",
      id: "123",
      channelUrl: "https://x.com/PewDiePie",
      platformUserId: "123",
      verified: true,
      protectedAccount: false,
      description: "bio",
    });

    const disconnected = await searchCreators(db, "x", "pewdiepie", {
      deps: {
        x: async () => ({
          ok: false,
          error: { code: "not_connected", message: "X is not connected.", retryAfterSeconds: null },
        }),
      },
    });
    expect(disconnected).toMatchObject({ ok: false, error: { code: "not_connected" } });
  });
});
