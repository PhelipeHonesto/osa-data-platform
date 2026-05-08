/**
 * SQLite → PostgreSQL Data Migration
 *
 * Reads from local SQLite, writes to Supabase PostgreSQL in batches.
 * Respects foreign key ordering via tiers.
 *
 * Usage:
 *   npm run db:migrate-data -- --all
 *   npm run db:migrate-data -- --tier 1
 *   npm run db:migrate-data -- --table faa_aircraft
 *   npm run db:migrate-data -- --all --dry-run
 *   npm run db:migrate-data -- --all --skip-existing
 */

import { readFileSync } from "node:fs";
import { childLogger } from "../utils/logger.js";

const log = childLogger("migrate-data");
import { resolve } from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

const { Pool } = pg;

// ── Load .env ───────────────────────────────────────────────────────────────

try {
  const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
} catch { /* no .env */ }

// ── Table definitions ───────────────────────────────────────────────────────

interface TableDef {
  name: string;
  tier: number;
  batchSize: number;
  // Columns that are JSONB in PG but TEXT in SQLite — need JSON.parse
  jsonbCols?: Set<string>;
  // Columns that are BOOLEAN in PG but INTEGER (0/1) in SQLite
  boolCols?: Set<string>;
  // Primary key column(s) for ON CONFLICT
  conflictKeys?: string[];
}

const TABLES: TableDef[] = [
  // Tier 1: reference data
  { name: "fuel_burn_estimates", tier: 1, batchSize: 100, conflictKeys: ["aircraft_class"] },
  { name: "faa_airports", tier: 1, batchSize: 500, conflictKeys: ["icao_code"],
    boolCols: new Set(["has_instrument_approach", "tower_controlled"]) },
  { name: "faa_operators", tier: 1, batchSize: 500, conflictKeys: ["certificate_number"] },
  { name: "faa_aircraft_types", tier: 1, batchSize: 500, conflictKeys: ["model_code"] },
  { name: "faa_engine_types", tier: 1, batchSize: 500, conflictKeys: ["engine_code"] },

  // Tier 2: core data
  { name: "faa_aircraft", tier: 2, batchSize: 1000, conflictKeys: ["tail_number"] },
  { name: "pilot_contacts", tier: 2, batchSize: 1000, conflictKeys: ["certificate_number"],
    jsonbCols: new Set(["ratings"]) },
  { name: "faa_docindex", tier: 2, batchSize: 1000 },
  { name: "faa_registry_changes", tier: 2, batchSize: 5000 },
  { name: "pilot_aircraft_link", tier: 2, batchSize: 5000 },
  { name: "faa_deregistered", tier: 2, batchSize: 5000 },
  { name: "ntsb_accidents", tier: 2, batchSize: 5000, conflictKeys: ["event_id"] },

  // Tier 3: large data
  { name: "adsb_completed_legs", tier: 3, batchSize: 5000 },
  { name: "adsb_aircraft_state", tier: 3, batchSize: 5000, conflictKeys: ["icao_hex"] },
  { name: "knowledge_graph", tier: 3, batchSize: 1000, conflictKeys: ["icao_hex"],
    boolCols: new Set(["is_charter_class", "is_near_network_airport", "is_ghost_candidate"]) },

  // Tier 5: operational (small)
  { name: "pipeline_runs", tier: 5, batchSize: 100 },
  { name: "backfill_progress", tier: 5, batchSize: 100, conflictKeys: ["date"] },
  { name: "archive_progress", tier: 5, batchSize: 100, conflictKeys: ["date"] },
  { name: "data_quality_runs", tier: 5, batchSize: 100,
    jsonbCols: new Set(["details"]) },
  { name: "eval_runs", tier: 5, batchSize: 1000 },
  { name: "eval_run_summaries", tier: 5, batchSize: 100, conflictKeys: ["run_id"] },
  { name: "deals", tier: 5, batchSize: 100, conflictKeys: ["id"],
    jsonbCols: new Set(["guardian_flags"]) },
  { name: "deal_events", tier: 5, batchSize: 1000,
    jsonbCols: new Set(["payload"]) },
  { name: "deal_outcomes", tier: 5, batchSize: 100 },
  { name: "route_intel", tier: 5, batchSize: 100,
    jsonbCols: new Set(["top_operators"]) },
  // operator_profiles removed from SQLite→Postgres sync as of migration
  // 2026-05-06-001 (operator-profiles-rebuild). The Postgres operator_profiles
  // is now Postgres-native — keyed on faa_cert_number, populated by the
  // profile-builder agent (scripts/profile-builder/), not synced from SQLite.
  // SQLite still has the old transactional shape from src/db/migrations.ts
  // for dumont-agent quoting heuristics; that lives independently.
  // { name: "operator_profiles", tier: 5, batchSize: 100, conflictKeys: ["name"],
  //   jsonbCols: new Set(["certs", "fleet"]) },
  { name: "client_profiles", tier: 5, batchSize: 100,
    jsonbCols: new Set(["deal_history", "preferred_routes"]) },
  { name: "messages", tier: 5, batchSize: 500, conflictKeys: ["id"],
    jsonbCols: new Set(["attachments", "parsed_data", "platform_metadata"]) },
  { name: "calls", tier: 5, batchSize: 100, conflictKeys: ["call_id"],
    jsonbCols: new Set(["participants", "transcript", "detected_entities"]) },
  { name: "autonomy_rules", tier: 5, batchSize: 100 },
  { name: "processed_webhooks", tier: 5, batchSize: 500, conflictKeys: ["idempotency_key"] },
  { name: "validation_ledger", tier: 5, batchSize: 500 },
  { name: "target_companies", tier: 5, batchSize: 100,
    jsonbCols: new Set(["tail_numbers", "aircraft_classes"]) },
  { name: "target_contacts", tier: 5, batchSize: 100 },
  { name: "aircraft_listings", tier: 5, batchSize: 500,
    jsonbCols: new Set(["price_history_json"]) },
];

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  table?: string;
  tier?: number;
  all: boolean;
  dryRun: boolean;
  skipExisting: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { all: false, dryRun: false, skipExisting: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--table" && args[i + 1]) { result.table = args[i + 1]; i++; }
    else if (a === "--tier" && args[i + 1]) { result.tier = parseInt(args[i + 1]!, 10); i++; }
    else if (a === "--all") result.all = true;
    else if (a === "--dry-run") result.dryRun = true;
    else if (a === "--skip-existing") result.skipExisting = true;
  }
  if (!result.table && !result.tier && !result.all) {
    console.error("Usage: npm run db:migrate-data -- --all");
    console.error("       npm run db:migrate-data -- --tier 1");
    console.error("       npm run db:migrate-data -- --table faa_aircraft");
    console.error("Flags: --dry-run, --skip-existing");
    process.exit(1);
  }
  return result;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureJsonb(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}

function buildMultiRowInsert(
  tableName: string,
  columns: string[],
  rowCount: number,
  conflictKeys?: string[],
): string {
  const colList = columns.map((c) => `"${c}"`).join(", ");
  const rows: string[] = [];
  let paramIdx = 0;

  for (let r = 0; r < rowCount; r++) {
    const placeholders = columns.map(() => {
      paramIdx++;
      return `$${paramIdx}`;
    });
    rows.push(`(${placeholders.join(", ")})`);
  }

  let sql = `INSERT INTO "${tableName}" (${colList}) VALUES ${rows.join(", ")}`;

  if (conflictKeys && conflictKeys.length > 0) {
    const keyList = conflictKeys.map((k) => `"${k}"`).join(", ");
    sql += ` ON CONFLICT (${keyList}) DO NOTHING`;
  }

  return sql;
}

// ── Migrate one table ───────────────────────────────────────────────────────

async function migrateTable(
  sqlite: Database.Database,
  pgPool: pg.Pool,
  def: TableDef,
  dryRun: boolean,
  skipExisting: boolean,
): Promise<{ rows: number; inserted: number; errors: number; skipped: boolean }> {
  // Check if table exists in SQLite
  const tableExists = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(def.name) as { name: string } | undefined;

  if (!tableExists) {
    console.log(`[migrate] ${def.name}: table not found in SQLite — skipping`);
    return { rows: 0, inserted: 0, errors: 0, skipped: true };
  }

  // Count rows in SQLite
  const countRow = sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${def.name}"`).get() as { cnt: number };
  const totalRows = countRow.cnt;

  if (totalRows === 0) {
    console.log(`[migrate] ${def.name}: 0 rows — skipping`);
    return { rows: 0, inserted: 0, errors: 0, skipped: true };
  }

  if (dryRun) {
    console.log(`[migrate] ${def.name}: ${totalRows.toLocaleString()} rows (dry run — would migrate)`);
    return { rows: totalRows, inserted: 0, errors: 0, skipped: false };
  }

  // Check if PG table already has data
  if (skipExisting) {
    try {
      const pgCount = await pgPool.query(`SELECT COUNT(*) as cnt FROM "${def.name}"`);
      const existing = parseInt((pgCount.rows[0] as { cnt: string }).cnt, 10);
      if (existing > 0) {
        console.log(`[migrate] ${def.name}: ${existing.toLocaleString()} rows already in PG — skipping`);
        return { rows: totalRows, inserted: 0, errors: 0, skipped: true };
      }
    } catch {
      // Table may not exist yet
    }
  }

  // Get column names from SQLite
  const colInfo = sqlite.prepare(`PRAGMA table_info("${def.name}")`).all() as Array<{ name: string }>;
  // Filter out SQLite-only columns like rowid/id for AUTOINCREMENT tables
  // We skip the 'id' column for SERIAL PRIMARY KEY tables (PG auto-generates)
  const serialIdTables = new Set([
    "validation_ledger", "deal_events", "autonomy_rules", "faa_docindex",
    "pilot_aircraft_link", "aircraft_listings", "target_companies", "target_contacts",
    "eval_runs", "eval_run_summaries", "deal_outcomes", "faa_registry_changes",
    "pipeline_runs", "faa_deregistered", "data_quality_runs",
    "adsb_positions", "adsb_completed_legs",
  ]);

  const skipIdCol = serialIdTables.has(def.name);
  const columns = colInfo
    .map((c) => c.name)
    .filter((name) => !(skipIdCol && name === "id"));

  // PG has a 65535 parameter limit per query — cap batch size accordingly
  const maxBatch = Math.floor(65535 / columns.length);
  const effectiveBatch = Math.min(def.batchSize, maxBatch);

  console.log(`[migrate] ${def.name}: ${totalRows.toLocaleString()} rows (${columns.length} cols, batch ${effectiveBatch})`);

  let inserted = 0;
  let errors = 0;
  let offset = 0;

  while (offset < totalRows) {
    // Read batch from SQLite
    const rows = sqlite
      .prepare(`SELECT * FROM "${def.name}" LIMIT ${effectiveBatch} OFFSET ${offset}`)
      .all() as Array<Record<string, unknown>>;

    if (rows.length === 0) break;

    // Build params array
    const params: unknown[] = [];
    for (const row of rows) {
      for (const col of columns) {
        let val = row[col];

        // JSONB conversion
        if (def.jsonbCols?.has(col)) {
          val = ensureJsonb(val);
          if (val !== null && typeof val !== "string") {
            val = JSON.stringify(val);
          }
        }

        // Boolean conversion (SQLite 0/1 → keep as 0/1, PG handles it)
        if (def.boolCols?.has(col)) {
          val = val === 1 || val === true;
        }

        params.push(val ?? null);
      }
    }

    // Build and execute multi-row INSERT
    try {
      const sql = buildMultiRowInsert(def.name, columns, rows.length, def.conflictKeys);
      await pgPool.query(sql, params);
      inserted += rows.length;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      // Truncate error message for readability
      log.error({ table: def.name, offset, msg: msg.slice(0, 200) }, "batch error");

      // Try row-by-row for this batch to salvage what we can
      for (const row of rows) {
        const singleParams: unknown[] = [];
        for (const col of columns) {
          let val = row[col];
          if (def.jsonbCols?.has(col)) {
            val = ensureJsonb(val);
            if (val !== null && typeof val !== "string") val = JSON.stringify(val);
          }
          if (def.boolCols?.has(col)) val = val === 1 || val === true;
          singleParams.push(val ?? null);
        }
        try {
          const sql = buildMultiRowInsert(def.name, columns, 1, def.conflictKeys);
          await pgPool.query(sql, singleParams);
          inserted++;
        } catch {
          // Skip this row silently
        }
      }
    }

    offset += rows.length;

    // Log progress for large tables
    if (totalRows >= 10_000 && (offset % 50_000 === 0 || offset >= totalRows)) {
      const pct = ((offset / totalRows) * 100).toFixed(1);
      console.log(`[migrate] ${def.name}: ${offset.toLocaleString()} / ${totalRows.toLocaleString()} (${pct}%)`);
    }
  }

  console.log(`[migrate] ${def.name}: done — ${inserted.toLocaleString()} inserted, ${errors} batch errors`);
  return { rows: totalRows, inserted, errors, skipped: false };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  // Open SQLite
  const sqlitePath = process.env.DATABASE_PATH ?? process.env.DUMONT_DB_PATH ?? resolve("./data/dumont.db");
  console.log(`[migrate] Source: SQLite at ${sqlitePath}`);
  const sqlite = new Database(sqlitePath, { readonly: true });
  sqlite.pragma("busy_timeout = 30000");

  // Open PG
  const connStr = process.env.SUPABASE_DATABASE_URL;
  if (!connStr) {
    log.error({}, "SUPABASE_DATABASE_URL not set");
    process.exit(1);
  }
  console.log(`[migrate] Target: Supabase PostgreSQL`);
  const pgPool = new Pool({
    connectionString: connStr,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });

  // Test PG connection
  const testResult = await pgPool.query("SELECT NOW() as now");
  console.log(`[migrate] PG connected. Server time: ${(testResult.rows[0] as { now: string }).now}`);

  if (args.dryRun) console.log("[migrate] DRY RUN — no data will be written\n");
  else console.log();

  // Determine which tables to migrate
  let tablesToMigrate: TableDef[];
  if (args.table) {
    const found = TABLES.find((t) => t.name === args.table);
    if (!found) {
      log.error({ requested: args.table, available: TABLES.map((t) => t.name) }, "unknown table");
      process.exit(1);
    }
    tablesToMigrate = [found];
  } else if (args.tier != null) {
    tablesToMigrate = TABLES.filter((t) => t.tier === args.tier);
  } else {
    // --all: skip tier 4 (analytics — rebuild after migration)
    tablesToMigrate = TABLES.filter((t) => t.tier !== 4);
  }

  console.log(`[migrate] Migrating ${tablesToMigrate.length} tables\n`);

  let totalRows = 0;
  let totalInserted = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  for (const def of tablesToMigrate) {
    const result = await migrateTable(sqlite, pgPool, def, args.dryRun, args.skipExisting);
    totalRows += result.rows;
    totalInserted += result.inserted;
    totalErrors += result.errors;
    if (result.skipped) totalSkipped++;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n===================================================");
  console.log("Data Migration Summary");
  console.log("===================================================");
  console.log(`Tables: ${tablesToMigrate.length} (${totalSkipped} skipped)`);
  console.log(`Rows: ${totalRows.toLocaleString()} total, ${totalInserted.toLocaleString()} inserted`);
  console.log(`Errors: ${totalErrors} batch errors`);
  console.log(`Time: ${elapsed}s`);

  sqlite.close();
  await pgPool.end();
}

main().catch((err) => {
  log.fatal({ err }, "migrate-data fatal error");
  process.exit(1);
});
