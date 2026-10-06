import type { Database } from "better-sqlite3";

export interface Migration {
  /** Stable, sortable identifier, e.g. "001". Never reuse or edit after release. */
  id: string;
  name: string;
  sql: string;
}

export function sortMigrations(migrations: readonly Migration[]): Migration[] {
  return [...migrations].sort((a, b) => a.id.localeCompare(b.id));
}

export function getAppliedMigrationIds(db: Database): Set<string> {
  const rows = db.prepare<[], { id: string }>("SELECT id FROM schema_migrations").all();
  return new Set(rows.map((row) => row.id));
}

/**
 * Applies pending migrations exactly once each, in id order, inside a
 * transaction per migration. Safe to call repeatedly on the same database:
 * already-applied migrations are skipped, so re-running is a no-op.
 */
export function runMigrations(db: Database, migrations: readonly Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = getAppliedMigrationIds(db);
  const recordApplied = db.prepare(
    "INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of sortMigrations(migrations)) {
    if (applied.has(migration.id)) {
      continue;
    }
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      recordApplied.run(migration.id, migration.name, new Date().toISOString());
    });
    apply();
  }
}
