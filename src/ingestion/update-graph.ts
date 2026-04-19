/**
 * update-graph — Knowledge Graph Builder
 *
 * Joins faa_aircraft ↔ adsb_aircraft_state on icao_hex to produce the
 * knowledge_graph table linking tail numbers to operators, flagging ghost
 * candidates (idle charter-class aircraft near network airports), and
 * computing fleet_stats per aircraft class.
 *
 * Migrated from update-graph.mjs (root) in Phase 6 Tier 3. Now runs against
 * Postgres via the DbBridge. Invoked from pipeline.ts as cron step 3.
 */

import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg } from "../memory/pg-database.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("update-graph");

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "update-graph requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  console.log(`[graph] Connected to Postgres`);

  // ── Idempotent schema safety net ─────────────────────────────────────────
  // Tables should exist from src/memory/schema/; these CREATE IF NOT EXISTS / ALTER
  // IF NOT EXISTS statements keep re-runs safe in environments that haven't
  // had the schema migration applied yet.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_graph (
      icao_hex TEXT PRIMARY KEY,
      tail_number TEXT, owner_name TEXT, operator_name TEXT,
      manufacturer TEXT, model TEXT, common_name TEXT, aircraft_class TEXT,
      year_manufactured INTEGER, num_seats INTEGER, certificate_number TEXT,
      state TEXT, latitude REAL, longitude REAL, nearest_airport TEXT,
      idle_since TEXT, idle_hours REAL DEFAULT 0, last_seen TEXT,
      last_leg_origin TEXT, last_leg_dest TEXT,
      operator_argus TEXT, operator_wyvern TEXT,
      operator_safety_score INTEGER DEFAULT 0,
      is_charter_class INTEGER DEFAULT 0,
      is_near_network_airport INTEGER DEFAULT 0,
      is_ghost_candidate INTEGER DEFAULT 0,
      ghost_airport TEXT,
      total_legs INTEGER DEFAULT 0,
      legs_last_30d INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_stats (
      aircraft_class TEXT PRIMARY KEY,
      total_tracked INTEGER DEFAULT 0,
      airborne INTEGER DEFAULT 0,
      idle INTEGER DEFAULT 0,
      ghost_candidates INTEGER DEFAULT 0,
      updated_at TEXT
    );
  `);

  // ── Step 1: Join FAA + ADS-B state → knowledge_graph ──────────────────
  await db.prepare("DELETE FROM knowledge_graph").run();
  await db.prepare(`
    INSERT INTO knowledge_graph (
      icao_hex, tail_number, owner_name, operator_name,
      manufacturer, model, common_name, aircraft_class,
      year_manufactured, num_seats, certificate_number,
      state, latitude, longitude, nearest_airport,
      idle_since, idle_hours, last_seen,
      last_leg_origin, last_leg_dest,
      is_charter_class, updated_at
    )
    SELECT DISTINCT ON (f.icao_hex)
      f.icao_hex,
      f.tail_number,
      f.owner_name,
      COALESCE(a.operator_name, f.certificate_holder, f.owner_name),
      f.manufacturer,
      f.model,
      f.common_name,
      COALESCE(a.aircraft_class, f.aircraft_class),
      f.year_manufactured,
      f.num_seats,
      f.certificate_number,
      a.state,
      a.latitude,
      a.longitude,
      a.nearest_airport,
      a.idle_since,
      a.idle_hours,
      a.last_seen,
      a.last_leg_origin,
      a.last_leg_destination,
      CASE WHEN COALESCE(a.aircraft_class, f.aircraft_class)
        IN ('light','midsize','super_mid','heavy','turboprop')
        THEN 1 ELSE 0 END,
      NOW()::text
    FROM faa_aircraft f
    INNER JOIN adsb_aircraft_state a ON f.icao_hex = a.icao_hex
    WHERE f.icao_hex IS NOT NULL
  `).run();

  const joined = (await db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_graph").get()) as { cnt: number };
  console.log(`[graph] Joined ${joined.cnt} aircraft (FAA ∩ ADS-B)`);

  // ── Step 2: Flag aircraft near network airports ──────────────────────
  const nearResult = await db.prepare(`
    UPDATE knowledge_graph
    SET is_near_network_airport = 1,
        ghost_airport = nearest_airport
    WHERE nearest_airport IN (SELECT icao_code FROM faa_airports)
  `).run() as { changes: number };
  console.log(`[graph] ${nearResult.changes} aircraft near network airports`);

  // ── Step 3: Flag ghost candidates ────────────────────────────────────
  const ghostResult = await db.prepare(`
    UPDATE knowledge_graph
    SET is_ghost_candidate = 1
    WHERE is_charter_class = 1
      AND is_near_network_airport = 1
      AND state = 'idle_transient'
  `).run() as { changes: number };
  console.log(`[graph] ${ghostResult.changes} ghost candidates flagged`);

  // ── Step 4: Compute leg stats per aircraft (two correlated UPDATEs) ──
  await db.prepare(`
    UPDATE knowledge_graph
    SET total_legs = sub.cnt
    FROM (
      SELECT icao_hex, COUNT(*)::int AS cnt
      FROM adsb_completed_legs
      WHERE icao_hex IS NOT NULL
      GROUP BY icao_hex
    ) sub
    WHERE knowledge_graph.icao_hex = sub.icao_hex
  `).run();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setUTCDate(thirtyDaysAgo.getUTCDate() - 30);
  await db.prepare(`
    UPDATE knowledge_graph
    SET legs_last_30d = sub.cnt
    FROM (
      SELECT icao_hex, COUNT(*)::int AS cnt
      FROM adsb_completed_legs
      WHERE icao_hex IS NOT NULL AND departure_time >= ?
      GROUP BY icao_hex
    ) sub
    WHERE knowledge_graph.icao_hex = sub.icao_hex
  `).run(thirtyDaysAgo.toISOString());
  console.log("[graph] Leg stats computed");

  // ── Step 5: Update fleet_stats ───────────────────────────────────────
  await db.prepare("DELETE FROM fleet_stats").run();
  await db.prepare(`
    INSERT INTO fleet_stats (aircraft_class, total_tracked, airborne, idle, ghost_candidates, updated_at)
    SELECT
      aircraft_class,
      COUNT(*)::int,
      SUM(CASE WHEN state = 'airborne' THEN 1 ELSE 0 END)::int,
      SUM(CASE WHEN state = 'idle_transient' THEN 1 ELSE 0 END)::int,
      SUM(is_ghost_candidate)::int,
      NOW()::text
    FROM knowledge_graph
    WHERE is_charter_class = 1
    GROUP BY aircraft_class
  `).run();
  console.log("[graph] Fleet stats updated");

  // ── Step 6: Link tail numbers to operator_profiles (for reporting) ───
  const ops = await db.prepare(`
    SELECT operator_name, COUNT(*)::int AS fleet_size,
           SUM(CASE WHEN state = 'airborne' THEN 1 ELSE 0 END)::int AS airborne,
           SUM(is_ghost_candidate)::int AS ghosts
    FROM knowledge_graph
    WHERE operator_name IS NOT NULL AND is_charter_class = 1
    GROUP BY operator_name
    HAVING COUNT(*) >= 2
    ORDER BY fleet_size DESC
    LIMIT 50
  `).all() as Array<{ operator_name: string; fleet_size: number; airborne: number; ghosts: number }>;

  console.log(`[graph] Top operators with 2+ charter aircraft: ${ops.length}`);
  for (const op of ops.slice(0, 10)) {
    console.log(`        ${op.operator_name}: ${op.fleet_size} aircraft (${op.airborne} airborne, ${op.ghosts} ghosts)`);
  }

  // ── Step 7: Propagate safety ratings from faa_operators ──────────────
  const exactResult = await db.prepare(`
    UPDATE knowledge_graph
    SET operator_argus = (
      SELECT o.argus_rating FROM faa_operators o
      WHERE o.name = knowledge_graph.operator_name
        AND o.argus_rating IS NOT NULL
      LIMIT 1
    ),
    operator_wyvern = (
      SELECT o.wyvern_rating FROM faa_operators o
      WHERE o.name = knowledge_graph.operator_name
        AND o.wyvern_rating IS NOT NULL
      LIMIT 1
    ),
    operator_safety_score = COALESCE((
      SELECT CASE
        WHEN o.argus_rating = 'platinum_elite' THEN 4
        WHEN o.argus_rating = 'platinum' OR (o.is_bao_stage IS NOT NULL AND o.is_bao_stage >= 2) THEN 3
        WHEN o.argus_rating = 'gold_plus' OR o.wyvern_rating = 'wingman' THEN 2
        WHEN o.argus_rating = 'gold' THEN 1
        ELSE 0
      END
      FROM faa_operators o
      WHERE o.name = knowledge_graph.operator_name
        AND (o.argus_rating IS NOT NULL OR o.wyvern_rating IS NOT NULL)
      LIMIT 1
    ), 0)
    WHERE operator_name IS NOT NULL AND operator_name != '' AND operator_name != '-'
  `).run() as { changes: number };
  console.log(`[graph] Safety scores propagated: ${exactResult.changes} rows (exact match)`);

  // Fuzzy match — update KG rows whose operator_name CONTAINS a rated operator name
  const ratedOps = await db.prepare(
    `SELECT name, argus_rating, wyvern_rating, is_bao_stage FROM faa_operators
     WHERE argus_rating IS NOT NULL OR wyvern_rating IS NOT NULL`,
  ).all() as Array<{
    name: string; argus_rating: string | null; wyvern_rating: string | null; is_bao_stage: number | null;
  }>;

  const fuzzyStmt = db.prepare(
    `UPDATE knowledge_graph SET operator_argus = ?, operator_wyvern = ?, operator_safety_score = ?
     WHERE operator_name LIKE ? AND operator_safety_score = 0`,
  );

  let fuzzyCount = 0;
  for (const op of ratedOps) {
    const score = op.argus_rating === "platinum_elite" ? 4
      : (op.argus_rating === "platinum" || (op.is_bao_stage != null && op.is_bao_stage >= 2)) ? 3
      : (op.argus_rating === "gold_plus" || op.wyvern_rating === "wingman") ? 2
      : op.argus_rating === "gold" ? 1 : 0;
    const r = await fuzzyStmt.run(op.argus_rating, op.wyvern_rating, score, `%${op.name}%`) as { changes: number };
    fuzzyCount += r.changes;
  }
  if (fuzzyCount > 0) console.log(`[graph] Safety scores propagated: ${fuzzyCount} rows (fuzzy match)`);

  // ── Final report ────────────────────────────────────────────────────
  console.log("\n═══ Knowledge Graph Summary ═══");

  const stats = await db.prepare(`
    SELECT
      COUNT(*)::int AS total,
      SUM(is_charter_class)::int AS charter_class,
      SUM(is_near_network_airport)::int AS near_network,
      SUM(is_ghost_candidate)::int AS ghost_candidates,
      SUM(CASE WHEN state = 'airborne' THEN 1 ELSE 0 END)::int AS airborne,
      SUM(CASE WHEN state = 'idle_transient' THEN 1 ELSE 0 END)::int AS idle
    FROM knowledge_graph
  `).get() as {
    total: number; charter_class: number; near_network: number;
    ghost_candidates: number; airborne: number; idle: number;
  };

  console.log(`Total aircraft in graph:    ${stats.total}`);
  console.log(`Charter-class:              ${stats.charter_class}`);
  console.log(`Near network airports:      ${stats.near_network}`);
  console.log(`Airborne:                   ${stats.airborne}`);
  console.log(`Idle:                       ${stats.idle}`);
  console.log(`Ghost candidates:           ${stats.ghost_candidates}`);

  console.log("\n── Fleet Stats by Class ──");
  const fleetRows = await db.prepare(
    "SELECT * FROM fleet_stats ORDER BY total_tracked DESC",
  ).all() as Array<{
    aircraft_class: string | null; total_tracked: number;
    airborne: number; idle: number; ghost_candidates: number;
  }>;
  for (const r of fleetRows) {
    console.log(`  ${(r.aircraft_class || "unknown").padEnd(12)} tracked=${r.total_tracked}  airborne=${r.airborne}  idle=${r.idle}  ghosts=${r.ghost_candidates}`);
  }

  console.log("\n── Ghost Candidates by Airport ──");
  const ghostByAirport = await db.prepare(`
    SELECT ghost_airport, aircraft_class, COUNT(*)::int AS cnt
    FROM knowledge_graph
    WHERE is_ghost_candidate = 1
    GROUP BY ghost_airport, aircraft_class
    ORDER BY cnt DESC
    LIMIT 20
  `).all() as Array<{ ghost_airport: string; aircraft_class: string; cnt: number }>;
  for (const r of ghostByAirport) {
    console.log(`  ${r.ghost_airport} (${r.aircraft_class}): ${r.cnt}`);
  }

  console.log("\n── Outcome Query ──");
  const outcome = await db.prepare(`
    SELECT COUNT(DISTINCT tail_number)::int AS ghost_count
    FROM knowledge_graph
    WHERE is_ghost_candidate = 1
  `).get() as { ghost_count: number };
  console.log(`SELECT COUNT(DISTINCT tail_number) FROM knowledge_graph WHERE is_ghost_candidate = 1`);
  console.log(`→ ${outcome.ghost_count}`);

  await closePg();
  console.log("\n[graph] Done.");
}

main().catch((err) => {
  log.fatal({ err }, "update-graph fatal error");
  process.exit(1);
});
