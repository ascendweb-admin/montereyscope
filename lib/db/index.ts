export { closeDatabase, getDb, getDatabasePath } from "./connection";
export type { ScopeDatabase } from "./connection";
export { INITIAL_MIGRATIONS } from "./migrations";
export type { Migration } from "./migrator";
export { runMigrations } from "./migrator";
