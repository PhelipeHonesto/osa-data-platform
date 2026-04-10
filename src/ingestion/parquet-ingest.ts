/**
 * Parquet Flight Data Ingestion (via CSV intermediate)
 *
 * Step 1: Python converts Parquet → filtered CSV (charter-class US flights only)
 * Step 2: This script reads the CSV and inserts into SQLite
 *
 * Usage:
 *   npm run ingest:parquet ~/Downloads/2025_Q4_detailed_github.parquet
 *
 * Or if you already have the CSV:
 *   npm run ingest:csv /tmp/charter-flights.csv
 */

import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { getDb, closeDb } from "../memory/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Aircraft class mapping lives in parquet-to-csv.py — Python does the filtering

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
  return min > 0 && min < 1440 ? min : null; // max 24h, must be positive
}

function ingestCSV(db: Database.Database, csvPath: string): void {
  console.log(`[parquet-ingest] Reading ${csvPath}...`);
  const content = readFileSync(csvPath, "utf-8");
  const lines = content.split("\n");
  const header = lines[0];
  if (!header) { console.error("Empty CSV"); return; }

  console.log(`[parquet-ingest] ${lines.length - 1} rows to process`);

  const insertLeg = db.prepare(`
    INSERT INTO adsb_completed_legs
    (icao_hex, tail_number, operator_name, aircraft_type, aircraft_class,
     origin_icao, destination_icao, departure_time, arrival_time, flight_time_min)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertAircraft = db.prepare(`
    INSERT INTO faa_aircraft (tail_number, icao_hex, model, aircraft_class, certificate_holder, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
    ON CONFLICT(tail_number) DO UPDATE SET
      icao_hex = COALESCE(excluded.icao_hex, faa_aircraft.icao_hex),
      model = COALESCE(excluded.model, faa_aircraft.model),
      aircraft_class = COALESCE(excluded.aircraft_class, faa_aircraft.aircraft_class),
      certificate_holder = COALESCE(excluded.certificate_holder, faa_aircraft.certificate_holder),
      updated_at = datetime('now')
  `);

  // Dedup check: same tail + departure within 10 minutes
  const checkDup = db.prepare(`
    SELECT 1 FROM adsb_completed_legs
    WHERE tail_number = ? AND departure_time BETWEEN datetime(?, '-10 minutes') AND datetime(?, '+10 minutes')
    LIMIT 1
  `);

  let inserted = 0;
  let dupes = 0;
  let errors = 0;
  const seenAircraft = new Set<string>();
  const classCounts: Record<string, number> = {};

  const BATCH_SIZE = 10000;
  let batch: FlightRow[] = [];

  function flushBatch(): void {
    const runBatch = db.transaction((rows: FlightRow[]) => {
      for (const r of rows) {
        // Dedup
        if (checkDup.get(r.tailNumber, r.departureTime, r.departureTime)) {
          dupes++;
          continue;
        }

        const flightMin = computeFlightTimeMin(r.departureTime, r.arrivalTime);
        insertLeg.run(
          r.icaoHex, r.tailNumber, r.operator, r.aircraftType, r.aircraftClass,
          r.originIcao || null, r.destIcao || null,
          r.departureTime, r.arrivalTime, flightMin,
        );
        inserted++;

        if (r.aircraftClass) {
          classCounts[r.aircraftClass] = (classCounts[r.aircraftClass] ?? 0) + 1;
        }

        // Upsert aircraft (once per tail)
        if (!seenAircraft.has(r.tailNumber)) {
          seenAircraft.add(r.tailNumber);
          upsertAircraft.run(r.tailNumber, r.icaoHex || null, r.aircraftType || null, r.aircraftClass || null, r.operator || null);
        }
      }
    });
    runBatch(batch);
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
        flushBatch();
        if (inserted % 100000 < BATCH_SIZE) {
          console.log(`[parquet-ingest] ${inserted.toLocaleString()} inserted, ${dupes.toLocaleString()} dupes, ${errors} errors`);
        }
      }
    } catch {
      errors++;
    }
  }

  // Flush remaining
  if (batch.length > 0) flushBatch();

  console.log("\n═══════════════════════════════════════════");
  console.log("Parquet Flight Data Ingestion Complete");
  console.log("═══════════════════════════════════════════");
  console.log(`Inserted: ${inserted.toLocaleString()}`);
  console.log(`Duplicates skipped: ${dupes.toLocaleString()}`);
  console.log(`Errors: ${errors}`);
  console.log(`Unique aircraft: ${seenAircraft.size.toLocaleString()}`);
  console.log("\nCharter-class breakdown:");
  for (const [cls, cnt] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${cnt.toLocaleString()}`);
  }

  // Total legs
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM adsb_completed_legs").get() as { cnt: number }).cnt;
  console.log(`\nTotal legs in database: ${total.toLocaleString()}`);
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: npm run ingest:parquet <file.parquet|file.csv>");
    process.exit(1);
  }

  const db = getDb();
  const resolved = resolve(inputPath);

  if (resolved.endsWith(".csv")) {
    // Direct CSV ingestion
    ingestCSV(db, resolved);
  } else {
    // Parquet → CSV → ingest
    const csvPath = "/tmp/charter-flights.csv";
    const pyScript = resolve(__dirname, "parquet-to-csv.py");
    console.log(`[parquet-ingest] Converting Parquet → CSV via Python...`);
    console.log(`[parquet-ingest] python3 ${pyScript} ${resolved} ${csvPath}`);
    execSync(`python3 "${pyScript}" "${resolved}" "${csvPath}"`, { stdio: "inherit", timeout: 600000 });
    ingestCSV(db, csvPath);
  }

  closeDb();
}

main().catch((err) => {
  console.error("[parquet-ingest] Fatal:", err);
  process.exit(1);
});
