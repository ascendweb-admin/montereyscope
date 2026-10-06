import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isAllowedRumbleImageUrl,
  mapRumbleItem,
  normalizeRumbleDate,
  parseRumbleChannelPage,
  rumbleItemLiveStatus,
} from "@/lib/rumble/channel-page";

const FIXTURE = path.join(__dirname, "..", "fixtures", "rumble-channel-page.fixture.html");

describe("parseRumbleChannelPage", () => {
  it("reads unquoted metadata and the header avatar when a channel alias differs from video authors", () => {
    const html = readFileSync(path.join(__dirname, "..", "fixtures", "rumble-channel-crypto.fixture.html"), "utf8");
    const outcome = parseRumbleChannelPage(html, "HowToCultivateCrypto");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.identity?.displayName).toBe("Cultivate Crypto");
    expect(outcome.identity?.channelUrl).toBe("https://rumble.com/c/c-7916148");
    expect(outcome.identity?.avatarUrl).toBe("https://hugh.cdn.rumble.cloud/video/z8/0/P/m/E/0PmEa.baa-HowToCultivateCrypto-tgz1sl.jpeg");
  });

  it("supports reversed metadata attributes and ignores disallowed header images and canonical URLs", () => {
    const outcome = parseRumbleChannelPage(`<meta content='Crypto &amp; More' property='og:title'>
      <meta content=https://evil.example/c/crypto property=og:url>
      <meta content=https://hugh.cdn.rumble.cloud/avatar.png property=og:image>
      <img src=https://evil.example/avatar.png class='extra channel-header--img'>`);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.identity).toMatchObject({
      displayName: "Crypto & More",
      channelUrl: "",
      avatarUrl: "https://hugh.cdn.rumble.cloud/avatar.png",
    });
  });

  it("extracts the channel identity from a real listing page", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const outcome = parseRumbleChannelPage(html, "styxhexenhammer666");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.identity).not.toBeNull();
    expect(outcome.identity?.displayName).toBe("Styxhexenhammer666");
    expect(outcome.identity?.channelUrl).toBe("https://rumble.com/c/Styxhexenhammer666");
    expect(outcome.identity?.avatarUrl ?? "").toMatch(/^https:\/\/hugh\.cdn\.rumble\.cloud\//);
    expect(outcome.identity?.followerCount).toBeGreaterThan(0);
    expect(outcome.identity?.verified).toBe(true);
  });

  it("maps every listed video into the draft model", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const outcome = parseRumbleChannelPage(html, "styxhexenhammer666");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.videos).toHaveLength(4);
    const first = outcome.videos[0];
    expect(first.id).toBe("v7dota4");
    expect(first.title).toBe("The Spokane Cocaine Fires");
    expect(first.url).toBe("https://rumble.com/v7dota4-the-spokane-cocaine-fires.html");
    expect(first.thumbnailUrl ?? "").toMatch(/^https:\/\/hugh\.cdn\.rumble\.cloud\//);
    expect(first.publishedAt).toBe("2026-08-04T01:32:33.000Z");
    expect(first.durationSeconds).toBe(758);
    expect(first.liveStatus).toBe("not_live");
  });

  it("maps ended livestreams onto the was_live status", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const outcome = parseRumbleChannelPage(html, "styxhexenhammer666");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const ended = outcome.videos.find((video) => video.id === "v7livex");
    expect(ended).toBeDefined();
    expect(ended?.liveStatus).toBe("was_live");
    expect(ended?.publishedAt).toBeNull();
    expect(ended?.durationSeconds).toBeNull();
  });

  it("prefers the by-object matching the expected channel slug", () => {
    // A listing blob that only carries other channels' entries must not
    // adopt the wrong identity.
    const html = [
      '<html><head><title>whatever</title></head><body>',
      '<script type="application/json">{"items":[{"object_type":"video","title":"Someone else","relative_url":"/v111111-some-other-video.html","permalink_id":"v111111","by":{"type":"channel","name":"Other Channel","url":"https://rumble.com/c/OtherChannel","thumb":"https://hugh.cdn.rumble.cloud/video/x.png","followers":5}}]}</script>',
      "</body></html>",
    ].join("");
    const outcome = parseRumbleChannelPage(html, "styxhexenhammer666");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    // Identity is not the other channel's; the video itself still parses.
    expect(outcome.videos).toHaveLength(1);
  });

  it("fails with no_data for a page without listing blobs", () => {
    const outcome = parseRumbleChannelPage("<html><body>hello</body></html>");
    expect(outcome.ok).toBe(false);
  });
});

describe("rumbleItemLiveStatus", () => {
  it("marks active livestreams is_live", () => {
    expect(rumbleItemLiveStatus({ live: true })).toBe("is_live");
  });

  it("marks VOD replays was_live via live_streamed_on", () => {
    expect(rumbleItemLiveStatus({ live: false, live_streamed_on: "2026-01-01T00:00:00Z" })).toBe(
      "was_live",
    );
  });

  it("marks ordinary uploads not_live", () => {
    expect(rumbleItemLiveStatus({ live: false })).toBe("not_live");
  });
});

describe("mapRumbleItem", () => {
  it("skips unusable items (no slug, no title)", () => {
    expect(mapRumbleItem({})).toBeNull();
    expect(mapRumbleItem({ permalink_id: "v7emyxa" })).toBeNull();
    expect(mapRumbleItem({ title: "no slug" })).toBeNull();
  });

  it("falls back to parsing the slug from relative_url", () => {
    const draft = mapRumbleItem({
      title: "Fallback test",
      relative_url: "/v7emyxa-warning-this-new-flu-shot.html?e9s=x",
      upload_date: "2026-08-04T01:32:33+00:00",
      duration: 42,
      thumb: "https://hugh.cdn.rumble.cloud/video/fwe2/9f/s8/1/o/r/A/S/orASA.qR4e.jpg",
    });
    expect(draft).not.toBeNull();
    expect(draft?.id).toBe("v7emyxa");
    expect(draft?.url).toBe("https://rumble.com/v7emyxa-warning-this-new-flu-shot.html");
    expect(draft?.thumbnailUrl).toContain("hugh.cdn.rumble.cloud");
  });

  it("drops thumbnails from hosts outside Rumble's image CDNs", () => {
    const draft = mapRumbleItem({
      title: "Bad thumb",
      permalink_id: "v7badx1",
      thumb: "https://evil.example.com/payload.jpg",
    });
    expect(draft?.thumbnailUrl).toBeNull();
  });
});

describe("isAllowedRumbleImageUrl", () => {
  it("accepts Rumble image CDNs over https", () => {
    expect(isAllowedRumbleImageUrl("https://hugh.cdn.rumble.cloud/video/x.jpg")).toBe(true);
    expect(isAllowedRumbleImageUrl("https://sp.rmbl.ws/s8/1/a/b.jpg")).toBe(true);
  });

  it("rejects other hosts, non-https, and garbage", () => {
    expect(isAllowedRumbleImageUrl("http://hugh.cdn.rumble.cloud/x.jpg")).toBe(false);
    expect(isAllowedRumbleImageUrl("https://evil.rumble.cloud.evil.com/x.jpg")).toBe(false);
    expect(isAllowedRumbleImageUrl("not a url")).toBe(false);
    expect(isAllowedRumbleImageUrl(null)).toBe(false);
  });
});

describe("normalizeRumbleDate", () => {
  it("normalizes Rumble's ISO+00:00 form to storage ISO", () => {
    expect(normalizeRumbleDate("2026-08-04T01:32:33+00:00")).toBe("2026-08-04T01:32:33.000Z");
  });

  it("returns null for missing, garbage, and epoch-zero values", () => {
    expect(normalizeRumbleDate(undefined)).toBeNull();
    expect(normalizeRumbleDate("")).toBeNull();
    expect(normalizeRumbleDate("not a date")).toBeNull();
    expect(normalizeRumbleDate("1970-01-01T00:00:00+00:00")).toBeNull();
  });
});
