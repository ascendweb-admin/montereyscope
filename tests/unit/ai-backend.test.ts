import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScopeDatabase } from "@/lib/db/connection";
import {
  AI_BACKEND_MIGRATIONS,
  AI_CHAT_MIGRATIONS,
  AI_CHAT_MODES_MIGRATIONS,
  AI_CLAUDE_BACKEND_MIGRATIONS,
  AI_REPORTS_MIGRATIONS,
  AI_SELECTED_SOURCES_MIGRATIONS,
  INITIAL_MIGRATIONS,
} from "@/lib/db/migrations";
import { runMigrations } from "@/lib/db/migrator";
import { createAiRunner } from "@/lib/ai/backend";
import { DEFAULT_AI_BACKEND, toAiBackendId } from "@/lib/ai/backend-id";
import { createThread, getThread, setThreadBackend } from "@/lib/ai/threads";
import { getAiBackend, setAiBackend, validateAiBackend } from "@/lib/settings/settings";

const tempDirs: string[] = [];
let db: ScopeDatabase;

function createTempDb(migrations: Parameters<typeof runMigrations>[1]): ScopeDatabase {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-ai-backend-"));
  tempDirs.push(dir);
  const database = new Database(path.join(dir, "test.db"));
  database.pragma("foreign_keys = ON");
  runMigrations(database, migrations);
  return database;
}

beforeEach(() => {
  if (db) {
    db.close();
  }
  db = createTempDb([
    ...INITIAL_MIGRATIONS,
    ...AI_CHAT_MIGRATIONS,
    ...AI_REPORTS_MIGRATIONS,
    ...AI_CHAT_MODES_MIGRATIONS,
    ...AI_BACKEND_MIGRATIONS,
    ...AI_CLAUDE_BACKEND_MIGRATIONS,
    ...AI_SELECTED_SOURCES_MIGRATIONS,
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (db?.open) db.close();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ai_backend setting", () => {
  it("defaults to codex when unset", () => {
    expect(getAiBackend(db)).toBe(DEFAULT_AI_BACKEND);
    expect(DEFAULT_AI_BACKEND).toBe("codex");
  });

  it("round-trips a saved backend", () => {
    setAiBackend(db, "opencode");
    expect(getAiBackend(db)).toBe("opencode");
    setAiBackend(db, "claude");
    expect(getAiBackend(db)).toBe("claude");
    setAiBackend(db, "codex");
    expect(getAiBackend(db)).toBe("codex");
  });

  it("falls back to the default on malformed rows", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('ai_backend', 'gemini')").run();
    expect(getAiBackend(db)).toBe("codex");
  });

  it("validates untrusted input", () => {
    expect(validateAiBackend("opencode")).toEqual({ ok: true, value: "opencode", adjusted: false });
    expect(validateAiBackend("codex")).toEqual({ ok: true, value: "codex", adjusted: false });
    expect(validateAiBackend("claude")).toEqual({ ok: true, value: "claude", adjusted: false });
    expect(validateAiBackend(42).ok).toBe(false);
  });

  it("coerces unknown ids to the default", () => {
    expect(toAiBackendId("opencode")).toBe("opencode");
    expect(toAiBackendId("claude")).toBe("claude");
    expect(toAiBackendId("nope")).toBe("codex");
  });
});

describe("thread backend column", () => {
  it("creates threads with the requested backend and reads it back", () => {
    const codexThread = createThread(db, {
      title: "codex thread",
      videoIds: ["abc123"],
      codexWorkDir: "/tmp/job-a",
      mode: "deep",
      backend: "codex",
    });
    expect(getThread(db, codexThread.id)?.backend).toBe("codex");

    const opencodeThread = createThread(db, {
      title: "opencode thread",
      videoIds: ["def456"],
      codexWorkDir: "/tmp/job-b",
      mode: "quick",
      backend: "opencode",
    });
    expect(getThread(db, opencodeThread.id)?.backend).toBe("opencode");

    const claudeThread = createThread(db, {
      title: "claude thread",
      videoIds: ["ghi789"],
      codexWorkDir: "/tmp/job-c",
      mode: "balanced",
      backend: "claude",
    });
    expect(getThread(db, claudeThread.id)?.backend).toBe("claude");
  });

  it("moves a thread's backend when a turn switches backends", () => {
    const thread = createThread(db, {
      title: "switching thread",
      videoIds: ["abc123"],
      codexWorkDir: "/tmp/job-c",
      mode: "balanced",
      backend: "codex",
    });
    setThreadBackend(db, thread.id, "opencode");
    expect(getThread(db, thread.id)?.backend).toBe("opencode");
    setThreadBackend(db, thread.id, "claude");
    expect(getThread(db, thread.id)?.backend).toBe("claude");
    setThreadBackend(db, thread.id, "codex");
    expect(getThread(db, thread.id)?.backend).toBe("codex");
  });
});

describe("createAiRunner", () => {
  const baseOptions = {
    prompt: "hello",
    workDir: "/tmp/job",
    model: "gpt-5.6-sol",
    reasoningEffort: "xhigh",
  } as const;

  it("binds the codex runner for the codex backend", async () => {
    const runCodex = vi.fn(() => {
      throw new Error("not executed");
    });
    const runner = await createAiRunner("codex", { runCodex });
    expect(() => runner(baseOptions)).toThrow("not executed");
    expect(runCodex).toHaveBeenCalledWith(baseOptions);
  });

  it("binds the opencode runner for the opencode backend", async () => {
    const runOpencode = vi.fn(() => {
      throw new Error("not executed");
    });
    const runner = await createAiRunner("opencode", { runOpencode });
    expect(() => runner(baseOptions)).toThrow("not executed");
    expect(runOpencode).toHaveBeenCalledWith(baseOptions);
  });

  it("binds the claude runner for the claude backend", async () => {
    const runClaude = vi.fn(() => {
      throw new Error("not executed");
    });
    const runner = await createAiRunner("claude", { runClaude });
    expect(() => runner(baseOptions)).toThrow("not executed");
    expect(runClaude).toHaveBeenCalledWith(baseOptions);
  });

  it("defaults to the real codex adapter when no overrides are given", async () => {
    const runner = await createAiRunner("codex");
    // The real adapter constructs a CodexRun object with events + completed.
    const run = runner({ ...baseOptions, command: "/nonexistent-opencode-binary" });
    expect(typeof run.events[Symbol.asyncIterator]).toBe("function");
    await expect(run.completed).rejects.toThrow();
  });
});
