import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPORT_PROFILE,
  DEFAULT_REPORT_STYLE,
  REPORT_PROFILE_OPTIONS,
  REPORT_STYLE_OPTIONS,
  isReportProfileId,
  isReportStyleId,
  reportProfileOption,
  reportStyleOption,
} from "@/components/ai/report-options";
import {
  REPORT_PROFILES,
  getReportProfile,
  isReportProfileId as isServerProfileId,
} from "@/lib/ai/report-profiles";
import {
  REPORT_STYLES,
  getReportStyle,
  isReportStyleId as isServerStyleId,
} from "@/lib/ai/report-styles";

/**
 * Report depth profiles and visual styles: their configuration, and the
 * client mirrors the Generate-report dialog and the reports list render
 * from. The client must never import the server-only AI layer, so these
 * tests are the drift guard.
 */
describe("report profile configuration", () => {
  it("offers brief, balanced, and deep with a distinct codex shape each", () => {
    expect(REPORT_PROFILES.map((profile) => profile.id)).toEqual(["brief", "balanced", "deep"]);

    const brief = getReportProfile("brief");
    expect(brief.model).toBe("gpt-5.6-luna");
    expect(brief.reasoningEffort).toBe("low");
    expect(brief.timeoutMs).toBe(8 * 60_000);

    const balanced = getReportProfile("balanced");
    expect(balanced.model).toBe("gpt-5.6-terra");
    expect(balanced.reasoningEffort).toBe("medium");
    expect(balanced.timeoutMs).toBe(15 * 60_000);

    const deep = getReportProfile("deep");
    expect(deep.model).toBe("gpt-5.6-sol");
    expect(deep.reasoningEffort).toBe("xhigh");
    expect(deep.timeoutMs).toBe(25 * 60_000);
  });

  it("gives each profile its own required sections", () => {
    expect(getReportProfile("brief").directive).toContain("The short version");
    expect(getReportProfile("brief").directive).not.toContain("Executive overview");
    expect(getReportProfile("balanced").directive).toContain("Executive overview");
    expect(getReportProfile("balanced").directive).toContain("Actionable takeaways");
    expect(getReportProfile("deep").directive).toContain("Source-by-source notes");
    expect(getReportProfile("deep").directive).toContain("Points of tension");
  });

  it("defaults to the balanced profile and validates untrusted ids", () => {
    expect(DEFAULT_REPORT_PROFILE).toBe("balanced");
    expect(isServerProfileId("brief")).toBe(true);
    expect(isServerProfileId("comprehensive")).toBe(false);
    expect(isServerProfileId(undefined)).toBe(false);
  });
});

describe("report style configuration", () => {
  it("ships one complete stylesheet per style", () => {
    expect(REPORT_STYLES.map((style) => style.id)).toEqual(["editorial", "terminal", "swiss"]);
    for (const style of REPORT_STYLES) {
      // Each stylesheet is self-sufficient: the accent custom property, the
      // citation-chip vocabulary, and print-safe breaks are all in the CSS.
      expect(style.css).toContain("--accent");
      expect(style.css).toContain(".source-chip");
      expect(style.css).toContain("break-inside: avoid");
    }
  });

  it("keeps the three design directions visually distinct", () => {
    const [editorial, terminal, swiss] = REPORT_STYLES;
    expect(editorial?.css).toContain("Georgia"); // warm serif print
    expect(terminal?.css).toContain("#101419"); // dark slate briefing
    expect(swiss?.css).toContain("#ffffff"); // white minimal memo
    expect(getReportStyle("editorial").directive).not.toBe(getReportStyle("terminal").directive);
  });

  it("defaults to the editorial style and validates untrusted ids", () => {
    expect(DEFAULT_REPORT_STYLE).toBe("editorial");
    expect(isServerStyleId("swiss")).toBe(true);
    expect(isServerStyleId("neon")).toBe(false);
    expect(isServerStyleId(7)).toBe(false);
  });
});

describe("report options client mirror", () => {
  it("matches the server profile configuration field for field", () => {
    expect(REPORT_PROFILE_OPTIONS).toHaveLength(REPORT_PROFILES.length);
    for (const [index, serverProfile] of REPORT_PROFILES.entries()) {
      const clientOption = REPORT_PROFILE_OPTIONS[index];
      expect(clientOption).toBeDefined();
      expect(clientOption?.id).toBe(serverProfile.id);
      expect(clientOption?.label).toBe(serverProfile.label);
      expect(clientOption?.tagline).toBe(serverProfile.tagline);
    }
  });

  it("matches the server style configuration field for field", () => {
    expect(REPORT_STYLE_OPTIONS).toHaveLength(REPORT_STYLES.length);
    for (const [index, serverStyle] of REPORT_STYLES.entries()) {
      const clientOption = REPORT_STYLE_OPTIONS[index];
      expect(clientOption).toBeDefined();
      expect(clientOption?.id).toBe(serverStyle.id);
      expect(clientOption?.label).toBe(serverStyle.label);
      expect(clientOption?.tagline).toBe(serverStyle.tagline);
    }
  });

  it("falls back to the defaults for unknown ids", () => {
    // The option resolvers take validated ids; the fallback guards list rows
    // from older servers, exercised through the cast.
    expect(reportProfileOption("nonexistent" as never).id).toBe(DEFAULT_REPORT_PROFILE);
    expect(reportStyleOption("nonexistent" as never).id).toBe(DEFAULT_REPORT_STYLE);
    expect(isReportProfileId("deep")).toBe(true);
    expect(isReportStyleId("terminal")).toBe(true);
    expect(isReportProfileId(42)).toBe(false);
    expect(isReportStyleId(null)).toBe(false);
  });
});
