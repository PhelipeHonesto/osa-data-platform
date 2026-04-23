/**
 * adsb.lol Historical Data Parser
 *
 * Parses globe_history trace files into in-memory structures.
 * Used by src/ingestion/history-backfill.ts; also runnable standalone to ingest
 * a local traces directory directly into Postgres.
 *
 * After Phase 6 migration, positions are NOT written to the hot tier
 * (adsb_positions has a 48h TTL that would immediately delete historical
 * data). Legs are detected in-memory per aircraft and written to
 * adsb_completed_legs. aircraft_class discovery writes to faa_aircraft.
 *
 * Usage: npm run ingest:history /tmp/adsb-history/traces
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getDatabase, setPgBridge } from "../db/database.js";
import { getPgBridge, closePg, type DbBridge } from "../db/pg-database.js";
import { bulkUpsert } from "../db/bulk-upsert.js";
import { haversine } from "../utils/haversine.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("adsblol-ingest");

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

export interface DownsampledPoint {
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
  skippedOversized: number;
  usAircraft: number;
  positionsIngested: number;
  positionsRaw: number;
  classCounts: Record<string, number>;
  unmatchedTypes: Map<string, number>;
  errors: number;
}

/**
 * Maximum trace file size (compressed or decompressed) that parseTraceFile
 * will attempt. Above this, the file is skipped and stats.skippedOversized
 * increments. Rationale: JSON.parse loads the whole trace into memory, and
 * V8's default ~4 GB heap OOMs on files whose decompressed JSON exceeds
 * that. A handful of aircraft (heavy-usage fractional fleets, mostly) have
 * daily traces that blow past reasonable limits. Streaming-parser
 * migration tracked in docs/phase1-followups.md.
 */
export const MAX_TRACE_SIZE_BYTES = 500 * 1024 * 1024; // 500 MB

export interface Airport {
  icao_code: string;
  latitude: number;
  longitude: number;
}

export interface ParsedTrace {
  data: TraceFile;
  aircraftClass: string | null;
  points: DownsampledPoint[];
}

export interface DetectedLeg {
  icao: string;
  tail: string;
  operator: string | null;
  aircraftType: string | null;
  aircraftClass: string | null;
  originIcao: string | null;
  destIcao: string | null;
  departureTime: string;
  arrivalTime: string;
  flightTimeMin: number;
  distanceNm: number;
}

// ── Airport index (in-memory for fast haversine lookup) ─────────────────────

export async function loadAirports(db: DbBridge): Promise<Airport[]> {
  return await db.prepare(
    `SELECT icao_code, latitude, longitude FROM faa_airports`,
  ).all() as Airport[];
}

/** In-memory nearest-airport lookup. Beats per-row SQL by ~1000x for bulk
 *  leg materialization. */
export function findNearestInMemory(
  airports: Airport[],
  lat: number,
  lon: number,
  maxNm = 15,
): string | null {
  const degRange = maxNm / 60;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const ap of airports) {
    if (Math.abs(ap.latitude - lat) > degRange) continue;
    if (Math.abs(ap.longitude - lon) > degRange) continue;
    const dist = haversine(lat, lon, ap.latitude, ap.longitude);
    if (dist < bestDist && dist <= maxNm) {
      bestDist = dist;
      best = ap.icao_code;
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

    // adsb.lol encodes alt as either a number (ft) or the string "ground"
    // when the aircraft is reported stationary on the field. Treat "ground"
    // as onGround=true regardless of speed (a plane taxiing at 19 kts is
    // still on the ground).
    const rawAlt = point[3] as number | string | null;
    const altIsGroundString = rawAlt === "ground";
    const altFt: number | null = typeof rawAlt === "number" ? rawAlt : null;
    const speedKts = point[4] as number | null;
    const track = point[5] as number | null;
    const vertRate = point[7] as number | null;

    const onGround = altIsGroundString
      || ((altFt != null && altFt <= 500) && (speedKts == null || speedKts < 60));

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

// ── Parse one trace file (no DB writes) ─────────────────────────────────────

/** Read + decompress + filter + downsample a single trace_full_*.json.gz file.
 *  Returns null for non-US aircraft (same filter as the pre-Phase-6 version).
 *  No DB writes — the caller accumulates and bulk-writes. */
export function parseTraceFile(filePath: string, stats: IngestStats): ParsedTrace | null {
  // Compressed-size pre-filter. A gzipped trace that already exceeds the
  // threshold at rest will almost always OOM on decompress+parse.
  const fileStats = statSync(filePath);
  if (fileStats.size > MAX_TRACE_SIZE_BYTES) {
    stats.skippedOversized++;
    log.warn(
      { file: filePath, sizeMB: (fileStats.size / 1024 / 1024).toFixed(0), stage: "compressed" },
      "skipping oversized trace file",
    );
    return null;
  }

  const raw = readFileSync(filePath);
  let json: string;
  try {
    json = gunzipSync(raw).toString("utf-8");
  } catch {
    // Some trace files are stored uncompressed — fall back to raw UTF-8.
    json = raw.toString("utf-8");
  }

  // Decompressed-size check. Catches files that compress well but have
  // huge position counts — the actual OOM scenario we saw on 2025-01-16.
  if (json.length > MAX_TRACE_SIZE_BYTES) {
    stats.skippedOversized++;
    log.warn(
      { file: filePath, sizeMB: (json.length / 1024 / 1024).toFixed(0), stage: "decompressed" },
      "skipping oversized trace file",
    );
    return null;
  }

  const data: TraceFile = JSON.parse(json);

  // Filter: only US aircraft with registration
  if (!data.r || !data.r.startsWith("N")) {
    stats.skippedNonUS++;
    return null;
  }

  stats.usAircraft++;

  const aircraftClass = data.t ? (ICAO_TYPE_CLASS[data.t] ?? null) : null;
  const points = downsampleTrace(data);
  stats.positionsIngested += points.length;
  stats.positionsRaw += data.trace.length;

  if (aircraftClass) {
    stats.classCounts[aircraftClass] = (stats.classCounts[aircraftClass] ?? 0) + 1;
  } else {
    stats.unmatchedTypes.set(data.t ?? "unknown", (stats.unmatchedTypes.get(data.t ?? "unknown") ?? 0) + 1);
  }

  return { data, aircraftClass, points };
}

// ── In-memory leg detection ─────────────────────────────────────────────────

/** Scan a single aircraft's downsampled points and emit completed legs
 *  (taxi-outs under 5 minutes are filtered out).
 *
 *  wasGround is tri-state:
 *    - null   → unknown (start of trace; aircraft may be mid-flight)
 *    - true   → last seen confirmed on ground
 *    - false  → last seen confirmed airborne
 *
 *  A legStart is only emitted on a confirmed ground→airborne transition
 *  (wasGround === true && !p.onGround). If the trace begins while the
 *  aircraft is already airborne (common for flights that cross UTC
 *  midnight in the daily globe-history tars), no fake takeoff is emitted
 *  at `data.timestamp + 0` — we simply wait for the first real takeoff
 *  later in the trace. This is the fix for Phase 7's timestamp bug.
 */
export function detectLegs(
  parsed: ParsedTrace,
  airports: Airport[],
): DetectedLeg[] {
  const legs: DetectedLeg[] = [];
  const { data, aircraftClass, points } = parsed;

  let legStart: { lat: number; lon: number; ts: number } | null = null;
  let wasGround: boolean | null = null;

  for (const p of points) {
    const ts = data.timestamp + p.offsetSec;
    if (wasGround === true && !p.onGround && !legStart) {
      legStart = { lat: p.lat, lon: p.lon, ts };
    } else if (wasGround === false && p.onGround && legStart) {
      const flightTimeMin = Math.round((ts - legStart.ts) / 60);
      if (flightTimeMin >= 5) {
        const distNm = haversine(legStart.lat, legStart.lon, p.lat, p.lon);
        legs.push({
          icao: data.icao.toLowerCase(),
          tail: data.r ?? "",
          operator: data.ownOp ?? null,
          aircraftType: data.t ?? null,
          aircraftClass,
          originIcao: findNearestInMemory(airports, legStart.lat, legStart.lon),
          destIcao: findNearestInMemory(airports, p.lat, p.lon),
          departureTime: new Date(legStart.ts * 1000).toISOString(),
          arrivalTime: new Date(ts * 1000).toISOString(),
          flightTimeMin,
          distanceNm: Math.round(distNm),
        });
      }
      legStart = null;
    }
    wasGround = p.onGround;
  }
  return legs;
}

// ── Bulk writers ────────────────────────────────────────────────────────────

const LEG_COLS = [
  "icao_hex", "tail_number", "operator_name", "aircraft_type", "aircraft_class",
  "origin_icao", "destination_icao", "departure_time", "arrival_time",
  "flight_time_min", "distance_nm",
] as const;

export async function bulkInsertLegs(db: DbBridge, legs: DetectedLeg[]): Promise<void> {
  if (legs.length === 0) return;
  const rows = legs.map((l) => [
    l.icao, l.tail, l.operator, l.aircraftType, l.aircraftClass,
    l.originIcao, l.destIcao, l.departureTime, l.arrivalTime,
    l.flightTimeMin, l.distanceNm,
  ]);
  await bulkUpsert(db, "adsb_completed_legs", [...LEG_COLS], rows, []);
}

const AIRCRAFT_COLS = [
  "tail_number", "icao_hex", "model", "common_name", "aircraft_class",
  "year_manufactured", "certificate_holder", "status", "updated_at",
] as const;

const AIRCRAFT_UPDATE_CLAUSE = `
  icao_hex = COALESCE(EXCLUDED.icao_hex, faa_aircraft.icao_hex),
  model = COALESCE(EXCLUDED.model, faa_aircraft.model),
  common_name = COALESCE(EXCLUDED.common_name, faa_aircraft.common_name),
  aircraft_class = COALESCE(EXCLUDED.aircraft_class, faa_aircraft.aircraft_class),
  year_manufactured = COALESCE(EXCLUDED.year_manufactured, faa_aircraft.year_manufactured),
  certificate_holder = COALESCE(EXCLUDED.certificate_holder, faa_aircraft.certificate_holder),
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at
`.trim();

/** Upsert aircraft discovered from traces. Preserves existing data where the
 *  trace file doesn't have a value (via COALESCE). */
export async function bulkUpsertAircraft(
  db: DbBridge,
  parses: ParsedTrace[],
): Promise<void> {
  if (parses.length === 0) return;
  const now = new Date().toISOString();
  const rows = parses
    .filter((p) => p.data.r) // must have tail (PK)
    .map((p) => [
      p.data.r ?? "",
      p.data.icao.toLowerCase(),
      p.data.t ?? null,
      p.data.desc ?? null,
      p.aircraftClass,
      p.data.year ? parseInt(p.data.year, 10) : null,
      p.data.ownOp ?? null,
      "active",
      now,
    ]);
  await bulkUpsert(db, "faa_aircraft", [...AIRCRAFT_COLS], rows,
    ["tail_number"], { updateClause: AIRCRAFT_UPDATE_CLAUSE });
}

// ── Main (standalone) ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "adsblol-ingest requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  const tracesDir = process.argv[2];
  if (!tracesDir) {
    console.error("Usage: npm run ingest:history <traces-dir>");
    process.exit(1);
  }

  console.log(`[adsblol] Starting ingestion from ${tracesDir}`);
  const airports = await loadAirports(db);
  console.log(`[adsblol] Loaded ${airports.length} airports`);

  // Find all trace files
  const files: string[] = [];
  const subdirs = readdirSync(tracesDir);
  for (const sub of subdirs) {
    const subPath = join(tracesDir, sub);
    if (!statSync(subPath).isDirectory()) continue;
    for (const file of readdirSync(subPath)) {
      if (file.startsWith("trace_full_") && (file.endsWith(".json") || file.endsWith(".json.gz"))) {
        files.push(join(subPath, file));
      }
    }
  }
  console.log(`[adsblol] Found ${files.length} trace files`);

  const stats: IngestStats = {
    processed: 0, skippedNonUS: 0, skippedOversized: 0, usAircraft: 0,
    positionsIngested: 0, positionsRaw: 0,
    classCounts: {},
    unmatchedTypes: new Map<string, number>(),
    errors: 0,
  };

  // Process in chunks: parse + detect legs in-memory, then bulk-flush.
  const CHUNK = 500;
  let totalLegs = 0;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    const parsedBatch: ParsedTrace[] = [];
    const legBatch: DetectedLeg[] = [];

    for (const file of chunk) {
      try {
        const p = parseTraceFile(file, stats);
        if (!p) { stats.processed++; continue; }
        parsedBatch.push(p);
        for (const leg of detectLegs(p, airports)) legBatch.push(leg);
      } catch {
        stats.errors++;
      }
      stats.processed++;
    }

    await bulkUpsertAircraft(db, parsedBatch);
    await bulkInsertLegs(db, legBatch);
    totalLegs += legBatch.length;

    if ((i + CHUNK) % 5000 === 0 || i + CHUNK >= files.length) {
      console.log(`[adsblol] Progress: ${stats.processed}/${files.length} files | ${stats.usAircraft} US aircraft | ${totalLegs} legs so far`);
    }
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("ADS-B Historical Ingestion Complete");
  console.log("═══════════════════════════════════════════");
  console.log(`Files processed: ${stats.processed} / ${files.length}`);
  console.log(`US aircraft:     ${stats.usAircraft}`);
  console.log(`Downsampled:     ${stats.positionsIngested.toLocaleString()} points (from ${stats.positionsRaw.toLocaleString()} raw)`);
  console.log(`Completed legs:  ${totalLegs}`);
  console.log(`Errors:          ${stats.errors}`);
  console.log(`Skipped (size):  ${stats.skippedOversized}`);
  console.log(`\nCharter-class aircraft:`);
  for (const [cls, count] of Object.entries(stats.classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls}: ${count}`);
  }

  await closePg();
}

const isDirectRun = process.argv[1]?.endsWith("adsblol-ingest.ts") || process.argv[1]?.endsWith("adsblol-ingest.js");
if (isDirectRun) {
  main().catch((err) => {
    log.fatal({ err }, "adsblol-ingest fatal error");
    process.exit(1);
  });
}
