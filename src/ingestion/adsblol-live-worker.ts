/**
 * adsb.lol Live ADS-B Ingestion Worker — standalone CLI process.
 *
 * Polls adsb.lol REST API every 15 seconds for US continental airspace.
 * Stores positions in adsb_positions, updates adsb_aircraft_state,
 * materializes completed legs into adsb_completed_legs.
 * Resolves hex codes to tail numbers via faa_aircraft table.
 * Cleans up positions older than 24 hours every hour.
 *
 * adsb.lol returns aviation units natively (feet, knots, fpm) —
 * no metric conversion needed unlike OpenSky.
 *
 * Run via: npm run adsb:live
 */

import type Database from "better-sqlite3";
import { getDb, closeDb } from "../memory/database.js";
import { haversine } from "../utils/haversine.js";

// ── Constants ──────────────────────────────────────────────────────────────

const ADSBLOL_BASE = "https://api.adsb.lol/v2";
const POLL_INTERVAL_MS = 15_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const POSITION_TTL_SECONDS = 86_400; // 24 hours
const LOG_EVERY_N_CYCLES = 10;

// US continental bounding box — same as opensky-worker
const US_BBOX = { lamin: 24.4, lamax: 49.4, lomin: -125.0, lomax: -66.9 };

// Grid of lat/lon centers covering the US bbox, each with 250nm radius.
// 250nm radius ≈ 4.2° lat, so spacing at ~4° gives full coverage.
// We need roughly a 6×3 grid to blanket 24.4→49.4 lat, -125→-67 lon.
const GRID_CENTERS: { lat: number; lon: number }[] = [];
for (let lat = 26; lat <= 48; lat += 5) {
  for (let lon = -123; lon <= -68; lon += 8) {
    GRID_CENTERS.push({ lat, lon });
  }
}

// ── adsb.lol response types ───────────────────────────────────────────────

interface AdsbLolAircraft {
  hex: string;
  r?: string;           // tail number
  t?: string;           // ICAO type code
  flight?: string;      // callsign
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";  // feet or "ground"
  alt_geom?: number;    // feet
  gs?: number;          // ground speed in knots
  track?: number;       // degrees
  baro_rate?: number;   // ft/min
  category?: string;
  ownOp?: string;       // owner/operator
  // fields we don't use but exist in response
  [key: string]: unknown;
}

interface AdsbLolResponse {
  ac: AdsbLolAircraft[] | null;
  total: number;
  now: number;          // epoch ms
  ctime: number;
  ptime: number;
}

// ── Shared types ──────────────────────────────────────────────────────────

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

// ── Nearest airport resolver (same as opensky-worker.ts) ──────────────────

function findNearestAirport(
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

// ── Tail number resolution ────────────────────────────────────────────────

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

// ── Fetch adsb.lol ────────────────────────────────────────────────────────

async function fetchGrid(): Promise<AdsbLolAircraft[]> {
  const seen = new Set<string>();
  const all: AdsbLolAircraft[] = [];

  for (const center of GRID_CENTERS) {
    const url = `${ADSBLOL_BASE}/lat/${center.lat}/lon/${center.lon}/dist/250`;
    try {
      const resp = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.warn(`[adsb.lol] HTTP ${resp.status} for ${center.lat},${center.lon}`);
        continue;
      }
      const data = (await resp.json()) as AdsbLolResponse;
      if (!data.ac) continue;

      for (const ac of data.ac) {
        if (!seen.has(ac.hex)) {
          seen.add(ac.hex);
          all.push(ac);
        }
      }
    } catch (err) {
      console.warn(`[adsb.lol] Fetch error for ${center.lat},${center.lon}: ${(err as Error).message}`);
    }
  }

  return all;
}

// ── Leg materialization for a single aircraft ─────────────────────────────
// Called when an aircraft transitions from airborne → on_ground.
// Looks back in adsb_positions to find the takeoff point.

function tryMaterializeLeg(
  db: Database.Database,
  icaoHex: string,
  landingLat: number,
  landingLon: number,
  landingTs: number,
): boolean {
  // Find the most recent ground→air transition (takeoff) before this landing
  const positions = db.prepare(`
    SELECT latitude, longitude, on_ground, timestamp
    FROM adsb_positions
    WHERE icao_hex = ? AND timestamp <= ? AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(
    icaoHex,
    landingTs,
    landingTs - 86_400, // look back max 24h
  ) as { latitude: number; longitude: number; on_ground: number; timestamp: number }[];

  // Walk backwards to find takeoff point (last on_ground before airborne sequence)
  let takeoffPos: { latitude: number; longitude: number; timestamp: number } | null = null;
  let foundAirborne = false;

  for (const pos of positions) {
    if (!foundAirborne && pos.on_ground === 0) {
      foundAirborne = true;
    } else if (foundAirborne && pos.on_ground === 1) {
      // This is the last ground point before takeoff
      takeoffPos = pos;
      break;
    }
  }

  if (!takeoffPos) return false;

  const flightTimeMin = Math.round((landingTs - takeoffPos.timestamp) / 60);
  if (flightTimeMin < 5) return false; // filter taxi movements

  const distNm = haversine(takeoffPos.latitude, takeoffPos.longitude, landingLat, landingLon);
  const originIcao = findNearestAirport(db, takeoffPos.latitude, takeoffPos.longitude);
  const destIcao = findNearestAirport(db, landingLat, landingLon);
  const depTime = new Date(takeoffPos.timestamp * 1000).toISOString();
  const arrTime = new Date(landingTs * 1000).toISOString();

  // Look up aircraft info
  const faa = db.prepare(
    "SELECT tail_number, model, aircraft_class, certificate_holder FROM faa_aircraft WHERE icao_hex = ?",
  ).get(icaoHex) as { tail_number: string; model: string | null; aircraft_class: string | null; certificate_holder: string | null } | undefined;

  db.prepare(`
    INSERT INTO adsb_completed_legs
    (icao_hex, tail_number, operator_name, aircraft_type, aircraft_class,
     origin_icao, destination_icao, departure_time, arrival_time, flight_time_min, distance_nm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    icaoHex,
    faa?.tail_number ?? null,
    faa?.certificate_holder ?? null,
    faa?.model ?? null,
    faa?.aircraft_class ?? null,
    originIcao,
    destIcao,
    depTime,
    arrTime,
    flightTimeMin,
    Math.round(distNm),
  );

  return true;
}

// ── Main ingestion cycle ──────────────────────────────────────────────────

function ingestCycle(
  db: Database.Database,
  icaoToTail: Map<string, string>,
  aircraft: AdsbLolAircraft[],
): { positions: number; legs: number } {
  if (aircraft.length === 0) return { positions: 0, legs: 0 };

  const insertPos = db.prepare(
    `INSERT INTO adsb_positions
       (icao_hex, tail_number, callsign, latitude, longitude, altitude_ft,
        ground_speed_kts, heading, vertical_rate, on_ground, nearest_airport, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const upsertState = db.prepare(
    `INSERT INTO adsb_aircraft_state
       (icao_hex, tail_number, aircraft_type, aircraft_class, operator_name,
        state, latitude, longitude, nearest_airport, last_seen, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(icao_hex) DO UPDATE SET
       tail_number = COALESCE(excluded.tail_number, adsb_aircraft_state.tail_number),
       aircraft_type = COALESCE(excluded.aircraft_type, adsb_aircraft_state.aircraft_type),
       aircraft_class = COALESCE(excluded.aircraft_class, adsb_aircraft_state.aircraft_class),
       operator_name = COALESCE(excluded.operator_name, adsb_aircraft_state.operator_name),
       state = excluded.state,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       nearest_airport = COALESCE(excluded.nearest_airport, adsb_aircraft_state.nearest_airport),
       last_seen = datetime('now'),
       idle_since = CASE
         WHEN excluded.state = 'idle_transient' AND adsb_aircraft_state.state != 'idle_transient' THEN datetime('now')
         WHEN excluded.state = 'idle_transient' THEN adsb_aircraft_state.idle_since
         ELSE NULL
       END,
       idle_hours = CASE
         WHEN excluded.state = 'idle_transient' AND adsb_aircraft_state.idle_since IS NOT NULL
           THEN (julianday('now') - julianday(adsb_aircraft_state.idle_since)) * 24.0
         ELSE 0
       END,
       updated_at = datetime('now')`,
  );

  // Read current state for leg detection (airborne → ground transitions)
  const currentStates = new Map<string, string>();
  const stateRows = db.prepare(
    "SELECT icao_hex, state FROM adsb_aircraft_state",
  ).all() as { icao_hex: string; state: string }[];
  for (const s of stateRows) currentStates.set(s.icao_hex, s.state);

  // Pre-load faa_aircraft data for enrichment
  const faaLookup = new Map<string, { type: string | null; cls: string | null; op: string | null }>();
  const faaRows = db.prepare(
    "SELECT icao_hex, model, aircraft_class, certificate_holder FROM faa_aircraft WHERE icao_hex IS NOT NULL",
  ).all() as { icao_hex: string; model: string | null; aircraft_class: string | null; certificate_holder: string | null }[];
  for (const f of faaRows) faaLookup.set(f.icao_hex.toLowerCase(), { type: f.model, cls: f.aircraft_class, op: f.certificate_holder });

  const rows: PositionRow[] = [];
  const landings: { icaoHex: string; lat: number; lon: number; ts: number }[] = [];
  const nowEpoch = Math.floor(Date.now() / 1000);

  for (const ac of aircraft) {
    if (!ac.hex || ac.lat == null || ac.lon == null) continue;

    // Filter to US bounding box (API returns some outside when near edges)
    if (ac.lat < US_BBOX.lamin || ac.lat > US_BBOX.lamax) continue;
    if (ac.lon < US_BBOX.lomin || ac.lon > US_BBOX.lomax) continue;

    const icaoLower = ac.hex.toLowerCase();
    const callsign = ac.flight?.trim() || null;

    // adsb.lol: alt_baro can be number (feet) or "ground"
    const onGround = ac.alt_baro === "ground" || (typeof ac.alt_baro === "number" && ac.alt_baro <= 0 && (ac.gs == null || ac.gs < 40));
    const altFt = typeof ac.alt_baro === "number" ? ac.alt_baro : (ac.alt_geom ?? null);
    const speedKts = ac.gs ?? null;           // already in knots
    const heading = ac.track ?? null;
    const vertRate = ac.baro_rate ?? null;    // already in ft/min

    // Resolve tail: prefer API's r field, fall back to FAA map
    const tailNumber = ac.r || icaoToTail.get(icaoLower) || null;

    // Nearest airport for on-ground aircraft
    const nearestAirport = onGround ? findNearestAirport(db, ac.lat, ac.lon) : null;

    // Detect airborne → ground transitions for leg materialization
    const prevState = currentStates.get(icaoLower);
    const newState = onGround ? "idle_transient" : "airborne";
    if (prevState === "airborne" && newState === "idle_transient") {
      landings.push({ icaoHex: icaoLower, lat: ac.lat, lon: ac.lon, ts: nowEpoch });
    }

    rows.push({
      icao_hex: icaoLower,
      tail_number: tailNumber,
      callsign,
      latitude: ac.lat,
      longitude: ac.lon,
      altitude_ft: altFt,
      ground_speed_kts: speedKts,
      heading,
      vertical_rate: vertRate,
      on_ground: onGround ? 1 : 0,
      nearest_airport: nearestAirport,
      timestamp: nowEpoch,
    });
  }

  // Batch insert in transaction
  let legsMaterialized = 0;
  const runBatch = db.transaction(() => {
    for (const r of rows) {
      insertPos.run(
        r.icao_hex, r.tail_number, r.callsign, r.latitude, r.longitude,
        r.altitude_ft, r.ground_speed_kts, r.heading, r.vertical_rate,
        r.on_ground, r.nearest_airport, r.timestamp,
      );

      const faa = faaLookup.get(r.icao_hex);
      // Resolve aircraft class: FAA table first, then ICAO type code lookup
      const aircraftClass = faa?.cls ?? null;
      const aircraftState = r.on_ground ? "idle_transient" : "airborne";

      upsertState.run(
        r.icao_hex, r.tail_number, faa?.type ?? null,
        aircraftClass, faa?.op ?? null,
        aircraftState, r.latitude, r.longitude, r.nearest_airport,
      );
    }

    // Materialize legs for aircraft that just landed
    for (const landing of landings) {
      if (tryMaterializeLeg(db, landing.icaoHex, landing.lat, landing.lon, landing.ts)) {
        legsMaterialized++;
      }
    }
  });
  runBatch();

  return { positions: rows.length, legs: legsMaterialized };
}

// ── Cleanup old positions ─────────────────────────────────────────────────

function cleanupOldPositions(db: Database.Database): number {
  const cutoff = Math.floor(Date.now() / 1000) - POSITION_TTL_SECONDS;
  const result = db.prepare("DELETE FROM adsb_positions WHERE timestamp < ?").run(cutoff);
  return result.changes;
}

// ── Worker loop ───────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the adsb.lol live ingestion worker.
 * Returns a stop function for graceful shutdown.
 */
export async function startWorker(): Promise<() => void> {
  console.log("[adsb.lol] Starting live ADS-B ingestion worker...");
  console.log(`[adsb.lol] Grid: ${GRID_CENTERS.length} cells (250nm radius each)`);
  console.log(`[adsb.lol] Poll interval: ${POLL_INTERVAL_MS / 1000}s | Cleanup: every ${CLEANUP_INTERVAL_MS / 3_600_000}h | TTL: ${POSITION_TTL_SECONDS / 3600}h`);

  const db = getDb();
  const icaoToTail = buildIcaoToTailMap(db);
  console.log(`[adsb.lol] Loaded ${icaoToTail.size} ICAO→tail mappings from faa_aircraft`);

  let cycle = 0;
  let totalPositions = 0;
  let totalLegs = 0;

  // Poll loop
  pollTimer = setInterval(async () => {
    cycle++;
    try {
      const aircraft = await fetchGrid();
      const result = ingestCycle(db, icaoToTail, aircraft);
      totalPositions += result.positions;
      totalLegs += result.legs;

      if (cycle % LOG_EVERY_N_CYCLES === 0) {
        const stateCount = (db.prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state").get() as { count: number }).count;
        const idleCount = (db.prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state WHERE state = 'idle_transient'").get() as { count: number }).count;
        console.log(
          `[adsb.lol] Cycle ${cycle}: ${result.positions} positions | ` +
          `${stateCount} tracked (${idleCount} idle) | ` +
          `${totalLegs} legs materialized | ${totalPositions} total`,
        );
      }
    } catch (err) {
      console.warn(`[adsb.lol] Cycle ${cycle} error: ${(err as Error).message}`);
    }
  }, POLL_INTERVAL_MS);

  // Cleanup loop
  cleanupTimer = setInterval(() => {
    const deleted = cleanupOldPositions(db);
    if (deleted > 0) {
      console.log(`[adsb.lol] Cleaned up ${deleted} positions older than 24h`);
    }
  }, CLEANUP_INTERVAL_MS);

  // Run first cycle immediately
  try {
    const aircraft = await fetchGrid();
    const result = ingestCycle(db, icaoToTail, aircraft);
    totalPositions += result.positions;
    totalLegs += result.legs;
    console.log(`[adsb.lol] Initial fetch: ${result.positions} positions from ${aircraft.length} aircraft, ${result.legs} legs materialized`);
  } catch (err) {
    console.warn(`[adsb.lol] Initial fetch failed: ${(err as Error).message} — will retry on next cycle`);
  }

  // Return stop function
  return () => {
    console.log("[adsb.lol] Stopping worker...");
    if (pollTimer) clearInterval(pollTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    pollTimer = null;
    cleanupTimer = null;
  };
}

// ── Standalone CLI entry point ────────────────────────────────────────────

const isMainModule = process.argv[1]?.includes("adsblol-live-worker");
if (isMainModule) {
  startWorker()
    .then((stop) => {
      process.on("SIGINT", () => { stop(); closeDb(); process.exit(0); });
      process.on("SIGTERM", () => { stop(); closeDb(); process.exit(0); });
    })
    .catch((err) => {
      console.error("[adsb.lol] Fatal:", err);
      process.exit(1);
    });
}
