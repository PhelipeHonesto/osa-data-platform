/**
 * classify-aircraft — fill NULL aircraft_class in faa_aircraft
 *
 * Uses common_name pattern matching based on aviation type knowledge.
 * Only classifies charter-relevant turbine aircraft: light, midsize,
 * super_mid, heavy, turboprop. Leaves GA / airline / military as NULL.
 *
 * Migrated from classify-aircraft.mjs (root) in Phase 6 Tier 3. Now runs
 * against Postgres via the DbBridge. Invoked from pipeline.ts as cron step 2.
 */

import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg } from "../memory/pg-database.js";

// ── Classification rules ────────────────────────────────────────────────
// Each rule: [class, SQL LIKE pattern]. Order matters: later rules only
// hit rows not matched by earlier ones (the WHERE aircraft_class IS NULL
// narrows the target on each pass).

type AircraftClass = "light" | "midsize" | "super_mid" | "heavy" | "turboprop";

const RULES: Array<[AircraftClass, string]> = [
  // ── HEAVY (large-cabin, long-range) ─────────────────────────
  ["heavy", "GULFSTREAM G650%"],
  ["heavy", "GULFSTREAM G600%"],
  ["heavy", "GULFSTREAM G500%"],
  ["heavy", "GULFSTREAM G700%"],
  ["heavy", "GULFSTREAM G-8 G800%"],
  ["heavy", "GULFSTREAM 5%"],
  ["heavy", "GULFSTREAM 4%"],
  ["heavy", "GULFSTREAM 3%"],
  ["heavy", "GULFSTREAM 2%"],
  ["heavy", "BOMBARDIER BD-700%"],
  ["heavy", "DASSAULT Falcon 7%"],
  ["heavy", "DASSAULT Falcon 8%"],
  ["heavy", "DASSAULT Falcon 900%"],
  ["heavy", "DASSAULT Falcon 6X%"],
  ["heavy", "EMBRAER EMB-135%Legacy%"],
  ["heavy", "%Lineage%"],
  ["heavy", "CESSNA 750 Citation 10%"],

  // ── SUPER_MID ───────────────────────────────────────────────
  ["super_mid", "BOMBARDIER BD-100 Challenger%"],
  ["super_mid", "BOMBARDIER CL-600%"],
  ["super_mid", "CESSNA 680 Citation Latitude%"],
  ["super_mid", "CESSNA 680 Citation Sovereign%"],
  ["super_mid", "CESSNA 700 Citation Longitude%"],
  ["super_mid", "CESSNA 650 Citation%"],
  ["super_mid", "DASSAULT Falcon 2000%"],
  ["super_mid", "DASSAULT Falcon 200%"],
  ["super_mid", "DASSAULT Falcon 100%"],
  ["super_mid", "EMBRAER EMB545 Praetor 500%"],
  ["super_mid", "EMBRAER EMB-550 Praetor 600%"],
  ["super_mid", "GULFSTREAM AEROSPACE Gulfstream G100%"],
  ["super_mid", "GULFSTREAM G280%"],
  ["super_mid", "GULFSTREAM G-7 G400%"],
  ["super_mid", "RAYTHEON 4000 Hawker Horizon%"],
  ["super_mid", "RAYTHEON Hawker 1000%"],

  // ── MIDSIZE ─────────────────────────────────────────────────
  ["midsize", "CESSNA 560%"],
  ["midsize", "CESSNA 551 Citation 2SP%"],
  ["midsize", "CESSNA 550 Citation%"],
  ["midsize", "HAWKER BEECHCRAFT Hawker%"],
  ["midsize", "LEARJET 45%"],
  ["midsize", "LEARJET 55%"],
  ["midsize", "LEARJET 60%"],
  ["midsize", "LEARJET 75%"],
  ["midsize", "EMBRAER EMB-505 Phenom 300%"],
  ["midsize", "EMBRAER EMB-500 Phenom 100%"],
  ["midsize", "LEARJET 31%"],
  ["midsize", "LEARJET 25%"],
  ["midsize", "LEARJET 35%"],

  // ── LIGHT (light jets, VLJ) ─────────────────────────────────
  ["light", "CESSNA 525%"],
  ["light", "CESSNA 510 Citation Mustang%"],
  ["light", "CESSNA 500 Citation 1%"],
  ["light", "CIRRUS SF-50 Vision%"],
  ["light", "ECLIPSE 550%"],
  ["light", "ECLIPSE 500%"],
  ["light", "ECLIPSE 10%"],
  ["light", "PILATUS PC-24%"],
  ["light", "PREMIER%"],
  ["light", "HONDA HA-420 HondaJet%"],
  ["light", "%HondaJet%"],
  ["light", "BEECH 400 Beechjet%"],
  ["light", "SYBERJET SJ30%"],

  // ── TURBOPROP ───────────────────────────────────────────────
  ["turboprop", "PILATUS PC-12%"],
  ["turboprop", "BEECH 200 Super King Air%"],
  ["turboprop", "BEECH 300 Super King Air%"],
  ["turboprop", "BEECHCRAFT Super King Air%"],
  ["turboprop", "BEECH 90 King Air%"],
  ["turboprop", "BEECH 100 King Air%"],
  ["turboprop", "BEECH F90 King Air%"],
  ["turboprop", "BEECH B200%King Air%"],
  ["turboprop", "SOCATA TBM%"],
  ["turboprop", "CESSNA 208 Caravan%"],
  ["turboprop", "CESSNA F406 Caravan%"],
  ["turboprop", "PIPER PA-46-500TP%"],
  ["turboprop", "PIPER PA-46-600TP%"],
  ["turboprop", "PIPER PA-46-701TP%"],
  ["turboprop", "DAHER TBM%"],
  ["turboprop", "PIAGGIO P-180 Avanti%"],
];

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "classify-aircraft requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  const beforeCount = ((await db.prepare(
    "SELECT COUNT(*) AS cnt FROM faa_aircraft WHERE aircraft_class IS NULL",
  ).get()) as { cnt: number }).cnt;

  console.log(`[classify] ${beforeCount} aircraft with NULL aircraft_class`);
  console.log(`[classify] Applying ${RULES.length} classification rules...\n`);

  const updateStmt = db.prepare(
    `UPDATE faa_aircraft
     SET aircraft_class = ?, updated_at = NOW()
     WHERE aircraft_class IS NULL AND common_name LIKE ?`,
  );

  let totalClassified = 0;
  const classCounts: Record<AircraftClass, number> = {
    light: 0, midsize: 0, super_mid: 0, heavy: 0, turboprop: 0,
  };

  for (const [cls, pattern] of RULES) {
    const result = await updateStmt.run(cls, pattern) as { changes: number };
    if (result.changes > 0) {
      totalClassified += result.changes;
      classCounts[cls] += result.changes;
      console.log(`  ${cls.padEnd(12)} +${String(result.changes).padStart(5)}  ← ${pattern}`);
    }
  }

  const afterCount = ((await db.prepare(
    "SELECT COUNT(*) AS cnt FROM faa_aircraft WHERE aircraft_class IS NULL",
  ).get()) as { cnt: number }).cnt;

  console.log(`\n═══ Classification Summary ═══`);
  console.log(`Before:          ${beforeCount} NULL`);
  console.log(`Classified:      ${totalClassified}`);
  console.log(`Remaining NULL:  ${afterCount}`);
  console.log(`\nBy class:`);
  for (const [cls, count] of Object.entries(classCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(12)} ${count}`);
  }

  console.log(`\n── Full aircraft_class distribution ──`);
  const dist = await db.prepare(
    `SELECT COALESCE(aircraft_class, '(null)') AS cls, COUNT(*) AS cnt
     FROM faa_aircraft
     GROUP BY aircraft_class
     ORDER BY cnt DESC`,
  ).all() as Array<{ cls: string; cnt: number | string }>;
  for (const r of dist) {
    console.log(`  ${r.cls.padEnd(12)} ${r.cnt}`);
  }

  await closePg();
  console.log("\n[classify] Done.");
}

main().catch((err) => {
  console.error("[classify] Fatal:", err);
  process.exit(1);
});
