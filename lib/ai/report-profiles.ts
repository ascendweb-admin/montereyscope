/**
 * Report depth profiles — the one place that defines what each kind of
 * generated report is. A profile is not just a length knob: like the chat
 * intelligence modes, each pairs a different codex model and reasoning effort
 * with its own writing brief (voice, required sections, how hard to dig), so
 * a Brief report genuinely reads in a few minutes instead of being a trimmed
 * Deep report.
 *
 * This module is pure data — no Node imports — so the client can keep its own
 * mirror of the user-facing fields without importing the server-only AI
 * layer; a unit test pins the two sides together.
 */

/** The report profiles offered in the Generate-report dialog, in display order. */
export type ReportProfileId = "brief" | "balanced" | "deep";

/** The profile new requests use when the client does not name one. */
export const DEFAULT_REPORT_PROFILE: ReportProfileId = "balanced";

/** One profile's full configuration: user-facing text plus codex run settings. */
export interface ReportProfileConfig {
  id: ReportProfileId;
  /** Short label on the profile picker. */
  label: string;
  /** One-line description surfaced in the picker and its tooltip. */
  tagline: string;
  /** Codex model for this report. */
  model: string;
  /** Codex reasoning effort for this report. */
  reasoningEffort: string;
  /** Claude Code model for this report (public catalog id). */
  claudeModel: string;
  /** Claude Code effort for this report; null when the model has none. */
  claudeReasoningEffort: string | null;
  /** Hard ceiling for the whole run; faster profiles fail faster. */
  timeoutMs: number;
  /**
   * The profile's writing brief, injected into the report prompt: what the
   * report covers, in which voice, and its required sections in order.
   */
  directive: string;
}

const MINUTE_MS = 60_000;

export const REPORT_PROFILES: readonly ReportProfileConfig[] = [
  {
    id: "brief",
    label: "Brief",
    tagline: "A relaxed overview to stay up to date",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    // Claude has no effort control on Haiku; the other profiles mirror the
    // chat modes' Claude ladder (Sonnet/Opus).
    claudeModel: "claude-haiku",
    claudeReasoningEffort: null,
    timeoutMs: 8 * MINUTE_MS,
    directive: [
      "Write a brief, relaxed read — the kind of overview someone enjoys with coffee to stay current,",
      "not a work document. Plain, warm, confident prose; short paragraphs; no jargon without a quick",
      "gloss. Surface what happened, why it matters, and the handful of things worth remembering.",
      "Skip exhaustive analysis, caveats, and hedging: prefer the clear main thread over completeness,",
      "and stay honest when the sources are thin rather than padding.",
      "",
      "Required sections, in this order:",
      "1. The short version — a one-paragraph overview that stands on its own.",
      "2. What's going on — two to four short subsections, one per main thread across the sources.",
      "3. Worth hearing — two or three of the most telling quotes, as pull-quotes.",
      "4. What to watch — a short closing paragraph on what seems likely to matter next.",
    ].join("\n"),
  },
  {
    id: "balanced",
    label: "Balanced",
    tagline: "The everyday analyst report",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
    claudeModel: "claude-sonnet",
    claudeReasoningEffort: "medium",
    timeoutMs: 15 * MINUTE_MS,
    directive: [
      "Write a grounded analyst report at everyday depth: the main findings, clearly organized and",
      "supported by the evidence, without exhaustive cross-referencing or tangents. Cover every",
      "selected source, but spend the words where the material is richest.",
      "",
      "Required sections, in this order:",
      "1. Executive overview — the few paragraphs a busy reader needs.",
      "2. Key themes — one subsection per theme, each with supporting evidence and the source chip naming the video it comes from.",
      "3. Notable quotes — exact quotes as pull-quotes, each attributed to its video.",
      "4. Actionable takeaways — concrete and numbered, each tied back to the evidence.",
    ].join("\n"),
  },
  {
    id: "deep",
    label: "Deep",
    tagline: "Everything the material has to give",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
    claudeModel: "claude-opus",
    claudeReasoningEffort: "xhigh",
    timeoutMs: 25 * MINUTE_MS,
    directive: [
      "Write a complete, rigorous brief that leaves nothing important behind: the reader should come",
      "away holding everything they would need to know from these transcripts without ever opening",
      "them. Read every source closely; cross-reference claims between videos; extract concrete",
      "technical detail — numbers, dates, names, mechanisms, and claims — always attributed to its",
      "video. Note contradictions between sources explicitly. Depth beats brevity, but every section",
      "must earn its length: no padding, no restating the same finding twice.",
      "",
      "Required sections, in this order:",
      "1. Executive overview — what the reader needs before anything else.",
      "2. Key themes — well-developed subsections, one per theme, each with supporting evidence and the source chip naming the video it comes from.",
      "3. Technical detail — the specifics a practitioner would ask about: figures, timelines, mechanisms, and how sources agree or disagree on them.",
      "4. Notable quotes — exact quotes as pull-quotes, each attributed to its video.",
      "5. Points of tension — where sources disagree, conflict, or leave questions open.",
      "6. Actionable takeaways — concrete and numbered, each tied back to the evidence.",
      "7. Source-by-source notes — one subsection per selected video, distilling what that transcript alone contributes to the picture.",
    ].join("\n"),
  },
];

/** Type guard for untrusted profile values (request bodies, database rows). */
export function isReportProfileId(value: unknown): value is ReportProfileId {
  return REPORT_PROFILES.some((profile) => profile.id === value);
}

/** Resolves a validated profile id to its full configuration. */
export function getReportProfile(id: ReportProfileId): ReportProfileConfig {
  const profile = REPORT_PROFILES.find((profile) => profile.id === id);
  if (!profile) {
    throw new RangeError(`Unknown report profile: ${String(id)}`);
  }
  return profile;
}
