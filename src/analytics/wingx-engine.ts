/**
 * WINGX-equivalent analytics engine.
 *
 * Aggregates adsb_completed_legs into analytics tables.
 * Works with both SQLite (getDb) and PostgreSQL (getDatabase/PgSyncBridge).
 *
 * CLI: npm run analytics:build -- --all
 *      npm run analytics:build -- --month 2026-03
 *      npm run analytics:build -- --from 2026-01 --to 2026-03
 */

import { getDatabase, closeDb, setPgBridge } from "../memory/database.js";
import type { DbBridge } from "../memory/pg-database.js";

// ── Load .env for CLI usage ─────────────────────────────────────────────────
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// ── Operator Market Share ───────────────────────────────────────────────────

export async function buildOperatorMarketShare(db: DbBridge, month: string): Promise<number> {
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31 23:59:59`;

  const totalRow = await db.prepare(`
    SELECT COUNT(*) as total FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time <= ?
  `).get(monthStart, monthEnd) as { total: number };
  const totalLegs = totalRow.total || 1;

  const operators = await db.prepare(`
    SELECT operator_name, COUNT(*) as total_legs,
      ROUND(COALESCE(SUM(flight_time_min), 0) / 60.0, 1) as total_flight_hours,
      ROUND(COALESCE(AVG(flight_time_min), 0), 1) as avg_flight_time_min
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time <= ?
      AND operator_name IS NOT NULL AND operator_name != ''
    GROUP BY operator_name ORDER BY total_legs DESC
  `).all(monthStart, monthEnd) as Array<{
    operator_name: string; total_legs: number;
    total_flight_hours: number; avg_flight_time_min: number;
  }>;

  // Delete existing month data (idempotent rebuild)
  await db.prepare("DELETE FROM operator_market_share WHERE month = ?").run(month);

  const insert = db.prepare(`
    INSERT INTO operator_market_share
    (month, operator_name, total_legs, total_flight_hours, market_share_pct,
     avg_flight_time_min, top_route, aircraft_classes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const op of operators) {
    const topRoute = await db.prepare(`
      SELECT origin_icao || '-' || destination_icao as route, COUNT(*) as cnt
      FROM adsb_completed_legs
      WHERE operator_name = ? AND departure_time >= ? AND departure_time <= ?
        AND origin_icao IS NOT NULL AND destination_icao IS NOT NULL
      GROUP BY route ORDER BY cnt DESC LIMIT 1
    `).get(op.operator_name, monthStart, monthEnd) as { route: string } | undefined;

    const classes = await db.prepare(`
      SELECT DISTINCT aircraft_class FROM adsb_completed_legs
      WHERE operator_name = ? AND departure_time >= ? AND departure_time <= ?
        AND aircraft_class IS NOT NULL
    `).all(op.operator_name, monthStart, monthEnd) as Array<{ aircraft_class: string }>;

    const sharePct = Math.round((op.total_legs / totalLegs) * 10000) / 100;

    await insert.run(
      month, op.operator_name, op.total_legs, op.total_flight_hours,
      sharePct, op.avg_flight_time_min,
      topRoute?.route ?? null,
      JSON.stringify(classes.map((c) => c.aircraft_class)),
    );
  }

  console.log(`[analytics] operator_market_share ${month}: ${operators.length} operators`);
  return operators.length;
}

// ── Aircraft Utilization ────────────────────────────────────────────────────

export async function buildAircraftUtilization(db: DbBridge, month: string): Promise<number> {
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31 23:59:59`;

  const aircraft = await db.prepare(`
    SELECT tail_number, MAX(icao_hex) as icao_hex,
      MAX(operator_name) as operator_name, MAX(aircraft_class) as aircraft_class,
      COUNT(*) as total_legs,
      ROUND(COALESCE(SUM(flight_time_min), 0) / 60.0, 2) as total_flight_hours,
      ROUND(COALESCE(SUM(distance_nm), 0), 1) as total_distance_nm,
      COUNT(DISTINCT DATE(departure_time)) as days_active
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time <= ?
      AND tail_number IS NOT NULL AND tail_number != ''
    GROUP BY tail_number ORDER BY total_legs DESC
  `).all(monthStart, monthEnd) as Array<{
    tail_number: string; icao_hex: string | null; operator_name: string | null;
    aircraft_class: string | null; total_legs: number; total_flight_hours: number;
    total_distance_nm: number; days_active: number;
  }>;

  await db.prepare("DELETE FROM aircraft_utilization WHERE month = ?").run(month);

  const insert = db.prepare(`
    INSERT INTO aircraft_utilization
    (month, tail_number, icao_hex, operator_name, aircraft_class,
     total_legs, total_flight_hours, total_distance_nm, days_active,
     avg_daily_hours, home_airport)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const ac of aircraft) {
    const avgDaily = ac.days_active > 0
      ? Math.round((ac.total_flight_hours / ac.days_active) * 100) / 100
      : 0;

    const home = await db.prepare(`
      SELECT origin_icao, COUNT(*) as cnt FROM adsb_completed_legs
      WHERE tail_number = ? AND departure_time >= ? AND departure_time <= ?
        AND origin_icao IS NOT NULL
      GROUP BY origin_icao ORDER BY cnt DESC LIMIT 1
    `).get(ac.tail_number, monthStart, monthEnd) as { origin_icao: string } | undefined;

    await insert.run(
      month, ac.tail_number, ac.icao_hex, ac.operator_name, ac.aircraft_class,
      ac.total_legs, ac.total_flight_hours, ac.total_distance_nm,
      ac.days_active, avgDaily, home?.origin_icao ?? null,
    );
  }

  console.log(`[analytics] aircraft_utilization ${month}: ${aircraft.length} aircraft`);
  return aircraft.length;
}

// ── Airport Activity ────────────────────────────────────────────────────────

export async function buildAirportActivity(db: DbBridge, date: string): Promise<number> {
  const dateStart = `${date} 00:00:00`;
  const dateEnd = `${date} 23:59:59`;

  const departures = await db.prepare(`
    SELECT origin_icao as airport, CAST(strftime('%H', departure_time) AS INTEGER) as hour,
           COUNT(*) as cnt,
           COUNT(DISTINCT COALESCE(tail_number, icao_hex)) as unique_ac,
           SUM(CASE WHEN aircraft_class IS NOT NULL THEN 1 ELSE 0 END) as charter
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time <= ? AND origin_icao IS NOT NULL
    GROUP BY origin_icao, hour
  `).all(dateStart, dateEnd) as Array<{
    airport: string; hour: number; cnt: number; unique_ac: number; charter: number;
  }>;

  const arrivals = await db.prepare(`
    SELECT destination_icao as airport, CAST(strftime('%H', arrival_time) AS INTEGER) as hour,
           COUNT(*) as cnt,
           COUNT(DISTINCT COALESCE(tail_number, icao_hex)) as unique_ac,
           SUM(CASE WHEN aircraft_class IS NOT NULL THEN 1 ELSE 0 END) as charter
    FROM adsb_completed_legs
    WHERE arrival_time >= ? AND arrival_time <= ? AND destination_icao IS NOT NULL
    GROUP BY destination_icao, hour
  `).all(dateStart, dateEnd) as Array<{
    airport: string; hour: number; cnt: number; unique_ac: number; charter: number;
  }>;

  const map = new Map<string, { dep: number; arr: number; unique: number; charter: number }>();
  const key = (airport: string, hour: number) => `${airport}|${hour}`;

  for (const d of departures) {
    const k = key(d.airport, d.hour);
    const existing = map.get(k) ?? { dep: 0, arr: 0, unique: 0, charter: 0 };
    existing.dep += d.cnt; existing.unique += d.unique_ac; existing.charter += d.charter;
    map.set(k, existing);
  }
  for (const a of arrivals) {
    const k = key(a.airport, a.hour);
    const existing = map.get(k) ?? { dep: 0, arr: 0, unique: 0, charter: 0 };
    existing.arr += a.cnt; existing.unique += a.unique_ac; existing.charter += a.charter;
    map.set(k, existing);
  }

  await db.prepare("DELETE FROM airport_activity WHERE date = ?").run(date);

  const insert = db.prepare(`
    INSERT INTO airport_activity
    (date, airport_icao, hour, departures, arrivals, total_movements,
     unique_aircraft, charter_movements)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [k, v] of map) {
    const [airport, hourStr] = k.split("|") as [string, string];
    const hour = parseInt(hourStr, 10);
    await insert.run(date, airport, hour, v.dep, v.arr, v.dep + v.arr, v.unique, v.charter);
  }

  console.log(`[analytics] airport_activity ${date}: ${map.size} airport-hours`);
  return map.size;
}

// ── Route Trends ────────────────────────────────────────────────────────────

export async function buildRouteTrends(db: DbBridge, month: string): Promise<number> {
  const monthStart = `${month}-01`;
  const monthEnd = `${month}-31 23:59:59`;
  const [yearStr, monthNum] = month.split("-") as [string, string];
  const prevYear = `${parseInt(yearStr, 10) - 1}-${monthNum}`;
  const prevStart = `${prevYear}-01`;
  const prevEnd = `${prevYear}-31 23:59:59`;

  const routes = await db.prepare(`
    SELECT origin_icao, destination_icao, COUNT(*) as total_flights,
      ROUND(COALESCE(AVG(flight_time_min), 0), 1) as avg_flight_time_min
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time <= ?
      AND origin_icao IS NOT NULL AND destination_icao IS NOT NULL
    GROUP BY origin_icao, destination_icao ORDER BY total_flights DESC
  `).all(monthStart, monthEnd) as Array<{
    origin_icao: string; destination_icao: string;
    total_flights: number; avg_flight_time_min: number;
  }>;

  await db.prepare("DELETE FROM route_trends WHERE month = ?").run(month);

  const insert = db.prepare(`
    INSERT INTO route_trends
    (month, origin_icao, destination_icao, total_flights, avg_flight_time_min,
     dominant_class, class_breakdown, yoy_change_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const route of routes) {
    const classes = await db.prepare(`
      SELECT aircraft_class, COUNT(*) as cnt FROM adsb_completed_legs
      WHERE origin_icao = ? AND destination_icao = ?
        AND departure_time >= ? AND departure_time <= ?
        AND aircraft_class IS NOT NULL
      GROUP BY aircraft_class ORDER BY cnt DESC
    `).all(route.origin_icao, route.destination_icao, monthStart, monthEnd) as Array<{
      aircraft_class: string; cnt: number;
    }>;

    const breakdown: Record<string, number> = {};
    let dominantClass: string | null = null;
    for (const c of classes) {
      breakdown[c.aircraft_class] = c.cnt;
      if (!dominantClass) dominantClass = c.aircraft_class;
    }

    const prevCount = await db.prepare(`
      SELECT COUNT(*) as cnt FROM adsb_completed_legs
      WHERE origin_icao = ? AND destination_icao = ?
        AND departure_time >= ? AND departure_time <= ?
    `).get(route.origin_icao, route.destination_icao, prevStart, prevEnd) as { cnt: number };

    const yoyPct = prevCount.cnt > 0
      ? Math.round(((route.total_flights - prevCount.cnt) / prevCount.cnt) * 1000) / 10
      : null;

    await insert.run(
      month, route.origin_icao, route.destination_icao,
      route.total_flights, route.avg_flight_time_min,
      dominantClass, JSON.stringify(breakdown), yoyPct,
    );
  }

  console.log(`[analytics] route_trends ${month}: ${routes.length} routes`);
  return routes.length;
}

// ── Fleet Snapshot ──────────────────────────────────────────────────────────

export async function buildFleetSnapshot(db: DbBridge, date: string): Promise<number> {
  const classes = ["light", "midsize", "super_mid", "heavy", "turboprop"];
  const thirtyDaysAgo = new Date(new Date(date + "T00:00:00Z").getTime() - 30 * 86400_000)
    .toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(new Date(date + "T00:00:00Z").getTime() - 7 * 86400_000)
    .toISOString().slice(0, 10);

  await db.prepare("DELETE FROM fleet_snapshot WHERE date = ?").run(date);

  const insert = db.prepare(`
    INSERT INTO fleet_snapshot
    (date, aircraft_class, total_registered, total_tracked, total_airborne,
     total_idle, avg_utilization_hours, new_registrations, deregistrations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const cls of classes) {
    const registered = await db.prepare(
      `SELECT COUNT(*) as cnt FROM faa_aircraft WHERE aircraft_class = ?`,
    ).get(cls) as { cnt: number };

    const tracked = await db.prepare(
      `SELECT COUNT(*) as cnt FROM adsb_aircraft_state WHERE aircraft_class = ?`,
    ).get(cls) as { cnt: number };

    const airborne = await db.prepare(
      `SELECT COUNT(*) as cnt FROM adsb_aircraft_state WHERE aircraft_class = ? AND state = 'airborne'`,
    ).get(cls) as { cnt: number };

    const idle = await db.prepare(
      `SELECT COUNT(*) as cnt FROM adsb_aircraft_state
       WHERE aircraft_class = ? AND (state = 'idle' OR state = 'idle_transient')`,
    ).get(cls) as { cnt: number };

    const util = await db.prepare(`
      SELECT ROUND(AVG(hours), 2) as avg_hours FROM (
        SELECT tail_number, SUM(flight_time_min) / 60.0 as hours
        FROM adsb_completed_legs WHERE aircraft_class = ? AND departure_time >= ?
        GROUP BY tail_number
      )
    `).get(cls, thirtyDaysAgo) as { avg_hours: number | null };

    // Registry changes — may not have data in PG, handle gracefully
    let newRegs = 0, deregs = 0;
    try {
      const nr = await db.prepare(`
        SELECT COUNT(*) as cnt FROM faa_registry_changes
        WHERE change_type = 'new' AND detected_at >= ?
          AND tail_number IN (SELECT tail_number FROM faa_aircraft WHERE aircraft_class = ?)
      `).get(sevenDaysAgo, cls) as { cnt: number };
      newRegs = nr.cnt;

      const dr = await db.prepare(`
        SELECT COUNT(*) as cnt FROM faa_registry_changes
        WHERE change_type = 'deregistered' AND detected_at >= ?
          AND tail_number IN (SELECT tail_number FROM faa_aircraft WHERE aircraft_class = ?)
      `).get(sevenDaysAgo, cls) as { cnt: number };
      deregs = dr.cnt;
    } catch { /* table may not exist */ }

    await insert.run(
      date, cls, registered.cnt, tracked.cnt, airborne.cnt, idle.cnt,
      util.avg_hours ?? 0, newRegs, deregs,
    );
  }

  console.log(`[analytics] fleet_snapshot ${date}: ${classes.length} classes`);
  return classes.length;
}

// ── Rebuild All ─────────────────────────────────────────────────────────────

function monthRange(from: string, to: string): string[] {
  const months: string[] = [];
  const [fromY, fromM] = from.split("-").map(Number) as [number, number];
  const [toY, toM] = to.split("-").map(Number) as [number, number];
  let y = fromY, m = fromM;
  while (y < toY || (y === toY && m <= toM)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function dateRangeForMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(y, m, 0).getDate();
  const dates: string[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    dates.push(`${month}-${String(d).padStart(2, "0")}`);
  }
  return dates;
}

export async function rebuildAll(db: DbBridge, fromMonth: string, toMonth: string): Promise<void> {
  const months = monthRange(fromMonth, toMonth);
  console.log(`[analytics] Rebuilding ${months.length} months: ${fromMonth} -> ${toMonth}`);

  for (const month of months) {
    const t0 = Date.now();
    await buildOperatorMarketShare(db, month);
    await buildAircraftUtilization(db, month);
    await buildRouteTrends(db, month);

    const dates = dateRangeForMonth(month);
    for (const date of dates) {
      await buildAirportActivity(db, date);
    }

    await buildFleetSnapshot(db, `${month}-01`);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[analytics] ${month} complete (${elapsed}s)`);
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  // Init PG bridge if needed
  if (process.env.DATABASE_TYPE === "postgres") {
    const { getPgBridge } = await import("../memory/pg-database.js");
    setPgBridge(getPgBridge());
  }

  const args = process.argv.slice(2);
  let fromMonth = "";
  let toMonth = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--month" && args[i + 1]) { fromMonth = args[i + 1]!; toMonth = args[i + 1]!; i++; }
    else if (args[i] === "--from" && args[i + 1]) { fromMonth = args[i + 1]!; i++; }
    else if (args[i] === "--to" && args[i + 1]) { toMonth = args[i + 1]!; i++; }
  }

  const db = getDatabase();

  if (!fromMonth || !toMonth) {
    const row = await db.prepare(`
      SELECT MIN(strftime('%Y-%m', departure_time)) as earliest,
             MAX(strftime('%Y-%m', departure_time)) as latest
      FROM adsb_completed_legs
    `).get() as { earliest: string | null; latest: string | null };

    if (!row?.earliest || !row?.latest) {
      console.error("[analytics] No completed legs found — nothing to aggregate");
      process.exit(1);
    }
    if (!fromMonth) fromMonth = row.earliest;
    if (!toMonth) toMonth = row.latest;
  }

  const t0 = Date.now();
  await rebuildAll(db, fromMonth, toMonth);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[analytics] All done in ${elapsed}s`);
  closeDb();
}

const isDirectRun = process.argv[1]?.includes("wingx-engine");
if (isDirectRun) {
  main().catch((err) => {
    console.error("[analytics] Fatal:", err);
    process.exit(1);
  });
}
