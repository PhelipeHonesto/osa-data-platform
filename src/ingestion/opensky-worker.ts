/**
 * OpenSky ADS-B Ingestion Worker — standalone CLI process.
 *
 * Polls OpenSky Network REST API every 12 seconds (free tier safe).
 * Stores position pings in adsb_positions, updates adsb_aircraft_state.
 * Resolves tail numbers from faa_aircraft via icao_hex join.
 * Cleans up positions older than 24 hours every hour.
 *
 * Run via: npm run opensky
 */

import type Database from "better-sqlite3";
import { getDb, closeDb } from "../memory/database.js";
import { haversine } from "../utils/haversine.js";

// ── Constants ──────────────────────────────────────────────────────────────

const OPENSKY_API = "https://opensky-network.org/api/states/all";
const POLL_INTERVAL_MS = 12_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const POSITION_TTL_SECONDS = 86_400; // 24 hours
const LOG_EVERY_N_CYCLES = 10;

const US_BBOX = { lamin: 24.4, lamax: 49.4, lomin: -125.0, lomax: -66.9 };

// Conversion factors
const METERS_TO_FEET = 3.28084;
const MPS_TO_KNOTS = 1.94384;
const MPS_TO_FPM = 196.85;

// ── OpenSky response types ─────────────────────────────────────────────────

/** OpenSky state vector — array positions per docs */
interface OpenSkyResponse {
  time: number;
  states: (string | number | boolean | null)[][] | null;
}

// state vector indices
const IDX_ICAO = 0;
const IDX_CALLSIGN = 1;
const IDX_LON = 5;
const IDX_LAT = 6;
const IDX_BARO_ALT = 7;
const IDX_ON_GROUND = 8;
const IDX_VELOCITY = 9;
const IDX_HEADING = 10;
const IDX_VERT_RATE = 11;
const IDX_GEO_ALT = 13;

// ── Types ──────────────────────────────────────────────────────────────────

interface PositionRow {
  icao_hex: string;
  tail_number: string | null;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitude_ft: number | null;
  ground_speed_kts: number | null;
  heading: number | null;
  vertical_rate: number | null;
  on_ground: number;
  nearest_airport: string | null;
  timestamp: number;
}

interface AirportCandidate {
  icao_code: string;
  latitude: number;
  longitude: number;
}

// ── Nearest airport resolver ───────────────────────────────────────────────

function findNearestAirport(
  db: Database.Database,
  lat: number,
  lon: number,
  maxNm = 15,
): string | null {
  // Bounding box filter: 1 degree ~ 60nm
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

// ── Tail number resolution ─────────────────────────────────────────────────

function buildIcaoToTailMap(db: Database.Database): Map<string, string> {
  const rows = db
    .prepare("SELECT icao_hex, tail_number FROM faa_aircraft WHERE icao_hex IS NOT NULL")
    .all() as { icao_hex: string; tail_number: string }[];
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.icao_hex.toLowerCase(), row.tail_number);
  }
  return map;
}

// ── Fetch OpenSky ──────────────────────────────────────────────────────────

async function fetchStates(): Promise<OpenSkyResponse | null> {
  const url = `${OPENSKY_API}?lamin=${US_BBOX.lamin}&lamax=${US_BBOX.lamax}&lomin=${US_BBOX.lomin}&lomax=${US_BBOX.lomax}`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(`[opensky] HTTP ${resp.status}: ${resp.statusText}`);
      return null;
    }
    return (await resp.json()) as OpenSkyResponse;
  } catch (err) {
    console.warn(`[opensky] Fetch error: ${(err as Error).message}`);
    return null;
  }
}

// ── Main ingestion cycle ───────────────────────────────────────────────────

function ingestCycle(db: Database.Database, icaoToTail: Map<string, string>, data: OpenSkyResponse): number {
  if (!data.states || data.states.length === 0) return 0;

  const insertPos = db.prepare(
    `INSERT INTO adsb_positions
       (icao_hex, tail_number, callsign, latitude, longitude, altitude_ft,
        ground_speed_kts, heading, vertical_rate, on_ground, nearest_airport, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const upsertState = db.prepare(
    `INSERT INTO adsb_aircraft_state
       (icao_hex, tail_number, state, latitude, longitude, nearest_airport, last_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(icao_hex) DO UPDATE SET
       tail_number = COALESCE(excluded.tail_number, adsb_aircraft_state.tail_number),
       state = excluded.state,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       nearest_airport = COALESCE(excluded.nearest_airport, adsb_aircraft_state.nearest_airport),
       last_seen = datetime('now'),
       idle_since = CASE
         WHEN excluded.state = 'idle' AND adsb_aircraft_state.state != 'idle' THEN datetime('now')
         WHEN excluded.state = 'idle' THEN adsb_aircraft_state.idle_since
         ELSE NULL
       END,
       idle_hours = CASE
         WHEN excluded.state = 'idle' AND adsb_aircraft_state.idle_since IS NOT NULL
           THEN (julianday('now') - julianday(adsb_aircraft_state.idle_since)) * 24.0
         ELSE 0
       END,
       updated_at = datetime('now')`,
  );

  const rows: PositionRow[] = [];

  for (const sv of data.states) {
    const icao = sv[IDX_ICAO] as string | null;
    const lat = sv[IDX_LAT] as number | null;
    const lon = sv[IDX_LON] as number | null;

    // Skip entries with missing position or ICAO
    if (!icao || lat == null || lon == null) continue;

    const icaoLower = icao.toLowerCase();
    const callsign = (sv[IDX_CALLSIGN] as string | null)?.trim() || null;
    const onGround = sv[IDX_ON_GROUND] as boolean;
    const baroAlt = sv[IDX_BARO_ALT] as number | null;
    const geoAlt = sv[IDX_GEO_ALT] as number | null;
    const velocity = sv[IDX_VELOCITY] as number | null;
    const heading = sv[IDX_HEADING] as number | null;
    const vertRate = sv[IDX_VERT_RATE] as number | null;

    const altFt = (baroAlt ?? geoAlt) != null ? (baroAlt ?? geoAlt)! * METERS_TO_FEET : null;
    const speedKts = velocity != null ? velocity * MPS_TO_KNOTS : null;
    const vertFpm = vertRate != null ? vertRate * MPS_TO_FPM : null;
    const tailNumber = icaoToTail.get(icaoLower) ?? null;

    // Only resolve nearest airport for on-ground aircraft (expensive per row)
    const nearestAirport = onGround ? findNearestAirport(db, lat, lon) : null;

    rows.push({
      icao_hex: icaoLower,
      tail_number: tailNumber,
      callsign,
      latitude: lat,
      longitude: lon,
      altitude_ft: altFt,
      ground_speed_kts: speedKts,
      heading,
      vertical_rate: vertFpm,
      on_ground: onGround ? 1 : 0,
      nearest_airport: nearestAirport,
      timestamp: data.time,
    });
  }

  // Batch insert in a transaction
  const runBatch = db.transaction(() => {
    for (const r of rows) {
      insertPos.run(
        r.icao_hex, r.tail_number, r.callsign, r.latitude, r.longitude,
        r.altitude_ft, r.ground_speed_kts, r.heading, r.vertical_rate,
        r.on_ground, r.nearest_airport, r.timestamp,
      );
      const aircraftState = r.on_ground ? "idle" : "airborne";
      upsertState.run(
        r.icao_hex, r.tail_number, aircraftState,
        r.latitude, r.longitude, r.nearest_airport,
      );
    }
  });
  runBatch();

  return rows.length;
}

// ── Cleanup old positions ──────────────────────────────────────────────────

function cleanupOldPositions(db: Database.Database): number {
  const cutoff = Math.floor(Date.now() / 1000) - POSITION_TTL_SECONDS;
  const result = db.prepare("DELETE FROM adsb_positions WHERE timestamp < ?").run(cutoff);
  return result.changes;
}

// ── Worker loop ────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the OpenSky ingestion worker.
 * Can be called from server/index.ts (embedded) or standalone CLI.
 * Returns a stop function for graceful shutdown.
 */
export async function startWorker(): Promise<() => void> {
  console.log("[opensky] Starting ADS-B ingestion worker...");
  console.log(`[opensky] Poll interval: ${POLL_INTERVAL_MS / 1000}s | Cleanup: every ${CLEANUP_INTERVAL_MS / 3_600_000}h | TTL: ${POSITION_TTL_SECONDS / 3600}h`);

  const db = getDb();
  const icaoToTail = buildIcaoToTailMap(db);
  console.log(`[opensky] Loaded ${icaoToTail.size} ICAO→tail mappings from faa_aircraft`);

  let cycle = 0;
  let totalIngested = 0;

  // Poll loop
  pollTimer = setInterval(async () => {
    cycle++;
    const data = await fetchStates();
    if (data) {
      const count = ingestCycle(db, icaoToTail, data);
      totalIngested += count;
      if (cycle % LOG_EVERY_N_CYCLES === 0) {
        const stateCount = (db.prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state").get() as { count: number }).count;
        console.log(
          `[opensky] Cycle ${cycle}: ${count} positions ingested | ` +
          `${stateCount} aircraft tracked | ${totalIngested} total positions`,
        );
      }
    }
  }, POLL_INTERVAL_MS);

  // Cleanup loop
  cleanupTimer = setInterval(() => {
    const deleted = cleanupOldPositions(db);
    if (deleted > 0) {
      console.log(`[opensky] Cleaned up ${deleted} positions older than 24h`);
    }
  }, CLEANUP_INTERVAL_MS);

  // Run first cycle immediately
  const data = await fetchStates();
  if (data) {
    const count = ingestCycle(db, icaoToTail, data);
    console.log(`[opensky] Initial fetch: ${count} positions from ${data.states?.length ?? 0} state vectors`);
  } else {
    console.warn("[opensky] Initial fetch failed — will retry on next cycle");
  }

  // Return stop function
  return () => {
    console.log("[opensky] Stopping worker...");
    if (pollTimer) clearInterval(pollTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    pollTimer = null;
    cleanupTimer = null;
  };
}

// ── Standalone CLI entry point ────────────────────────────────────────────
// Only runs when executed directly (not when imported by server)

const isMainModule = process.argv[1]?.includes("opensky-worker");
if (isMainModule) {
  startWorker()
    .then((stop) => {
      process.on("SIGINT", () => { stop(); closeDb(); process.exit(0); });
      process.on("SIGTERM", () => { stop(); closeDb(); process.exit(0); });
    })
    .catch((err) => {
      console.error("[opensky] Fatal:", err);
      process.exit(1);
    });
}
