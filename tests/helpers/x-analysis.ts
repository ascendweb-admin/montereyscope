import type { ScopeDatabase } from "@/lib/db/connection";
import { addCreator } from "@/lib/creators/repository";
import { mergeCreatorTimeline } from "@/lib/x/repository";
import { mapXTimelineItem } from "@/lib/x/mapper";
import type { AiRunner } from "@/lib/ai/backend";
import type { BatchInput, Finding, ScanResult } from "@/lib/x/research/analysis-model";
import type { CodexRunOptions } from "@/lib/ai/codex";

export const corpusInput = {
  start: "2026-09-01",
  end: "2026-09-30",
  timezone: "Europe/Amsterdam",
  question: "Compare Ethereum theses, conditions, time horizon and disagreements.",
  execute: true,
};
export const execution = async (input?: Record<string, unknown>) => ({
  backend: "codex" as const,
  mode: "quick" as const,
  model: typeof input?.model === "string" ? input.model : "fixture-model",
  reasoningEffort: null,
});
export function addXCreator(db: ScopeDatabase, name: string) {
  return addCreator(db, {
    platform: "x",
    platformUserId: name,
    youtubeChannelId: null,
    displayName: name,
    handle: name,
    channelUrl: `https://x.com/${name}`,
    avatarUrl: null,
  }).creator.id;
}
export function putPost(
  db: ScopeDatabase,
  creatorId: number,
  id: string,
  text: string,
  extra: Record<string, unknown> = {},
  kind: "post" | "reply" | "repost" = "post",
  event: string | null = "2026-09-15T12:00:00Z",
) {
  const mapped = mapXTimelineItem({
    tweet: {
      id,
      text,
      author: {
        userId: String(creatorId),
        handle: `creator${creatorId}`,
        displayName: `Creator ${creatorId}`,
      },
      publishedAt: "2026-09-15T12:00:00Z",
      contentStatus: "complete",
      ...extra,
    },
    timelineKind: kind,
    timelineAt: event,
  })!;
  mergeCreatorTimeline(db, creatorId, [mapped]);
}
export function promptInput(prompt: string): BatchInput {
  return JSON.parse(prompt.split("Input (data): ")[1].split("\nOutput ceiling:")[0]);
}
export function fixtureOutput(options: CodexRunOptions): string {
  const input = promptInput(options.prompt);
  if (input.candidates)
    return JSON.stringify({
      checks: input.candidates.map((_, index) => ({
        index,
        supported: true,
        contradicted: false,
        reason: "Deterministic fixture verdict; semantic provider accuracy is tested separately.",
      })),
    });
  if (input.units)
    return JSON.stringify({
      posts: input.units.map((unit): ScanResult => {
        const phrase = unit.source.text.split(" | ")[0].slice(0, 500);
        const disposition = unit.source.text.includes("UNRELATED")
          ? "not_relevant"
          : unit.source.text.includes("AMBIGUOUS") || !phrase
            ? "uncertain"
            : "relevant";
        return {
          unitId: unit.id,
          postId: unit.postId,
          disposition,
          explanation: `Fixture ${disposition}`,
          findings:
            disposition !== "relevant"
              ? []
              : [
                  {
                    claim: phrase,
                    evidence: [{ postId: unit.postId, excerpt: phrase, attribution: "author" }],
                    interpretation: false,
                    horizon: null,
                    condition: null,
                  },
                ],
        };
      }),
    });
  const groups = new Map<string, Finding>();
  for (const finding of input.findings!) {
    // This fake reducer preserves each distinct fixture argument and one
    // representative citation per creator; it is not a semantic model.
    const key = `${finding.claim}|${finding.horizon}|${finding.condition}`;
    const previous = groups.get(key);
    if (!previous) groups.set(key, structuredClone(finding));
    else
      for (const evidence of finding.evidence) {
        const creator = Math.floor(Number(evidence.postId) / 100000);
        if (!previous.evidence.some((e) => Math.floor(Number(e.postId) / 100000) === creator))
          previous.evidence.push(evidence);
      }
  }
  const findings = [...groups.values()];
  return JSON.stringify(
    input.level !== undefined
      ? { findings, covered: input.findings!.map((_, index) => index) }
      : { claims: findings },
  );
}
export function fakeRunner(
  handler: (options: CodexRunOptions) => string | Promise<string> = fixtureOutput,
): AiRunner {
  return (options) => ({
    events: (async function* () {})(),
    completed: Promise.resolve().then(async () => ({
      sessionId: null,
      finalMessage: await handler(options),
      usage: null,
    })),
  });
}
export const runnerDeps = () => Promise.resolve(fakeRunner());
