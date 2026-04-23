/**
 * adsb.lol Live ADS-B Ingestion Worker — standalone CLI process.
 *
 * ── AUDIT (current behavior) ────────────────────────────────────────────────
 *
 *   Entry point:       bottom of file, `if (isMainModule) startWorker().then(…)`
 *   Polling:           every 15 s against adsb.lol /v2/lat/{lat}/lon/{lon}/dist/250
 *                      across a 5° × 8° grid of centers covering the US bbox
 *   Per-cycle flow:    1. Fetch grid (parallel HTTP)
 *                      2. Filter to US bbox
 *                      3. For each aircraft: compute derived fields (onGround,
 *                         nearest airport, state)
 *                      4. Detect airborne → idle transitions → materialize legs
 *                      5. Write positions + state updates + legs to DB
 *   Writes to:
 *     - adsb_positions:       (icao_hex, timestamp) tuple — no conflict key
 *                             (PK is SERIAL id); plain INSERT.
 *     - adsb_aircraft_state:  PK (icao_hex); UPSERT with COALESCE preservation
 *                             on nullable enrichment fields (tail/type/class/op)
 *                             and CASE-based idle_since / idle_hours tracking.
 *     - adsb_completed_legs:  id SERIAL PK; plain INSERT, one row per landing
 *                             event that has a valid takeoff in the lookback.
 *   TTL cleanup:       every hour, DELETE FROM adsb_positions WHERE timestamp
 *                      < now - POSITION_TTL_SECONDS (48 h).
 *   Error handling:    per-cycle try/catch around the whole fetch+ingest;
 *                      logs a warning on failure and keeps polling.
 *
 * ── REWRITE (this file) ────────────────────────────────────────────────────
 *
 *   Database target is PostgreSQL via the async DbBridge (getDatabase()).
 *   Writes are batched via bulkUpsert — one multi-row INSERT per table per
 *   cycle instead of per-row INSERTs. Matches the pattern used in
 *   src/analytics/wingx-engine.ts (today's analytics fix).
 *
 *   In-memory caches replace per-row SQL lookups:
 *     - airports (198 rows): loaded once, used for haversine nearest-airport
 *     - icaoToTail, faaLookup: loaded once at startup, refreshed hourly
 *     - currentStates: loaded once per cycle for leg-detection
 *
 *   Polling interval, grid, and bbox unchanged.
 *
 * Run:
 *   DATABASE_TYPE=postgres npm run adsb:live
 *   DATABASE_TYPE=postgres npx tsx src/ingestion/adsblol-live-worker.ts --single-cycle
 */

import { getDatabase, setPgBridge } from "../db/database.js";
import { getPgBridge, closePg } from "../db/pg-database.js";
import type { DbBridge } from "../db/pg-database.js";
import { bulkUpsert } from "../db/bulk-upsert.js";
import { haversine } from "../utils/haversine.js";
import { childLogger } from "../utils/logger.js";
import { initSentry, installProcessHandlers } from "../utils/sentry.js";

initSentry();
installProcessHandlers("adsb-feed");
const log = childLogger("adsb-feed");

// ── Constants ──────────────────────────────────────────────────────────────

const ADSBLOL_BASE = "https://api.adsb.lol/v2";
const POLL_INTERVAL_MS = 15_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const FAA_REFRESH_INTERVAL_MS = 3_600_000;
const POSITION_TTL_SECONDS = 48 * 3600; // 48 hours — Postgres hot tier
const LOG_EVERY_N_CYCLES = 10;

const US_BBOX = { lamin: 24.4, lamax: 49.4, lomin: -125.0, lomax: -66.9 };

const GRID_CENTERS: { lat: number; lon: number }[] = [];
for (let lat = 26; lat <= 48; lat += 5) {
  for (let lon = -123; lon <= -68; lon += 8) {
    GRID_CENTERS.push({ lat, lon });
  }
}

// ── adsb.lol response types ───────────────────────────────────────────────

interface AdsbLolAircraft {
  hex: string;
  r?: string;
  t?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  baro_rate?: number;
  category?: string;
  ownOp?: string;
  [key: string]: unknown;
}

interface AdsbLolResponse {
  ac: AdsbLolAircraft[] | null;
  total: number;
  now: number;
  ctime: number;
  ptime: number;
}

interface Airport {
  icao_code: string;
  latitude: number;
  longitude: number;
}

interface FaaRow {
  type: string | null;
  cls: string | null;
  op: string | null;
  tail: string | null;
}

// ── Column definitions (for bulkUpsert) ───────────────────────────────────

const POSITION_COLS = [
  "icao_hex", "tail_number", "callsign", "latitude", "longitude",
  "altitude_ft", "ground_speed_kts", "heading", "vertical_rate",
  "on_ground", "nearest_airport", "timestamp",
] as const;

const STATE_COLS = [
  "icao_hex", "tail_number", "aircraft_type", "aircraft_class", "operator_name",
  "state", "latitude", "longitude", "nearest_airport", "last_seen", "updated_at",
] as const;

const LEG_COLS = [
  "icao_hex", "tail_number", "operator_name", "aircraft_type", "aircraft_class",
  "origin_icao", "destination_icao", "departure_time", "arrival_time",
  "flight_time_min", "distance_nm",
] as const;

// Preserve-on-null semantics + idle_since/idle_hours tracking in PG SQL.
// Uses EXCLUDED.updated_at (TIMESTAMPTZ) and EXCLUDED.last_seen (TEXT ISO)
// passed in by the JS caller — no NOW() calls inside the DB expression.
const STATE_UPDATE_CLAUSE = `
  tail_number = COALESCE(EXCLUDED.tail_number, adsb_aircraft_state.tail_number),
  aircraft_type = COALESCE(EXCLUDED.aircraft_type, adsb_aircraft_state.aircraft_type),
  aircraft_class = COALESCE(EXCLUDED.aircraft_class, adsb_aircraft_state.aircraft_class),
  operator_name = COALESCE(EXCLUDED.operator_name, adsb_aircraft_state.operator_name),
  state = EXCLUDED.state,
  latitude = EXCLUDED.latitude,
  longitude = EXCLUDED.longitude,
  nearest_airport = COALESCE(EXCLUDED.nearest_airport, adsb_aircraft_state.nearest_airport),
  last_seen = EXCLUDED.last_seen,
  idle_since = CASE
    WHEN EXCLUDED.state = 'idle_transient' AND adsb_aircraft_state.state <> 'idle_transient' THEN EXCLUDED.last_seen
    WHEN EXCLUDED.state = 'idle_transient' THEN adsb_aircraft_state.idle_since
    ELSE NULL
  END,
  idle_hours = CASE
    WHEN EXCLUDED.state = 'idle_transient' AND adsb_aircraft_state.idle_since IS NOT NULL
      THEN EXTRACT(EPOCH FROM (EXCLUDED.updated_at - adsb_aircraft_state.idle_since::timestamp)) / 3600.0
    ELSE 0
  END,
  updated_at = EXCLUDED.updated_at
`.trim();

// ── Cache loaders ─────────────────────────────────────────────────────────

async function loadAirports(db: DbBridge): Promise<Airport[]> {
  const rows = await db.prepare(
    "SELECT icao_code, latitude, longitude FROM faa_airports",
  ).all() as Airport[];
  return rows;
}

async function loadIcaoToTail(db: DbBridge): Promise<Map<string, string>> {
  const rows = await db.prepare(
    "SELECT icao_hex, tail_number FROM faa_aircraft WHERE icao_hex IS NOT NULL",
  ).all() as Array<{ icao_hex: string; tail_number: string }>;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.icao_hex.toLowerCase(), r.tail_number);
  return map;
}

async function loadFaaLookup(db: DbBridge): Promise<Map<string, FaaRow>> {
  const rows = await db.prepare(
    `SELECT icao_hex, tail_number, model, aircraft_class, certificate_holder
     FROM faa_aircraft WHERE icao_hex IS NOT NULL`,
  ).all() as Array<{
    icao_hex: string; tail_number: string | null;
    model: string | null; aircraft_class: string | null; certificate_holder: string | null;
  }>;
  const map = new Map<string, FaaRow>();
  for (const r of rows) {
    map.set(r.icao_hex.toLowerCase(), {
      type: r.model,
      cls: r.aircraft_class,
      op: r.certificate_holder,
      tail: r.tail_number,
    });
  }
  return map;
}

// ── In-memory nearest airport ─────────────────────────────────────────────

function findNearestInMemory(
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

// ── Fetch adsb.lol ────────────────────────────────────────────────────────

async function fetchGrid(): Promise<AdsbLolAircraft[]> {
  const results = await Promise.all(
    GRID_CENTERS.map(async (center) => {
      const url = `${ADSBLOL_BASE}/lat/${center.lat}/lon/${center.lon}/dist/250`;
      try {
        const resp = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          log.warn({ status: resp.status, lat: center.lat, lon: center.lon }, "HTTP error from adsb.lol");
          return [] as AdsbLolAircraft[];
        }
        const data = (await resp.json()) as AdsbLolResponse;
        return data.ac ?? [];
      } catch (err) {
        log.warn({ err, lat: center.lat, lon: center.lon }, "fetch error from adsb.lol");
        return [] as AdsbLolAircraft[];
      }
    }),
  );

  // Dedupe by icao hex across grid cells (overlapping 250 nm radii)
  const seen = new Set<string>();
  const all: AdsbLolAircraft[] = [];
  for (const batch of results) {
    for (const ac of batch) {
      if (!seen.has(ac.hex)) {
        seen.add(ac.hex);
        all.push(ac);
      }
    }
  }
  return all;
}

// ── Leg materialization ──────────────────────────────────────────────────
// Called when an aircraft transitions airborne → idle_transient. Queries
// adsb_positions for this aircraft's last 24 h to find the takeoff point.
// Positions must already be inserted for the current cycle so "now" is visible.

interface LandingEvent {
  icaoHex: string;
  lat: number;
  lon: number;
  ts: number;
}

async function tryMaterializeLeg(
  db: DbBridge,
  landing: LandingEvent,
  airports: Airport[],
  faaLookup: Map<string, FaaRow>,
): Promise<unknown[] | null> {
  const positions = await db.prepare(`
    SELECT latitude, longitude, on_ground, timestamp
    FROM adsb_positions
    WHERE icao_hex = $1 AND timestamp <= $2 AND timestamp >= $3
    ORDER BY timestamp DESC
    LIMIT 500
  `).all(
    landing.icaoHex,
    landing.ts,
    landing.ts - 86_400,
  ) as Array<{ latitude: number; longitude: number; on_ground: boolean; timestamp: number }>;

  let takeoffPos: { latitude: number; longitude: number; timestamp: number } | null = null;
  let foundAirborne = false;
  for (const pos of positions) {
    const ground = pos.on_ground === true || (pos.on_ground as unknown) === 1;
    if (!foundAirborne && !ground) {
      foundAirborne = true;
    } else if (foundAirborne && ground) {
      takeoffPos = { latitude: pos.latitude, longitude: pos.longitude, timestamp: pos.timestamp };
      break;
    }
  }
  if (!takeoffPos) return null;

  const flightTimeMin = Math.round((landing.ts - takeoffPos.timestamp) / 60);
  if (flightTimeMin < 5) return null;

  const distNm = haversine(
    takeoffPos.latitude, takeoffPos.longitude,
    landing.lat, landing.lon,
  );
  const originIcao = findNearestInMemory(airports, takeoffPos.latitude, takeoffPos.longitude);
  const destIcao = findNearestInMemory(airports, landing.lat, landing.lon);
  const depTime = new Date(takeoffPos.timestamp * 1000).toISOString();
  const arrTime = new Date(landing.ts * 1000).toISOString();
  const faa = faaLookup.get(landing.icaoHex);

  return [
    landing.icaoHex,
    faa?.tail ?? null,
    faa?.op ?? null,
    faa?.type ?? null,
    faa?.cls ?? null,
    originIcao,
    destIcao,
    depTime,
    arrTime,
    flightTimeMin,
    Math.round(distNm),
  ];
}

// ── Ingestion cycle ──────────────────────────────────────────────────────

interface CycleResult {
  positions: number;
  legs: number;
  ms: number;
}

async function ingestCycle(
  db: DbBridge,
  aircraft: AdsbLolAircraft[],
  airports: Airport[],
  icaoToTail: Map<string, string>,
  faaLookup: Map<string, FaaRow>,
): Promise<CycleResult> {
  const t0 = Date.now();
  if (aircraft.length === 0) return { positions: 0, legs: 0, ms: 0 };

  const nowEpoch = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowEpoch * 1000).toISOString();

  // Load prev-state for landing detection
  const stateRows = await db.prepare(
    "SELECT icao_hex, state FROM adsb_aircraft_state",
  ).all() as Array<{ icao_hex: string; state: string }>;
  const currentStates = new Map<string, string>(
    stateRows.map((s) => [s.icao_hex, s.state]),
  );

  const positionRows: unknown[][] = [];
  const stateUpsertRows: unknown[][] = [];
  const landings: LandingEvent[] = [];

  for (const ac of aircraft) {
    if (!ac.hex || ac.lat == null || ac.lon == null) continue;
    if (ac.lat < US_BBOX.lamin || ac.lat > US_BBOX.lamax) continue;
    if (ac.lon < US_BBOX.lomin || ac.lon > US_BBOX.lomax) continue;

    const icaoLower = ac.hex.toLowerCase();
    const callsign = ac.flight?.trim() || null;
    const onGround = ac.alt_baro === "ground"
      || (typeof ac.alt_baro === "number" && ac.alt_baro <= 0 && (ac.gs == null || ac.gs < 40));
    const altFt = typeof ac.alt_baro === "number" ? ac.alt_baro : (ac.alt_geom ?? null);
    const speedKts = ac.gs ?? null;
    const heading = ac.track ?? null;
    const vertRate = ac.baro_rate ?? null;
    const tailNumber = ac.r || icaoToTail.get(icaoLower) || null;
    const nearestAirport = onGround ? findNearestInMemory(airports, ac.lat, ac.lon) : null;

    const prevState = currentStates.get(icaoLower);
    const newState = onGround ? "idle_transient" : "airborne";
    if (prevState === "airborne" && newState === "idle_transient") {
      landings.push({ icaoHex: icaoLower, lat: ac.lat, lon: ac.lon, ts: nowEpoch });
    }

    positionRows.push([
      icaoLower, tailNumber, callsign, ac.lat, ac.lon, altFt,
      speedKts, heading, vertRate, onGround, nearestAirport, nowEpoch,
    ]);

    const faa = faaLookup.get(icaoLower);
    stateUpsertRows.push([
      icaoLower, tailNumber, faa?.type ?? null, faa?.cls ?? null, faa?.op ?? null,
      newState, ac.lat, ac.lon, nearestAirport, nowIso, nowIso,
    ]);
  }

  // 1. Positions — plain bulk INSERT (no unique constraint, no conflict key)
  await bulkUpsert(db, "adsb_positions", [...POSITION_COLS], positionRows, []);

  // 2. Legs — query positions (including the ones just inserted) per landing
  const legRows: unknown[][] = [];
  for (const landing of landings) {
    const leg = await tryMaterializeLeg(db, landing, airports, faaLookup);
    if (leg) legRows.push(leg);
  }
  await bulkUpsert(db, "adsb_completed_legs", [...LEG_COLS], legRows, []);

  // 3. Aircraft state — UPSERT with custom preservation clause
  await bulkUpsert(
    db, "adsb_aircraft_state", [...STATE_COLS], stateUpsertRows,
    ["icao_hex"], { updateClause: STATE_UPDATE_CLAUSE },
  );

  return { positions: positionRows.length, legs: legRows.length, ms: Date.now() - t0 };
}

// ── Cleanup old positions ─────────────────────────────────────────────────

async function cleanupOldPositions(db: DbBridge): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - POSITION_TTL_SECONDS;
  const result = await db.prepare(
    "DELETE FROM adsb_positions WHERE timestamp < $1",
  ).run(cutoff) as { changes: number };
  return result.changes;
}

// ── Worker loop ───────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let faaRefreshTimer: ReturnType<typeof setInterval> | null = null;

export async function startWorker(opts: { singleCycle?: boolean } = {}): Promise<() => Promise<void>> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "adsblol-live-worker requires DATABASE_TYPE=postgres (SQLite path removed in Phase 2)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  console.log("[adsb.lol] Starting live ADS-B ingestion worker...");
  console.log(`[adsb.lol] Grid: ${GRID_CENTERS.length} cells (250nm each)`);
  console.log(`[adsb.lol] Poll: ${POLL_INTERVAL_MS / 1000}s | Cleanup: ${CLEANUP_INTERVAL_MS / 3_600_000}h | TTL: ${POSITION_TTL_SECONDS / 3600}h`);

  const airports = await loadAirports(db);
  const icaoToTail = await loadIcaoToTail(db);
  let faaLookup = await loadFaaLookup(db);
  console.log(`[adsb.lol] Caches loaded: ${airports.length} airports, ${icaoToTail.size} ICAO→tail, ${faaLookup.size} FAA enrichment rows`);

  let cycle = 0;
  let totalPositions = 0;
  let totalLegs = 0;

  async function runCycle(): Promise<void> {
    cycle++;
    try {
      const tFetch = Date.now();
      const aircraft = await fetchGrid();
      const fetchMs = Date.now() - tFetch;
      const result = await ingestCycle(db, aircraft, airports, icaoToTail, faaLookup);
      totalPositions += result.positions;
      totalLegs += result.legs;
      if (opts.singleCycle) {
        console.log(`[feed] timing: fetch=${fetchMs}ms, ingest=${result.ms}ms`);
      }

      if (opts.singleCycle || cycle === 1 || cycle % LOG_EVERY_N_CYCLES === 0) {
        const stateCountRow = await db.prepare(
          "SELECT COUNT(*) AS count FROM adsb_aircraft_state",
        ).get() as { count: number | string };
        const idleCountRow = await db.prepare(
          "SELECT COUNT(*) AS count FROM adsb_aircraft_state WHERE state = 'idle_transient'",
        ).get() as { count: number | string };
        console.log(
          `[feed] cycle ${cycle} done: ${result.positions} positions, ` +
          `${result.legs} legs, ${result.ms}ms | ` +
          `${stateCountRow.count} tracked (${idleCountRow.count} idle) | ` +
          `running totals: ${totalPositions} positions, ${totalLegs} legs`,
        );
      }
    } catch (err) {
      log.warn({ err, cycle }, "cycle error");
    }
  }

  // First cycle immediately
  await runCycle();

  if (opts.singleCycle) {
    // Caller handles shutdown
    return async () => { /* no timers to clear */ };
  }

  pollTimer = setInterval(runCycle, POLL_INTERVAL_MS);

  cleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupOldPositions(db);
      if (deleted > 0) console.log(`[adsb.lol] Cleaned up ${deleted} positions older than ${POSITION_TTL_SECONDS / 3600}h`);
    } catch (err) {
      log.warn({ err }, "cleanup error");
    }
  }, CLEANUP_INTERVAL_MS);

  faaRefreshTimer = setInterval(async () => {
    try {
      faaLookup = await loadFaaLookup(db);
      console.log(`[adsb.lol] FAA enrichment cache refreshed: ${faaLookup.size} rows`);
    } catch (err) {
      log.warn({ err }, "faa refresh error");
    }
  }, FAA_REFRESH_INTERVAL_MS);

  return async () => {
    console.log("[adsb.lol] Stopping worker...");
    if (pollTimer) clearInterval(pollTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    if (faaRefreshTimer) clearInterval(faaRefreshTimer);
    pollTimer = null;
    cleanupTimer = null;
    faaRefreshTimer = null;
    await closePg();
  };
}

// ── Standalone CLI entry point ────────────────────────────────────────────

const isMainModule = process.argv[1]?.includes("adsblol-live-worker");
if (isMainModule) {
  const singleCycle = process.argv.includes("--single-cycle");
  startWorker({ singleCycle })
    .then(async (stop) => {
      if (singleCycle) {
        await stop();
        console.log("[adsb.lol] --single-cycle complete, exiting.");
        process.exit(0);
      }
      const shutdown = async () => { await stop(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      log.fatal({ err }, "adsb-feed fatal error");
      process.exit(1);
    });
}
