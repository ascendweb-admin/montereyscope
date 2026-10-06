import { describe, expect, it } from "vitest";

import { vttToPlainText, VttParseError } from "@/lib/transcripts/vtt-to-text";

/** Realistic YouTube auto-caption fragment with word-level tags and rolling cues. */
const ROLLING_AUTO_VTT = [
  "WEBVTT",
  "Kind: captions",
  "Language: en",
  "",
  "00:00:00.000 --> 00:00:01.150 align:start position:0%",
  " ",
  "We<00:00:00.200><c> got</c><00:00:00.320><c> a</c><00:00:01.000><c> lot</c>",
  "",
  "00:00:01.150 --> 00:00:01.160 align:start position:0%",
  "We got a lot",
  " ",
  "",
  "00:00:01.160 --> 00:00:02.230 align:start position:0%",
  "We got a lot",
  "to<00:00:01.240><c> cover.</c>",
  "",
].join("\n");

describe("vttToPlainText — structure removal", () => {
  it("removes headers, metadata blocks, cue ids, timings, and positioning settings", () => {
    const vtt = [
      "WEBVTT",
      "Kind: captions",
      "Language: pt-BR",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "REGION",
      "id:fred width:40%",
      "",
      "NOTE This is a multi-line",
      "comment block.",
      "",
      "simple-cue-id-1",
      "00:00:01.000 --> 00:00:03.000 align:start position:0%",
      "Hello world",
    ].join("\n");

    expect(vttToPlainText(vtt)).toBe("Hello world");
  });

  it("strips inline caption markup and word-level timestamp tags", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<i>Hello</i> <b>brave</b> <u>new</u> <c.colorE5E5E5>world</c>",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "Good<00:00:02.400><c>bye</c><00:00:03.000><c> now</c>",
    ].join("\n");

    const output = vttToPlainText(vtt);
    expect(output).toContain("Hello brave new world");
    expect(output).toContain("Goodbye now");
    expect(output).not.toMatch(/[<>]/);
  });

  it("accepts CRLF line endings and a BOM", () => {
    const vtt = "\uFEFFWEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nLine one\r\n";
    expect(vttToPlainText(vtt)).toBe("Line one");
  });

  it("supports hour-less timestamps", () => {
    const vtt = ["WEBVTT", "", "00:05.000 --> 00:07.500", "Short form"].join("\n");
    expect(vttToPlainText(vtt)).toBe("Short form");
  });
});

describe("vttToPlainText — content preservation", () => {
  it("preserves punctuation, case, and Unicode text verbatim", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "Café — naïve résumé?",
      "",
      "00:00:02.100 --> 00:00:04.000",
      "日本語と Ελληνικά 🎬 work too!",
    ].join("\n");

    const output = vttToPlainText(vtt);
    expect(output).toContain("Café — naïve résumé?");
    expect(output).toContain("日本語と Ελληνικά 🎬 work too!");
  });

  it("decodes named and numeric HTML entities without double-encoding", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "Tom &amp; Jerry &lt;3 &#39;quotes&#39; &quot;doubles&quot; A&nbsp;B &#x1F3AC;",
    ].join("\n");

    const output = vttToPlainText(vtt);
    expect(output).toContain(`Tom & Jerry <3 'quotes' "doubles" A B 🎬`);
    expect(output).not.toContain("&amp;");
  });

  it("keeps meaningful speaker labels as a readable prefix", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<v Fred>Welcome back, everyone.</v>",
      "",
      "00:00:02.100 --> 00:00:04.000",
      "<v Fred>Thanks for coming.</v>",
    ].join("\n");

    const output = vttToPlainText(vtt);
    expect(output).toContain("Fred: Welcome back, everyone.");
    // Same speaker continuing flows inside one paragraph without repeats.
    expect(output).toContain("Thanks for coming.");
    expect(output.match(/Fred:/g)?.length ?? 0).toBe(1);
  });
});

describe("vttToPlainText — rolling captions and duplication", () => {
  it("collapses YouTube rolling auto-captions into flowing unique text", () => {
    const output = vttToPlainText(ROLLING_AUTO_VTT);
    expect(output).toBe("We got a lot to cover.");
  });

  it("drops short confirmation-only duplicate cues between rolling cues", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "first part of the sentence",
      "",
      "00:00:01.000 --> 00:00:01.010",
      "first part of the sentence",
      "",
      "00:00:01.010 --> 00:00:02.000",
      "first part of the sentence",
      "and the ending",
    ].join("\n");

    expect(vttToPlainText(vtt)).toBe("first part of the sentence and the ending");
  });

  it("collapses identical adjacent cues but preserves repeated speech after a pause", () => {
    const adjacent = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "echo echo",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "echo echo",
    ].join("\n");
    expect(vttToPlainText(adjacent)).toBe("echo echo");

    // Genuine repetition: same words later in time are legitimate speech.
    const repeated = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "really really long trunks",
      "",
      "00:00:10.000 --> 00:00:11.000",
      "really really long trunks",
    ].join("\n");
    expect(vttToPlainText(repeated)).toBe("really really long trunks\n\nreally really long trunks");
  });

  it("never deduplicates repetition inside a single cue", () => {
    const vtt = ["WEBVTT", "", "00:00:00.000 --> 00:00:02.000", "no no no no said the voter"].join(
      "\n",
    );
    expect(vttToPlainText(vtt)).toBe("no no no no said the voter");
  });
});

describe("vttToPlainText — readability", () => {
  it("starts a new paragraph after a temporal gap or speaker change", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<v Ann>First speaker talks here",
      "",
      "00:00:02.000 --> 00:00:03.500",
      "<v Ann>still talking along nicely",
      "",
      "00:00:30.000 --> 00:00:31.000",
      "<v Bob>A completely different topic",
    ].join("\n");

    const output = vttToPlainText(vtt);
    expect(output.split("\n\n").length).toBe(2);
    expect(output.startsWith("Ann: First speaker")).toBe(true);
    expect(output.endsWith("Bob: A completely different topic")).toBe(true);
  });

  it("handles very long captions efficiently and completely", () => {
    const cueCount = 20_000;
    const blocks: string[] = [];
    for (let i = 0; i < cueCount; i += 1) {
      const start = i * 2;
      const mm = String(Math.floor(start / 60) % 60).padStart(2, "0");
      const hh = String(Math.floor(start / 3600));
      const ss = String(start % 60).padStart(2, "0");
      blocks.push(`${hh}:${mm}:${ss}.000 --> ${hh}:${mm}:${ss}.900`);
      blocks.push(`Sentence number ${i} keeps rolling along`);
    }
    const vtt = ["WEBVTT", ""].concat(blocks).join("\n");

    const output = vttToPlainText(vtt);
    expect(output).toContain("Sentence number 0 ");
    expect(output).toContain(`Sentence number ${cueCount - 1}`);
  });
});

describe("vttToPlainText — failures", () => {
  it("rejects empty and whitespace-only files", () => {
    expect(() => vttToPlainText("")).toThrow(VttParseError);
    try {
      vttToPlainText("   \n \n ");
    } catch (error) {
      expect((error as VttParseError).code).toBe("empty");
    }
  });

  it("rejects non-WebVTT content such as SRT", () => {
    const srt = ["1", "00:00:01,000 --> 00:00:02,000", "SubRip, not WebVTT"].join("\n");
    try {
      vttToPlainText(srt);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VttParseError);
      expect((error as VttParseError).code).toBe("not_webvtt");
    }
  });

  it("rejects structurally malformed blocks instead of guessing", () => {
    const malformed = ["WEBVTT", "", "this block has no timing line at all"].join("\n");
    try {
      vttToPlainText(malformed);
      expect.unreachable();
    } catch (error) {
      expect((error as VttParseError).code).toBe("malformed");
    }
  });

  it("rejects header-only files with no cues", () => {
    try {
      vttToPlainText("WEBVTT\n");
      expect.unreachable();
    } catch (error) {
      expect((error as VttParseError).code).toBe("empty");
    }
  });
});
