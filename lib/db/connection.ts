import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { ALL_MIGRATIONS } from "./migrations";
import { runMigrations } from "./migrator";

export type ScopeDatabase = Database.Database;

const DEFAULT_DB_DIR = path.join(process.cwd(), "data");
const DEFAULT_DB_FILENAME = "localtube.db";

/**
 * Absolute path of the SQLite database file. The legacy environment key is
 * retained as a fallback so the rebrand never disconnects an existing library.
 * This value stays on the server; it must never be included in API responses.
 */
export function getDatabasePath(): string {
  return (
    process.env.SCOPE_DB_PATH ??
    process.env.LOCALTUBE_DB_PATH ??
    path.join(DEFAULT_DB_DIR, DEFAULT_DB_FILENAME)
  );
}

let dbInstance: ScopeDatabase | null = null;

/**
 * Returns the process-wide database connection, creating and migrating the
 * database file on first use. Migrations are idempotent, so this is safe to
 * call repeatedly across requests.
 */
export function getDb(): ScopeDatabase {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  // WAL keeps reads fast while a refresh writes; FK enforcement is per-connection.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db, ALL_MIGRATIONS);

  dbInstance = db;
  return dbInstance;
}

/** Closes the process-wide connection; intended for tests and graceful shutdown. */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
