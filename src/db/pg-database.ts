/**
 * PostgreSQL connection pool for Supabase.
 *
 * Reads SUPABASE_DATABASE_URL from env. Exports pool, query helper, PgSyncBridge,
 * and the DbBridge interface shared with better-sqlite3.
 */

import pg from "pg";
import { childLogger } from "../utils/logger.js";

const log = childLogger("pg");

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DATABASE_URL not set. Add it to .env or set it as an environment variable.",
    );
  }

  pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false },
  });

  pool.on("error", (err) => {
    log.error({ err }, "unexpected pool error");
  });

  return pool;
}

/** Convenience: run a single query against the pool. */
export async function query(
  sql: string,
  params?: unknown[],
): Promise<pg.QueryResult> {
  return getPool().query(sql, params);
}

/** Close the pool for graceful shutdown. */
export async function closePg(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Standalone one-off pg.Client for scripts that don't want to use the shared
 *  pool (so they can `.end()` cleanly without closing the pool that other
 *  callers in the same process may still be using). Applies the standard
 *  Supabase SSL options consistently.
 *
 *  Caller is responsible for .connect() and .end(). */
export function createStandaloneClient(): pg.Client {
  const connectionString = process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "SUPABASE_DATABASE_URL not set. Add it to .env or set it as an environment variable.",
    );
  }
  return new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
}

// ── SQL dialect converter ───────────────────────────────────────────────────

/** Rewrite ROUND(expr, N) → ROUND((expr)::numeric, N) for PostgreSQL. */
function fixRound(sql: string): string {
  const re = /\bROUND\s*\(/gi;
  let result = "";
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
    result += sql.slice(lastIdx, match.index);
    // Find the matching close paren
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    // Inner content between ROUND( and the final )
    const inner = sql.slice(re.lastIndex, i - 1);
    // Split on the LAST comma to get expr and precision
    const lastComma = inner.lastIndexOf(",");
    if (lastComma >= 0) {
      const expr = inner.slice(0, lastComma).trim();
      const prec = inner.slice(lastComma + 1).trim();
      result += `ROUND((${expr})::numeric, ${prec})`;
    } else {
      result += `ROUND(${inner})`; // no precision arg
    }
    lastIdx = i;
  }
  result += sql.slice(lastIdx);
  return result;
}

/** Convert SQLite SQL to PostgreSQL — params, functions, syntax. */
export function convertSql(sql: string): string {
  let r = sql;

  // ? → $1, $2, ...
  let idx = 0;
  let inStr = false;
  let out = "";
  for (let i = 0; i < r.length; i++) {
    const ch = r[i]!;
    if (ch === "'" && r[i - 1] !== "\\") { inStr = !inStr; out += ch; }
    else if (ch === "?" && !inStr) { idx++; out += `$${idx}`; }
    else { out += ch; }
  }
  r = out;

  // CAST(strftime('%w', col) AS INTEGER) → EXTRACT(DOW FROM col::timestamp)::INTEGER
  r = r.replace(
    /CAST\s*\(\s*strftime\s*\(\s*'%w'\s*,\s*([^)]+)\)\s+AS\s+INTEGER\s*\)/gi,
    "EXTRACT(DOW FROM $1::timestamp)::INTEGER",
  );
  // CAST(strftime('%H', col) AS INTEGER) → EXTRACT(HOUR FROM col::timestamp)::INTEGER
  r = r.replace(
    /CAST\s*\(\s*strftime\s*\(\s*'%H'\s*,\s*([^)]+)\)\s+AS\s+INTEGER\s*\)/gi,
    "EXTRACT(HOUR FROM $1::timestamp)::INTEGER",
  );
  // strftime('%Y-%m', col) → to_char(col::timestamp, 'YYYY-MM')
  r = r.replace(
    /strftime\s*\(\s*'%Y-%m'\s*,\s*([^)]+)\)/gi,
    "to_char($1::timestamp, 'YYYY-MM')",
  );
  // DATE(col) → (col)::date
  r = r.replace(/\bDATE\s*\(\s*([^)]+)\)/gi, "($1)::date");
  // datetime('now', 'interval') → (NOW() + INTERVAL 'interval')::text
  r = r.replace(
    /datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    "(NOW() + INTERVAL '$1')::text",
  );
  // datetime('now') → NOW()::text (for TEXT column comparisons)
  r = r.replace(/datetime\s*\(\s*'now'\s*\)/gi, "NOW()::text");
  // INSERT OR REPLACE / INSERT OR IGNORE
  r = r.replace(/INSERT\s+OR\s+REPLACE/gi, "INSERT");
  r = r.replace(/INSERT\s+OR\s+IGNORE/gi, "INSERT");
  // COLLATE NOCASE
  r = r.replace(/\s+COLLATE\s+NOCASE/gi, "");
  // GROUP_CONCAT(col, sep) → STRING_AGG(col::text, sep)
  r = r.replace(
    /GROUP_CONCAT\s*\(\s*([^,)]+),\s*([^)]+)\)/gi,
    "STRING_AGG($1::text, $2)",
  );
  // GROUP_CONCAT(col) → STRING_AGG(col::text, ',')
  r = r.replace(
    /GROUP_CONCAT\s*\(\s*([^)]+)\)/gi,
    "STRING_AGG($1::text, ',')",
  );
  // IFNULL(a, b) → COALESCE(a, b)
  r = r.replace(/\bIFNULL\s*\(/gi, "COALESCE(");
  // ROUND(expr, N) — PG requires numeric, not real/double precision
  r = fixRound(r);

  return r;
}

// ── DbBridge interface ──────────────────────────────────────────────────────
// Shared contract for both better-sqlite3 and PgSyncBridge.
// better-sqlite3 returns values synchronously; PgSyncBridge returns Promises.
// Callers use `await` on all calls — `await syncValue` passes through.

export interface DbBridge {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[] | Promise<unknown[]>;
    get(...params: unknown[]): unknown | Promise<unknown>;
    run(...params: unknown[]): { changes: number } | Promise<{ changes: number }>;
  };
  exec(sql: string): unknown;
  close(): unknown;
}

// ── PgSyncBridge ────────────────────────────────────────────────────────────
// Mimics better-sqlite3's prepare().all/get/run pattern but async.
// Callers just add `await` — works with both SQLite (sync, await passes through)
// and PG (async, await resolves the Promise).

let bridge: PgSyncBridge | null = null;

export class PgSyncBridge implements DbBridge {
  private p: pg.Pool;

  constructor(pool: pg.Pool) { this.p = pool; }

  prepare(sql: string) {
    const pgSql = convertSql(sql);
    const p = this.p;
    return {
      all: async (...params: unknown[]) => {
        const result = await p.query(pgSql, params.length > 0 ? params : undefined);
        return result.rows;
      },
      get: async (...params: unknown[]) => {
        const result = await p.query(pgSql, params.length > 0 ? params : undefined);
        return result.rows[0] as Record<string, unknown> | undefined;
      },
      run: async (...params: unknown[]) => {
        const result = await p.query(pgSql, params.length > 0 ? params : undefined);
        return { changes: result.rowCount ?? 0 };
      },
    };
  }

  async exec(sql: string): Promise<void> {
    const pgSql = convertSql(sql);
    await this.p.query(pgSql);
  }

  async close(): Promise<void> {
    await this.p.end();
  }
}

/** Get the PgSyncBridge singleton. */
export function getPgBridge(): PgSyncBridge {
  if (bridge) return bridge;
  bridge = new PgSyncBridge(getPool());
  return bridge;
}
