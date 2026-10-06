import { readXMutation } from "@/lib/x/http";
import { researchThread, startResearchConversation } from "@/lib/x/research/experience";
import { getResearchAnalysisEngine } from "@/lib/x/research/analysis";
import { researchError } from "@/lib/x/research/http";
/**
 * POST /api/ai/chat — one AI chat turn, streamed to the client as SSE.
 *
 * Body: {videoIds, message, mode?} starts a new thread in that chat mode
 * (scope is validated against the cached feed and transcripts are
 * materialized into a fresh job dir that doubles as the Codex work dir),
 * {threadId, message, mode?} resumes an existing Codex session with just the
 * new message — a changed mode switches model, reasoning effort, and working
 * directive from this turn on. Codex runs in a read-only sandbox on the Node
 * runtime.
 *
 * The SSE stream emits typed events (`thread`, `user_message`, `status`,
 * `delta`, `message`, `done`, `error`) separated by heartbeats while Codex
 * reasons, so the UI can stay alive during silent xhigh turns. Request
 * validation failures return plain JSON errors before the stream starts;
 * anything failing mid-stream is reported as an `error` event instead.
 */
import {
  acquireChatTurnLock,
  materializeSources,
  maxMaterializedBytes,
  resolveSourceScope,
  streamChatTurn,
  MAX_SCOPE_VIDEOS,
  type ChatStreamEvent,
  type SourceMaterializationManifest,
} from "@/lib/ai";
import { DEFAULT_CHAT_MODE, isChatModeId } from "@/lib/ai/chat-modes";
import { getThread } from "@/lib/ai/threads";
import { normalizeSourceRefs, videoIdsToSourceRefs, type SourceRef } from "@/lib/content/model";
import { getDb } from "@/lib/db/connection";

// Every request touches SQLite and spawns codex; nothing here is cacheable.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Sanity bound for one user message; generous, but blocks pathological bodies. */
const MAX_MESSAGE_LENGTH = 100_000;

/** Thread titles are the first user message, collapsed and truncated. */
const MAX_TITLE_LENGTH = 80;

/** SSE keepalive interval; xhigh reasoning can stay silent for minutes. */
const HEARTBEAT_INTERVAL_MS = 15_000;

const HEARTBEAT_COMMENT = ": ping\n\n";

interface ChatRequestBody {
  scopeId?: unknown;
  /** Mixed source selection: [{kind: "video"|"tweet", id}]. */
  sources?: unknown;
  /** Legacy video-only selection; normalized into sources once. */
  videoIds?: unknown;
  message?: unknown;
  threadId?: unknown;
  /** Chat intelligence mode; omitted reads as the default (deep). */
  mode?: unknown;
}

interface JsonError {
  error: { code: string; message: string };
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  const body: JsonError & Record<string, unknown> = { error: { code, message } };
  return Response.json({ ...body, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

function validateMessage(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) {
    return null;
  }
  return trimmed;
}

function validateVideoIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    return null;
  }
  const ids = (value as string[]).map((id) => id.trim()).filter((id) => id.length > 0);
  return ids.length > 0 ? ids : null;
}

/**
 * Normalizes the request's scope into typed source references: the new
 * `sources` payload wins; legacy `videoIds` normalize once. A request that
 * carries both is ambiguous and rejected.
 */
function normalizeRequestedSources(body: ChatRequestBody): SourceRef[] | Response {
  if (body.sources !== undefined && body.videoIds !== undefined) {
    return jsonError(400, "ambiguous_scope", "Send either sources or videoIds, not both.");
  }
  if (body.sources !== undefined) {
    const refs = normalizeSourceRefs(body.sources);
    if (refs === null || refs.length === 0) {
      return jsonError(
        400,
        "invalid_sources",
        "sources must be a non-empty array of {kind, id} entries.",
      );
    }
    return refs;
  }
  const videoIds = validateVideoIds(body.videoIds);
  if (videoIds === null) {
    return jsonError(
      400,
      "invalid_video_ids",
      "Provide a non-empty sources array, or videoIds for a video-only analysis.",
    );
  }
  return videoIdsToSourceRefs(videoIds);
}

/**
 * The scope guard shared with the reports route: one analysis covers at most
 * MAX_SCOPE_VIDEOS sources across all kinds (duplicates collapse first). The
 * selection UI enforces this while picking; the server re-checks so a stale
 * client or a hand-written request gets the same readable refusal.
 */
function scopeTooLarge(sources: readonly SourceRef[]): Response | null {
  const unique = new Set(sources.map((source) => `${source.kind}:${source.id}`));
  if (unique.size <= MAX_SCOPE_VIDEOS) {
    return null;
  }
  return jsonError(
    422,
    "scope_too_large",
    `Analyses are capped at ${MAX_SCOPE_VIDEOS} sources at once — this selection covers ${unique.size}. Deselect a few and try again.`,
  );
}

function validateThreadId(value: unknown): number | null {
  const id = typeof value === "string" ? Number(value) : value;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 ? id : null;
}

/** Derives the thread title from the first user message. */
function threadTitle(message: string): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_TITLE_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_TITLE_LENGTH - 3)}...`;
}

/**
 * Root for materialized job directories. Override keeps the value on the
 * server, mirroring SCOPE_DB_PATH; defaults to <cwd>/data/ai-jobs.
 */
function jobsRoot(): string | undefined {
  return process.env.SCOPE_AI_JOBS_ROOT ?? process.env.LOCALTUBE_AI_JOBS_ROOT;
}

/**
 * One-line scope disclosure when the materialized-bytes budget cut the
 * sources (stage 7 guardrail): the client shows it as a quiet notice before
 * the answer, and the seeded prompt's framing stays honest about what the
 * model can see.
 */
function scopeTruncationNotice(manifest: SourceMaterializationManifest): string | undefined {
  const truncation = manifest.truncation;
  if (!truncation) {
    return undefined;
  }
  const titleByKey = new Map(
    manifest.sources.map((source) => [`${source.kind}:${source.id}`, source.title]),
  );
  const parts: string[] = [];
  if (truncation.truncatedSourceKeys.length > 0) {
    const titles = truncation.truncatedSourceKeys.map((key) => titleByKey.get(key) ?? key);
    parts.push(
      `${titles.length === 1 ? "The source" : "The sources"} ${titles
        .map((title) => `“${title}”`)
        .join(
          ", ",
        )} ${titles.length === 1 ? "was" : "were"} cut short to fit the analysis byte budget.`,
    );
  }
  if (truncation.skippedSourceKeys.length > 0) {
    const titles = truncation.skippedSourceKeys.map((key) => titleByKey.get(key) ?? key);
    parts.push(
      `${titles.length === 1 ? "The source" : "The sources"} ${titles
        .map((title) => `“${title}”`)
        .join(", ")} could not be included at all.`,
    );
  }
  return parts.join(" ");
}

/**
 * Serializes turns per thread (stage 7): resume commands wait for any
 * in-flight turn on the same thread before doing anything, so two windows
 * can never interleave messages around one Codex session. The wait happens
 * inside the SSE pump, so heartbeat comments keep the stream alive while the
 * turn is queued; the lock is released whenever the generator winds down,
 * including on aborts and errors.
 */
async function* withThreadTurnLock(
  threadId: number | null,
  events: AsyncGenerator<ChatStreamEvent>,
): AsyncGenerator<ChatStreamEvent> {
  if (threadId === null) {
    yield* events;
    return;
  }
  const release = await acquireChatTurnLock(threadId);
  try {
    yield* events;
  } finally {
    release();
  }
}

function sseEvent(event: ChatStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Awaits the next chat event, emitting SSE heartbeat comments while the
 * generator stays silent (Codex reasoning at xhigh can pause for minutes).
 */
async function nextWithHeartbeat(
  next: () => Promise<IteratorResult<ChatStreamEvent>>,
  send: (chunk: string) => void,
): Promise<IteratorResult<ChatStreamEvent>> {
  const pending = next();
  for (;;) {
    let firePing: (() => void) | undefined;
    const ping = new Promise<"ping">((resolve) => {
      firePing = () => resolve("ping");
    });
    const timer = setTimeout(() => firePing?.(), HEARTBEAT_INTERVAL_MS);
    try {
      const winner = await Promise.race([
        pending.then((result) => ({ kind: "event" as const, result })),
        ping,
      ]);
      if (winner === "ping") {
        send(HEARTBEAT_COMMENT);
        continue;
      }
      return winner.result;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function POST(request: Request) {
  const guardedRequest = request.clone();
  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return jsonError(400, "invalid_body", "Request body must be JSON.");
  }

  const message = validateMessage(body.message);
  if (message === null) {
    return jsonError(
      400,
      "invalid_message",
      `message must be a non-empty string of at most ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }

  // Omitted reads as the default so pre-mode clients keep working; anything
  // present must be a known mode id.
  const mode = body.mode === undefined ? DEFAULT_CHAT_MODE : body.mode;
  if (!isChatModeId(mode)) {
    return jsonError(400, "invalid_mode", "mode must be one of: quick, balanced, deep.");
  }

  const db = getDb();

  const research =
    body.threadId === undefined ? null : researchThread(db, validateThreadId(body.threadId) ?? -1);
  if (body.scopeId !== undefined || research) {
    const guarded = await readXMutation(guardedRequest);
    if (!guarded.ok) return guarded.response;
    if (
      body.sources !== undefined ||
      body.videoIds !== undefined ||
      (body.scopeId !== undefined && body.threadId !== undefined)
    )
      return jsonError(
        400,
        "ambiguous_scope",
        "Use a saved research scope or conversation without another selection.",
      );
    try {
      const result = await startResearchConversation(db, getResearchAnalysisEngine(), {
        question: message,
        mode,
        ...(research ? { threadId: research.id } : { scopeId: body.scopeId }),
      });
      return Response.json(result, { status: 202, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return researchError(error);
    }
  }

  const command = (() => {
    if (body.threadId !== undefined) {
      const threadId = validateThreadId(body.threadId);
      if (threadId === null) {
        return jsonError(400, "invalid_thread", "threadId must be a positive integer.");
      }
      const thread = getThread(db, threadId);
      if (thread === null) {
        return jsonError(404, "thread_not_found", "That chat thread does not exist.");
      }
      return { kind: "resume" as const, thread, message, mode };
    }

    const requested = normalizeRequestedSources(body);
    if (requested instanceof Response) {
      return requested;
    }
    const tooLarge = scopeTooLarge(requested);
    if (tooLarge !== null) {
      return tooLarge;
    }
    const scope = resolveSourceScope(db, requested);
    if (!scope.sources.some((source) => source.readyForAnalysis)) {
      return jsonError(
        422,
        "no_ready_sources",
        "None of the selected sources has cached content yet. Fetch at least one first.",
        {
          unknownSources: scope.unknown,
          notReadySources: scope.notReady,
        },
      );
    }
    // The job directory doubles as the CLI work dir and stays the same for
    // every later turn of the thread.
    let outcome;
    try {
      outcome = materializeSources(db, requested, {
        jobsRoot: jobsRoot(),
        maxTotalBytes: maxMaterializedBytes(),
      });
    } catch (error) {
      // Disk trouble or a bad jobs root: a readable refusal instead of a raw 500.
      console.error("[ai/chat] source materialization failed:", error);
      return jsonError(
        500,
        "materialize_failed",
        "scope could not prepare the sources folder for this analysis. Check the server logs and try again.",
      );
    }
    return {
      kind: "new" as const,
      message,
      title: threadTitle(message),
      sources: requested,
      workDir: outcome.jobDir,
      mode,
      notice: scopeTruncationNotice(outcome.manifest),
    };
  })();

  if (command instanceof Response) {
    return command;
  }

  // Client disconnects (request signal or stream cancel) must kill codex.
  const localAbort = new AbortController();
  const abort = () => localAbort.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) {
    abort();
  }

  const lockThreadId = command.kind === "resume" ? command.thread.id : null;
  const events = withThreadTurnLock(
    lockThreadId,
    streamChatTurn({ db, signal: localAbort.signal }, command),
  );
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string): void => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away mid-stream; stop codex and stop sending.
          closed = true;
          localAbort.abort();
        }
      };

      const iterator = events[Symbol.asyncIterator]();
      void (async () => {
        try {
          for (;;) {
            const result = await nextWithHeartbeat(() => iterator.next(), send);
            if (result.done) {
              break;
            }
            send(sseEvent(result.value));
            if (closed) {
              // The client is gone: stop pulling events and let the
              // generator's finally blocks run (per-thread lock release,
              // codex kill via the abort signal).
              void iterator.return(undefined);
              break;
            }
          }
        } catch (error) {
          // streamChatTurn reports its own failures as error events; this is
          // a last-resort guard so the stream still terminates cleanly.
          send(
            sseEvent({
              type: "error",
              code: "chat_failed",
              message: "The chat turn failed unexpectedly.",
            }),
          );
          console.error("[ai/chat] stream pump failed:", error);
        }
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by a cancel().
        }
      })();
    },
    cancel() {
      localAbort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
