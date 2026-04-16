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

// ── Bulk upsert helper ──────────────────────────────────────────────────────
// Collapses N-per-row network round-trips into ceil(N/500) multi-row INSERTs.

async function bulkUpsert(
  db: DbBridge,
  table: string,
  columns: readonly string[],
  rows: readonly unknown[][],
  conflictCols: readonly string[],
  batchSize = 500,
): Promise<void> {
  if (rows.length === 0) return;
  const colList = columns.join(", ");
  const conflictList = conflictCols.join(", ");
  const updateSet = columns
    .filter((c) => !conflictCols.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let p = 1;
    for (const row of slice) {
      const rowPh = row.map(() => `$${p++}`).join(",");
      placeholders.push(`(${rowPh})`);
      values.push(...row);
    }
    const sql =
      `INSERT INTO ${table} (${colList}) VALUES ${placeholders.join(",")} ` +
      `ON CONFLICT (${conflictList}) DO UPDATE SET ${updateSet}`;
    await db.prepare(sql).run(...values);
  }
}

// ── Operator Market Share ───────────────────────────────────────────────────

export async function buildOperatorMarketShare(db: DbBridge, month: string): Promise<number> {
  const monthStart = `${month}-01`;
  const monthEnd = nextMonthStart(month);  // exclusive — text-safe across space/T separator formats

  const totalRow = await db.prepare(`
    SELECT COUNT(*) as total FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
  `).get(monthStart, monthEnd) as { total: number };
  const totalLegs = totalRow.total || 1;

  const operators = await db.prepare(`
    SELECT operator_name, COUNT(*) as total_legs,
      ROUND(COALESCE(SUM(flight_time_min), 0) / 60.0, 1) as total_flight_hours,
      ROUND(COALESCE(AVG(flight_time_min), 0), 1) as avg_flight_time_min
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
      AND operator_name IS NOT NULL AND operator_name != ''
    GROUP BY operator_name ORDER BY total_legs DESC
  `).all(monthStart, monthEnd) as Array<{
    operator_name: string; total_legs: number;
    total_flight_hours: number; avg_flight_time_min: number;
  }>;

  // Batch: top route per operator (DISTINCT ON + window)
  const topRouteRows = await db.prepare(`
    SELECT DISTINCT ON (operator_name) operator_name,
           origin_icao || '-' || destination_icao AS route
    FROM (
      SELECT operator_name, origin_icao, destination_icao, COUNT(*) AS n
      FROM adsb_completed_legs
      WHERE departure_time >= ? AND departure_time < ?
        AND operator_name IS NOT NULL AND operator_name != ''
        AND origin_icao IS NOT NULL AND destination_icao IS NOT NULL
      GROUP BY operator_name, origin_icao, destination_icao
    ) t
    ORDER BY operator_name, n DESC
  `).all(monthStart, monthEnd) as Array<{ operator_name: string; route: string }>;
  const topRouteMap = new Map<string, string>();
  for (const r of topRouteRows) topRouteMap.set(r.operator_name, r.route);

  // Batch: distinct aircraft classes per operator
  const classRows = await db.prepare(`
    SELECT operator_name, aircraft_class
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
      AND operator_name IS NOT NULL AND operator_name != ''
      AND aircraft_class IS NOT NULL
    GROUP BY operator_name, aircraft_class
  `).all(monthStart, monthEnd) as Array<{ operator_name: string; aircraft_class: string }>;
  const classesMap = new Map<string, string[]>();
  for (const r of classRows) {
    const arr = classesMap.get(r.operator_name) ?? [];
    arr.push(r.aircraft_class);
    classesMap.set(r.operator_name, arr);
  }

  const rows: unknown[][] = [];
  for (const op of operators) {
    const sharePct = Math.round((op.total_legs / totalLegs) * 10000) / 100;
    rows.push([
      month, op.operator_name, op.total_legs, op.total_flight_hours,
      sharePct, op.avg_flight_time_min,
      topRouteMap.get(op.operator_name) ?? null,
      JSON.stringify(classesMap.get(op.operator_name) ?? []),
    ]);
  }

  await bulkUpsert(
    db, "operator_market_share",
    ["month", "operator_name", "total_legs", "total_flight_hours",
     "market_share_pct", "avg_flight_time_min", "top_route", "aircraft_classes"],
    rows,
    ["month", "operator_name"],
  );

  console.log(`[analytics] operator_market_share ${month}: ${operators.length} operators`);
  return operators.length;
}

// ── Aircraft Utilization ────────────────────────────────────────────────────

export async function buildAircraftUtilization(db: DbBridge, month: string): Promise<number> {
  const monthStart = `${month}-01`;
  const monthEnd = nextMonthStart(month);  // exclusive — text-safe across space/T separator formats

  const aircraft = await db.prepare(`
    SELECT tail_number, MAX(icao_hex) as icao_hex,
      MAX(operator_name) as operator_name, MAX(aircraft_class) as aircraft_class,
      COUNT(*) as total_legs,
      ROUND(COALESCE(SUM(flight_time_min), 0) / 60.0, 2) as total_flight_hours,
      ROUND(COALESCE(SUM(distance_nm), 0), 1) as total_distance_nm,
      COUNT(DISTINCT DATE(departure_time)) as days_active
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
      AND tail_number IS NOT NULL AND tail_number != ''
    GROUP BY tail_number ORDER BY total_legs DESC
  `).all(monthStart, monthEnd) as Array<{
    tail_number: string; icao_hex: string | null; operator_name: string | null;
    aircraft_class: string | null; total_legs: number; total_flight_hours: number;
    total_distance_nm: number; days_active: number;
  }>;

  // Batch: home airport (most-frequent origin) per tail_number
  const homeRows = await db.prepare(`
    SELECT DISTINCT ON (tail_number) tail_number, origin_icao
    FROM (
      SELECT tail_number, origin_icao, COUNT(*) AS n
      FROM adsb_completed_legs
      WHERE departure_time >= ? AND departure_time < ?
        AND tail_number IS NOT NULL AND tail_number != ''
        AND origin_icao IS NOT NULL
      GROUP BY tail_number, origin_icao
    ) t
    ORDER BY tail_number, n DESC
  `).all(monthStart, monthEnd) as Array<{ tail_number: string; origin_icao: string }>;
  const homeMap = new Map<string, string>();
  for (const r of homeRows) homeMap.set(r.tail_number, r.origin_icao);

  const rows: unknown[][] = [];
  for (const ac of aircraft) {
    const avgDaily = ac.days_active > 0
      ? Math.round((ac.total_flight_hours / ac.days_active) * 100) / 100
      : 0;
    rows.push([
      month, ac.tail_number, ac.icao_hex, ac.operator_name, ac.aircraft_class,
      ac.total_legs, ac.total_flight_hours, ac.total_distance_nm,
      ac.days_active, avgDaily, homeMap.get(ac.tail_number) ?? null,
    ]);
  }

  await bulkUpsert(
    db, "aircraft_utilization",
    ["month", "tail_number", "icao_hex", "operator_name", "aircraft_class",
     "total_legs", "total_flight_hours", "total_distance_nm", "days_active",
     "avg_daily_hours", "home_airport"],
    rows,
    ["month", "tail_number"],
  );

  console.log(`[analytics] aircraft_utilization ${month}: ${aircraft.length} aircraft`);
  return aircraft.length;
}

// ── Airport Activity ────────────────────────────────────────────────────────

export async function buildAirportActivity(db: DbBridge, date: string): Promise<number> {
  const dateStart = date;
  const dateEnd = nextDayStart(date);  // exclusive — text-safe across space/T separator formats

  const departures = await db.prepare(`
    SELECT origin_icao as airport, CAST(strftime('%H', departure_time) AS INTEGER) as hour,
           COUNT(*) as cnt,
           COUNT(DISTINCT COALESCE(tail_number, icao_hex)) as unique_ac,
           SUM(CASE WHEN aircraft_class IS NOT NULL THEN 1 ELSE 0 END) as charter
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ? AND origin_icao IS NOT NULL
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
    WHERE arrival_time >= ? AND arrival_time < ? AND destination_icao IS NOT NULL
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

  const rows: unknown[][] = [];
  for (const [k, v] of map) {
    const [airport, hourStr] = k.split("|") as [string, string];
    const hour = parseInt(hourStr, 10);
    rows.push([date, airport, hour, v.dep, v.arr, v.dep + v.arr, v.unique, v.charter]);
  }

  await bulkUpsert(
    db, "airport_activity",
    ["date", "airport_icao", "hour", "departures", "arrivals",
     "total_movements", "unique_aircraft", "charter_movements"],
    rows,
    ["date", "airport_icao", "hour"],
  );

  console.log(`[analytics] airport_activity ${date}: ${map.size} airport-hours`);
  return map.size;
}

// ── Route Trends ────────────────────────────────────────────────────────────

export async function buildRouteTrends(db: DbBridge, month: string): Promise<number> {
  const monthStart = `${month}-01`;
  const monthEnd = nextMonthStart(month);  // exclusive — text-safe across space/T separator formats
  const [yearStr, monthNum] = month.split("-") as [string, string];
  const prevYear = `${parseInt(yearStr, 10) - 1}-${monthNum}`;
  const prevStart = `${prevYear}-01`;
  const prevEnd = nextMonthStart(prevYear);  // exclusive

  const routes = await db.prepare(`
    SELECT origin_icao, destination_icao, COUNT(*) as total_flights,
      ROUND(COALESCE(AVG(flight_time_min), 0), 1) as avg_flight_time_min
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
      AND origin_icao IS NOT NULL AND destination_icao IS NOT NULL
    GROUP BY origin_icao, destination_icao ORDER BY total_flights DESC
  `).all(monthStart, monthEnd) as Array<{
    origin_icao: string; destination_icao: string;
    total_flights: number; avg_flight_time_min: number;
  }>;

  // Batch: class breakdown per route (ordered by cnt so first = dominant)
  const classRows = await db.prepare(`
    SELECT origin_icao, destination_icao, aircraft_class, COUNT(*) AS cnt
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
      AND origin_icao IS NOT NULL AND destination_icao IS NOT NULL
      AND aircraft_class IS NOT NULL
    GROUP BY origin_icao, destination_icao, aircraft_class
    ORDER BY origin_icao, destination_icao, cnt DESC
  `).all(monthStart, monthEnd) as Array<{
    origin_icao: string; destination_icao: string; aircraft_class: string; cnt: number;
  }>;
  const routeKey = (o: string, d: string) => `${o}|${d}`;
  const classesByRoute = new Map<string, Array<{ aircraft_class: string; cnt: number }>>();
  for (const r of classRows) {
    const k = routeKey(r.origin_icao, r.destination_icao);
    const arr = classesByRoute.get(k) ?? [];
    arr.push({ aircraft_class: r.aircraft_class, cnt: r.cnt });
    classesByRoute.set(k, arr);
  }

  // Batch: previous-year counts per route for YoY
  const prevRows = await db.prepare(`
    SELECT origin_icao, destination_icao, COUNT(*) AS cnt
    FROM adsb_completed_legs
    WHERE departure_time >= ? AND departure_time < ?
      AND origin_icao IS NOT NULL AND destination_icao IS NOT NULL
    GROUP BY origin_icao, destination_icao
  `).all(prevStart, prevEnd) as Array<{ origin_icao: string; destination_icao: string; cnt: number }>;
  const prevMap = new Map<string, number>();
  for (const r of prevRows) prevMap.set(routeKey(r.origin_icao, r.destination_icao), r.cnt);

  const rows: unknown[][] = [];
  for (const route of routes) {
    const k = routeKey(route.origin_icao, route.destination_icao);
    const classes = classesByRoute.get(k) ?? [];
    const breakdown: Record<string, number> = {};
    let dominantClass: string | null = null;
    for (const c of classes) {
      breakdown[c.aircraft_class] = c.cnt;
      if (!dominantClass) dominantClass = c.aircraft_class;
    }

    const prevCnt = prevMap.get(k) ?? 0;
    const yoyPct = prevCnt > 0
      ? Math.round(((route.total_flights - prevCnt) / prevCnt) * 1000) / 10
      : null;

    rows.push([
      month, route.origin_icao, route.destination_icao,
      route.total_flights, route.avg_flight_time_min,
      dominantClass, JSON.stringify(breakdown), yoyPct,
    ]);
  }

  await bulkUpsert(
    db, "route_trends",
    ["month", "origin_icao", "destination_icao", "total_flights",
     "avg_flight_time_min", "dominant_class", "class_breakdown", "yoy_change_pct"],
    rows,
    ["month", "origin_icao", "destination_icao"],
  );

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

  // Batch: per-class counts across tables (one aggregate query each)
  const regRows = await db.prepare(
    `SELECT aircraft_class, COUNT(*) AS cnt FROM faa_aircraft
     WHERE aircraft_class IS NOT NULL GROUP BY aircraft_class`,
  ).all() as Array<{ aircraft_class: string; cnt: number }>;
  const regMap = new Map(regRows.map((r) => [r.aircraft_class, Number(r.cnt)]));

  const stateRows = await db.prepare(
    `SELECT aircraft_class, state, COUNT(*) AS cnt FROM adsb_aircraft_state
     WHERE aircraft_class IS NOT NULL GROUP BY aircraft_class, state`,
  ).all() as Array<{ aircraft_class: string; state: string; cnt: number }>;
  const trackedMap = new Map<string, number>();
  const airborneMap = new Map<string, number>();
  const idleMap = new Map<string, number>();
  for (const r of stateRows) {
    const cnt = Number(r.cnt);
    trackedMap.set(r.aircraft_class, (trackedMap.get(r.aircraft_class) ?? 0) + cnt);
    if (r.state === "airborne") airborneMap.set(r.aircraft_class, cnt);
    if (r.state === "idle" || r.state === "idle_transient") {
      idleMap.set(r.aircraft_class, (idleMap.get(r.aircraft_class) ?? 0) + cnt);
    }
  }

  // Avg hours per tail over last 30 days, then averaged per class (subquery aliased — PG requires it)
  const utilRows = await db.prepare(`
    SELECT aircraft_class, ROUND(AVG(hours)::numeric, 2) AS avg_hours FROM (
      SELECT aircraft_class, tail_number, SUM(flight_time_min) / 60.0 AS hours
      FROM adsb_completed_legs
      WHERE aircraft_class IS NOT NULL AND departure_time >= ?
      GROUP BY aircraft_class, tail_number
    ) t GROUP BY aircraft_class
  `).all(thirtyDaysAgo) as Array<{ aircraft_class: string; avg_hours: number | null }>;
  const utilMap = new Map(utilRows.map((r) => [r.aircraft_class, Number(r.avg_hours ?? 0)]));

  // Registry changes per class (tolerate empty table)
  const newRegsMap = new Map<string, number>();
  const deregsMap = new Map<string, number>();
  try {
    const changes = await db.prepare(`
      SELECT fa.aircraft_class, fc.change_type, COUNT(*) AS cnt
      FROM faa_registry_changes fc
      JOIN faa_aircraft fa ON fa.tail_number = fc.tail_number
      WHERE fc.change_type IN ('new','deregistered')
        AND fc.detected_at >= ?
        AND fa.aircraft_class IS NOT NULL
      GROUP BY fa.aircraft_class, fc.change_type
    `).all(sevenDaysAgo) as Array<{ aircraft_class: string; change_type: string; cnt: number }>;
    for (const r of changes) {
      const cnt = Number(r.cnt);
      if (r.change_type === "new") newRegsMap.set(r.aircraft_class, cnt);
      else deregsMap.set(r.aircraft_class, cnt);
    }
  } catch { /* ignore */ }

  const rows: unknown[][] = [];
  for (const cls of classes) {
    rows.push([
      date, cls,
      regMap.get(cls) ?? 0,
      trackedMap.get(cls) ?? 0,
      airborneMap.get(cls) ?? 0,
      idleMap.get(cls) ?? 0,
      utilMap.get(cls) ?? 0,
      newRegsMap.get(cls) ?? 0,
      deregsMap.get(cls) ?? 0,
    ]);
  }

  await bulkUpsert(
    db, "fleet_snapshot",
    ["date", "aircraft_class", "total_registered", "total_tracked",
     "total_airborne", "total_idle", "avg_utilization_hours",
     "new_registrations", "deregistrations"],
    rows,
    ["date", "aircraft_class"],
  );

  console.log(`[analytics] fleet_snapshot ${date}: ${classes.length} classes`);
  return classes.length;
}

// ── Rebuild All ─────────────────────────────────────────────────────────────

function nextMonthStart(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-01`;
}

function nextDayStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

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
