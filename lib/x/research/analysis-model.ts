import type { AiBackendId } from "@/lib/ai/backend-id";
import type { ChatModeId } from "@/lib/ai/chat-modes";
import type { ResearchPost, ResearchPostType, ExactSearch, CachedFeed } from "./model";
import { ResearchInputError } from "./input";

export const ANALYSIS_PROMPT_VERSION = "x-full-scan-v1";
export type AnalysisStatus =
  | "queued"
  | "running"
  | "waiting_for_provider"
  | "paused"
  | "partial"
  | "failed"
  | "cancelled"
  | "complete";
export type AnalysisPhase = "scan" | "reduce" | "synthesize" | "verify";
export type Disposition = "relevant" | "not_relevant" | "uncertain";
export type Exclusion = "missing_date" | "incomplete_text" | "missing_text";
export interface CorpusRequest {
  listId: number | null;
  creatorIds: number[];
  timezone: string;
  since: string;
  until: string;
  types: ResearchPostType[];
  selection:
    | { kind: "all" }
    | { kind: "exact"; search: ExactSearch }
    | { kind: "selected"; tweetIds: string[] };
}
export interface CorpusSummary {
  total: number;
  eligible: number;
  excluded: Record<Exclusion, number>;
  bytes: number;
  creators: Array<{ id: number; name: string; handle: string | null }>;
  coverage: CachedFeed["coverage"];
  retrieval: Array<{ creatorId: number; config: string; lane: string; state: unknown }>;
  limitations: string[];
}
export interface CorpusScope {
  id: string;
  createdAt: string;
  request: CorpusRequest;
  summary: CorpusSummary;
}
export interface CorpusPost extends ResearchPost {
  version: string;
  exclusion: Exclusion | null;
  context: {
    id: string;
    author: string;
    text: string;
    publishedAt: string | null;
    role: "context_only";
  } | null;
}
/** These are conservative execution ceilings, not claims about provider capacity.
 * The CLI catalog does not currently publish context/output capabilities. A
 * smaller real provider limit triggers durable splitting; larger values require
 * an explicit configuration. */
export interface AnalysisLimits {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  maxCalls: number;
  maxTokens: number;
  timeoutMs: number;
  maxRunMs: number;
  maxSnapshotBytes: number;
  retries: number;
}
export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = {
  contextTokens: 32768,
  inputTokens: 8000,
  outputTokens: 8000,
  maxCalls: 200,
  maxTokens: 2_000_000,
  timeoutMs: 300_000,
  maxRunMs: 3_600_000,
  maxSnapshotBytes: 256 * 1024 * 1024,
  retries: 2,
};
const bounds: Record<keyof AnalysisLimits, [number, number]> = {
  contextTokens: [2048, 1_000_000],
  inputTokens: [512, 128000],
  outputTokens: [512, 64000],
  maxCalls: [1, 10000],
  maxTokens: [1000, 100_000_000],
  timeoutMs: [1000, 900000],
  maxRunMs: [1000, 86_400_000],
  maxSnapshotBytes: [1024, 1024 * 1024 * 1024],
  retries: [0, 5],
};
export function analysisLimits(value: unknown, base = DEFAULT_ANALYSIS_LIMITS): AnalysisLimits {
  if (value === undefined) return { ...base };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ResearchInputError("Provide valid analysis limits.");
  const result = { ...base };
  for (const [key, raw] of Object.entries(value)) {
    if (!(key in bounds)) throw new ResearchInputError(`Unknown analysis limit: ${key}.`);
    const field = key as keyof AnalysisLimits;
    const [min, max] = bounds[field];
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max)
      throw new ResearchInputError(`${key} must be between ${min} and ${max}.`);
    result[field] = raw;
  }
  if (result.inputTokens + result.outputTokens + 1024 > result.contextTokens)
    throw new ResearchInputError("Reserve context space for instructions and output.");
  return result;
}
export interface AnalysisConfig {
  question: string;
  conversation?: { question: string; answer: string | null; abridged?: boolean };
  strategy: "full_scan";
  mode: ChatModeId;
  backend: AiBackendId;
  model: string;
  reasoningEffort: string | null;
  promptVersion: string;
  limits: AnalysisLimits;
}
export interface AnalysisState {
  status: AnalysisStatus;
  phase: AnalysisPhase;
  reason: string | null;
  calls: number;
  chargedTokens: number;
  reportedTokens: number;
  usageReportedCalls: number;
  reusedBatches: number;
  estimatedBatches: number;
  estimatedTokens: number;
  result: AnalysisAnswer | null;
}
export interface AnalysisJob {
  id: string;
  scopeId: string;
  createdAt: string;
  updatedAt: string;
  config: AnalysisConfig;
  state: AnalysisState;
  scope: CorpusSummary;
  progress: {
    reviewed: number;
    relevant: number;
    uncertain: number;
    unfinished: number;
    completedBatches: number;
    unfinishedBatches: number;
    creators: Array<{ id: number; total: number; reviewed: number }>;
  };
}
export interface Evidence {
  postId: string;
  excerpt: string;
  attribution: "author" | "quoted";
}
export interface Finding {
  claim: string;
  evidence: Evidence[];
  interpretation: boolean;
  horizon: string | null;
  condition: string | null;
}
export interface PostResult {
  postId: string;
  disposition: Disposition;
  explanation: string;
  findings: Finding[];
}
export interface ScanUnit {
  id: string;
  postId: string;
  version: string;
  creatorId: number;
  segment: number;
  segments: number;
  source: {
    author: string;
    publishedAt: string | null;
    eventAt: string;
    postType: ResearchPostType;
    provenance: ResearchPost["provenance"];
    text: string;
    quoted: { author: string | null; text: string } | null;
    context: CorpusPost["context"];
    mediaAnalyzed: false;
  };
}
export interface ScanResult extends PostResult {
  unitId: string;
}
export interface AnalysisAnswer {
  text: string;
  claims: Finding[];
  scopeNote: string;
  verified: true;
}
export interface BatchInput {
  units?: ScanUnit[];
  findings?: Finding[];
  candidates?: Finding[];
  candidateIndices?: number[];
  answerText?: string;
  level?: number;
  creatorId?: number;
}
export interface AnalysisBatch {
  key: string;
  phase: AnalysisPhase;
  ordinal: number;
  cacheKey: string;
  input: BatchInput;
  status: "pending" | "running" | "complete" | "superseded" | "failed";
  attempts: number;
  result: unknown;
  error: string | null;
}
