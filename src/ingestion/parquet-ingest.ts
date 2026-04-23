/**
 * Parquet Flight Data Ingestion (via CSV intermediate)
 *
 * Step 1: Python converts Parquet → filtered CSV (charter-class US flights only)
 * Step 2: This script reads the CSV and bulk-inserts into Postgres.
 *
 * Usage:
 *   npm run ingest:parquet ~/Downloads/2025_Q4_detailed_github.parquet
 *
 * Or if you already have the CSV:
 *   npm run ingest:csv /tmp/charter-flights.csv
 *
 * NOTE: The pre-Phase-6 version had per-row dedup via SELECT ... datetime(?, '-10 minutes').
 * That round-tripped N times and was expensive. Post-migration, dedup is done
 * per-batch by pre-fetching existing (tail_number, departure_time) pairs for
 * the batch's tails and filtering in-memory with a ±10-min bucket set.
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDatabase, setPgBridge } from "../db/database.js";
import { getPgBridge, closePg, type DbBridge } from "../db/pg-database.js";
import { bulkUpsert } from "../db/bulk-upsert.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("parquet-ingest");

const __dirname = dirname(fileURLToPath(import.meta.url));

interface FlightRow {
  icaoHex: string;
  tailNumber: string;
  aircraftType: string;
  aircraftClass: string;
  operator: string;
  originIcao: string;
  destIcao: string;
  departureTime: string;
  arrivalTime: string;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { fields.push(current); current = ""; continue; }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function computeFlightTimeMin(dep: string, arr: string): number | null {
  const depMs = new Date(dep).getTime();
  const arrMs = new Date(arr).getTime();
  if (isNaN(depMs) || isNaN(arrMs)) return null;
  const min = Math.round((arrMs - depMs) / 60000);
  return min > 0 && min < 1440 ? min : null;
}

const LEG_COLS = [
  "icao_hex", "tail_number", "operator_name", "aircraft_type", "aircraft_class",
  "origin_icao", "destination_icao", "departure_time", "arrival_time", "flight_time_min",
] as const;

const AIRCRAFT_COLS = [
  "tail_number", "icao_hex", "model", "aircraft_class", "certificate_holder", "status", "updated_at",
] as const;

const AIRCRAFT_UPDATE_CLAUSE = `
  icao_hex = COALESCE(EXCLUDED.icao_hex, faa_aircraft.icao_hex),
  model = COALESCE(EXCLUDED.model, faa_aircraft.model),
  aircraft_class = COALESCE(EXCLUDED.aircraft_class, faa_aircraft.aircraft_class),
  certificate_holder = COALESCE(EXCLUDED.certificate_holder, faa_aircraft.certificate_holder),
  updated_at = EXCLUDED.updated_at
`.trim();

/** Pre-fetch existing (tail, dep_time_minute) pairs for this batch's tails,
 *  returning a lookup map. Callers use this to filter near-duplicates (±10 min). */
async function prefetchExisting(
  db: DbBridge,
  tails: string[],
): Promise<Map<string, Set<number>>> {
  if (tails.length === 0) return new Map();
  const placeholders = tails.map((_, i) => `$${i + 1}`).join(",");
  const sql =
    `SELECT tail_number, departure_time FROM adsb_completed_legs ` +
    `WHERE tail_number IN (${placeholders})`;
  const rows = await db.prepare(sql).all(...tails) as Array<{ tail_number: string; departure_time: string }>;
  const map = new Map<string, Set<number>>();
  for (const r of rows) {
    const min = Math.floor(new Date(r.departure_time).getTime() / 60000);
    if (!Number.isFinite(min)) continue;
    const s = map.get(r.tail_number) ?? new Set<number>();
    s.add(min);
    map.set(r.tail_number, s);
  }
  return map;
}

function isNearDuplicate(row: FlightRow, existing: Map<string, Set<number>>): boolean {
  const ex = existing.get(row.tailNumber);
  if (!ex) return false;
  const min = Math.floor(new Date(row.departureTime).getTime() / 60000);
  if (!Number.isFinite(min)) return false;
  for (let m = min - 10; m <= min + 10; m++) if (ex.has(m)) return true;
  return false;
}

async function ingestCSV(db: DbBridge, csvPath: string): Promise<void> {
  console.log(`[parquet-ingest] Reading ${csvPath}...`);
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.split("\n");
  const header = lines[0];
  if (!header) { log.error({}, "empty CSV"); return; }

  console.log(`[parquet-ingest] ${lines.length - 1} rows to process`);

  const BATCH_SIZE = 10_000;
  let batch: FlightRow[] = [];
  let inserted = 0;
  let dupes = 0;
  let errors = 0;
  const seenAircraft = new Set<string>();
  const classCounts: Record<string, number> = {};
  const now = new Date().toISOString();

  async function flushBatch(): Promise<void> {
    if (batch.length === 0) return;
    const tails = [...new Set(batch.map((r) => r.tailNumber))];
    const existing = await prefetchExisting(db, tails);

    const legRows: unknown[][] = [];
    const aircraftRows: unknown[][] = [];

    for (const r of batch) {
      if (isNearDuplicate(r, existing)) { dupes++; continue; }

      legRows.push([
        r.icaoHex, r.tailNumber, r.operator, r.aircraftType, r.aircraftClass,
        r.originIcao || null, r.destIcao || null,
        r.departureTime, r.arrivalTime, computeFlightTimeMin(r.departureTime, r.arrivalTime),
      ]);
      inserted++;

      if (r.aircraftClass) classCounts[r.aircraftClass] = (classCounts[r.aircraftClass] ?? 0) + 1;

      if (!seenAircraft.has(r.tailNumber)) {
        seenAircraft.add(r.tailNumber);
        aircraftRows.push([
          r.tailNumber, r.icaoHex || null, r.aircraftType || null,
          r.aircraftClass || null, r.operator || null, "active", now,
        ]);
      }
    }

    await bulkUpsert(db, "adsb_completed_legs", [...LEG_COLS], legRows, []);
    await bulkUpsert(
      db, "faa_aircraft", [...AIRCRAFT_COLS], aircraftRows,
      ["tail_number"], { updateClause: AIRCRAFT_UPDATE_CLAUSE },
    );
    batch = [];
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    try {
      const cols = parseCSVLine(line);
      const row: FlightRow = {
        icaoHex: cols[0] ?? "",
        tailNumber: cols[1] ?? "",
        aircraftType: cols[2] ?? "",
        aircraftClass: cols[3] ?? "",
        operator: cols[4] ?? "",
        originIcao: cols[5] ?? "",
        destIcao: cols[6] ?? "",
        departureTime: cols[7] ?? "",
        arrivalTime: cols[8] ?? "",
      };
      if (!row.tailNumber || !row.departureTime) continue;
      batch.push(row);

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
        if (inserted % 100_000 < BATCH_SIZE) {
          console.log(`[parquet-ingest] ${inserted.toLocaleString()} inserted, ${dupes.toLocaleString()} dupes, ${errors} errors`);
        }
      }
    } catch {
      errors++;
    }
  }

  if (batch.length > 0) await flushBatch();

  console.log("\n═══════════════════════════════════════════");
  console.log("Parquet Flight Data Ingestion Complete");
  console.log("═══════════════════════════════════════════");
  console.log(`Inserted:           ${inserted.toLocaleString()}`);
  console.log(`Duplicates skipped: ${dupes.toLocaleString()}`);
  console.log(`Errors:             ${errors}`);
  console.log(`Unique aircraft:    ${seenAircraft.size.toLocaleString()}`);
  console.log("\nCharter-class breakdown:");
  for (const [cls, cnt] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${cnt.toLocaleString()}`);
  }

  const total = ((await db.prepare("SELECT COUNT(*) as cnt FROM adsb_completed_legs").get()) as { cnt: number }).cnt;
  console.log(`\nTotal legs in database: ${total.toLocaleString()}`);
}

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "parquet-ingest requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: npm run ingest:parquet <file.parquet|file.csv>");
    process.exit(1);
  }

  const resolved = resolve(inputPath);

  if (resolved.endsWith(".csv")) {
    await ingestCSV(db, resolved);
  } else {
    const csvPath = "/tmp/charter-flights.csv";
    const pyScript = resolve(__dirname, "parquet-to-csv.py");
    console.log(`[parquet-ingest] Converting Parquet → CSV via Python...`);
    console.log(`[parquet-ingest] python3 ${pyScript} ${resolved} ${csvPath}`);
    execSync(`python3 "${pyScript}" "${resolved}" "${csvPath}"`, { stdio: "inherit", timeout: 600000 });
    await ingestCSV(db, csvPath);
  }

  await closePg();
}

main().catch((err) => {
  log.fatal({ err }, "parquet-ingest fatal error");
  process.exit(1);
});
