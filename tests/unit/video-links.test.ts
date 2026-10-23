import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  extractVideoLinks,
  looksLikeVideoLink,
  parseVideoLink,
  videoLinkId,
} from "@/lib/videos/import/links";

const ID = "jNQXAC9IVRw";
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

describe("parseVideoLink: YouTube forms", () => {
  const accepted: Array<[string, string]> = [
    ["watch", `https://www.youtube.com/watch?v=${ID}`],
    ["bare host", `https://youtube.com/watch?v=${ID}`],
    ["mobile", `https://m.youtube.com/watch?v=${ID}`],
    ["short link", `https://youtu.be/${ID}`],
    ["shorts", `https://www.youtube.com/shorts/${ID}`],
    ["live", `https://www.youtube.com/live/${ID}`],
    ["embed", `https://www.youtube.com/embed/${ID}`],
    ["legacy /v/", `https://www.youtube.com/v/${ID}`],
    ["trailing slash", `https://youtu.be/${ID}/`],
    ["surrounding whitespace", `  https://youtu.be/${ID}\n`],
    ["uppercase host", `https://WWW.YouTube.com/watch?v=${ID}`],
    ["tracking params", `https://youtu.be/${ID}?si=abcDEF123&feature=share`],
    ["timestamp", `https://www.youtube.com/watch?v=${ID}&t=42s`],
    ["playlist context ignored", `https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=4`],
    ["v param after others", `https://www.youtube.com/watch?feature=share&v=${ID}`],
  ];

  it.each(accepted)("%s", (_name, input) => {
    expect(parseVideoLink(input)).toEqual({
      ok: true,
      link: { platform: "youtube", id: ID, url: CANONICAL },
    });
  });

  it("keeps ids with dashes and underscores intact", () => {
    const result = parseVideoLink("https://youtu.be/a-b_c-d_e-f");
    expect(result.ok && result.link).toEqual({
      platform: "youtube",
      id: "a-b_c-d_e-f",
      url: "https://www.youtube.com/watch?v=a-b_c-d_e-f",
    });
  });
});

describe("parseVideoLink: rejections", () => {
  const rejected: Array<[string, string, string, RegExp]> = [
    ["empty input", "   ", "invalid_link", /Paste a video link/],
    ["not a url", "youtu.be/jNQXAC9IVRw", "invalid_link", /complete link/],
    ["plain http", `http://www.youtube.com/watch?v=${ID}`, "invalid_link", /HTTPS/],
    ["other protocol", `ftp://www.youtube.com/watch?v=${ID}`, "invalid_link", /https/],
    ["credentials", `https://user:pass@www.youtube.com/watch?v=${ID}`, "invalid_link", /usernames/],
    [
      "look-alike host",
      `https://youtube.com.evil.test/watch?v=${ID}`,
      "unsupported_site",
      /YouTube and Rumble/,
    ],
    [
      "host with youtube as userinfo",
      `https://www.youtube.com@evil.test/watch?v=${ID}`,
      "invalid_link",
      /usernames/,
    ],
    ["suffix look-alike", `https://notyoutube.com/watch?v=${ID}`, "unsupported_site", /YouTube/],
    ["music subdomain", `https://music.youtube.com/watch?v=${ID}`, "unsupported_site", /YouTube/],
    ["other site", "https://vimeo.com/123456789", "unsupported_site", /YouTube and Rumble/],
    ["channel handle", "https://www.youtube.com/@pbdpodcast", "invalid_link", /channel link/],
    [
      "channel id",
      "https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A",
      "invalid_link",
      /channel link/,
    ],
    ["legacy channel", "https://www.youtube.com/c/Name", "invalid_link", /channel link/],
    ["playlist", "https://www.youtube.com/playlist?list=PLabc123", "invalid_link", /playlist/],
    ["home page", "https://www.youtube.com/", "invalid_link", /home page/],
    ["short host home", "https://youtu.be/", "invalid_link", /not a video link/],
    [
      "results page",
      "https://www.youtube.com/results?search_query=x",
      "invalid_link",
      /not a single video/,
    ],
    ["watch without v", "https://www.youtube.com/watch", "invalid_link", /incomplete/],
    ["watch with short id", "https://www.youtube.com/watch?v=abc", "invalid_link", /incomplete/],
    ["id with bad characters", "https://youtu.be/jNQXAC9IV!w", "invalid_link", /incomplete/],
    ["id too long", "https://youtu.be/jNQXAC9IVRwx", "invalid_link", /incomplete/],
    ["shorts without id", "https://www.youtube.com/shorts/", "invalid_link", /not a single video/],
    [
      "short link with extra path",
      `https://youtu.be/${ID}/more`,
      "invalid_link",
      /not a single video/,
    ],
  ];

  it.each(rejected)("%s", (_name, input, code, message) => {
    const result = parseVideoLink(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(code);
      expect(result.message).toMatch(message);
    }
  });
});

describe("parseVideoLink: Rumble", () => {
  it.each([
    "https://rumble.com/v7emyxa",
    "https://www.rumble.com/v7emyxa-warning-this-new-flu-shot.html",
    "https://rumble.com/v7emyxa-warning-this-new-flu-shot.html?e9s=src_v1_ucp&utm_source=x",
  ])("accepts %s", (input) => {
    expect(parseVideoLink(input)).toEqual({
      ok: true,
      link: { platform: "rumble", slug: "v7emyxa", url: "https://rumble.com/v7emyxa" },
    });
  });

  it("rejects a channel for this flow with the channel message", () => {
    const result = parseVideoLink("https://rumble.com/c/Redacted");
    expect(result).toEqual({
      ok: false,
      code: "invalid_link",
      message: "That is a channel link; add it with Add creator.",
    });
  });

  it("rejects the Rumble home page, listings, and look-alike hosts", () => {
    expect(parseVideoLink("https://rumble.com/")).toMatchObject({
      ok: false,
      code: "invalid_link",
    });
    expect(parseVideoLink("https://rumble.com/videos")).toMatchObject({
      ok: false,
      code: "invalid_link",
    });
    expect(parseVideoLink("https://rumble.com.evil.test/v7emyxa")).toMatchObject({
      ok: false,
      code: "unsupported_site",
    });
  });

  it("rejects plain http", () => {
    expect(parseVideoLink("http://rumble.com/v7emyxa")).toMatchObject({
      ok: false,
      code: "invalid_link",
    });
  });
});

describe("videoLinkId and looksLikeVideoLink", () => {
  it("returns the stored id for each platform", () => {
    const youtube = parseVideoLink(CANONICAL);
    const rumble = parseVideoLink("https://rumble.com/v7emyxa-title.html");
    expect(youtube.ok && videoLinkId(youtube.link)).toBe(ID);
    expect(rumble.ok && videoLinkId(rumble.link)).toBe("v7emyxa");
  });

  it("is true only for a single YouTube or Rumble video", () => {
    expect(looksLikeVideoLink(CANONICAL)).toBe(true);
    expect(looksLikeVideoLink(` https://youtu.be/${ID} `)).toBe(true);
    expect(looksLikeVideoLink("https://rumble.com/v7emyxa")).toBe(true);
    expect(looksLikeVideoLink("https://www.youtube.com/@pbdpodcast")).toBe(false);
    expect(looksLikeVideoLink("https://rumble.com/c/Redacted")).toBe(false);
    expect(looksLikeVideoLink("https://example.com/watch?v=" + ID)).toBe(false);
    expect(looksLikeVideoLink("Luke Belmar")).toBe(false);
    expect(looksLikeVideoLink("")).toBe(false);
  });
});

describe("extractVideoLinks", () => {
  const A = "aaaaaaaaaaa";
  const B = "bbbbbbbbbbb";
  const C = "ccccccccccc";
  const url = (id: string) => `https://www.youtube.com/watch?v=${id}`;

  it("reads one link per line", () => {
    const result = extractVideoLinks(`${url(A)}\n${url(B)}\r\n${url(C)}\n`);
    expect(result.links.map((link) => videoLinkId(link))).toEqual([A, B, C]);
    expect(result.rejected).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("splits on spaces and commas", () => {
    const result = extractVideoLinks(`${url(A)}, ${url(B)} ${url(C)},https://youtu.be/${A}`);
    expect(result.links.map((link) => videoLinkId(link))).toEqual([A, B, C]);
  });

  it("finds links inside prose and strips trailing punctuation", () => {
    const text = `Watch (https://youtu.be/${A}), then https://youtu.be/${B}. Also "https://youtu.be/${C}"!`;
    const result = extractVideoLinks(text);
    expect(result.links.map((link) => videoLinkId(link))).toEqual([A, B, C]);
  });

  it("reads markdown links", () => {
    const result = extractVideoLinks(
      `[Episode 12](https://youtu.be/${A}) and <https://youtu.be/${B}>`,
    );
    expect(result.links.map((link) => videoLinkId(link))).toEqual([A, B]);
  });

  it("collapses duplicates written in different forms", () => {
    const result = extractVideoLinks(
      [
        `https://youtu.be/${A}?si=one`,
        `https://www.youtube.com/watch?v=${A}&t=30`,
        `https://m.youtube.com/shorts/${A}`,
        `https://youtu.be/${B}`,
      ].join("\n"),
    );
    expect(result.links.map((link) => videoLinkId(link))).toEqual([A, B]);
  });

  it("mixes YouTube and Rumble in input order", () => {
    const result = extractVideoLinks(`https://rumble.com/v7emyxa-title.html ${url(A)}`);
    expect(result.links.map((link) => link.url)).toEqual(["https://rumble.com/v7emyxa", url(A)]);
  });

  it("reports rejected links with their original text and reason", () => {
    const result = extractVideoLinks(
      [
        url(A),
        "https://www.youtube.com/@pbdpodcast",
        "https://vimeo.com/123456789",
        "https://www.youtube.com/playlist?list=PLabc123",
      ].join("\n"),
    );
    expect(result.links).toHaveLength(1);
    expect(result.rejected).toEqual([
      expect.objectContaining({
        raw: "https://www.youtube.com/@pbdpodcast",
        code: "invalid_link",
        message: "That is a channel link; add it with Add creator.",
      }),
      expect.objectContaining({ raw: "https://vimeo.com/123456789", code: "unsupported_site" }),
      expect.objectContaining({
        raw: "https://www.youtube.com/playlist?list=PLabc123",
        code: "invalid_link",
      }),
    ]);
  });

  it("lists the same rejected text once", () => {
    const result = extractVideoLinks("https://vimeo.com/1 https://vimeo.com/1");
    expect(result.rejected).toHaveLength(1);
  });

  it("returns nothing for text without links", () => {
    expect(extractVideoLinks("just some words, no links")).toEqual({
      links: [],
      rejected: [],
      truncated: false,
    });
    expect(extractVideoLinks("")).toEqual({ links: [], rejected: [], truncated: false });
  });

  it("caps valid links at 30 by default and says so", () => {
    const ids = Array.from({ length: 35 }, (_, index) => `video${String(index).padStart(6, "0")}`);
    const result = extractVideoLinks(ids.map((id) => `https://youtu.be/${id}`).join("\n"));
    expect(result.links).toHaveLength(30);
    expect(result.links.map((link) => videoLinkId(link))).toEqual(ids.slice(0, 30));
    expect(result.truncated).toBe(true);
  });

  it("honors a custom cap and is not truncated at exactly the cap", () => {
    const text = [A, B, C].map((id) => `https://youtu.be/${id}`).join(" ");
    expect(extractVideoLinks(text, { max: 3 })).toMatchObject({ truncated: false });
    const capped = extractVideoLinks(text, { max: 2 });
    expect(capped.links).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("does not count duplicates toward the cap", () => {
    const text = [A, A, A, B].map((id) => `https://youtu.be/${id}`).join(" ");
    expect(extractVideoLinks(text, { max: 2 })).toMatchObject({ truncated: false });
  });
});

describe("client safety", () => {
  const ROOT = path.join(__dirname, "..", "..");
  const FORBIDDEN = /^(node:|server-only$|better-sqlite3$|child_process$|fs$|path$)/;

  /** Runtime import specifiers of a source file, ignoring type-only imports. */
  function runtimeImports(file: string): string[] {
    const source = readFileSync(file, "utf8");
    const specifiers: string[] = [];
    for (const match of source.matchAll(
      /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gm,
    )) {
      specifiers.push(match[1]);
    }
    for (const match of source.matchAll(/^import\s+"([^"]+)"/gm)) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  function resolve(from: string, specifier: string): string | null {
    const base = specifier.startsWith("@/")
      ? path.join(ROOT, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(from), specifier)
        : null;
    return base === null ? null : `${base}.ts`;
  }

  it("imports nothing a client component could not bundle", () => {
    const seen = new Set<string>();
    const queue = [path.join(ROOT, "lib/videos/import/links.ts")];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      for (const specifier of runtimeImports(file)) {
        expect(specifier, `${path.relative(ROOT, file)} imports ${specifier}`).not.toMatch(
          FORBIDDEN,
        );
        const next = resolve(file, specifier);
        if (next !== null) {
          queue.push(next);
        }
      }
    }
    // links.ts and the Rumble URL parser it reuses, and nothing else.
    expect([...seen].map((file) => path.relative(ROOT, file)).sort()).toEqual([
      "lib/rumble/urls.ts",
      "lib/videos/import/links.ts",
    ]);
  });
});
