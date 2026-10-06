import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as GET_AVATAR } from "@/app/api/creators/[id]/avatar/route";
import { localAvatarSrc } from "@/lib/creators/avatar";
import { addCreator } from "@/lib/creators/repository";
import { closeDatabase, getDb } from "@/lib/db/connection";
import type { XTweetDraft } from "@/lib/x/model";
import { linkCreatorTweet, upsertTweet } from "@/lib/x/repository";

/**
 * The avatar proxy route: streams a stored, allowlisted URL through the
 * local origin (so browsers never make a third-party request for avatars);
 * anything missing, disallowed, or failing upstream is a plain 404 an
 * <img> tag can live with.
 */

const ALLOWED_URL = "https://yt3.googleusercontent.com/example-avatar=s900-c-k-c0x00ffffff-no-rj";
const AUTHOR_AVATAR_URL = "https://pbs.twimg.com/profile_images/1234567890/author_normal.jpg";
const UNKNOWN_AVATAR_URL = "https://pbs.twimg.com/profile_images/9999999999/nobody_normal.jpg";
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

const CREATOR = {
  youtubeChannelId: "UCX6OQ3DkcsbYNE6H8uQQuVA",
  handle: "samplecreator",
  displayName: "Sample Creator",
  channelUrl: "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
  avatarUrl: ALLOWED_URL,
};

const REPOST_TWEET_ID = "1234567890123456789";

function repostDraft(): XTweetDraft {
  return {
    id: REPOST_TWEET_ID,
    author: {
      userId: "987654321",
      handle: "retweetedauthor",
      displayName: "Retweeted Author",
      avatarUrl: AUTHOR_AVATAR_URL,
    },
    text: "A post the saved creator reposted.",
    language: "en",
    publishedAt: "2026-09-15T10:00:00.000Z",
    url: `https://x.com/retweetedauthor/status/${REPOST_TWEET_ID}`,
    replyCount: null,
    repostCount: null,
    likeCount: null,
    quoteCount: null,
    contentStatus: "complete",
    isRepost: true,
    repostedByUserId: "555555555",
    repostedByHandle: "samplecreator",
    conversationId: null,
    inReplyToTweetId: null,
    inReplyToUserId: null,
    inReplyToHandle: null,
    quoted: null,
    media: [],
  };
}

function cacheRepost(creatorId: number, avatarUrl = AUTHOR_AVATAR_URL): void {
  const draft = repostDraft();
  upsertTweet(getDb(), { ...draft, author: { ...draft.author, avatarUrl } });
  linkCreatorTweet(getDb(), {
    creatorId,
    tweetId: draft.id,
    timelineKind: "repost",
    timelineAt: null,
  });
}

function routeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function requestFor(id: string, avatarUrl?: string): Request {
  const pathname =
    avatarUrl === undefined ? `/api/creators/${id}/avatar` : localAvatarSrc(avatarUrl, Number(id));
  return new Request(`http://127.0.0.1:3000${pathname}`);
}

function upstreamResponse(
  init: {
    status?: number;
    contentType?: string | null;
    contentLength?: string;
    body?: BodyInit | null;
  } = {},
): Response {
  const headers = new Headers();
  if (init.contentType !== null) {
    headers.set("content-type", init.contentType ?? "image/png");
  }
  if (init.contentLength !== undefined) {
    headers.set("content-length", init.contentLength);
  }
  return new Response(init.body ?? PNG_BYTES, { status: init.status ?? 200, headers });
}

let workDir = "";

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "localtube-avatar-route-"));
  process.env.LOCALTUBE_DB_PATH = path.join(workDir, "localtube.db");
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(workDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("GET /api/creators/[id]/avatar", () => {
  it("streams the stored avatar through with image headers and a long cache", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    fetchMock.mockResolvedValue(upstreamResponse({}));

    const response = await GET_AVATAR(
      requestFor(String(creator.id), ALLOWED_URL),
      routeCtx(String(creator.id)),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age=604800");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ALLOWED_URL);
  });

  it("does not cache legacy ID-only URLs", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    fetchMock.mockResolvedValue(upstreamResponse());
    const id = String(creator.id);
    const response = await GET_AVATAR(requestFor(id), routeCtx(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("separates cached images when the same local ID gets a different avatar", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    const id = String(creator.id);
    const oldRequest = requestFor(id, ALLOWED_URL);
    const replacementUrl = "https://yt3.googleusercontent.com/another-creator=s900?x=1&y=2";
    getDb()
      .prepare("UPDATE creators SET avatar_url = ? WHERE id = ?")
      .run(replacementUrl, creator.id);
    const newRequest = requestFor(id, replacementUrl);
    expect(newRequest.url).not.toBe(oldRequest.url);

    const staleResponse = await GET_AVATAR(oldRequest, routeCtx(id));
    expect(staleResponse.status).toBe(404);
    expect(staleResponse.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(upstreamResponse());
    expect((await GET_AVATAR(newRequest, routeCtx(id))).status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe(replacementUrl);
  });

  it("streams a retweeted author's avatar for the creator that reposted them", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    cacheRepost(creator.id);
    fetchMock.mockResolvedValue(upstreamResponse());

    const id = String(creator.id);
    const response = await GET_AVATAR(requestFor(id, AUTHOR_AVATAR_URL), routeCtx(id));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("max-age=604800");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(AUTHOR_AVATAR_URL);
  });

  it("404s for an author avatar that is not cached on that creator's timeline", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    cacheRepost(creator.id);
    const id = String(creator.id);

    expect((await GET_AVATAR(requestFor(id, UNKNOWN_AVATAR_URL), routeCtx(id))).status).toBe(404);

    const other = addCreator(getDb(), {
      ...CREATOR,
      youtubeChannelId: "UCBJycsmduvYEL83R_U4JriQ",
      handle: "othercreator",
      channelUrl: "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ",
    });
    const otherId = String(other.creator.id);
    expect(
      (await GET_AVATAR(requestFor(otherId, AUTHOR_AVATAR_URL), routeCtx(otherId))).status,
    ).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never fetches a stored author avatar outside the allowlisted CDNs", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    const disallowedUrl = "https://evil.example/avatar.png";
    cacheRepost(creator.id, disallowedUrl);

    const id = String(creator.id);
    const response = await GET_AVATAR(requestFor(id, disallowedUrl), routeCtx(id));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves direct previews and missing-avatar fallbacks", () => {
    expect(localAvatarSrc(ALLOWED_URL)).toBe(ALLOWED_URL);
    expect(localAvatarSrc(ALLOWED_URL, null)).toBe(ALLOWED_URL);
    expect(localAvatarSrc(null, 1)).toBeNull();
  });

  it("404s without fetching for creators without a stored avatar", async () => {
    const { creator } = addCreator(getDb(), { ...CREATOR, avatarUrl: null });

    const response = await GET_AVATAR(requestFor(String(creator.id)), routeCtx(String(creator.id)));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s without fetching when the stored URL points at a non-CDN host", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    // Overwrite behind the write-path sanitizer to simulate a corrupt row.
    getDb()
      .prepare("UPDATE creators SET avatar_url = ? WHERE id = ?")
      .run("https://evil.example/avatar.png", creator.id);

    const response = await GET_AVATAR(requestFor(String(creator.id)), routeCtx(String(creator.id)));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s for unknown and malformed ids", async () => {
    addCreator(getDb(), CREATOR);

    expect((await GET_AVATAR(requestFor("424242"), routeCtx("424242"))).status).toBe(404);
    expect((await GET_AVATAR(requestFor("abc"), routeCtx("abc"))).status).toBe(404);
    expect((await GET_AVATAR(requestFor("0"), routeCtx("0"))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("404s when the upstream fetch fails or answers with a non-image", async () => {
    const { creator } = addCreator(getDb(), CREATOR);
    const id = String(creator.id);

    fetchMock.mockRejectedValue(new Error("offline"));
    expect((await GET_AVATAR(requestFor(id), routeCtx(id))).status).toBe(404);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(upstreamResponse({ status: 404, body: "nope" }));
    expect((await GET_AVATAR(requestFor(id), routeCtx(id))).status).toBe(404);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      upstreamResponse({ contentType: "text/html", body: "<html></html>" }),
    );
    expect((await GET_AVATAR(requestFor(id), routeCtx(id))).status).toBe(404);
  });
});
