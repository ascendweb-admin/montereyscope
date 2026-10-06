/**
 * Report visual styles — the one place that defines how each generated report
 * looks. Instead of asking codex to invent a design every run (which drifts),
 * each style ships a complete stylesheet that the prompt requires verbatim,
 * so a style is a real, tested design and every report in it looks the same.
 *
 * The stylesheets style elements first (body, headings, paragraphs, quotes,
 * lists) so the design holds even where the model invents structure, and
 * define a small class vocabulary the prompt asks the content to use:
 * header/dek/report-meta, section, blockquote + .quote-source, and the
 * .source-chip citation chips. No JavaScript, no external requests — the
 * documents stay self-contained and pass the serving CSP.
 *
 * This module is pure data — no Node imports — so the client can keep its own
 * mirror of the user-facing fields without importing the server-only AI
 * layer; a unit test pins the two sides together.
 */

/** The visual styles offered in the Generate-report dialog, in display order. */
export type ReportStyleId = "editorial" | "terminal" | "swiss";

/** The style new requests use when the client does not name one. */
export const DEFAULT_REPORT_STYLE: ReportStyleId = "editorial";

/** One style's full configuration: user-facing text, directive, and CSS. */
export interface ReportStyleConfig {
  id: ReportStyleId;
  /** Short label on the style picker. */
  label: string;
  /** One-line description surfaced in the picker and its tooltip. */
  tagline: string;
  /**
   * The complete stylesheet the report must include verbatim in its single
   * <style> block. Authored here, not by the model, so the style is stable.
   */
  css: string;
  /**
   * Short design direction in the prompt: how to use the stylesheet's
   * vocabulary and any style-specific content manner.
   */
  directive: string;
}

export const REPORT_STYLES: readonly ReportStyleConfig[] = [
  {
    id: "editorial",
    label: "Editorial",
    tagline: "Warm print-magazine feature",
    directive: [
      "The report reads like a print-magazine feature on warm paper: serif body text, a serif display",
      "headline, small uppercase sans-serif section labels, hairline rules, and one terracotta accent.",
      "The stylesheet below defines the whole design — include it verbatim and do not restyle it.",
    ].join("\n"),
    css: `:root {
  --paper: #f9f6f0;
  --ink: #26221c;
  --muted: #6f675c;
  --rule: #ddd5c8;
  --accent: #b0512c;
  --accent-soft: #f0e4da;
}

* { box-sizing: border-box; }

html { background: var(--paper); }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
  font-size: 1.0625rem;
  line-height: 1.75;
  text-rendering: optimizeLegibility;
}

.page {
  width: min(100% - 2.5rem, 34em);
  margin: 0 auto;
  padding: 4.5rem 0 6rem;
}

header { border-bottom: 1px solid var(--rule); padding-bottom: 2.25rem; }

.eyebrow {
  margin: 0 0 1.1rem;
  color: var(--accent);
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

h1, h2, h3 { margin: 0; color: var(--ink); font-weight: 700; line-height: 1.15; }

h1 {
  margin-bottom: 1rem;
  font-size: clamp(2.1rem, 7vw, 3.2rem);
  letter-spacing: -0.03em;
}

.dek { margin: 0; color: var(--muted); font-size: 1.13rem; line-height: 1.55; font-style: italic; }

.report-meta {
  margin: 1.5rem 0 0;
  color: var(--muted);
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 0.76rem;
  line-height: 1.6;
}

section { margin-top: 3.5rem; }

h2 {
  margin-bottom: 1.5rem;
  padding-bottom: 0.6rem;
  border-bottom: 1px solid var(--rule);
  font-size: 1.55rem;
  letter-spacing: -0.015em;
}

h3 { margin: 2.25rem 0 0.5rem; font-size: 1.18rem; }

p { margin: 0 0 1.15rem; }
p:last-child { margin-bottom: 0; }

a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }

blockquote {
  margin: 1.75rem 0;
  padding: 0.25rem 0 0.25rem 1.5rem;
  border-left: 3px solid var(--accent);
}

blockquote p { font-size: 1.22rem; line-height: 1.6; font-style: italic; }

.quote-source {
  margin: 0.75rem 0 0;
  color: var(--muted);
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 0.78rem;
  font-style: normal;
}

ol, ul { margin: 0 0 1.15rem; padding-left: 1.5rem; }
li { margin-bottom: 0.6rem; }

.takeaways li { padding-left: 0.25rem; }
.takeaways li::marker { color: var(--accent); font-weight: 700; }

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  padding: 0.12em 0.7em;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: "Helvetica Neue", Arial, sans-serif;
  font-size: 0.74em;
  font-weight: 700;
  font-style: normal;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.source-chip-dot { width: 0.45em; height: 0.45em; border-radius: 999px; background: var(--accent); }

blockquote, li { break-inside: avoid; }

@media print {
  .page { padding-top: 2rem; }
  section { break-inside: auto; }
  h2 { break-after: avoid; }
}
`,
  },
  {
    id: "terminal",
    label: "Terminal",
    tagline: "Dark technical briefing",
    directive: [
      "The report reads like a dark technical briefing from a terminal: near-black slate background,",
      "monospaced uppercase section labels auto-numbered by the stylesheet, sans-serif body text,",
      "sharp corners, dotted separators, and one green accent. The stylesheet below defines the whole",
      "design — include it verbatim and do not restyle it.",
    ].join("\n"),
    css: `:root {
  --bg: #101419;
  --panel: #171d25;
  --ink: #d7e0ea;
  --muted: #8792a3;
  --rule: #2a3340;
  --accent: #3ecf8e;
  --accent-dim: rgba(62, 207, 142, 0.12);
}

* { box-sizing: border-box; }

html { background: var(--bg); }

body {
  margin: 0;
  counter-reset: section;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 1rem;
  line-height: 1.7;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.page {
  width: min(100% - 2.5rem, 36em);
  margin: 0 auto;
  padding: 3.5rem 0 5.5rem;
}

header { border-bottom: 1px dotted var(--rule); padding-bottom: 2rem; }

.eyebrow {
  margin: 0 0 0.9rem;
  color: var(--accent);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1, h2, h3 { margin: 0; color: var(--ink); font-weight: 650; line-height: 1.2; }

h1 {
  margin-bottom: 1rem;
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: clamp(1.6rem, 5.5vw, 2.4rem);
  letter-spacing: -0.02em;
}

.dek { margin: 0; color: var(--muted); font-size: 1.05rem; line-height: 1.6; }

.report-meta {
  margin: 1.4rem 0 0;
  color: var(--muted);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 0.74rem;
  line-height: 1.7;
}

section { margin-top: 3rem; }

h2 {
  display: flex;
  align-items: baseline;
  gap: 0.75em;
  margin-bottom: 1.4rem;
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 0.95rem;
  font-weight: 650;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  counter-increment: section;
}

h2::before {
  content: counter(section, decimal-leading-zero);
  color: var(--accent);
  font-size: 0.9em;
}

h2::after { content: ""; flex: 1; border-bottom: 1px dotted var(--rule); }

h3 { margin: 2rem 0 0.5rem; font-size: 1.05rem; }

p { margin: 0 0 1.05rem; }
p:last-child { margin-bottom: 0; }

a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--rule); }
a:hover { border-bottom-color: var(--accent); }

code {
  padding: 0.1em 0.4em;
  border-radius: 3px;
  background: var(--panel);
  color: var(--accent);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 0.88em;
}

blockquote {
  margin: 1.6rem 0;
  padding: 1rem 1.25rem;
  border-left: 2px solid var(--accent);
  background: var(--panel);
}

blockquote p { color: var(--ink); font-size: 1.02rem; }

.quote-source {
  margin: 0.7rem 0 0;
  color: var(--muted);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 0.72rem;
}

ol, ul { margin: 0 0 1.05rem; padding-left: 1.6rem; }
li { margin-bottom: 0.55rem; }

.takeaways li::marker { color: var(--accent); font-family: ui-monospace, Menlo, monospace; font-weight: 700; }

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  padding: 0.15em 0.65em;
  border: 1px solid var(--rule);
  border-radius: 3px;
  background: var(--panel);
  color: var(--accent);
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  font-size: 0.72em;
  font-weight: 600;
  font-style: normal;
  white-space: nowrap;
}

.source-chip-dot { width: 0.45em; height: 0.45em; border-radius: 1px; background: var(--accent); }

blockquote, li { break-inside: avoid; }

@media print {
  .page { padding-top: 2rem; }
  h2 { break-after: avoid; }
}
`,
  },
  {
    id: "swiss",
    label: "Swiss",
    tagline: "Clean minimal memo",
    directive: [
      "The report reads like a modern Swiss-style memo: white page, near-black grotesque sans-serif",
      "type, huge tight-tracked headline, numbered section headings on thin rules, generous whitespace,",
      "and one vermilion accent doing all the color work. The stylesheet below defines the whole",
      "design — include it verbatim and do not restyle it.",
    ].join("\n"),
    css: `:root {
  --bg: #ffffff;
  --ink: #141414;
  --muted: #6b6b6b;
  --rule: #e3e3e3;
  --accent: #dd3311;
}

* { box-sizing: border-box; }

html { background: var(--bg); }

body {
  margin: 0;
  counter-reset: section;
  background: var(--bg);
  color: var(--ink);
  font-family: "Helvetica Neue", Helvetica, "Segoe UI", Arial, sans-serif;
  font-size: 1rem;
  line-height: 1.7;
}

.page {
  width: min(100% - 2.5rem, 36em);
  margin: 0 auto;
  padding: 4.5rem 0 6rem;
}

header { border-bottom: 2px solid var(--ink); padding-bottom: 2.25rem; }

.eyebrow {
  margin: 0 0 1.2rem;
  color: var(--accent);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

h1, h2, h3 { margin: 0; color: var(--ink); font-weight: 700; line-height: 1.1; }

h1 {
  margin-bottom: 1.1rem;
  font-size: clamp(2.2rem, 8vw, 3.4rem);
  letter-spacing: -0.045em;
}

.dek { margin: 0; color: var(--muted); font-size: 1.1rem; line-height: 1.55; }

.report-meta {
  margin: 1.6rem 0 0;
  color: var(--muted);
  font-size: 0.75rem;
  line-height: 1.6;
  letter-spacing: 0.03em;
}

section { margin-top: 3.25rem; }

h2 {
  display: flex;
  align-items: baseline;
  gap: 0.9em;
  margin-bottom: 1.4rem;
  padding-top: 0.9rem;
  border-top: 1px solid var(--rule);
  font-size: 1.05rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  counter-increment: section;
}

h2::before { content: counter(section) "."; color: var(--accent); }

h3 { margin: 2.1rem 0 0.5rem; font-size: 1.1rem; letter-spacing: -0.01em; }

p { margin: 0 0 1.1rem; }
p:last-child { margin-bottom: 0; }

a { color: var(--ink); text-decoration-color: var(--accent); text-decoration-thickness: 2px; text-underline-offset: 3px; }

blockquote {
  margin: 1.9rem 0;
  padding: 0.2rem 0 0.2rem 1.4rem;
  border-left: 4px solid var(--accent);
}

blockquote p { font-size: 1.25rem; font-weight: 500; letter-spacing: -0.015em; line-height: 1.5; }

.quote-source {
  margin: 0.8rem 0 0;
  color: var(--muted);
  font-size: 0.75rem;
  letter-spacing: 0.02em;
}

ol, ul { margin: 0 0 1.1rem; padding-left: 1.5rem; }
li { margin-bottom: 0.6rem; }

.takeaways li::marker { color: var(--accent); font-weight: 700; }

.source-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.45em;
  padding: 0.18em 0.6em;
  border: 1px solid var(--ink);
  color: var(--ink);
  font-size: 0.72em;
  font-weight: 600;
  font-style: normal;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.source-chip-dot { width: 0.42em; height: 0.42em; background: var(--accent); }

blockquote, li { break-inside: avoid; }

@media print {
  .page { padding-top: 2rem; }
  h2 { break-after: avoid; }
}
`,
  },
];

/** Type guard for untrusted style values (request bodies, database rows). */
export function isReportStyleId(value: unknown): value is ReportStyleId {
  return REPORT_STYLES.some((style) => style.id === value);
}

/** Resolves a validated style id to its full configuration. */
export function getReportStyle(id: ReportStyleId): ReportStyleConfig {
  const style = REPORT_STYLES.find((style) => style.id === id);
  if (!style) {
    throw new RangeError(`Unknown report style: ${String(id)}`);
  }
  return style;
}
