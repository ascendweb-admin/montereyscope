/**
 * GET /api/ai/chat/threads/[id] — one thread with its full message history.
 *
 * Messages are returned oldest-first with their roles (system messages are
 * the seeded analyst instruction; the chat UI decides which roles to render).
 * DELETE removes the thread and its messages (the workspace's history
 * sidebar); it waits out any in-flight turn on the thread first so a running
 * Codex turn can never race the delete with its message writes.
 */
import { acquireChatTurnLock } from "@/lib/ai";
import { deleteThread, getThread, listMessages } from "@/lib/ai/threads";
import { getDb } from "@/lib/db/connection";

// Threads live in the local SQLite file; always read at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function parseThreadId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number.parseInt(raw, 10);
}

export async function GET(_request: Request, ctx: RouteParams) {
  const { id: rawThreadId } = await ctx.params;
  const threadId = parseThreadId(rawThreadId);
  if (threadId === null) {
    return Response.json(
      { error: { code: "invalid_thread", message: "That thread reference is not valid." } },
      { status: 400 },
    );
  }

  const db = getDb();
  const thread = getThread(db, threadId);
  if (thread === null) {
    return Response.json(
      { error: { code: "thread_not_found", message: "That chat thread does not exist." } },
      { status: 404 },
    );
  }

  // codexWorkDir stays on the server; the client gets the session reference.
  const publicThread = {
    id: thread.id,
    title: thread.title,
    codexSessionId: thread.codexSessionId,
    videoIds: thread.videoIds,
    selectedSources: thread.selectedSources,
    mode: thread.mode,
    createdAt: thread.createdAt,
  };
  return Response.json(
    { thread: publicThread, messages: listMessages(db, threadId) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(_request: Request, ctx: RouteParams) {
  const { id: rawThreadId } = await ctx.params;
  const threadId = parseThreadId(rawThreadId);
  if (threadId === null) {
    return Response.json(
      { error: { code: "invalid_thread", message: "That thread reference is not valid." } },
      { status: 400 },
    );
  }

  const db = getDb();
  if (getThread(db, threadId) === null) {
    return Response.json(
      { error: { code: "thread_not_found", message: "That chat thread does not exist." } },
      { status: 404 },
    );
  }

  // Serialize against any in-flight turn on this thread: its message writes
  // must not race the delete (the turn lock is released whenever the turn
  // winds down, including aborts and errors).
  const release = await acquireChatTurnLock(threadId);
  try {
    const deleted = deleteThread(db, threadId);
    return Response.json({ deleted }, { headers: { "Cache-Control": "no-store" } });
  } finally {
    release();
  }
}
