import { describe, expect, it } from "vitest";

import {
  anchorReportHeadings,
  readingMinutes,
  summarizeReportDocument,
} from "@/lib/ai/report-document";

/**
 * Reading a finished report without rendering it: the outline (and the
 * anchors the reader jumps to), the text search indexes, and the word count
 * behind the reading time.
 */

const REPORT = [
  '<!doctype html><html lang="en"><head><title>Ignored title</title>',
  "<style>h2 { color: red }</style></head><body>",
  '<header><p class="eyebrow">Transcript report</p>',
  "<h1>Markets at a Fork</h1>",
  '<p class="dek">A single-source analysis of a livestream.</p></header>',
  '<section aria-labelledby="overview"><h2 id="overview">1. Executive overview</h2>',
  "<p>The central signal is a fragile, selective market.</p></section>",
  '<section><h2 class="big">2. Key &amp; themes</h2>',
  "<h3>A threshold market, not a <em>broad</em> one</h3><p>Selection beats beta.</p>",
  "<h3 id=''>Rules are lagging</h3><p>Enforcement trails behaviour.</p>",
  "<h2>   </h2></section>",
  "<!-- <h2>Commented out</h2> --></body></html>",
].join("");

describe("anchorReportHeadings", () => {
  it("keeps the document's own ids, names the rest, and outlines in order", () => {
    const { html, outline } = anchorReportHeadings(REPORT);
    expect(outline).toEqual([
      { id: "overview", text: "1. Executive overview", level: 2 },
      { id: "scope-section-1", text: "2. Key & themes", level: 2 },
      { id: "scope-section-2", text: "A threshold market, not a broad one", level: 3 },
      { id: "scope-section-3", text: "Rules are lagging", level: 3 },
    ]);
    expect(html).toContain('<h2 id="overview">1. Executive overview</h2>');
    expect(html).toContain('<h2 id="scope-section-1" class="big">2. Key &amp; themes</h2>');
    // An empty id is replaced rather than duplicated.
    expect(html).toContain('<h3 id="scope-section-3">Rules are lagging</h3>');
    // Empty headings still get an anchor but stay out of the outline, and
    // commented-out markup is left alone.
    expect(html).toContain('<h2 id="scope-section-4">   </h2>');
    expect(html).toContain("<!-- <h2>Commented out</h2> -->");
    expect(html.replace(/ id="scope-section-\d+"/g, "").replace(" id=''", "")).toBe(
      REPORT.replace(" id=''", ""),
    );
  });

  it("treats h3s before the first h2 as sections, as Markdown briefs write them", () => {
    const { outline } = anchorReportHeadings(
      "<h1>Brief</h1><h3>TL;DR</h3><p>…</p><h3>BTC: buying the fear</h3><h2>Sources</h2><h3>Post</h3>",
    );
    expect(outline.map((entry) => [entry.text, entry.level])).toEqual([
      ["TL;DR", 2],
      ["BTC: buying the fear", 2],
      ["Sources", 2],
      ["Post", 3],
    ]);
  });

  it("does not mistake a data-id attribute for an id", () => {
    const { html, outline } = anchorReportHeadings('<h2 data-id="x">Section</h2>');
    expect(outline[0].id).toBe("scope-section-1");
    expect(html).toBe('<h2 id="scope-section-1" data-id="x">Section</h2>');
  });
});

describe("summarizeReportDocument", () => {
  it("indexes the visible prose below the headline and standfirst", () => {
    const summary = summarizeReportDocument(REPORT);
    expect(summary.text).toContain("The central signal is a fragile, selective market.");
    expect(summary.text).toContain("Key & themes");
    expect(summary.text).not.toContain("Ignored title");
    expect(summary.text).not.toContain("color: red");
    expect(summary.text).not.toContain("Markets at a Fork");
    expect(summary.text).not.toContain("single-source analysis");
    expect(summary.outline).toHaveLength(4);
  });

  it("leaves the briefs' source appendices out of the reading time", () => {
    const prose = Array.from({ length: 460 }, (_, index) => `word${index}`).join(" ");
    const appendix = Array.from({ length: 2000 }, () => "post").join(" ");
    const insight = `<h1>Brief</h1><section><p>${prose}</p></section><div class="sources"><h2>Sources</h2><ol><li>${appendix}</li></ol></div></body></html>`;
    const research = `<h1>Question</h1><p>${prose}</p><details id="post-1"><summary>Author</summary><p>${appendix}</p></details>`;

    for (const html of [insight, research]) {
      const summary = summarizeReportDocument(html);
      // The prose and its one-word headline; none of the appendix.
      expect(summary.wordCount).toBe(461);
      // The appendix is still searchable.
      expect(summary.text).toContain("post post");
      expect(readingMinutes(summary.wordCount)).toBe(2);
    }
  });
});

describe("readingMinutes", () => {
  it("rounds to whole minutes and never says zero", () => {
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(230)).toBe(1);
    expect(readingMinutes(1369)).toBe(6);
  });
});
