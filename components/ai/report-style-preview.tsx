import type { CSSProperties, ReactNode } from "react";

import type { ReportProfileId, ReportStyleId } from "@/components/ai/report-options";

/**
 * A miniature of the top of a generated report, drawn in each style's own
 * palette and type so the Generate-report dialog shows what a style looks
 * like instead of describing it. Purely decorative (aria-hidden): the picker's
 * label and tagline carry the meaning.
 *
 * The colors and font stacks mirror the stylesheets in lib/ai/report-styles.ts
 * (server-only, so they cannot be imported here); update both together.
 */

interface PreviewTheme {
  page: string;
  ink: string;
  muted: string;
  rule: string;
  accent: string;
  /** Pull-quote background; transparent where the style has none. */
  quoteBg: string;
  bodyFont: string;
  headlineFont: string;
  labelFont: string;
  headline: CSSProperties;
  /** Header bottom border. */
  headerRule: string;
  /** Renders the section heading in the style's manner. */
  section: (title: string, theme: PreviewTheme) => ReactNode;
  chip: CSSProperties;
  chipDot: CSSProperties;
}

const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const MONO = 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace';

const THEMES: Record<ReportStyleId, PreviewTheme> = {
  editorial: {
    page: "#f9f6f0",
    ink: "#26221c",
    muted: "#6f675c",
    rule: "#ddd5c8",
    accent: "#b0512c",
    quoteBg: "transparent",
    bodyFont: SERIF,
    headlineFont: SERIF,
    labelFont: SANS,
    headline: { fontSize: 13, fontWeight: 700, letterSpacing: "-0.02em" },
    headerRule: "1px solid #ddd5c8",
    section: (title, theme) => (
      <div
        style={{
          fontFamily: theme.headlineFont,
          fontSize: 8.5,
          fontWeight: 700,
          paddingBottom: 3,
          borderBottom: `1px solid ${theme.rule}`,
        }}
      >
        {title}
      </div>
    ),
    chip: { borderRadius: 999, background: "#f0e4da", color: "#b0512c" },
    chipDot: { borderRadius: 999 },
  },
  terminal: {
    page: "#101419",
    ink: "#d7e0ea",
    muted: "#8792a3",
    rule: "#2a3340",
    accent: "#3ecf8e",
    quoteBg: "#171d25",
    bodyFont: SANS,
    headlineFont: MONO,
    labelFont: MONO,
    headline: { fontSize: 11, fontWeight: 650, letterSpacing: "-0.02em" },
    headerRule: "1px dotted #2a3340",
    section: (title, theme) => (
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 4,
          fontFamily: MONO,
          fontSize: 6.5,
          fontWeight: 650,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
        }}
      >
        <span style={{ color: theme.accent }}>01</span>
        <span>{title}</span>
        <span style={{ flex: 1, borderBottom: `1px dotted ${theme.rule}` }} />
      </div>
    ),
    chip: {
      borderRadius: 2,
      border: "1px solid #2a3340",
      background: "#171d25",
      color: "#3ecf8e",
      fontFamily: MONO,
    },
    chipDot: { borderRadius: 1 },
  },
  swiss: {
    page: "#ffffff",
    ink: "#141414",
    muted: "#6b6b6b",
    rule: "#e3e3e3",
    accent: "#dd3311",
    quoteBg: "transparent",
    bodyFont: SANS,
    headlineFont: SANS,
    labelFont: SANS,
    headline: { fontSize: 15, fontWeight: 700, letterSpacing: "-0.05em", lineHeight: 1.05 },
    headerRule: "2px solid #141414",
    section: (title, theme) => (
      <div
        style={{
          display: "flex",
          gap: 4,
          paddingTop: 3,
          borderTop: `1px solid ${theme.rule}`,
          fontSize: 6.5,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        <span style={{ color: theme.accent }}>1.</span>
        <span>{title}</span>
      </div>
    ),
    chip: { borderRadius: 0, border: "1px solid #141414", color: "#141414" },
    chipDot: { borderRadius: 0 },
  },
};

/** Each profile's opening section, as its writing brief names it. */
const OPENING_SECTION: Record<ReportProfileId, string> = {
  brief: "The short version",
  balanced: "Executive overview",
  deep: "Executive overview",
};

/** A line of body copy, abstracted to a bar so the preview stays legible at size. */
function TextLine({ width, color }: { width: string; color: string }) {
  return <div style={{ width, height: 3, borderRadius: 999, background: color, opacity: 0.22 }} />;
}

export function ReportStylePreview({
  style,
  profile,
}: {
  style: ReportStyleId;
  profile: ReportProfileId;
}) {
  const theme = THEMES[style];
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none relative flex h-full flex-col gap-2 overflow-hidden px-3 pt-3 select-none"
      style={{ background: theme.page, color: theme.ink, fontFamily: theme.bodyFont }}
    >
      <div style={{ borderBottom: theme.headerRule, paddingBottom: 7 }}>
        <div
          style={{
            fontFamily: theme.labelFont,
            fontSize: 5.5,
            fontWeight: 700,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: theme.accent,
          }}
        >
          Report
        </div>
        <div
          style={{
            marginTop: 3,
            fontFamily: theme.headlineFont,
            lineHeight: 1.1,
            whiteSpace: "nowrap",
            ...theme.headline,
          }}
        >
          The week in review
        </div>
        <div className="mt-1.5 flex flex-col gap-1">
          <TextLine width="88%" color={theme.muted} />
          <TextLine width="56%" color={theme.muted} />
        </div>
      </div>

      {theme.section(OPENING_SECTION[profile], theme)}

      <div className="flex flex-col gap-1">
        <TextLine width="100%" color={theme.ink} />
        <TextLine width="94%" color={theme.ink} />
        <div className="flex items-center gap-1">
          <TextLine width="42%" color={theme.ink} />
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              padding: "1px 4px",
              fontFamily: theme.labelFont,
              fontSize: 5,
              fontWeight: 700,
              lineHeight: 1.2,
              whiteSpace: "nowrap",
              ...theme.chip,
            }}
          >
            <span style={{ width: 3, height: 3, background: theme.accent, ...theme.chipDot }} />
            Source
          </span>
        </div>
      </div>

      <div
        className="flex flex-col gap-1"
        style={{
          borderLeft: `2px solid ${theme.accent}`,
          background: theme.quoteBg,
          padding: "4px 0 4px 6px",
        }}
      >
        <TextLine width="80%" color={theme.ink} />
        <TextLine width="62%" color={theme.ink} />
      </div>

      {/* The page continues below the crop; fade it out rather than slicing it. */}
      <div
        className="absolute inset-x-0 bottom-0 h-5"
        style={{ background: `linear-gradient(to bottom, transparent, ${theme.page})` }}
      />
    </div>
  );
}
