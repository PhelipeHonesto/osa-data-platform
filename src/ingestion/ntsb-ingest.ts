/**
 * NTSB Aviation Accident Database Ingestion
 *
 * Downloads the full NTSB accident/incident CSV (pipe-delimited, 80K+ records)
 * and loads into ntsb_accidents. Links to faa_aircraft via registration_number.
 *
 * Source: https://app.ntsb.gov/avdata/
 *
 * Usage:
 *   npm run ingest:ntsb                           # download from NTSB
 *   npm run ingest:ntsb -- --file /path/to/AviationData.txt
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import type Database from "better-sqlite3";
import { getDb, closeDb } from "../memory/database.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("ntsb");

// ── Constants ───────────────────────────────────────────────────────────────

const NTSB_URL = "https://app.ntsb.gov/aviationquery/Download.ashx?type=csv";
const TEMP_DIR = resolve("./data/ntsb_raw");
const BATCH_SIZE = 500;

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(): { filePath?: string } {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) return { filePath: resolve(args[i + 1]!) };
  }
  return {};
}

// ── Download ────────────────────────────────────────────────────────────────

async function downloadNtsbData(): Promise<string> {
  mkdirSync(TEMP_DIR, { recursive: true });
  const outPath = join(TEMP_DIR, "AviationData.txt");

  console.log(`[ntsb] Downloading from ${NTSB_URL}...`);
  const resp = await fetch(NTSB_URL, {
    signal: AbortSignal.timeout(180_000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OSA-Dumont/1.0)" },
  });

  if (!resp.ok) {
    throw new Error(`NTSB download failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(outPath, buffer);
  console.log(`[ntsb] Downloaded ${(buffer.length / 1_048_576).toFixed(1)} MB → ${outPath}`);
  return outPath;
}

// ── Column mapping ──────────────────────────────────────────────────────────

// NTSB CSV columns (pipe-delimited) — mapped by header name
const COLUMN_MAP: Record<string, string> = {
  "EventId": "event_id",
  "InvestigationType": "investigation_type",
  "EventDate": "event_date",
  "Location": "location",
  "City": "city",
  "State": "state",
  "Country": "country",
  "Latitude": "latitude",
  "Longitude": "longitude",
  "AirportCode": "airport_code",
  "AirportName": "airport_name",
  "InjurySeverity": "injury_severity",
  "AircraftDamage": "aircraft_damage",
  "RegistrationNumber": "registration_number",
  "Make": "aircraft_make",
  "Model": "aircraft_model",
  "AircraftCategory": "aircraft_category",
  "AmateurBuilt": "amateur_built",
  "NumberOfEngines": "number_of_engines",
  "EngineType": "engine_type",
  "FARDescription": "far_description",
  "TotalFatalInjuries": "total_fatal_injuries",
  "TotalSeriousInjuries": "total_serious_injuries",
  "TotalMinorInjuries": "total_minor_injuries",
  "TotalUninjured": "total_uninjured",
  "WeatherCondition": "weather_condition",
  "BroadPhaseOfFlight": "broad_phase_of_flight",
  "ReportStatus": "report_status",
  "PublicationDate": "publication_date",
};

const INT_FIELDS = new Set([
  "number_of_engines", "total_fatal_injuries", "total_serious_injuries",
  "total_minor_injuries", "total_uninjured",
]);
const FLOAT_FIELDS = new Set(["latitude", "longitude"]);

// ── Parse & Ingest ──────────────────────────────────────────────────────────

async function ingestFile(db: Database.Database, filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  console.log(`[ntsb] Parsing ${filePath}...`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO ntsb_accidents
    (event_id, investigation_type, event_date, location, city, state, country,
     latitude, longitude, airport_code, airport_name, injury_severity,
     aircraft_damage, registration_number, aircraft_make, aircraft_model,
     aircraft_category, amateur_built, number_of_engines, engine_type,
     far_description, total_fatal_injuries, total_serious_injuries,
     total_minor_injuries, total_uninjured, weather_condition,
     broad_phase_of_flight, report_status, publication_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const flush = db.transaction((ops: Array<() => void>) => {
    for (const op of ops) op();
  });

  let headers: string[] = [];
  let headerMap: Map<string, number> = new Map();
  let lineNum = 0;
  let count = 0;
  let skipped = 0;
  let batch: Array<() => void> = [];
  let stats = { fatal: 0, part135: 0, part91: 0, part121: 0 };

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (lineNum === 1) {
      // Parse header — strip BOM, pipe-delimited
      headers = trimmed.replace(/^\uFEFF/, "").split("|").map((h) => h.trim());
      for (let i = 0; i < headers.length; i++) {
        headerMap.set(headers[i]!, i);
      }
      continue;
    }

    const cols = trimmed.split("|");
    const eventId = cols[headerMap.get("EventId") ?? -1]?.trim();
    if (!eventId) { skipped++; continue; }

    // Build values array in the INSERT column order
    const dbCols = [
      "event_id", "investigation_type", "event_date", "location", "city",
      "state", "country", "latitude", "longitude", "airport_code",
      "airport_name", "injury_severity", "aircraft_damage",
      "registration_number", "aircraft_make", "aircraft_model",
      "aircraft_category", "amateur_built", "number_of_engines",
      "engine_type", "far_description", "total_fatal_injuries",
      "total_serious_injuries", "total_minor_injuries", "total_uninjured",
      "weather_condition", "broad_phase_of_flight", "report_status",
      "publication_date",
    ];

    // Reverse map: db column → NTSB header
    const reverseMap = new Map<string, string>();
    for (const [ntsbCol, dbCol] of Object.entries(COLUMN_MAP)) {
      reverseMap.set(dbCol, ntsbCol);
    }

    const values: (string | number | null)[] = [];
    for (const dbCol of dbCols) {
      const ntsbHeader = reverseMap.get(dbCol);
      const colIdx = ntsbHeader ? (headerMap.get(ntsbHeader) ?? -1) : -1;
      const raw = colIdx >= 0 ? (cols[colIdx]?.trim() ?? "") : "";

      if (!raw) {
        values.push(null);
      } else if (INT_FIELDS.has(dbCol)) {
        const n = parseInt(raw, 10);
        values.push(Number.isFinite(n) ? n : null);
      } else if (FLOAT_FIELDS.has(dbCol)) {
        const n = parseFloat(raw);
        values.push(Number.isFinite(n) ? n : null);
      } else {
        values.push(raw);
      }
    }

    // Track stats
    const severity = values[dbCols.indexOf("injury_severity")] as string | null;
    const far = values[dbCols.indexOf("far_description")] as string | null;
    if (severity === "Fatal") stats.fatal++;
    if (far?.includes("135")) stats.part135++;
    if (far?.includes("121")) stats.part121++;
    if (far?.includes("91") && !far.includes("135") && !far.includes("121")) stats.part91++;

    // Normalize registration number
    const regIdx = dbCols.indexOf("registration_number");
    const reg = values[regIdx] as string | null;
    if (reg && !reg.startsWith("N") && /^[A-Z0-9]+$/.test(reg)) {
      values[regIdx] = `N${reg}`;
    }

    const boundValues = [...values];
    batch.push(() => { insert.run(...boundValues); });
    count++;

    if (batch.length >= BATCH_SIZE) {
      flush(batch);
      batch = [];
    }

    if (count % 10_000 === 0) {
      console.log(`[ntsb] ${count.toLocaleString()} records...`);
    }
  }

  if (batch.length > 0) flush(batch);

  console.log(`\n[ntsb] Ingestion complete`);
  console.log(`  Total records: ${count.toLocaleString()}`);
  console.log(`  Skipped (no event ID): ${skipped}`);
  console.log(`  Fatal accidents: ${stats.fatal.toLocaleString()}`);
  console.log(`  Part 135 (charter): ${stats.part135.toLocaleString()}`);
  console.log(`  Part 121 (airline): ${stats.part121.toLocaleString()}`);
  console.log(`  Part 91 (general aviation): ${stats.part91.toLocaleString()}`);

  // Link stats
  const linked = db.prepare(`
    SELECT COUNT(*) as cnt FROM ntsb_accidents n
    JOIN faa_aircraft a ON n.registration_number = a.tail_number
  `).get() as { cnt: number };
  console.log(`  Linked to faa_aircraft: ${linked.cnt.toLocaleString()}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const t0 = Date.now();

  let filePath: string;
  if (args.filePath) {
    filePath = args.filePath;
  } else {
    filePath = await downloadNtsbData();
  }

  const db = getDb();
  await ingestFile(db, filePath);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[ntsb] Done in ${elapsed}s`);
  closeDb();
}

main().catch((err) => {
  log.fatal({ err }, "ntsb fatal error");
  process.exit(1);
});
