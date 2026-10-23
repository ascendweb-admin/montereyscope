import { describe, expect, it } from "vitest";

import {
  compactAge,
  creatorLabel,
  dateGroupLabel,
  facetOptions,
  focusSnippet,
  groupReportsByDate,
  jobsAhead,
  matchesFacets,
  matchesQuery,
  NO_FACETS,
  splitSnippet,
  type ReportCreatorSummary,
  type ReportSummary,
} from "@/components/reports/model";

/** The Reports rail's pure rules: calendar buckets and queue positions. */

function row(id: number, status: ReportSummary["status"], createdAt: string): ReportSummary {
  return {
    id,
    status,
    title: `Report ${id}`,
    dek: null,
    videoIds: [],
    videoCount: 0,
    sourceCount: 0,
    sources: [],
    videos: [],
    profile: "balanced",
    style: "editorial",
    filePath: null,
    fileUrl: null,
    error: null,
    createdAt,
    completedAt: null,
    origin: "report",
    scopeLabel: null,
    creators: [],
    categories: [],
    platforms: [],
    outline: [],
    wordCount: null,
    readingMinutes: null,
  };
}

const NOW = new Date(2026, 9, 14, 15, 0, 0);

describe("dateGroupLabel", () => {
  it("buckets by calendar day relative to now", () => {
    expect(dateGroupLabel(new Date(2026, 9, 14, 0, 5).toISOString(), NOW)).toBe("Today");
    expect(dateGroupLabel(new Date(2026, 9, 13, 23, 55).toISOString(), NOW)).toBe("Yesterday");
    expect(dateGroupLabel(new Date(2026, 9, 9).toISOString(), NOW)).toBe("Previous 7 days");
    expect(dateGroupLabel(new Date(2026, 8, 20).toISOString(), NOW)).toBe("Previous 30 days");
    expect(dateGroupLabel(new Date(2026, 6, 2).toISOString(), NOW)).toMatch(/July/);
    expect(dateGroupLabel(new Date(2025, 6, 2).toISOString(), NOW)).toMatch(/2025/);
    expect(dateGroupLabel("not a date", NOW)).toBe("Earlier");
  });
});

describe("groupReportsByDate", () => {
  it("keeps list order and merges consecutive rows of the same bucket", () => {
    const groups = groupReportsByDate(
      [
        row(4, "done", new Date(2026, 9, 14, 12).toISOString()),
        row(3, "done", new Date(2026, 9, 14, 9).toISOString()),
        row(2, "failed", new Date(2026, 9, 13, 9).toISOString()),
      ],
      NOW,
    );
    expect(groups.map((group) => [group.label, group.reports.map((report) => report.id)])).toEqual([
      ["Today", [4, 3]],
      ["Yesterday", [2]],
    ]);
  });
});

describe("jobsAhead", () => {
  it("counts the running job and earlier queued jobs", () => {
    const at = NOW.toISOString();
    const reports = [
      row(9, "queued", at),
      row(8, "queued", at),
      row(7, "running", at),
      row(6, "done", at),
    ];
    expect(jobsAhead(reports[1], reports)).toBe(1);
    expect(jobsAhead(reports[0], reports)).toBe(2);
    expect(jobsAhead(reports[0], reports.slice(0, 2))).toBe(1);
  });
});

function person(id: number, name: string): ReportCreatorSummary {
  return { id, name, avatarCreatorId: null, avatarUrl: null, sourceCount: 1 };
}

const CRYPTO = { id: 1, name: "Crypto", color: "sky" as const };
const AI = { id: 2, name: "AI", color: "violet" as const };

describe("creatorLabel", () => {
  it("names the list a brief covered, else one, two, or the first of many people", () => {
    const base = row(1, "done", "2026-10-14T12:00:00.000Z");
    expect(creatorLabel(base)).toBeNull();
    expect(creatorLabel({ ...base, creators: [person(1, "threadguy")] })).toBe("threadguy");
    expect(creatorLabel({ ...base, creators: [person(1, "Ansem"), person(2, "Flood")] })).toBe(
      "Ansem & Flood",
    );
    expect(
      creatorLabel({
        ...base,
        creators: [person(1, "Ansem"), person(2, "Flood"), person(3, "Killa")],
      }),
    ).toBe("Ansem +2");
    expect(
      creatorLabel({ ...base, scopeLabel: "Crypto KOL's", creators: [person(1, "Ansem")] }),
    ).toBe("Crypto KOL's");
  });
});

describe("facet filters", () => {
  const video = {
    ...row(1, "done", "2026-10-14T12:00:00.000Z"),
    creators: [person(1, "threadguy")],
    categories: [CRYPTO],
    platforms: ["youtube" as const],
  };
  const posts = {
    ...row(2, "done", "2026-10-14T11:00:00.000Z"),
    creators: [person(2, "Ansem"), person(1, "threadguy")],
    categories: [CRYPTO],
    platforms: ["x" as const],
  };
  const ai = {
    ...row(3, "done", "2026-10-14T10:00:00.000Z"),
    creators: [person(3, "Bijan")],
    categories: [AI],
    platforms: ["youtube" as const, "x" as const],
  };

  it("matches any value within a facet and every facet across them", () => {
    const pick = (facets: Partial<typeof NO_FACETS>) =>
      [video, posts, ai]
        .filter((report) => matchesFacets(report, { ...NO_FACETS, ...facets }))
        .map((report) => report.id);
    expect(pick({})).toEqual([1, 2, 3]);
    expect(pick({ platforms: ["x"] })).toEqual([2, 3]);
    expect(pick({ categories: [AI, CRYPTO].map((category) => category.id) })).toEqual([1, 2, 3]);
    expect(pick({ creators: [1] })).toEqual([1, 2]);
    expect(pick({ creators: [1], platforms: ["x"] })).toEqual([2]);
    expect(pick({ creators: [3], categories: [CRYPTO.id] })).toEqual([]);
  });

  it("offers every value the reports carry, with how many carry it", () => {
    const options = facetOptions([video, posts, ai]);
    expect(options.creators.map((creator) => [creator.name, creator.reportCount])).toEqual([
      ["threadguy", 2],
      ["Ansem", 1],
      ["Bijan", 1],
    ]);
    expect(options.categories.map((category) => [category.name, category.reportCount])).toEqual([
      ["AI", 1],
      ["Crypto", 2],
    ]);
    expect(options.platforms).toEqual([
      { id: "youtube", reportCount: 2 },
      { id: "x", reportCount: 2 },
    ]);
  });

  it("lets search find a report by the people behind it", () => {
    expect(matchesQuery(posts, "ansem")).toBe(true);
    expect(matchesQuery({ ...posts, scopeLabel: "Crypto KOL's" }, "kol")).toBe(true);
    expect(matchesQuery(posts, "bijan")).toBe(false);
  });
});

describe("compactAge", () => {
  it("says how long ago in a row-sized unit", () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(compactAge(ago(20_000), now)).toBe("now");
    expect(compactAge(ago(5 * 60_000), now)).toBe("5m");
    expect(compactAge(ago(3 * 3_600_000), now)).toBe("3h");
    expect(compactAge(ago(2 * 86_400_000), now)).toBe("2d");
    expect(compactAge(ago(15 * 86_400_000), now)).toBe("2w");
    expect(compactAge(ago(60 * 86_400_000), now)).toBe("2mo");
    expect(compactAge(ago(400 * 86_400_000), now)).toBe("1y");
    expect(compactAge("not a date", now)).toBeNull();
  });
});

describe("search snippets", () => {
  it("splits a snippet into plain and matched runs", () => {
    expect(splitSnippet("…the \u0002Warsh\u0003 speech, \u0002warsh\u0003…")).toEqual([
      { text: "…the ", match: false },
      { text: "Warsh", match: true },
      { text: " speech, ", match: false },
      { text: "warsh", match: true },
      { text: "…", match: false },
    ]);
    expect(splitSnippet("no markers")).toEqual([{ text: "no markers", match: false }]);
  });

  it("brings a late first match to the front, cutting at a word", () => {
    const late =
      "…one two three four five six seven eight nine ten eleven \u0002memecoins\u0003 are";
    const focused = focusSnippet(late, 12);
    expect(focused.startsWith("…")).toBe(true);
    expect(focused).toContain("\u0002memecoins\u0003 are");
    expect(focused.indexOf("\u0002")).toBeLessThanOrEqual(14);
    // The cut lands on a whole word of the original.
    const kept = focused.slice(1);
    expect(late.endsWith(kept)).toBe(true);
    expect(late[late.length - kept.length - 1]).toBe(" ");
    const early = "…the \u0002Warsh\u0003 speech";
    expect(focusSnippet(early, 12)).toBe(early);
  });
});
