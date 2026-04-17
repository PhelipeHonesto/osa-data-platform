/**
 * OpenSky ADS-B Ingestion Worker — alternate feed to adsblol-live-worker.
 *
 * Polls OpenSky Network REST API every 12 seconds (free tier safe).
 * Stores position pings in adsb_positions (bulk), upserts adsb_aircraft_state
 * (bulk with COALESCE preservation). Resolves tail numbers from faa_aircraft
 * via icao_hex join. Cleans up positions older than TTL every hour.
 *
 * Auto-started by src/server/index.ts unless ENABLE_OPENSKY=false.
 * Can also run standalone: npm run opensky.
 */

import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg, type DbBridge } from "../memory/pg-database.js";
import { bulkUpsert } from "../memory/bulk-upsert.js";
import { haversine } from "../utils/haversine.js";
import { childLogger } from "../utils/logger.js";
import { initSentry, installProcessHandlers, flushSentry } from "../utils/sentry.js";

initSentry();
installProcessHandlers("opensky");
const log = childLogger("opensky");

// ── Constants ──────────────────────────────────────────────────────────────

const OPENSKY_API = "https://opensky-network.org/api/states/all";
const POLL_INTERVAL_MS = 12_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const FAA_REFRESH_INTERVAL_MS = 3_600_000;
const POSITION_TTL_SECONDS = 48 * 3600; // 48 h — matches Phase 2 hot tier
const LOG_EVERY_N_CYCLES = 10;

const US_BBOX = { lamin: 24.4, lamax: 49.4, lomin: -125.0, lomax: -66.9 };

const METERS_TO_FEET = 3.28084;
const MPS_TO_KNOTS = 1.94384;
const MPS_TO_FPM = 196.85;

// ── OpenSky state-vector column indices ────────────────────────────────────

interface OpenSkyResponse {
  time: number;
  states: (string | number | boolean | null)[][] | null;
}
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

// ── Column definitions ─────────────────────────────────────────────────────

const POSITION_COLS = [
  "icao_hex", "tail_number", "callsign", "latitude", "longitude",
  "altitude_ft", "ground_speed_kts", "heading", "vertical_rate",
  "on_ground", "nearest_airport", "timestamp",
] as const;

const STATE_COLS = [
  "icao_hex", "tail_number", "aircraft_type", "aircraft_class", "operator_name",
  "state", "latitude", "longitude", "nearest_airport", "last_seen", "updated_at",
] as const;

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
    WHEN EXCLUDED.state = 'idle' AND adsb_aircraft_state.state <> 'idle' THEN EXCLUDED.last_seen
    WHEN EXCLUDED.state = 'idle' THEN adsb_aircraft_state.idle_since
    ELSE NULL
  END,
  idle_hours = CASE
    WHEN EXCLUDED.state = 'idle' AND adsb_aircraft_state.idle_since IS NOT NULL
      THEN EXTRACT(EPOCH FROM (EXCLUDED.updated_at - adsb_aircraft_state.idle_since::timestamp)) / 3600.0
    ELSE 0
  END,
  updated_at = EXCLUDED.updated_at
`.trim();

// ── In-memory caches ───────────────────────────────────────────────────────

async function loadAirports(db: DbBridge): Promise<Airport[]> {
  return await db.prepare(
    "SELECT icao_code, latitude, longitude FROM faa_airports",
  ).all() as Airport[];
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
      type: r.model, cls: r.aircraft_class, op: r.certificate_holder, tail: r.tail_number,
    });
  }
  return map;
}

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

// ── Fetch OpenSky ──────────────────────────────────────────────────────────

async function fetchStates(): Promise<OpenSkyResponse | null> {
  const url = `${OPENSKY_API}?lamin=${US_BBOX.lamin}&lamax=${US_BBOX.lamax}&lomin=${US_BBOX.lomin}&lomax=${US_BBOX.lomax}`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      log.warn({ status: resp.status, statusText: resp.statusText }, "HTTP error from OpenSky");
      return null;
    }
    return (await resp.json()) as OpenSkyResponse;
  } catch (err) {
    log.warn({ err }, "fetch error");
    return null;
  }
}

// ── Ingestion cycle ────────────────────────────────────────────────────────

async function ingestCycle(
  db: DbBridge,
  data: OpenSkyResponse,
  airports: Airport[],
  icaoToTail: Map<string, string>,
  faaLookup: Map<string, FaaRow>,
): Promise<number> {
  if (!data.states || data.states.length === 0) return 0;

  const nowEpoch = Math.floor(Date.now() / 1000);
  const nowIso = new Date(nowEpoch * 1000).toISOString();

  const positionRows: unknown[][] = [];
  const stateRows: unknown[][] = [];

  for (const sv of data.states) {
    const icao = sv[IDX_ICAO] as string | null;
    const lat = sv[IDX_LAT] as number | null;
    const lon = sv[IDX_LON] as number | null;
    if (!icao || lat == null || lon == null) continue;

    const icaoLower = icao.toLowerCase();
    const callsign = (sv[IDX_CALLSIGN] as string | null)?.trim() || null;
    const onGround = Boolean(sv[IDX_ON_GROUND]);
    const baroAlt = sv[IDX_BARO_ALT] as number | null;
    const geoAlt = sv[IDX_GEO_ALT] as number | null;
    const velocity = sv[IDX_VELOCITY] as number | null;
    const heading = sv[IDX_HEADING] as number | null;
    const vertRate = sv[IDX_VERT_RATE] as number | null;

    const altFt = (baroAlt ?? geoAlt) != null ? (baroAlt ?? geoAlt)! * METERS_TO_FEET : null;
    const speedKts = velocity != null ? velocity * MPS_TO_KNOTS : null;
    const vertFpm = vertRate != null ? vertRate * MPS_TO_FPM : null;
    const tailNumber = icaoToTail.get(icaoLower) ?? null;
    const nearestAirport = onGround ? findNearestInMemory(airports, lat, lon) : null;

    positionRows.push([
      icaoLower, tailNumber, callsign, lat, lon, altFt,
      speedKts, heading, vertFpm, onGround, nearestAirport, data.time,
    ]);

    const faa = faaLookup.get(icaoLower);
    stateRows.push([
      icaoLower, tailNumber, faa?.type ?? null, faa?.cls ?? null, faa?.op ?? null,
      onGround ? "idle" : "airborne", lat, lon, nearestAirport, nowIso, nowIso,
    ]);
  }

  await bulkUpsert(db, "adsb_positions", [...POSITION_COLS], positionRows, []);
  await bulkUpsert(
    db, "adsb_aircraft_state", [...STATE_COLS], stateRows,
    ["icao_hex"], { updateClause: STATE_UPDATE_CLAUSE },
  );

  return positionRows.length;
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

export async function startWorker(): Promise<() => Promise<void>> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "opensky-worker requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  log.info({
    poll_sec: POLL_INTERVAL_MS / 1000,
    cleanup_hr: CLEANUP_INTERVAL_MS / 3_600_000,
    ttl_hr: POSITION_TTL_SECONDS / 3600,
  }, "worker starting");

  const airports = await loadAirports(db);
  const icaoToTail = await loadIcaoToTail(db);
  let faaLookup = await loadFaaLookup(db);
  log.info({ airports: airports.length, icao_to_tail: icaoToTail.size, faa_enrichment: faaLookup.size }, "caches loaded");

  let cycle = 0;
  let totalIngested = 0;

  async function runCycle(): Promise<void> {
    cycle++;
    const data = await fetchStates();
    if (!data) return;
    try {
      const count = await ingestCycle(db, data, airports, icaoToTail, faaLookup);
      totalIngested += count;
      if (cycle === 1 || cycle % LOG_EVERY_N_CYCLES === 0) {
        const stateCountRow = await db.prepare("SELECT COUNT(*) as count FROM adsb_aircraft_state").get() as { count: number | string };
        log.info({
          cycle, positions: count, tracked: stateCountRow.count, total: totalIngested,
        }, "cycle complete");
      }
    } catch (err) {
      log.warn({ err, cycle }, "cycle error");
    }
  }

  // Initial cycle
  await runCycle();

  pollTimer = setInterval(runCycle, POLL_INTERVAL_MS);
  cleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupOldPositions(db);
      if (deleted > 0) log.info({ deleted, ttl_hr: POSITION_TTL_SECONDS / 3600 }, "cleaned up old positions");
    } catch (err) {
      log.warn({ err }, "cleanup error");
    }
  }, CLEANUP_INTERVAL_MS);
  faaRefreshTimer = setInterval(async () => {
    try {
      faaLookup = await loadFaaLookup(db);
      log.info({ rows: faaLookup.size }, "faa cache refreshed");
    } catch (err) {
      log.warn({ err }, "faa refresh error");
    }
  }, FAA_REFRESH_INTERVAL_MS);

  return async () => {
    log.info("stopping worker");
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

const isMainModule = process.argv[1]?.includes("opensky-worker");
if (isMainModule) {
  // --test-sentry: emit one error event and exit. Used to verify the
  // Sentry bridge end-to-end from a local shell before deploying.
  if (process.argv.includes("--test-sentry")) {
    const testLog = childLogger("sentry-test");
    testLog.error({ err: new Error("Phase 15 Step 2 test error") }, "test");
    void flushSentry(3000).finally(() => process.exit(0));
  } else {
  startWorker()
    .then((stop) => {
      const shutdown = async () => { await stop(); process.exit(0); };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      log.fatal({ err }, "opensky fatal error");
      process.exit(1);
    });
  }
}
