import { describe, expect, it } from "vitest";

import { parseCreatorChannelUrl } from "@/lib/validation/creator-url";

const ACCEPTED: readonly [string, { kind: string; value: string }][] = [
  ["https://www.youtube.com/@mkbhd", { kind: "handle", value: "mkbhd" }],
  ["https://youtube.com/@veritasium", { kind: "handle", value: "veritasium" }],
  ["https://m.youtube.com/@NASA", { kind: "handle", value: "nasa" }],
  ["https://www.youtube.com/@Kurzgesagt?si=abc123", { kind: "handle", value: "kurzgesagt" }],
  [
    "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ",
    { kind: "channel_id", value: "UCBR8-60-B28hp2BmDPdntcQ" },
  ],
  [
    "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ/",
    { kind: "channel_id", value: "UCBR8-60-B28hp2BmDPdntcQ" },
  ],
];

const REJECTED: readonly [string, RegExp][] = [
  // Empty and malformed input
  ["", /Paste a YouTube channel link/i],
  ["not a url at all", /does not look like a complete URL/i],
  // Unexpected protocols
  ["http://www.youtube.com/@mkbhd", /only accepts secure HTTPS/i],
  ["ftp://www.youtube.com/@mkbhd", /links are not supported/i],
  ["javascript:alert(1)", /links are not supported/i],
  // Credentials in URLs
  ["https://user:pass@www.youtube.com/@mkbhd", /embedded usernames or passwords/i],
  ["https://user@www.youtube.com/@mkbhd", /embedded usernames or passwords/i],
  // Non-YouTube hosts
  ["https://vimeo.com/channel/someone", /Only youtube\.com channels can be added/i],
  ["https://example.com/@mkbhd", /Only youtube\.com channels can be added/i],
  ["https://youtube.evil.example/@mkbhd", /is not a YouTube address/i],
  // Video and playlist forms
  ["https://youtu.be/dQw4w9WgXcQ", /video link \(youtu\.be\)/i],
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", /single video link/i],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", /single video link/i],
  ["https://www.youtube.com/live/dQw4w9WgXcQ", /single video link/i],
  ["https://www.youtube.com/embed/dQw4w9WgXcQ", /single video link/i],
  ["https://www.youtube.com/playlist?list=PL1234", /Playlists cannot be saved here/i],
  // Ambiguous or unsupported paths
  ["https://www.youtube.com", /YouTube home page/i],
  ["https://www.youtube.com/", /YouTube home page/i],
  ["https://www.youtube.com/feed/subscriptions", /YouTube page, not a creator's channel/i],
  ["https://www.youtube.com/results?search_query=test", /YouTube page, not a creator's channel/i],
  ["https://www.youtube.com/user/mkbhd", /Legacy custom URLs/i],
  ["https://www.youtube.com/c/mkbhd", /Legacy custom URLs/i],
  ["https://www.youtube.com/@mkbhd/videos", /specific tab of a channel/i],
  ["https://www.youtube.com/random/path/here", /does not look like a channel/i],
  // Malformed identifiers
  ["https://www.youtube.com/@x", /Handles are 3–30 letters/i],
  [
    "https://www.youtube.com/@this-handle-is-way-way-too-long-for-youtube",
    /Handles are 3–30 letters/i,
  ],
  ["https://www.youtube.com/channel/notAChannelId", /Channel IDs start with “UC”/i],
  ["https://www.youtube.com/channel/UCshort", /Channel IDs start with “UC”/i],
  ["https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ/extra", /with nothing after the ID/i],
  ["https://www.youtube.com/channel/", /Channel ID links must look like/i],
];

describe("parseCreatorChannelUrl", () => {
  it.each(ACCEPTED)("accepts %s", (input, expected) => {
    const result = parseCreatorChannelUrl(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      if (expected.kind === "handle") {
        expect(result.target).toEqual({ kind: "handle", handle: expected.value });
      } else {
        expect(result.target).toEqual({ kind: "channel_id", channelId: expected.value });
      }
    }
  });

  it.each(REJECTED)("rejects %s with plain-language feedback", (input, messagePattern) => {
    const result = parseCreatorChannelUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(messagePattern);
    }
  });

  it("normalizes handle casing for stable identity", () => {
    const result = parseCreatorChannelUrl("https://www.youtube.com/@MKBHD");
    expect(result.ok).toBe(true);
    if (result.ok && result.target.kind === "handle") {
      expect(result.target.handle).toBe("mkbhd");
    }
  });
});
