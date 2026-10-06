/**
 * SQLite persistence for AI chat threads (stage 3). Server-only.
 *
 * Rows map the `ai_threads` and `ai_messages` tables created by migration
 * 002. A thread owns one provider session: `codexSessionId` is the session id
 * for `codex exec resume` / `opencode --session` / `claude --resume` (null
 * until the first turn completes; the column name is legacy and shared by
 * every backend) and `codexWorkDir` is the materialized transcript job
 * directory the session runs in. Timestamps are filled by SQLite defaults
 * and read back so stored values are authoritative.
 */
import type { ScopeDatabase } from "@/lib/db/connection";
import {
  decodeSourceRefs,
  encodeSourceRefs,
  sourceRefsToVideoIds,
  videoIdsToSourceRefs,
  type SourceRef,
} from "@/lib/content/model";

import { isAiBackendId, type AiBackendId } from "./backend-id";
import { DEFAULT_CHAT_MODE, isChatModeId, type ChatModeId } from "./chat-modes";

/** Matches the CHECK constraint on the ai_messages.role column. */
export type AiMessageRole = "system" | "user" | "assistant";

export interface AiThread {
  id: number;
  title: string;
  /** Active provider's session id for resume, or null until a turn completes. */
  codexSessionId: string | null;
  /** Absolute path of the transcript job directory used as the Codex work dir. */
  codexWorkDir: string;
  /** Requested video ids, in request order (parsed from JSON). */
  videoIds: string[];
  /** Mixed source selection, in request order (videos + tweets). */
  selectedSources: SourceRef[];
  /** Chat intelligence mode the conversation currently runs in. */
  mode: ChatModeId;
  /** AI CLI the session ids in this thread belong to (stage 9). */
  backend: AiBackendId;
  researchJobId?: string;
  researchScopeId?: string;
  createdAt: string;
}

export interface AiMessage {
  id: number;
  threadId: number;
  role: AiMessageRole;
  content: string;
  createdAt: string;
}

/** One thread in the history list, with activity counts but no message bodies. */
export interface AiThreadSummary {
  id: number;
  title: string;
  videoIds: string[];
  /** Mixed source selection, in request order (videos + tweets). */
  selectedSources: SourceRef[];
  messageCount: number;
  /** Chat intelligence mode the conversation currently runs in. */
  mode: ChatModeId;
  researchJobId?: string;
  researchScopeId?: string;
  createdAt: string;
  /** Timestamp of the newest message, or null when the thread has none. */
  lastMessageAt: string | null;
}

interface ThreadRow {
  id: number;
  title: string;
  codex_session_id: string | null;
  codex_work_dir: string;
  selected_video_ids: string;
  selected_sources: string | null;
  mode: string | null;
  backend: string | null;
  research_job_id?: string | null;
  research_scope_id?: string | null;
  created_at: string;
}

interface MessageRow {
  id: number;
  thread_id: number;
  role: AiMessageRole;
  content: string;
  created_at: string;
}

interface ThreadSummaryRow {
  id: number;
  title: string;
  selected_video_ids: string;
  selected_sources: string | null;
  mode: string | null;
  message_count: number;
  research_job_id?: string | null;
  research_scope_id?: string | null;
  created_at: string;
  last_message_at: string | null;
}

function parseVideoIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Mixed-source selection reader: new rows carry a versioned
 * `selected_sources` document; rows written before migration 013 fall back
 * to their video id list so old threads keep opening unchanged.
 */
function parseSelectedSources(json: string | null, videoIdsJson: string): SourceRef[] {
  const decoded = decodeSourceRefs(json);
  if (decoded !== null && decoded.length > 0) {
    return decoded;
  }
  return videoIdsToSourceRefs(parseVideoIds(videoIdsJson));
}

/** Coerces a stored mode value; anything unexpected reads as the default. */
function toMode(value: string | null): ChatModeId {
  return isChatModeId(value) ? value : DEFAULT_CHAT_MODE;
}

/** Coerces a stored backend value; pre-stage-9 rows read as codex. */
function toBackend(value: string | null): AiBackendId {
  return isAiBackendId(value) ? value : "codex";
}

function toThread(row: ThreadRow): AiThread {
  const videoIds = parseVideoIds(row.selected_video_ids);
  return {
    id: Number(row.id),
    title: row.title,
    ...(row.research_job_id
      ? { researchJobId: row.research_job_id, researchScopeId: row.research_scope_id! }
      : {}),
    codexSessionId: row.codex_session_id,
    codexWorkDir: row.codex_work_dir,
    videoIds,
    selectedSources: parseSelectedSources(row.selected_sources, row.selected_video_ids),
    mode: toMode(row.mode),
    backend: toBackend(row.backend),
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): AiMessage {
  return {
    id: Number(row.id),
    threadId: Number(row.thread_id),
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  };
}

export interface CreateThreadInput {
  title: string;
  /** Legacy video-only scope; prefer `sources` for mixed selections. */
  videoIds?: readonly string[];
  /** Mixed source scope (videos + tweets). */
  sources?: readonly SourceRef[];
  codexWorkDir: string;
  /** Chat intelligence mode the conversation starts in. */
  mode: ChatModeId;
  /** AI CLI the thread's turns run on (defaults to codex for pre-9 callers). */
  backend?: AiBackendId;
}

/** Inserts a thread with no Codex session yet and returns the stored row. */
export function createThread(db: ScopeDatabase, input: CreateThreadInput): AiThread {
  const sources =
    input.sources && input.sources.length > 0
      ? [...input.sources]
      : videoIdsToSourceRefs(input.videoIds ?? []);
  const videoIds = sourceRefsToVideoIds(sources);
  const result = db
    .prepare(
      `INSERT INTO ai_threads
         (title, codex_work_dir, selected_video_ids, selected_sources, mode, backend)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.codexWorkDir,
      JSON.stringify(videoIds),
      encodeSourceRefs(sources),
      input.mode,
      input.backend ?? "codex",
    );
  const row = db
    .prepare<[number], ThreadRow>("SELECT * FROM ai_threads WHERE id = ?")
    .get(Number(result.lastInsertRowid));
  if (!row) {
    throw new Error("AI thread insert did not return a row.");
  }
  return toThread(row);
}

/** Reads one thread by id, or null when it does not exist. */
export function getThread(db: ScopeDatabase, threadId: number): AiThread | null {
  const row = db
    .prepare<[number], ThreadRow>("SELECT * FROM ai_threads WHERE id = ?")
    .get(threadId);
  return row ? toThread(row) : null;
}

/**
 * Lists every thread for the history sidebar, most recently active first.
 * Activity is the newest message time, falling back to thread creation.
 */
export function listThreads(db: ScopeDatabase): AiThreadSummary[] {
  const rows = db
    .prepare<[], ThreadSummaryRow>(
      `SELECT t.id, t.title, t.selected_video_ids, t.selected_sources, t.mode, t.research_job_id, t.research_scope_id, t.created_at,
              COUNT(m.id) AS message_count,
              MAX(m.created_at) AS last_message_at
       FROM ai_threads t
       LEFT JOIN ai_messages m ON m.thread_id = t.id
       GROUP BY t.id
       ORDER BY COALESCE(MAX(m.created_at), t.created_at) DESC, t.id DESC`,
    )
    .all();
  return rows.map((row) => ({
    id: Number(row.id),
    title: row.title,
    ...(row.research_job_id
      ? { researchJobId: row.research_job_id, researchScopeId: row.research_scope_id! }
      : {}),
    videoIds: parseVideoIds(row.selected_video_ids),
    selectedSources: parseSelectedSources(row.selected_sources, row.selected_video_ids),
    messageCount: Number(row.message_count),
    mode: toMode(row.mode),
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
  }));
}

export interface AppendMessageInput {
  threadId: number;
  role: AiMessageRole;
  content: string;
}

/** Appends one message to a thread and returns the stored row. */
export function appendMessage(db: ScopeDatabase, input: AppendMessageInput): AiMessage {
  const result = db
    .prepare("INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)")
    .run(input.threadId, input.role, input.content);
  const row = db
    .prepare<[number], MessageRow>("SELECT * FROM ai_messages WHERE id = ?")
    .get(Number(result.lastInsertRowid));
  if (!row) {
    throw new Error("AI message insert did not return a row.");
  }
  return toMessage(row);
}

/** Lists one thread's messages oldest-first. */
export function listMessages(db: ScopeDatabase, threadId: number): AiMessage[] {
  const rows = db
    .prepare<[number], MessageRow>("SELECT * FROM ai_messages WHERE thread_id = ? ORDER BY id ASC")
    .all(threadId);
  return rows.map(toMessage);
}

/** Records the Codex session id once a turn has produced one. */
export function setThreadCodexSession(
  db: ScopeDatabase,
  threadId: number,
  codexSessionId: string,
): void {
  db.prepare("UPDATE ai_threads SET codex_session_id = ? WHERE id = ?").run(
    codexSessionId,
    threadId,
  );
}

/** Switches the chat mode a thread runs in (takes effect on the next turn). */
export function setThreadMode(db: ScopeDatabase, threadId: number, mode: ChatModeId): void {
  db.prepare("UPDATE ai_threads SET mode = ? WHERE id = ?").run(mode, threadId);
}

/**
 * Records which AI CLI a thread's latest turn ran on. Called when a turn
 * switches backends: the old CLI's session id is no longer resumable, so the
 * next turn on this thread starts a fresh session.
 */
export function setThreadBackend(db: ScopeDatabase, threadId: number, backend: AiBackendId): void {
  db.prepare("UPDATE ai_threads SET backend = ? WHERE id = ?").run(backend, threadId);
}

/**
 * Deletes a thread and its messages (the FK cascade handles the messages).
 * Resolves false when the thread does not exist; throws when the delete
 * hits a constraint — e.g. a turn is still appending messages — which the
 * route translates into a readable refusal.
 */
export function deleteThread(db: ScopeDatabase, threadId: number): boolean {
  const result = db.prepare("DELETE FROM ai_threads WHERE id = ?").run(threadId);
  return Number(result.changes) > 0;
}
