import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DELETE } from "@/app/api/ai/chat/threads/[id]/route";
import { acquireChatTurnLock } from "@/lib/ai";
import {
  appendMessage,
  createThread,
  deleteThread,
  getThread,
  listMessages,
} from "@/lib/ai/threads";
import { closeDatabase, getDb } from "@/lib/db/connection";

/**
 * Thread deletion (full-screen chat history): the repository cascade and the
 * DELETE route — including the serialization against an in-flight turn, so a
 * running Codex turn can never race the delete with its message writes.
 */

let workDir = "";

function routeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function seedThread(): number {
  const thread = createThread(getDb(), {
    title: "What did the video claim?",
    videoIds: ["vid0000001"],
    codexWorkDir: path.join(workDir, "job-1"),
    mode: "deep",
  });
  appendMessage(getDb(), { threadId: thread.id, role: "system", content: "instruction" });
  appendMessage(getDb(), {
    threadId: thread.id,
    role: "user",
    content: "What did the video claim?",
  });
  appendMessage(getDb(), { threadId: thread.id, role: "assistant", content: "Three claims." });
  return thread.id;
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "localtube-chat-delete-"));
  process.env.LOCALTUBE_DB_PATH = path.join(workDir, "localtube.db");
});

afterEach(() => {
  closeDatabase();
  delete process.env.LOCALTUBE_DB_PATH;
  rmSync(workDir, { recursive: true, force: true });
});

describe("deleteThread", () => {
  it("removes the thread and cascades its messages", () => {
    const db = getDb();
    const threadId = seedThread();

    expect(deleteThread(db, threadId)).toBe(true);
    expect(getThread(db, threadId)).toBeNull();
    expect(listMessages(db, threadId)).toEqual([]);
    // A second delete reports that nothing was there.
    expect(deleteThread(db, threadId)).toBe(false);
  });
});

describe("DELETE /api/ai/chat/threads/[id]", () => {
  it("deletes an existing thread and reports the count", async () => {
    const threadId = seedThread();

    const response = await DELETE(
      new Request(`http://127.0.0.1:3000/api/ai/chat/threads/${threadId}`, { method: "DELETE" }),
      routeCtx(String(threadId)),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });
    expect(getThread(getDb(), threadId)).toBeNull();
  });

  it("404s for unknown threads and 400s for malformed ids", async () => {
    const missing = await DELETE(
      new Request("http://127.0.0.1:3000/api/ai/chat/threads/999", { method: "DELETE" }),
      routeCtx("999"),
    );
    expect(missing.status).toBe(404);

    const malformed = await DELETE(
      new Request("http://127.0.0.1:3000/api/ai/chat/threads/abc", { method: "DELETE" }),
      routeCtx("abc"),
    );
    expect(malformed.status).toBe(400);
  });

  it("waits out an in-flight turn before deleting, so writes never race", async () => {
    const threadId = seedThread();

    // Simulate a turn holding the thread's lock (as streamChatTurn would).
    const release = await acquireChatTurnLock(threadId);

    const holder: { response?: Response } = {};
    const deleting = DELETE(
      new Request(`http://127.0.0.1:3000/api/ai/chat/threads/${threadId}`, { method: "DELETE" }),
      routeCtx(String(threadId)),
    ).then((result) => {
      holder.response = result;
    });

    // Give the delete a tick: it must still be waiting on the turn lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(holder.response).toBeUndefined();
    expect(getThread(getDb(), threadId)).not.toBeNull();

    release();
    await deleting;

    expect(holder.response?.status).toBe(200);
    expect(getThread(getDb(), threadId)).toBeNull();
  });
});
