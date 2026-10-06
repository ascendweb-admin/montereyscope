import type { AnalysisConfig, BatchInput, Evidence, Finding, ScanResult } from "./analysis-model";
import { estimateTokens } from "./analysis-planner";

export class AnalysisOutputError extends Error {}
const fail = (message: string): never => {
  throw new AnalysisOutputError(message);
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    return fail("Missing or overlong result text.");
  return value.trim();
}
function dimension(value: unknown): string | null {
  return value === null ? null : text(value, 1000);
}
export function parseAnalysisOutput(raw: string, config: AnalysisConfig): Record<string, unknown> {
  if (estimateTokens(raw) > config.limits.outputTokens)
    fail("The structured result exceeds its output budget.");
  try {
    return object(JSON.parse(raw));
  } catch (error) {
    if (error instanceof AnalysisOutputError) throw error;
    return fail("The provider did not return valid structured JSON.");
  }
}
export function evidenceIdentity(evidence: Evidence): string {
  return JSON.stringify(evidence);
}
export type EvidenceLookup = (
  postId: string,
  attribution: Evidence["attribution"],
) => string | null;
export function validateFindings(
  value: unknown,
  lookup: EvidenceLookup,
  allowed?: Set<string>,
): Finding[] {
  if (!Array.isArray(value)) return fail("Missing findings array.");
  return value.map((item): Finding => {
    const row = object(item);
    if (
      typeof row.interpretation !== "boolean" ||
      !Array.isArray(row.evidence) ||
      !row.evidence.length ||
      row.evidence.length > 30
    )
      return fail("Every finding needs bounded original evidence and an interpretation flag.");
    const evidence = row.evidence.map((item): Evidence => {
      const ref = object(item);
      if (typeof ref.postId !== "string" || !["author", "quoted"].includes(String(ref.attribution)))
        return fail("Invalid evidence reference.");
      if (typeof ref.excerpt !== "string" || !ref.excerpt.trim() || ref.excerpt.length > 1000)
        return fail("Invalid supporting excerpt.");
      const e: Evidence = {
        postId: ref.postId,
        excerpt: ref.excerpt,
        attribution: ref.attribution as Evidence["attribution"],
      };
      const original = lookup(e.postId, e.attribution);
      if (original === null || !original.includes(e.excerpt))
        return fail("Evidence is not supported by an in-scope original excerpt.");
      if (allowed && !allowed.has(evidenceIdentity(e)))
        return fail("The reduction or answer invented evidence outside its manifest.");
      return e;
    });
    return {
      claim: text(row.claim),
      evidence,
      interpretation: row.interpretation,
      horizon: dimension(row.horizon),
      condition: dimension(row.condition),
    };
  });
}
export function validateScan(output: Record<string, unknown>, input: BatchInput): ScanResult[] {
  const units = input.units!;
  if (!Array.isArray(output.posts) || output.posts.length !== units.length)
    return fail("The batch did not account for every supplied segment.");
  const seen = new Set<string>();
  return output.posts.map((item): ScanResult => {
    const row = object(item);
    const unit = units.find((unit) => unit.id === row.unitId);
    if (!unit || seen.has(unit.id) || row.postId !== unit.postId)
      return fail("Unknown, duplicate or mismatched source disposition.");
    seen.add(unit.id);
    if (!["relevant", "not_relevant", "uncertain"].includes(String(row.disposition)))
      return fail("Invalid post disposition.");
    const findings = validateFindings(row.findings, (id, attribution) =>
      id !== unit.postId
        ? null
        : attribution === "author"
          ? unit.source.text
          : (unit.source.quoted?.text ?? null),
    );
    if (row.disposition === "relevant" && !findings.length)
      return fail("A relevant post needs source-supported findings.");
    if (row.disposition === "not_relevant" && findings.length)
      return fail("An irrelevant post cannot carry findings.");
    return {
      unitId: unit.id,
      postId: unit.postId,
      disposition: row.disposition as ScanResult["disposition"],
      explanation: text(row.explanation),
      findings,
    };
  });
}
export function validateReduction(
  output: Record<string, unknown>,
  input: BatchInput,
  lookup: EvidenceLookup,
): { findings: Finding[]; covered: number[] } {
  const sources = input.findings!;
  const covered = output.covered;
  if (
    !Array.isArray(covered) ||
    covered.length !== sources.length ||
    new Set(covered).size !== sources.length ||
    covered.some((n) => !Number.isInteger(n) || n < 0 || n >= sources.length)
  )
    return fail("Reduction omitted input findings from its coverage manifest.");
  const allowed = new Set(sources.flatMap((f) => f.evidence.map(evidenceIdentity)));
  const findings = validateFindings(output.findings, lookup, allowed);
  if (sources.length && !findings.length) return fail("Reduction discarded all findings.");
  return { findings, covered };
}
export function validateSynthesis(
  output: Record<string, unknown>,
  input: BatchInput,
  lookup: EvidenceLookup,
): { claims: Finding[] } {
  const allowed = new Set(input.findings!.flatMap((f) => f.evidence.map(evidenceIdentity)));
  const claims = validateFindings(output.claims, lookup, allowed);
  if (input.findings!.length && !claims.length) return fail("Synthesis discarded every finding.");
  return { claims };
}
export function validateVerification(
  output: Record<string, unknown>,
  input: BatchInput,
): { checks: Array<{ index: number; supported: boolean; contradicted: boolean; reason: string }> } {
  if (!Array.isArray(output.checks) || output.checks.length !== input.candidates!.length)
    return fail("Source verification omitted claims.");
  const seen = new Set<number>();
  return {
    checks: output.checks.map((item) => {
      const row = object(item);
      const index = row.index;
      if (
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= input.candidates!.length ||
        seen.has(index) ||
        typeof row.supported !== "boolean" ||
        typeof row.contradicted !== "boolean"
      )
        return fail("Invalid source verification verdict.");
      seen.add(index);
      return {
        index,
        supported: row.supported,
        contradicted: row.contradicted as boolean,
        reason: text(row.reason),
      };
    }),
  };
}
