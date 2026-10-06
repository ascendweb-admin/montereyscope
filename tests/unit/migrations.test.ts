import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import {
  ALL_MIGRATIONS,
  AI_BACKEND_MIGRATIONS,
  AI_CHAT_MIGRATIONS,
  AI_CHAT_MODES_MIGRATIONS,
  AI_CLAUDE_BACKEND_MIGRATIONS,
  AI_REPORT_META_MIGRATIONS,
  AI_REPORTS_MIGRATIONS,
  AI_SELECTED_SOURCES_MIGRATIONS,
  CREATOR_CATEGORY_MIGRATIONS,
  CREATOR_PLATFORM_MIGRATIONS,
  CREATOR_PLATFORM_X_MIGRATIONS,
  INITIAL_MIGRATIONS,
  TWEET_CACHE_MIGRATIONS,
} from "@/lib/db/migrations";
import { getAppliedMigrationIds, runMigrations, sortMigrations } from "@/lib/db/migrator";

const tempDirs: string[] = [];
const databases: Database.Database[] = [];

function createTempDb(): { db: Database.Database; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "localtube-migrations-"));
  tempDirs.push(dir);
  const file = path.join(dir, "test.db");
  const db = new Database(file);
  databases.push(db);
  db.pragma("foreign_keys = ON");
  return { db, file };
}

afterAll(() => {
  for (const db of databases) {
    if (db.open) db.close();
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TABLES = ["creators", "videos", "transcripts", "settings"] as const;

describe("runMigrations", () => {
  it("creates the initial schema on an empty database", () => {
    const { db } = createTempDb();

    runMigrations(db, INITIAL_MIGRATIONS);

    for (const table of TABLES) {
      const row = db
        .prepare<[string], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table);
      expect(row?.name, `table ${table} should exist`).toBe(table);
    }
    expect(getAppliedMigrationIds(db).size).toBe(INITIAL_MIGRATIONS.length);
    db.close();
  });

  it("is idempotent when run twice on the same database", () => {
    const { db } = createTempDb();

    expect(() => {
      runMigrations(db, INITIAL_MIGRATIONS);
      runMigrations(db, INITIAL_MIGRATIONS);
      runMigrations(db, INITIAL_MIGRATIONS);
    }).not.toThrow();

    // One row per migration, no duplicates.
    expect(getAppliedMigrationIds(db).size).toBe(INITIAL_MIGRATIONS.length);

    for (const table of TABLES) {
      const count = db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table);
      expect(count?.n, `${table} must not be recreated`).toBe(1);
    }
    db.close();
  });

  it("preserves existing data when re-run and applies only pending migrations", () => {
    const { db, file } = createTempDb();
    runMigrations(db, INITIAL_MIGRATIONS);

    db.prepare(
      "INSERT INTO creators (youtube_channel_id, handle, display_name, channel_url) VALUES (?, ?, ?, ?)",
    ).run(
      "UCX6OQ3DkcsbYNE6H8uQQuVA",
      "@mkbhd",
      "Marques Brownlee",
      "https://www.youtube.com/@mkbhd",
    );
    db.close();

    // Re-open the same file and migrate again — data survives.
    const reopened = new Database(file);
    reopened.pragma("foreign_keys = ON");
    runMigrations(reopened, INITIAL_MIGRATIONS);

    const creators = reopened
      .prepare<[], { display_name: string }>("SELECT display_name FROM creators")
      .all();
    expect(creators).toEqual([{ display_name: "Marques Brownlee" }]);
    reopened.close();
  });

  it("enforces foreign keys and check constraints from the schema", () => {
    const { db } = createTempDb();
    runMigrations(db, INITIAL_MIGRATIONS);

    // Orphan video must be rejected by the creators foreign key.
    expect(() => {
      db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
        "dQw4w9WgXcQ",
        9999,
        "Orphan video",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      );
    }).toThrow(/FOREIGN KEY/);

    const { lastInsertRowid: creatorId } = db
      .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
      .run("Some Channel", "https://www.youtube.com/@somechannel");
    db.prepare("INSERT INTO videos (id, creator_id, title, url) VALUES (?, ?, ?, ?)").run(
      "dQw4w9WgXcQ",
      Number(creatorId),
      "Real video",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );

    // Invalid transcript source must be rejected by the check constraint.
    expect(() => {
      db.prepare(
        "INSERT INTO transcripts (video_id, language, source, plain_text) VALUES (?, ?, ?, ?)",
      ).run("dQw4w9WgXcQ", "en", "whisper", "not a valid source");
    }).toThrow(/CHECK/);
    db.close();
  });

  it("creates the lookup indexes required by AGENTS.md", () => {
    const { db } = createTempDb();
    runMigrations(db, INITIAL_MIGRATIONS);

    const indexNames = ["idx_videos_creator_published", "idx_creators_youtube_channel_id"];
    for (const name of indexNames) {
      const row = db
        .prepare<[string], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(name);
      expect(row?.name, `index ${name} should exist`).toBe(name);
    }

    // Partial uniqueness: two NULL channel IDs are fine, duplicates are not.
    const insertCreator = db.prepare(
      "INSERT INTO creators (youtube_channel_id, display_name, channel_url) VALUES (?, ?, ?)",
    );
    insertCreator.run(null, "No channel id yet", "https://www.youtube.com/@one");
    insertCreator.run(null, "Another without id", "https://www.youtube.com/@two");

    const creatorId = db.prepare<[], { id: number }>("SELECT id FROM creators LIMIT 1").get()
      ?.id as number;
    insertCreator.run("UCtest123", "Known channel", "https://www.youtube.com/@known");
    expect(() => insertCreator.run("UCtest123", "Duplicate channel", "https://x")).toThrow(
      /UNIQUE/,
    );
    expect(creatorId).toBeGreaterThan(0);
    db.close();
  });

  it("sorts migrations by id regardless of input order", () => {
    const sorted = sortMigrations([
      { id: "010", name: "b", sql: "" },
      { id: "002", name: "a", sql: "" },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["002", "010"]);
  });
});

describe("creator category migration (006)", () => {
  it("creates the many-to-many tables with uniqueness and cascades", () => {
    const { db } = createTempDb();
    runMigrations(db, [...INITIAL_MIGRATIONS, ...CREATOR_CATEGORY_MIGRATIONS]);

    const creatorId = Number(
      db
        .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
        .run("Creator", "https://www.youtube.com/@creator").lastInsertRowid,
    );
    const categoryId = Number(
      db.prepare("INSERT INTO categories (name, color) VALUES (?, ?)").run("Markets", "amber")
        .lastInsertRowid,
    );
    db.prepare("INSERT INTO creator_categories (creator_id, category_id) VALUES (?, ?)").run(
      creatorId,
      categoryId,
    );

    expect(() =>
      db.prepare("INSERT INTO categories (name, color) VALUES (?, ?)").run("markets", "sky"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.prepare("INSERT INTO categories (name, color) VALUES (?, ?)").run("Bad", "orange"),
    ).toThrow(/CHECK/);

    db.prepare("DELETE FROM categories WHERE id = ?").run(categoryId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM creators").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM creator_categories").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("AI chat migration (002)", () => {
  function createMigratedDb(): Database.Database {
    const { db } = createTempDb();
    runMigrations(db, [...INITIAL_MIGRATIONS, ...AI_CHAT_MIGRATIONS]);
    return db;
  }

  function insertThread(db: Database.Database, selectedVideoIds = ["dQw4w9WgXcQ"]): number {
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids) VALUES (?, ?, ?)",
      )
      .run("A thread", "/tmp/job", JSON.stringify(selectedVideoIds));
    return Number(lastInsertRowid);
  }

  it("creates the ai_threads and ai_messages tables", () => {
    const db = createMigratedDb();
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%'",
      )
      .all()
      .map((row) => row.name);
    expect(tables.sort()).toEqual(["ai_messages", "ai_threads"]);
    db.close();
  });

  it("is idempotent alongside the initial migrations", () => {
    const { db } = createTempDb();
    const all = [...INITIAL_MIGRATIONS, ...AI_CHAT_MIGRATIONS];
    runMigrations(db, all);
    runMigrations(db, all);
    expect(getAppliedMigrationIds(db).size).toBe(all.length);
    db.close();
  });

  it("rejects invalid roles and non-JSON video id lists", () => {
    const db = createMigratedDb();
    const threadId = insertThread(db);
    const insertMessage = db.prepare(
      "INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)",
    );

    expect(() => insertMessage.run(threadId, "moderator", "nope")).toThrow(/CHECK/);

    expect(() =>
      db
        .prepare(
          "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids) VALUES (?, ?, ?)",
        )
        .run("Broken", "/tmp/job", "not json"),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("cascades message deletion with their thread", () => {
    const db = createMigratedDb();
    const threadId = insertThread(db);
    const insertMessage = db.prepare(
      "INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)",
    );
    insertMessage.run(threadId, "system", "instruction");
    insertMessage.run(threadId, "user", "hello");

    db.prepare("DELETE FROM ai_threads WHERE id = ?").run(threadId);

    const remaining = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM ai_messages").get();
    expect(Number(remaining?.n)).toBe(0);
    db.close();
  });

  it("timestamps rows with ISO 8601 text by default", () => {
    const db = createMigratedDb();
    const threadId = insertThread(db);
    db.prepare("INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)").run(
      threadId,
      "user",
      "hello",
    );

    const thread = db
      .prepare<[number], { created_at: string }>("SELECT created_at FROM ai_threads WHERE id = ?")
      .get(threadId);
    const message = db
      .prepare<[], { created_at: string }>("SELECT created_at FROM ai_messages LIMIT 1")
      .get();
    expect(thread?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(message?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.close();
  });
});

describe("AI chat modes migration (004)", () => {
  function createMigratedDb(): Database.Database {
    const { db } = createTempDb();
    runMigrations(db, [
      ...INITIAL_MIGRATIONS,
      ...AI_CHAT_MIGRATIONS,
      ...AI_REPORTS_MIGRATIONS,
      ...AI_CHAT_MODES_MIGRATIONS,
    ]);
    return db;
  }

  it("adds the mode column to ai_threads with the deep default", () => {
    const db = createMigratedDb();
    const { lastInsertRowid } = db
      .prepare(
        "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids) VALUES (?, ?, ?)",
      )
      .run("Legacy thread", "/tmp/job", JSON.stringify(["dQw4w9WgXcQ"]));
    const row = db
      .prepare<[number], { mode: string }>("SELECT mode FROM ai_threads WHERE id = ?")
      .get(Number(lastInsertRowid));
    // Pre-mode threads all ran the deep configuration.
    expect(row?.mode).toBe("deep");
    db.close();
  });

  it("rejects unknown modes and accepts every shipped one", () => {
    const db = createMigratedDb();
    const insert = db.prepare(
      "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids, mode) VALUES (?, ?, ?, ?)",
    );
    expect(() => insert.run("Broken", "/tmp/job", "[]", "ultra")).toThrow(/CHECK/);
    for (const mode of ["quick", "balanced", "deep"]) {
      expect(() => insert.run(`Thread ${mode}`, "/tmp/job", "[]", mode)).not.toThrow();
    }
    db.close();
  });

  it("is idempotent alongside the other migrations", () => {
    const { db } = createTempDb();
    const all = [
      ...INITIAL_MIGRATIONS,
      ...AI_CHAT_MIGRATIONS,
      ...AI_REPORTS_MIGRATIONS,
      ...AI_CHAT_MODES_MIGRATIONS,
    ];
    runMigrations(db, all);
    runMigrations(db, all);
    expect(getAppliedMigrationIds(db).size).toBe(all.length);
    db.close();
  });
});

describe("AI reports migration (003)", () => {
  function createMigratedDb(): Database.Database {
    const { db } = createTempDb();
    runMigrations(db, [...INITIAL_MIGRATIONS, ...AI_CHAT_MIGRATIONS, ...AI_REPORTS_MIGRATIONS]);
    return db;
  }

  it("creates the ai_reports table alongside the chat tables", () => {
    const db = createMigratedDb();
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%'",
      )
      .all()
      .map((row) => row.name);
    expect(tables.sort()).toEqual(["ai_messages", "ai_reports", "ai_threads"]);
    db.close();
  });

  it("is idempotent alongside the other migrations", () => {
    const { db } = createTempDb();
    const all = [...INITIAL_MIGRATIONS, ...AI_CHAT_MIGRATIONS, ...AI_REPORTS_MIGRATIONS];
    runMigrations(db, all);
    runMigrations(db, all);
    expect(getAppliedMigrationIds(db).size).toBe(all.length);
    db.close();
  });

  it("defaults to queued, rejects unknown statuses and non-JSON scopes", () => {
    const db = createMigratedDb();
    const insert = db.prepare("INSERT INTO ai_reports (selected_video_ids) VALUES (?)");
    const { lastInsertRowid } = insert.run(JSON.stringify(["dQw4w9WgXcQ"]));
    const row = db
      .prepare<[number], { status: string }>("SELECT status FROM ai_reports WHERE id = ?")
      .get(Number(lastInsertRowid));
    expect(row?.status).toBe("queued");

    expect(() =>
      db
        .prepare("INSERT INTO ai_reports (selected_video_ids, status) VALUES (?, ?)")
        .run("[]", "running_fast"),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare("INSERT INTO ai_reports (selected_video_ids) VALUES (?)").run("not json"),
    ).toThrow(/CHECK/);
    db.close();
  });

  it("timestamps created_at with ISO 8601 text by default", () => {
    const db = createMigratedDb();
    db.prepare("INSERT INTO ai_reports (selected_video_ids) VALUES (?)").run("[]");
    const row = db
      .prepare<[], { created_at: string }>("SELECT created_at FROM ai_reports LIMIT 1")
      .get();
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.close();
  });
});

describe("AI report meta migration (008)", () => {
  function createReportDb(): Database.Database {
    const { db } = createTempDb();
    runMigrations(db, [
      ...INITIAL_MIGRATIONS,
      ...AI_CHAT_MIGRATIONS,
      ...AI_REPORTS_MIGRATIONS,
      ...AI_REPORT_META_MIGRATIONS,
    ]);
    return db;
  }

  it("adds nullable title, dek, and job_dir columns to ai_reports", () => {
    const db = createReportDb();
    // Pre-existing rows keep working: every new column is nullable.
    const { lastInsertRowid } = db
      .prepare("INSERT INTO ai_reports (selected_video_ids) VALUES (?)")
      .run(JSON.stringify(["dQw4w9WgXcQ"]));
    const row = db
      .prepare<[number], { title: string | null; dek: string | null; job_dir: string | null }>(
        "SELECT title, dek, job_dir FROM ai_reports WHERE id = ?",
      )
      .get(Number(lastInsertRowid));
    expect(row).toEqual({ title: null, dek: null, job_dir: null });

    db.prepare("UPDATE ai_reports SET title = ?, dek = ?, job_dir = ? WHERE id = ?").run(
      "A real headline",
      "A standfirst",
      "/jobs/x",
      Number(lastInsertRowid),
    );
    const updated = db
      .prepare<[number], { title: string }>("SELECT title FROM ai_reports WHERE id = ?")
      .get(Number(lastInsertRowid));
    expect(updated?.title).toBe("A real headline");
    db.close();
  });

  it("is idempotent alongside the other migrations", () => {
    const { db } = createTempDb();
    const all = [
      ...INITIAL_MIGRATIONS,
      ...AI_CHAT_MIGRATIONS,
      ...AI_REPORTS_MIGRATIONS,
      ...AI_REPORT_META_MIGRATIONS,
    ];
    runMigrations(db, all);
    runMigrations(db, all);
    expect(getAppliedMigrationIds(db).size).toBe(all.length);
    db.close();
  });
});

describe("AI backend widening migration (010)", () => {
  const PRE_CLAUDE = [
    ...INITIAL_MIGRATIONS,
    ...AI_CHAT_MIGRATIONS,
    ...AI_CHAT_MODES_MIGRATIONS,
    ...AI_BACKEND_MIGRATIONS,
  ];
  const WITH_CLAUDE = [...PRE_CLAUDE, ...AI_CLAUDE_BACKEND_MIGRATIONS];

  interface ThreadSnapshot {
    id: number;
    title: string;
    codex_session_id: string | null;
    codex_work_dir: string;
    selected_video_ids: string;
    mode: string;
    backend: string;
    created_at: string;
  }

  function insertLegacyThreads(db: Database.Database): void {
    db.prepare(
      `INSERT INTO ai_threads
         (title, codex_session_id, codex_work_dir, selected_video_ids, mode, backend, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "Old codex thread",
      "0f1e2d3c-4b5a-4678-8796-a5b4c3d2e1f0",
      "/tmp/job-codex",
      JSON.stringify(["dQw4w9WgXcQ"]),
      "deep",
      "codex",
      "2026-01-01T00:00:00.000Z",
    );
    db.prepare(
      `INSERT INTO ai_threads
         (title, codex_session_id, codex_work_dir, selected_video_ids, mode, backend, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "Old opencode thread",
      "ses_f972bd039ffeuagY7F24bvfLFF",
      "/tmp/job-opencode",
      JSON.stringify(["dQw4w9WgXcQ"]),
      "quick",
      "opencode",
      "2026-01-02T00:00:00.000Z",
    );
    db.prepare("INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)").run(
      1,
      "user",
      "A question from before Claude existed.",
    );
    db.prepare("INSERT INTO ai_messages (thread_id, role, content) VALUES (?, ?, ?)").run(
      2,
      "assistant",
      "An answer that must survive the upgrade.",
    );
  }

  it("upgrades existing databases without losing threads or messages", () => {
    const { db } = createTempDb();
    runMigrations(db, PRE_CLAUDE);
    insertLegacyThreads(db);

    const before = db.prepare<[], ThreadSnapshot>("SELECT * FROM ai_threads ORDER BY id").all();
    const messagesBefore = db
      .prepare<[], { id: number; thread_id: number; content: string }>(
        "SELECT id, thread_id, content FROM ai_messages ORDER BY id",
      )
      .all();

    runMigrations(db, WITH_CLAUDE);

    // Identical rows: ids, session ids, work dirs, modes, backends, timestamps.
    expect(db.prepare<[], ThreadSnapshot>("SELECT * FROM ai_threads ORDER BY id").all()).toEqual(
      before,
    );
    expect(
      db
        .prepare<[], { id: number; thread_id: number; content: string }>(
          "SELECT id, thread_id, content FROM ai_messages ORDER BY id",
        )
        .all(),
    ).toEqual(messagesBefore);
    expect(getAppliedMigrationIds(db).size).toBe(WITH_CLAUDE.length);
    db.close();
  });

  it("accepts claude inserts and still rejects unknown backends", () => {
    const { db } = createTempDb();
    runMigrations(db, WITH_CLAUDE);

    const insert = db.prepare(
      "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids, backend) VALUES (?, ?, ?, ?)",
    );
    for (const backend of ["codex", "opencode", "claude"]) {
      expect(() => insert.run(`Thread ${backend}`, "/tmp/job", "[]", backend)).not.toThrow();
    }
    expect(() => insert.run("Broken", "/tmp/job", "[]", "gemini")).toThrow(/CHECK/);

    // The widened constraint survives updates too.
    db.prepare("UPDATE ai_threads SET backend = 'claude' WHERE backend = 'opencode'").run();
    expect(
      db
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM ai_threads WHERE backend = 'claude'")
        .get(),
    ).toEqual({ n: 2 });
    expect(() => db.prepare("UPDATE ai_threads SET backend = 'nope'").run()).toThrow(/CHECK/);
    db.close();
  });

  it("keeps the message foreign key cascade and repeated startup is a no-op", () => {
    const { db } = createTempDb();
    runMigrations(db, PRE_CLAUDE);
    insertLegacyThreads(db);

    runMigrations(db, WITH_CLAUDE);
    // Repeated startup (server boots again) must not touch the schema or rows.
    runMigrations(db, WITH_CLAUDE);
    expect(getAppliedMigrationIds(db).size).toBe(WITH_CLAUDE.length);

    // The FK survived the column replacement: deleting a thread cascades.
    db.prepare("DELETE FROM ai_threads WHERE id = ?").run(1);
    const remaining = db
      .prepare<[], { thread_id: number }>("SELECT thread_id FROM ai_messages")
      .all();
    expect(remaining).toEqual([{ thread_id: 2 }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("keeps the widened CHECK when the migration runs on a fresh database", () => {
    const { db } = createTempDb();
    runMigrations(db, WITH_CLAUDE);
    expect(() =>
      db
        .prepare(
          "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids, backend) VALUES (?, ?, ?, ?)",
        )
        .run("Fresh claude thread", "/tmp/job", "[]", "claude"),
    ).not.toThrow();
    db.close();
  });
});

describe("X platform migration (011)", () => {
  const PRE_X = [
    ...INITIAL_MIGRATIONS,
    ...CREATOR_CATEGORY_MIGRATIONS,
    ...CREATOR_PLATFORM_MIGRATIONS,
  ];
  const WITH_X = [...PRE_X, ...CREATOR_PLATFORM_X_MIGRATIONS];

  it("widens the platform enum and adds the stable user id without losing rows", () => {
    const { db } = createTempDb();
    runMigrations(db, PRE_X);
    const youtubeId = Number(
      db
        .prepare(
          "INSERT INTO creators (youtube_channel_id, handle, display_name, channel_url, platform) VALUES (?, ?, ?, ?, ?)",
        )
        .run("UCtest", "handle", "YouTube Creator", "https://www.youtube.com/@handle", "youtube")
        .lastInsertRowid,
    );
    const rumbleId = Number(
      db
        .prepare(
          "INSERT INTO creators (handle, display_name, channel_url, platform) VALUES (?, ?, ?, ?)",
        )
        .run("rumble", "Rumble Creator", "https://rumble.com/c/rumble", "rumble").lastInsertRowid,
    );

    runMigrations(db, WITH_X);

    const rows = db
      .prepare<[], { id: number; platform: string; platform_user_id: string | null }>(
        "SELECT id, platform, platform_user_id FROM creators ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: youtubeId, platform: "youtube", platform_user_id: null },
      { id: rumbleId, platform: "rumble", platform_user_id: null },
    ]);

    expect(() =>
      db
        .prepare(
          "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, ?, ?)",
        )
        .run("X Creator", "https://x.com/xcreator", "x", "1234567890123456789"),
    ).not.toThrow();
    expect(() =>
      db
        .prepare("INSERT INTO creators (display_name, channel_url, platform) VALUES (?, ?, ?)")
        .run("Broken", "https://example.com", "mastodon"),
    ).toThrow(/CHECK/);
  });

  it("enforces one saved creator per (platform, user id)", () => {
    const { db } = createTempDb();
    runMigrations(db, WITH_X);
    const insert = db.prepare(
      "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, 'x', ?)",
    );
    insert.run("One", "https://x.com/one", "1234567890123456789");
    expect(() => insert.run("Duplicate", "https://x.com/dup", "1234567890123456789")).toThrow(
      /UNIQUE/,
    );
    // Null user ids stay unconstrained (YouTube/Rumble rows).
    insert.run("No id", "https://x.com/noid", null);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent alongside the other migrations", () => {
    const { db } = createTempDb();
    runMigrations(db, ALL_MIGRATIONS);
    runMigrations(db, ALL_MIGRATIONS);
    expect(getAppliedMigrationIds(db).size).toBe(ALL_MIGRATIONS.length);
    db.close();
  });
});

describe("tweet cache migration (012)", () => {
  const WITH_ALL = [
    ...INITIAL_MIGRATIONS,
    ...CREATOR_PLATFORM_MIGRATIONS,
    ...CREATOR_PLATFORM_X_MIGRATIONS,
    ...TWEET_CACHE_MIGRATIONS,
  ];

  function createMigratedDb(): Database.Database {
    const { db } = createTempDb();
    runMigrations(db, WITH_ALL);
    return db;
  }

  it("creates tweets, memberships, and feed state with the documented guards", () => {
    const db = createMigratedDb();
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tweets','creator_tweets','x_feed_state') ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(["creator_tweets", "tweets", "x_feed_state"]);

    const creatorId = Number(
      db
        .prepare(
          "INSERT INTO creators (display_name, channel_url, platform, platform_user_id) VALUES (?, ?, 'x', ?)",
        )
        .run("Creator", "https://x.com/creator", "1").lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("42", "1", "creator", "Creator", "https://x.com/creator/status/42", "hello");

    expect(() =>
      db
        .prepare(
          "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, content_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("43", "1", "creator", "Creator", "https://x.com/creator/status/43", "x", "partial"),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text, media_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("44", "1", "creator", "Creator", "https://x.com/creator/status/44", "x", "not json"),
    ).toThrow(/CHECK/);

    db.prepare(
      "INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind, timeline_at) VALUES (?, ?, ?, ?)",
    ).run(creatorId, "42", "post", "2026-09-16T10:00:00.000Z");
    expect(() =>
      db
        .prepare("INSERT INTO creator_tweets (creator_id, tweet_id, timeline_kind) VALUES (?, ?, ?)")
        .run(creatorId, "42", "quote"),
    ).toThrow(/CHECK/);
    // One membership per (creator, tweet): a repeat link is a conflict.
    expect(() =>
      db
        .prepare("INSERT INTO creator_tweets (creator_id, tweet_id) VALUES (?, ?)")
        .run(creatorId, "42"),
    ).toThrow(/UNIQUE|PRIMARY/);

    db.prepare("INSERT INTO x_feed_state (creator_id, config_key) VALUES (?, ?)").run(
      creatorId,
      "x1:worker:1",
    );
    expect(() =>
      db.prepare("INSERT INTO x_feed_state (creator_id, config_key, exhausted) VALUES (?, ?, ?)").run(
        creatorId,
        "x1:worker:1",
        "maybe",
      ),
    ).toThrow(/CHECK/);

    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("keeps a shared post when one timeline membership is removed", () => {
    const db = createMigratedDb();
    const creatorA = Number(
      db
        .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
        .run("A", "https://x.com/a").lastInsertRowid,
    );
    const creatorB = Number(
      db
        .prepare("INSERT INTO creators (display_name, channel_url) VALUES (?, ?)")
        .run("B", "https://x.com/b").lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO tweets (id, author_user_id, author_handle, author_name, url, text) VALUES ('7', '1', 'a', 'A', 'https://x.com/a/status/7', 'shared')",
    ).run();
    db.prepare("INSERT INTO creator_tweets (creator_id, tweet_id) VALUES (?, ?)").run(
      creatorA,
      "7",
    );
    db.prepare("INSERT INTO creator_tweets (creator_id, tweet_id) VALUES (?, ?)").run(
      creatorB,
      "7",
    );

    db.prepare("DELETE FROM creators WHERE id = ?").run(creatorA);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM tweets").get()).toEqual({ n: 1 });
    expect(
      db.prepare<[], { creator_id: number }>("SELECT creator_id FROM creator_tweets").all(),
    ).toEqual([{ creator_id: creatorB }]);

    db.prepare("DELETE FROM creators WHERE id = ?").run(creatorB);
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM creator_tweets").get()).toEqual({
      n: 0,
    });
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM tweets").get()).toEqual({ n: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});

describe("selected sources migration (013)", () => {
  const PRE_SOURCES = [
    ...INITIAL_MIGRATIONS,
    ...AI_CHAT_MIGRATIONS,
    ...AI_REPORTS_MIGRATIONS,
  ];
  const WITH_SOURCES = [...PRE_SOURCES, ...AI_SELECTED_SOURCES_MIGRATIONS];

  it("backfills legacy video id lists as versioned source documents", () => {
    const { db } = createTempDb();
    runMigrations(db, PRE_SOURCES);
    db.prepare(
      "INSERT INTO ai_threads (title, codex_work_dir, selected_video_ids) VALUES (?, ?, ?)",
    ).run("Thread", "/tmp/job", JSON.stringify(["vid1", "vid2"]));
    db.prepare("INSERT INTO ai_reports (selected_video_ids) VALUES (?)").run(
      JSON.stringify(["vid1"]),
    );

    runMigrations(db, WITH_SOURCES);

    const thread = db
      .prepare<[], { selected_sources: string; selected_video_ids: string }>(
        "SELECT selected_sources, selected_video_ids FROM ai_threads LIMIT 1",
      )
      .get();
    expect(JSON.parse(thread!.selected_sources)).toEqual({
      version: 1,
      sources: [
        { kind: "video", id: "vid1" },
        { kind: "video", id: "vid2" },
      ],
    });
    // The legacy column is untouched for old readers.
    expect(JSON.parse(thread!.selected_video_ids)).toEqual(["vid1", "vid2"]);

    const report = db
      .prepare<[], { selected_sources: string }>("SELECT selected_sources FROM ai_reports LIMIT 1")
      .get();
    expect(JSON.parse(report!.selected_sources)).toEqual({
      version: 1,
      sources: [{ kind: "video", id: "vid1" }],
    });

    // New mixed documents are accepted; non-JSON values are not.
    expect(() =>
      db
        .prepare("UPDATE ai_threads SET selected_sources = ? WHERE id = 1")
        .run(JSON.stringify({ version: 1, sources: [{ kind: "tweet", id: "42" }] })),
    ).not.toThrow();
    expect(() =>
      db.prepare("UPDATE ai_threads SET selected_sources = ? WHERE id = 1").run("nope"),
    ).toThrow(/CHECK/);
    db.close();
  });
});
