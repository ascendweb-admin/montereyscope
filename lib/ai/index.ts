/**
 * AI integration domain layer (stages 1–7: scope, materialization, Codex
 * adapter, chat persistence + streaming, HTML report jobs, hardening) —
 * server-only. Never import these modules from client components.
 */
export {
  createSourceScopeReader,
  createTranscriptScopeReader,
  resolveScope,
  resolveSourceScope,
} from "./scope";
export type {
  ScopeResolution,
  ScopedSource,
  ScopedVideo,
  SourceScopeReader,
  SourceScopeResolution,
  TranscriptScopeReader,
} from "./scope";
export {
  createSourceMaterializer,
  createTranscriptMaterializer,
  DEFAULT_MAX_MATERIALIZED_BYTES,
  materializeSources,
  materializeTranscripts,
  maxMaterializedBytes,
  renderTweetFile,
  TRUNCATION_MARKER,
} from "./materialize";
export type {
  ExclusionReason,
  ExcludedVideo,
  MaterializeManifest,
  MaterializeOptions,
  MaterializeOutcome,
  MaterializedSourceFile,
  MaterializedTranscriptFile,
  MaterializeTruncation,
  SourceExclusionReason,
  SourceMaterializationManifest,
  SourceMaterializeOutcome,
  SourceMaterializer,
  SourceTruncation,
  TranscriptMaterializer,
} from "./materialize";
export {
  acquireChatTurnLock,
  buildFirstTurnPrompt,
  buildModeSwitchInstruction,
  buildModeSwitchPrompt,
  buildSystemInstruction,
  streamChatTurn,
  SYSTEM_INSTRUCTION,
} from "./chat";
export type { ChatDeps, ChatErrorCode, ChatStreamEvent, ChatTurnCommand } from "./chat";
export { CHAT_MODES, DEFAULT_CHAT_MODE, getChatMode, isChatModeId } from "./chat-modes";
export type { ChatModeConfig, ChatModeId } from "./chat-modes";
export {
  DEFAULT_REPORT_PROFILE,
  getReportProfile,
  isReportProfileId,
  REPORT_PROFILES,
} from "./report-profiles";
export type { ReportProfileConfig, ReportProfileId } from "./report-profiles";
export {
  DEFAULT_REPORT_STYLE,
  getReportStyle,
  isReportStyleId,
  REPORT_STYLES,
} from "./report-styles";
export type { ReportStyleConfig, ReportStyleId } from "./report-styles";
export {
  appendMessage,
  createThread,
  deleteThread,
  getThread,
  listMessages,
  listThreads,
  setThreadCodexSession,
  setThreadMode,
} from "./threads";
export type { AiMessage, AiMessageRole, AiThread, AiThreadSummary } from "./threads";
export {
  backfillReportTitles,
  buildReportPrompt,
  canTransitionReport,
  closeReportQueue,
  createReport,
  createReportQueue,
  deleteReport,
  extractReportMeta,
  findReportFile,
  getReport,
  getReportQueue,
  getReportSources,
  getReportVideos,
  listReports,
  publicReportFor,
  recoverStalledReports,
  renameReport,
  REPORT_FILE_NAME,
  REPORT_INSTRUCTION,
  REPORT_TITLE_MAX_LENGTH,
  RESTARTED_WHILE_RUNNING_ERROR,
  runReportJob,
  ReportStateError,
  toPublicReport,
  transitionReport,
} from "./reports";
export type {
  AiReport,
  AiReportStatus,
  PublicReport,
  ReportJobDeps,
  ReportMeta,
  ReportOptions,
  ReportQueue,
  ReportScopeInput,
  ReportSource,
  ReportVideo,
} from "./reports";
export {
  MAX_SCOPE_SOURCES,
  MAX_SCOPE_VIDEOS,
  formatScopeCapMessage,
  formatSkippedSources,
  planChatScope,
  planSourceScope,
} from "./scope-selection";
export type { ScopeCandidate, ScopePlan, SourceCandidate, SourcePlan } from "./scope-selection";
