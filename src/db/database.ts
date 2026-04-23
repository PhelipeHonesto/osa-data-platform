/**
 * Database singleton — SQLite via better-sqlite3.
 *
 * Opens ./data/dumont.db (or path from DUMONT_DB_PATH env var).
 * WAL mode for read performance. Foreign keys enabled.
 * Runs migrations on first access.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { runMigrations } from "./migrations.js";
import type { DbBridge } from "./pg-database.js";

let db: Database.Database | null = null;

/**
 * Get the database instance. Creates and migrates on first call.
 * @param dbPath - Override path (used in tests for temp databases).
 */
export function getDb(dbPath?: string): Database.Database {
  if (db && !dbPath) return db;

  const resolvedPath = dbPath ?? process.env.DATABASE_PATH ?? process.env.DUMONT_DB_PATH ?? path.resolve("./data/dumont.db");

  // Auto-create data directory (skip for in-memory databases)
  if (resolvedPath !== ":memory:") {
    mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const instance = new Database(resolvedPath);
  instance.pragma("journal_mode = WAL");
  instance.pragma("busy_timeout = 30000");
  instance.pragma("foreign_keys = ON");

  runMigrations(instance);

  // Only cache the singleton for the default path
  if (!dbPath) {
    db = instance;
  }

  return instance;
}

/**
 * Close the singleton database connection.
 * Call on process shutdown or in tests for cleanup.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Create an isolated in-memory database for testing.
 * Fully migrated, independent from the singleton.
 */
export function createTestDb(): Database.Database {
  return getDb(":memory:");
}

/**
 * Get the database for the configured backend.
 * DATABASE_TYPE=postgres → PgSyncBridge (async .prepare().all/get/run)
 * DATABASE_TYPE=sqlite (default) → better-sqlite3 (sync)
 *
 * Callers should `await` all .prepare().all/get/run calls.
 * `await syncValue` passes through immediately, so this works for both.
 */

// Cached PgSyncBridge instance (lazy-loaded)
let pgBridge: DbBridge | null = null;

export function getDatabase(): DbBridge {
  if (process.env.DATABASE_TYPE === "postgres") {
    if (pgBridge) return pgBridge;
    // Dynamic import at module level is not possible synchronously in ESM.
    // Use the pg-database module directly since it's already imported by callers.
    throw new Error("Call initPgBridge() before getDatabase() in postgres mode");
  }
  return getDb();
}

/**
 * Initialize the PG bridge. Call once at server startup when DATABASE_TYPE=postgres.
 */
export function setPgBridge(bridge: DbBridge): void {
  pgBridge = bridge;
}
