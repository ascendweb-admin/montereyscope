import type {
  AnalysisConfig,
  AnalysisPhase,
  BatchInput,
  CorpusPost,
  ScanUnit,
  AnalysisBatch,
} from "./analysis-model";
import { digest } from "./corpus";
import { analysisPrompt } from "./analysis-prompts";
import { ResearchInputError } from "./input";

/** Deliberately conservative in the absence of provider tokenizers. */
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 2);
export function batchIdentity(
  config: AnalysisConfig,
  phase: AnalysisPhase,
  input: BatchInput,
): string {
  // Attempt resource budgets do not affect compatibility; context/output and
  // reasoning settings do. Never cache by question or final citation ids alone.
  return digest({
    question: config.question,
    conversation: config.conversation,
    strategy: config.strategy,
    mode: config.mode,
    backend: config.backend,
    model: config.model,
    effort: config.reasoningEffort,
    promptVersion: config.promptVersion,
    context: config.limits.contextTokens,
    inputTokens: config.limits.inputTokens,
    outputTokens: config.limits.outputTokens,
    phase,
    input,
  });
}
export function makeBatch(
  config: AnalysisConfig,
  phase: AnalysisPhase,
  input: BatchInput,
  ordinal: number,
): AnalysisBatch {
  const key = batchIdentity(config, phase, input);
  return {
    key: `${phase}:${ordinal}:${key}`,
    cacheKey: key,
    phase,
    ordinal,
    input,
    status: "pending",
    attempts: 0,
    result: null,
    error: null,
  };
}
export function fits(config: AnalysisConfig, phase: AnalysisPhase, input: BatchInput): boolean {
  const tokens = estimateTokens(analysisPrompt(config, phase, input));
  const output =
    phase === "scan"
      ? (input.units?.length ?? 0) * 600
      : phase === "verify"
        ? (input.candidates?.length ?? 0) * 200
        : estimateTokens(JSON.stringify(input.findings ?? [])) + 256;
  return (
    tokens <= config.limits.inputTokens &&
    tokens + config.limits.outputTokens + 1024 <= config.limits.contextTokens &&
    output <= config.limits.outputTokens
  );
}
function splitString(value: string): [string, string] {
  const chars = Array.from(value);
  const mid = Math.ceil(chars.length / 2);
  return [chars.slice(0, mid).join(""), chars.slice(mid).join("")];
}
/** No text slicing away: split the largest field, preserving quote/parent roles. */
export function splitUnit(unit: ScanUnit): ScanUnit[] {
  const sizes = [
    unit.source.text.length,
    unit.source.quoted?.text.length ?? 0,
    unit.source.context?.text.length ?? 0,
  ];
  const largest = Math.max(...sizes);
  if (largest <= 1)
    throw new ResearchInputError(
      "Source metadata exceeds the model input budget. Increase the input/context budget or narrow the scope.",
    );
  const a = structuredClone(unit),
    b = structuredClone(unit);
  if (sizes[0] === largest) {
    [a.source.text, b.source.text] = splitString(unit.source.text);
    b.source.quoted = null;
    b.source.context = null;
  } else if (sizes[1] === largest) {
    [a.source.quoted!.text, b.source.quoted!.text] = splitString(unit.source.quoted!.text);
    b.source.text = "";
    b.source.context = null;
  } else {
    [a.source.context!.text, b.source.context!.text] = splitString(unit.source.context!.text);
    b.source.text = "";
    b.source.quoted = null;
  }
  return [a, b];
}
export function postUnits(config: AnalysisConfig, post: CorpusPost): ScanUnit[] {
  const initial: ScanUnit = {
    id: post.tweet.id,
    postId: post.tweet.id,
    version: post.version,
    creatorId: post.tweet.creatorId,
    segment: 1,
    segments: 1,
    source: {
      author: post.tweet.authorHandle,
      publishedAt: post.tweet.publishedAt,
      eventAt: post.eventAt,
      postType: post.postType,
      provenance: post.provenance,
      text: post.tweet.text,
      quoted: post.tweet.quoted
        ? { author: post.tweet.quoted.handle, text: post.tweet.quoted.text }
        : null,
      context: post.context,
      mediaAnalyzed: false,
    },
  };
  const pending = [initial],
    ready: ScanUnit[] = [];
  while (pending.length) {
    const unit = pending.shift()!;
    // Reserve digits for segment labels that grow after splitting.
    if (
      fits(config, "scan", {
        units: [
          { ...unit, id: `${unit.postId}:segment:999999`, segment: 999999, segments: 999999 },
        ],
      })
    )
      ready.push(unit);
    else pending.unshift(...splitUnit(unit));
  }
  return ready.map((unit, index) => ({
    ...unit,
    id: `${post.tweet.id}:segment:${index + 1}`,
    segment: index + 1,
    segments: ready.length,
  }));
}
export function planScan(config: AnalysisConfig, posts: Iterable<CorpusPost>): AnalysisBatch[] {
  const batches: AnalysisBatch[] = [];
  let group: ScanUnit[] = [];
  const flush = () => {
    if (group.length) batches.push(makeBatch(config, "scan", { units: group }, batches.length));
    group = [];
  };
  for (const post of posts) {
    for (const unit of postUnits(config, post)) {
      if (
        group.length &&
        (group[0].creatorId !== unit.creatorId ||
          !fits(config, "scan", { units: [...group, unit] }))
      )
        flush();
      group.push(unit);
    }
  }
  flush();
  return batches;
}
export function packInputs<T>(
  config: AnalysisConfig,
  phase: AnalysisPhase,
  items: T[],
  build: (items: T[]) => BatchInput,
): BatchInput[] {
  const result: BatchInput[] = [];
  let group: T[] = [];
  for (const item of items) {
    if (group.length && !fits(config, phase, build([...group, item]))) {
      result.push(build(group));
      group = [];
    }
    if (!fits(config, phase, build([item])))
      throw new ResearchInputError(
        "An evidence finding exceeds the configured model budget. Increase input/output limits and Resume.",
      );
    group.push(item);
  }
  if (group.length) result.push(build(group));
  return result;
}
