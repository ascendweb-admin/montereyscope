import { describe, expect, it } from "vitest";

import {
  parseRumbleUrl,
  slugFromPathSegment,
  rumbleVideoUrlFromSlug,
  rumbleChannelUrlFromSlug,
} from "@/lib/rumble/urls";

describe("parseRumbleUrl — video links", () => {
  it("accepts the full video page form with the descriptive tail", () => {
    const outcome = parseRumbleUrl(
      "https://www.rumble.com/v7emyxa-warning-this-new-flu-shot-can-accelerate-aging.html",
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toEqual({ kind: "video", slug: "v7emyxa" });
    }
  });

  it("accepts the bare video form without a tail", () => {
    const outcome = parseRumbleUrl("https://rumble.com/v7emyxa");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toEqual({ kind: "video", slug: "v7emyxa" });
    }
  });

  it("accepts the tail without the .html extension", () => {
    const outcome = parseRumbleUrl("https://rumble.com/v2o2oe5-synthwave-radio.html");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toEqual({ kind: "video", slug: "v2o2oe5" });
    }
  });

  it("ignores tracking params appended by share links", () => {
    const outcome = parseRumbleUrl(
      "https://rumble.com/v7emyxa-warning-this-new-flu-shot.html?e9s=src_v1_cllr&u=abc",
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toEqual({ kind: "video", slug: "v7emyxa" });
    }
  });
});

describe("parseRumbleUrl — channel links", () => {
  it("accepts /c/ channel pages", () => {
    const outcome = parseRumbleUrl("https://rumble.com/c/Redacted");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toEqual({ kind: "channel", slug: "Redacted", prefix: "c" });
    }
  });

  it("accepts /user/ channel pages", () => {
    const outcome = parseRumbleUrl("https://www.rumble.com/user/goldenpoodleharleyeuna");
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.target).toEqual({ kind: "channel", slug: "goldenpoodleharleyeuna", prefix: "user" });
    }
  });

  it("rejects channel links with extra path segments", () => {
    const outcome = parseRumbleUrl("https://rumble.com/c/Redacted/videos");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toContain("Channel links must look like");
    }
  });
});

describe("parseRumbleUrl — rejections", () => {
  const rejected: ReadonlyArray<[string, RegExp]> = [
    ["", /Paste a Rumble link first/],
    ["not a url at all", /does not look like a complete URL/],
    ["http://rumble.com/v7emyxa", /secure HTTPS Rumble links/],
    ["ftp://rumble.com/v7emyxa", /links are not supported/],
    ["https://youtube.com/@mkbhd", /not a Rumble address/],
    ["https://rumble.com", /Rumble home page/],
    ["https://rumble.com/search/video?q=x", /listing page/],
    ["https://rumble.com/browse/all", /listing page/],
    ["https://rumble.com/videos", /listing page/],
    ["https://rumble.com/embed/v7cglzs", /embedded player link/],
    ["https://rumble.com/vfoo-bar.html", /looks malformed|not look like a Rumble video/],
  ];
  for (const [input, messagePattern] of rejected) {
    it(`rejects: ${input === "" ? "(empty)" : input}`, () => {
      const outcome = parseRumbleUrl(input);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.message).toMatch(messagePattern);
      }
    });
  }
});

describe("slugFromPathSegment", () => {
  it("extracts the slug from full page segments", () => {
    expect(slugFromPathSegment("v7emyxa-warning-this-new-flu-shot.html")).toBe("v7emyxa");
  });

  it("returns null for non-video segments", () => {
    expect(slugFromPathSegment("videos")).toBeNull();
    expect(slugFromPathSegment("c")).toBeNull();
    expect(slugFromPathSegment("")).toBeNull();
  });
});

describe("canonical URL builders", () => {
  it("builds the canonical video URL", () => {
    expect(rumbleVideoUrlFromSlug("v7emyxa")).toBe("https://rumble.com/v7emyxa");
  });

  it("builds the canonical channel URL", () => {
    expect(rumbleChannelUrlFromSlug("Redacted")).toBe("https://rumble.com/c/Redacted");
  });
});
