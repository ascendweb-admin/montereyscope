import { describe, expect, it } from "vitest";

import {
  isXHost,
  looksLikeBareHandle,
  parseXTarget,
  tweetIdFromStatusUrl,
  xProfileUrl,
  xStatusUrl,
} from "@/lib/x/urls";

describe("parseXTarget", () => {
  it("accepts profile links across the supported hosts", () => {
    for (const input of [
      "https://x.com/OpenAI",
      "https://www.x.com/OpenAI",
      "https://twitter.com/OpenAI",
      "https://www.twitter.com/OpenAI",
      "https://mobile.twitter.com/OpenAI",
      "https://x.com/@OpenAI",
      "https://x.com/OpenAI?ref=share",
    ]) {
      const parsed = parseXTarget(input);
      expect(parsed.ok, input).toBe(true);
      if (parsed.ok) {
        expect(parsed.target).toEqual({ kind: "profile", handle: "OpenAI" });
      }
    }
  });

  it("accepts status links and extracts the tweet id", () => {
    const parsed = parseXTarget("https://x.com/OpenAI/status/1234567890123456789");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.target).toEqual({
        kind: "status",
        handle: "OpenAI",
        tweetId: "1234567890123456789",
      });
    }
    expect(tweetIdFromStatusUrl("https://twitter.com/OpenAI/status/42")).toBe("42");
  });

  it("accepts bare handles only when X is explicitly selected", () => {
    expect(parseXTarget("@OpenAI").ok).toBe(false);
    const parsed = parseXTarget("@OpenAI", { allowBareHandle: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.target).toEqual({ kind: "profile", handle: "OpenAI" });
    }
    expect(looksLikeBareHandle("@OpenAI")).toBe(true);
    expect(looksLikeBareHandle("@not a handle")).toBe(false);
  });

  it("rejects deceptive hosts and non-https protocols", () => {
    expect(parseXTarget("https://x.com.evil.example/OpenAI").ok).toBe(false);
    expect(parseXTarget("https://twitter.com.evil.example/OpenAI").ok).toBe(false);
    expect(parseXTarget("http://x.com/OpenAI").ok).toBe(false);
    expect(parseXTarget("ftp://x.com/OpenAI").ok).toBe(false);
    expect(parseXTarget("https://user:pass@x.com/OpenAI").ok).toBe(false);
  });

  it("rejects pages that are not profiles", () => {
    for (const input of [
      "https://x.com/home",
      "https://x.com/explore",
      "https://x.com/i/flow/login",
      "https://x.com/settings/profile",
      "https://x.com/search?q=abc",
      "https://x.com/OpenAI/followers",
      "https://x.com/OpenAI/status/notanumber",
      "https://x.com/OpenAI/media",
    ]) {
      expect(parseXTarget(input).ok, input).toBe(false);
    }
  });

  it("rejects handles that are too long or contain invalid characters", () => {
    expect(parseXTarget("https://x.com/this_handle_is_way_too_long").ok).toBe(false);
    expect(parseXTarget("https://x.com/has-dash").ok).toBe(false);
    expect(parseXTarget("https://x.com/").ok).toBe(false);
  });

  it("builds canonical URLs", () => {
    expect(xProfileUrl("OpenAI")).toBe("https://x.com/OpenAI");
    expect(xStatusUrl("OpenAI", "42")).toBe("https://x.com/OpenAI/status/42");
    expect(isXHost("twitter.com")).toBe(true);
    expect(isXHost("x.com.evil.example")).toBe(false);
  });
});
