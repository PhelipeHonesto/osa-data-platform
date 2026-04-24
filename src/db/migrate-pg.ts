/**
 * PostgreSQL schema migration for Supabase.
 *
 * Loads every .sql file under schema/ (repo root) in deterministic order
 * (extensions → transactional → silver → analytics → gold → migrations) and
 * executes the concatenated result against the database. All statements are
 * CREATE ... IF NOT EXISTS, so re-applying is idempotent.
 *
 * Usage: npm run db:migrate-pg
 * Requires: SUPABASE_DATABASE_URL in .env or environment
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, closePg } from "./pg-database.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("migrate-pg");

// Load .env if present
try {
  const envPath = resolve(process.cwd(), ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — ok, env vars may be set directly
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// schema/ lives at repo root; migrate-pg.ts lives at src/db/ — go up two levels.
const SCHEMA_DIR = resolve(__dirname, "../../schema");

// Load order: extensions first, then namespace schemas, then dependencies,
// then additive migrations. Within each folder, files load alphabetically.
// schema/rollback/ is intentionally NOT listed — down-migrations apply manually.
const LOAD_ORDER = [
  "_extensions.sql",
  "_schemas.sql",
  "transactional/",
  "silver/",
  "analytics/",
  "gold/canonical/",
  "canonical/",
  "gold/infra/",
  "gold/views/",
  "migrations/",
];

function listSqlFiles(path: string): string[] {
  if (!existsSync(path) || !statSync(path).isDirectory()) return [];
  return readdirSync(path)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => join(path, f));
}

function resolveLoadPaths(): string[] {
  const paths: string[] = [];
  for (const entry of LOAD_ORDER) {
    const full = join(SCHEMA_DIR, entry);
    if (entry.endsWith(".sql")) {
      if (existsSync(full)) paths.push(full);
      continue;
    }
    paths.push(...listSqlFiles(full));
  }
  return paths;
}

function concatSchema(paths: string[]): string {
  const parts: string[] = [];
  for (const p of paths) {
    const rel = p.slice(SCHEMA_DIR.length + 1);
    parts.push(`-- ── ${rel} ─────────────────────────────────────────────`);
    parts.push(readFileSync(p, "utf-8"));
  }
  return parts.join("\n\n");
}

/** Extract [schema.]table pairs declared in the concatenated schema. */
function extractTableNames(sql: string): Array<{ schema: string; name: string }> {
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?:([a-zA-Z_][a-zA-Z0-9_]*)\.)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const seen = new Set<string>();
  const out: Array<{ schema: string; name: string }> = [];
  for (const m of sql.matchAll(re)) {
    const schema = m[1] ?? "public";
    const name = m[2];
    if (!name) continue;
    const k = `${schema}.${name}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ schema, name });
    }
  }
  return out.sort((a, b) => `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`));
}

async function main(): Promise<void> {
  console.log("[migrate-pg] Connecting to Supabase PostgreSQL...");

  const pool = getPool();

  const testResult = await pool.query("SELECT NOW() as now");
  console.log(`[migrate-pg] Connected. Server time: ${testResult.rows[0]?.now}`);

  const paths = resolveLoadPaths();
  if (paths.length === 0) {
    throw new Error(`No schema files found under ${SCHEMA_DIR}`);
  }
  console.log(`[migrate-pg] Loading ${paths.length} schema files:`);
  for (const p of paths) console.log(`  - ${p.slice(SCHEMA_DIR.length + 1)}`);

  const schema = concatSchema(paths);
  const expected = extractTableNames(schema);

  console.log(`[migrate-pg] Executing schema (${expected.length} tables declared)...`);
  await pool.query(schema);
  console.log("[migrate-pg] Schema executed successfully.");

  const expectedSchemas = Array.from(new Set(expected.map((t) => t.schema)));
  const tablesResult = await pool.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_tables
     WHERE schemaname = ANY($1::text[])
     ORDER BY schemaname, tablename`,
    [expectedSchemas],
  );
  const present = new Set(tablesResult.rows.map((r) => `${r.schemaname}.${r.tablename}`));
  console.log(
    `\n[migrate-pg] ${tablesResult.rows.length} tables present across schemas [${expectedSchemas.join(", ")}]:`,
  );
  for (const r of tablesResult.rows) console.log(`  - ${r.schemaname}.${r.tablename}`);

  const missing = expected
    .map((t) => `${t.schema}.${t.name}`)
    .filter((k) => !present.has(k));
  if (missing.length > 0) {
    log.error({ missing }, "expected tables missing");
  } else {
    console.log(`\n[migrate-pg] All ${expected.length} declared tables verified.`);
  }

  const extResult = await pool.query(`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
  if (extResult.rows.length > 0) {
    console.log("[migrate-pg] pgvector extension: enabled");
  } else {
    log.warn({}, "pgvector extension NOT enabled (may need superuser)");
  }

  const fuelResult = await pool.query("SELECT COUNT(*) as cnt FROM fuel_burn_estimates");
  console.log(`[migrate-pg] Fuel burn estimates: ${(fuelResult.rows[0] as { cnt: string }).cnt} rows`);

  await closePg();
  console.log("\n[migrate-pg] Done.");
}

main().catch((err) => {
  log.fatal({ err }, "migrate-pg fatal error");
  process.exit(1);
});
