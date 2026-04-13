/**
 * adsb.lol Historical Data Ingestion
 *
 * Parses globe_history trace files into SQLite:
 * - faa_aircraft (upsert with icao_hex, type, operator)
 * - adsb_positions (downsampled positions)
 * - adsb_aircraft_state (final state per aircraft)
 * - adsb_completed_legs (materialized flight legs)
 *
 * Usage: npm run ingest:history /tmp/adsb-history/traces
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { getDb, closeDb } from "../memory/database.js";
import { haversine } from "../utils/haversine.js";

// ── ICAO Type Code → Aircraft Class mapping ─────────────────────────────────

export const ICAO_TYPE_CLASS: Record<string, string> = {
  // Heavy / Ultra-long
  GLF5: "heavy", GLF6: "heavy", G650: "heavy", GLEX: "heavy",
  GL5T: "heavy", GL7T: "heavy", CL60: "heavy", CL61: "heavy",
  GALX: "heavy", FA7X: "heavy", FA8X: "heavy",
  F900: "heavy", F2TH: "heavy", BD70: "heavy",
  G280: "super_mid", G150: "midsize",
  // Super-mid
  CL30: "super_mid", CL35: "super_mid", C68A: "super_mid",
  C680: "super_mid", E550: "super_mid", E545: "super_mid",
  LJ45: "super_mid", H25B: "super_mid", FA50: "super_mid",
  // Midsize
  C56X: "midsize", C560: "midsize", C55B: "midsize",
  E35L: "midsize", LJ35: "midsize", LJ40: "midsize",
  H25A: "midsize", BE40: "midsize", E55P: "midsize",
  LJ60: "midsize",
  // Light
  C25A: "light", C25B: "light", C25C: "light", C25M: "light",
  C510: "light", E500: "light", PRM1: "light", SF50: "light",
  EA50: "light", C501: "light", C525: "light", C526: "light",
  HDJT: "light",
  // Turboprop
  B350: "turboprop", B200: "turboprop", PC12: "turboprop",
  P180: "turboprop", TBM7: "turboprop", TBM8: "turboprop",
  TBM9: "turboprop", PAY4: "turboprop", BE9L: "turboprop",
  BE20: "turboprop", C208: "turboprop",
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface TraceFile {
  icao: string;
  r?: string;         // tail number
  t?: string;         // type code
  desc?: string;
  ownOp?: string;
  year?: string;
  noRegData?: boolean;
  timestamp: number;
  trace: (number | null | object | string)[][];
}

interface DownsampledPoint {
  offsetSec: number;
  lat: number;
  lon: number;
  altFt: number | null;
  speedKts: number | null;
  track: number | null;
  onGround: boolean;
  vertRate: number | null;
}

export interface IngestStats {
  processed: number;
  skippedNonUS: number;
  usAircraft: number;
  positionsIngested: number;
  positionsRaw: number;
  classCounts: Record<string, number>;
  unmatchedTypes: Map<string, number>;
  errors: number;
}

interface AirportCandidate {
  icao_code: string;
  latitude: number;
  longitude: number;
}

// ── Nearest airport resolver (same pattern as opensky-worker.ts) ─────────────

export function findNearestAirport(
  db: Database.Database,
  lat: number,
  lon: number,
  maxNm = 15,
): string | null {
  const degRange = maxNm / 60;
  const rows = db
    .prepare(
      `SELECT icao_code, latitude, longitude FROM faa_airports
       WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?`,
    )
    .all(
      lat - degRange,
      lat + degRange,
      lon - degRange,
      lon + degRange,
    ) as AirportCandidate[];

  let best: string | null = null;
  let bestDist = Infinity;
  for (const row of rows) {
    const dist = haversine(lat, lon, row.latitude, row.longitude);
    if (dist < bestDist && dist <= maxNm) {
      bestDist = dist;
      best = row.icao_code;
    }
  }
  return best;
}

// ── Downsampling ─────────────────────────────────────────────────────────────

export function downsampleTrace(data: TraceFile): DownsampledPoint[] {
  const result: DownsampledPoint[] = [];
  let lastKeptTime = -Infinity;
  let wasOnGround = false;

  for (const point of data.trace) {
    const offsetSec = point[0] as number;
    const lat = point[1] as number | null;
    const lon = point[2] as number | null;
    if (lat == null || lon == null) continue;

    const altFt = point[3] as number | null;
    const speedKts = point[4] as number | null;
    const track = point[5] as number | null;
    const vertRate = point[7] as number | null;

    // On-ground heuristic: low altitude + low speed
    const onGround = (altFt != null && altFt <= 500) && (speedKts == null || speedKts < 60);

    // Keep point if:
    // - Ground state changed (airborne <-> ground transition)
    // - At least 60 seconds since last kept point (airborne)
    // - At least 300 seconds since last kept point (ground — less granularity needed)
    const timeSinceLast = offsetSec - lastKeptTime;
    const stateChanged = onGround !== wasOnGround;
    const minInterval = onGround ? 300 : 60;

    if (stateChanged || timeSinceLast >= minInterval || result.length === 0) {
      result.push({ offsetSec, lat, lon, altFt, speedKts, track, onGround, vertRate });
      lastKeptTime = offsetSec;
      wasOnGround = onGround;
    }
  }

  return result;
}

// ── Batch insert positions ───────────────────────────────────────────────────

export function insertPositions(
  db: Database.Database,
  icaoHex: string,
  tailNumber: string,
  points: DownsampledPoint[],
  baseTimestamp: number,
): void {
  const insert = db.prepare(`
    INSERT INTO adsb_positions
    (icao_hex, tail_number, latitude, longitude, altitude_ft, ground_speed_kts,
     heading, vertical_rate, on_ground, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const p of points) {
    insert.run(
      icaoHex, tailNumber, p.lat, p.lon, p.altFt, p.speedKts,
      p.track, p.vertRate, p.onGround ? 1 : 0,
      Math.round(baseTimestamp + p.offsetSec),
    );
  }
}

// ── Upsert aircraft ──────────────────────────────────────────────────────────

export function upsertAircraft(db: Database.Database, data: TraceFile, aircraftClass: string | null): void {
  db.prepare(`
    INSERT OR REPLACE INTO faa_aircraft
    (tail_number, icao_hex, model, common_name, aircraft_class,
     year_manufactured, certificate_holder, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
  `).run(
    data.r, data.icao, data.t ?? null, data.desc ?? null,
    aircraftClass, data.year ? parseInt(data.year, 10) : null,
    data.ownOp ?? null,
  );
}

// ── Process a single trace file ──────────────────────────────────────────────

export function processFile(filePath: string, db: Database.Database, stats: IngestStats): void {
  // 1. Read and decompress
  const raw = readFileSync(filePath);
  const json = gunzipSync(raw).toString("utf-8");
  const data: TraceFile = JSON.parse(json);

  // 2. Filter: only US aircraft with registration
  if (!data.r || !data.r.startsWith("N")) {
    stats.skippedNonUS++;
    return;
  }

  stats.usAircraft++;

  // 3. Upsert faa_aircraft
  const aircraftClass = data.t ? (ICAO_TYPE_CLASS[data.t] ?? null) : null;
  upsertAircraft(db, data, aircraftClass);

  // 4. Downsample and ingest positions
  const positions = downsampleTrace(data);
  insertPositions(db, data.icao, data.r, positions, data.timestamp);
  stats.positionsIngested += positions.length;
  stats.positionsRaw += data.trace.length;

  // 5. Track class counts
  if (aircraftClass) {
    stats.classCounts[aircraftClass] = (stats.classCounts[aircraftClass] ?? 0) + 1;
  } else {
    stats.unmatchedTypes.set(data.t ?? "unknown", (stats.unmatchedTypes.get(data.t ?? "unknown") ?? 0) + 1);
  }
}

// ── Leg materialization ──────────────────────────────────────────────────────

function materializeLegs(db: Database.Database): number {
  const aircraft = db.prepare(`
    SELECT DISTINCT p.icao_hex, p.tail_number,
      a.model as aircraft_type, a.aircraft_class, a.certificate_holder as operator_name
    FROM adsb_positions p
    LEFT JOIN faa_aircraft a ON a.icao_hex = p.icao_hex
    WHERE p.tail_number IS NOT NULL
  `).all() as { icao_hex: string; tail_number: string; aircraft_type: string | null; aircraft_class: string | null; operator_name: string | null }[];

  const insertLeg = db.prepare(`
    INSERT INTO adsb_completed_legs
    (icao_hex, tail_number, operator_name, aircraft_type, aircraft_class,
     origin_icao, destination_icao, departure_time, arrival_time, flight_time_min, distance_nm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let legCount = 0;

  for (const ac of aircraft) {
    const positions = db.prepare(
      "SELECT latitude, longitude, altitude_ft, on_ground, timestamp FROM adsb_positions WHERE icao_hex = ? ORDER BY timestamp",
    ).all(ac.icao_hex) as { latitude: number; longitude: number; altitude_ft: number | null; on_ground: number; timestamp: number }[];

    // Find legs: sequence of airborne points between ground points
    let legStart: { lat: number; lon: number; ts: number } | null = null;
    let wasGround = true;

    for (const pos of positions) {
      const isGround = pos.on_ground === 1;

      if (wasGround && !isGround && !legStart) {
        // Takeoff detected
        legStart = { lat: pos.latitude, lon: pos.longitude, ts: pos.timestamp };
      } else if (!wasGround && isGround && legStart) {
        // Landing detected
        const flightTimeMin = Math.round((pos.timestamp - legStart.ts) / 60);

        // Only count legs > 5 minutes (filter taxi movements)
        if (flightTimeMin >= 5) {
          const distNm = haversine(legStart.lat, legStart.lon, pos.latitude, pos.longitude);
          const originIcao = findNearestAirport(db, legStart.lat, legStart.lon) ?? null;
          const destIcao = findNearestAirport(db, pos.latitude, pos.longitude) ?? null;
          const depTime = new Date(legStart.ts * 1000).toISOString();
          const arrTime = new Date(pos.timestamp * 1000).toISOString();

          insertLeg.run(ac.icao_hex, ac.tail_number, ac.operator_name, ac.aircraft_type, ac.aircraft_class, originIcao, destIcao, depTime, arrTime, flightTimeMin, Math.round(distNm));
          legCount++;
        }
        legStart = null;
      }

      wasGround = isGround;
    }
  }

  return legCount;
}

// ── Aircraft state computation ───────────────────────────────────────────────

function computeAircraftStates(db: Database.Database): number {
  const latest = db.prepare(`
    SELECT p.icao_hex, p.tail_number, p.latitude, p.longitude, p.altitude_ft,
           p.on_ground, p.timestamp,
           a.model as aircraft_type, a.aircraft_class, a.certificate_holder
    FROM adsb_positions p
    LEFT JOIN faa_aircraft a ON a.icao_hex = p.icao_hex
    WHERE p.timestamp = (SELECT MAX(p2.timestamp) FROM adsb_positions p2 WHERE p2.icao_hex = p.icao_hex)
    GROUP BY p.icao_hex
  `).all() as {
    icao_hex: string;
    tail_number: string | null;
    latitude: number;
    longitude: number;
    altitude_ft: number | null;
    on_ground: number;
    timestamp: number;
    aircraft_type: string | null;
    aircraft_class: string | null;
    certificate_holder: string | null;
  }[];

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO adsb_aircraft_state
    (icao_hex, tail_number, operator_name, aircraft_type, aircraft_class,
     state, latitude, longitude, nearest_airport,
     idle_since, idle_hours, last_seen, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let count = 0;
  const batch = db.transaction((rows: typeof latest) => {
    for (const r of rows) {
      const isGround = r.on_ground === 1;
      const state = isGround ? "idle_transient" : "airborne";
      const nearestAirport = isGround ? findNearestAirport(db, r.latitude, r.longitude) : null;
      const lastSeen = new Date(r.timestamp * 1000).toISOString();
      const idleSince = isGround ? lastSeen : null;
      const idleHours = 0; // Will be computed by the live worker

      upsert.run(
        r.icao_hex, r.tail_number, r.certificate_holder, r.aircraft_type, r.aircraft_class,
        state, r.latitude, r.longitude, nearestAirport,
        idleSince, idleHours, lastSeen,
      );
      count++;
    }
  });
  batch(latest);
  return count;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const tracesDir = process.argv[2];
  if (!tracesDir) {
    console.error("Usage: npm run ingest:history <traces-dir>");
    process.exit(1);
  }

  console.log(`[adsblol] Starting ingestion from ${tracesDir}`);
  const db = getDb();

  // Find all trace files
  const files: string[] = [];
  const subdirs = readdirSync(tracesDir);
  for (const sub of subdirs) {
    const subPath = join(tracesDir, sub);
    if (!statSync(subPath).isDirectory()) continue;
    for (const file of readdirSync(subPath)) {
      if (file.startsWith("trace_full_") && file.endsWith(".json")) {
        files.push(join(subPath, file));
      }
    }
  }
  console.log(`[adsblol] Found ${files.length} trace files`);

  const stats: IngestStats = {
    processed: 0,
    skippedNonUS: 0,
    usAircraft: 0,
    positionsIngested: 0,
    positionsRaw: 0,
    classCounts: {},
    unmatchedTypes: new Map<string, number>(),
    errors: 0,
  };

  // Process in transaction batches of 100 files
  const BATCH_SIZE = 100;
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const batch = files.slice(i, i + BATCH_SIZE);
    const runBatch = db.transaction(() => {
      for (const file of batch) {
        try {
          processFile(file, db, stats);
        } catch (_err) {
          stats.errors++;
        }
        stats.processed++;
      }
    });
    runBatch();

    if ((i + BATCH_SIZE) % 1000 === 0 || i + BATCH_SIZE >= files.length) {
      console.log(`[adsblol] Progress: ${stats.processed}/${files.length} files | ${stats.usAircraft} US aircraft | ${stats.positionsIngested} positions`);
    }
  }

  // Compute aircraft states
  console.log("[adsblol] Computing aircraft states...");
  const stateCount = computeAircraftStates(db);

  // Materialize completed legs
  console.log("[adsblol] Materializing completed legs...");
  const legCount = db.transaction(() => materializeLegs(db))();

  // Print summary
  console.log("\n═══════════════════════════════════════════");
  console.log("ADS-B Historical Ingestion Complete");
  console.log("═══════════════════════════════════════════");
  console.log(`Files processed: ${stats.processed} / ${files.length}`);
  console.log(`US aircraft found: ${stats.usAircraft}`);
  console.log(`Positions ingested: ${stats.positionsIngested.toLocaleString()} (downsampled from ${stats.positionsRaw.toLocaleString()})`);
  console.log(`Aircraft states: ${stateCount}`);
  console.log(`Completed legs: ${legCount}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`\nCharter-class aircraft:`);
  for (const [cls, count] of Object.entries(stats.classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }
  if (stats.unmatchedTypes.size > 0) {
    console.log(`\nTop 20 unmatched type codes:`);
    const sorted = [...stats.unmatchedTypes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    for (const [type, count] of sorted) {
      console.log(`  ${type}: ${count}`);
    }
  }

  // Top airports
  const topAirports = db.prepare(`
    SELECT origin_icao as airport, COUNT(*) as departures
    FROM adsb_completed_legs
    WHERE origin_icao IS NOT NULL
    GROUP BY origin_icao ORDER BY departures DESC LIMIT 10
  `).all() as { airport: string; departures: number }[];
  if (topAirports.length > 0) {
    console.log(`\nTop 10 airports by charter departures:`);
    for (const a of topAirports) {
      console.log(`  ${a.airport}: ${a.departures} departures`);
    }
  }

  closeDb();
}

// Only run main when invoked directly (not when imported)
const isDirectRun = process.argv[1]?.endsWith("adsblol-ingest.ts") || process.argv[1]?.endsWith("adsblol-ingest.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("[adsblol] Fatal:", err);
    process.exit(1);
  });
}
