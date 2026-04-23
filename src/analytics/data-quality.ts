/**
 * Data quality validation layer.
 *
 * Read-only checks that flag malformed data, duplicates, orphans,
 * stale records, and anomalies. Never modifies data.
 *
 * CLI: npm run quality:check
 */

import type Database from "better-sqlite3";
import { getDb, closeDb } from "../db/database.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("quality");

// ── Types ───────────────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  count: number;
  details: string;
}

export interface QualityReport {
  runAt: string;
  checks: CheckResult[];
  overall: "green" | "yellow" | "red";
  totalIssues: number;
}

// ── Individual checks ───────────────────────────────────────────────────────

export function checkTailNumbers(db: Database.Database): CheckResult {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM faa_aircraft
    WHERE tail_number NOT GLOB 'N[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'
      AND tail_number NOT GLOB 'N[A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]'
      AND tail_number NOT GLOB 'N[A-Z0-9][A-Z0-9][A-Z0-9]'
      AND tail_number NOT GLOB 'N[A-Z0-9][A-Z0-9]'
      AND tail_number NOT GLOB 'N[A-Z0-9]'
  `).get() as { cnt: number };

  return {
    name: "malformed_tail_numbers",
    status: row.cnt === 0 ? "pass" : row.cnt < 100 ? "warn" : "fail",
    count: row.cnt,
    details: `${row.cnt} tail numbers don't match N + 1-5 alphanumeric`,
  };
}

export function checkIcaoCodes(db: Database.Database): CheckResult {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM adsb_completed_legs
    WHERE (origin_icao IS NOT NULL AND origin_icao NOT GLOB '[A-Z][A-Z][A-Z][A-Z]')
       OR (destination_icao IS NOT NULL AND destination_icao NOT GLOB '[A-Z][A-Z][A-Z][A-Z]')
  `).get() as { cnt: number };

  return {
    name: "invalid_icao_codes",
    status: row.cnt === 0 ? "pass" : row.cnt < 100 ? "warn" : "fail",
    count: row.cnt,
    details: `${row.cnt} legs with non-standard ICAO airport codes`,
  };
}

export function checkDuplicateLegs(db: Database.Database): CheckResult {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM (
      SELECT icao_hex, departure_time, COUNT(*) as dupes
      FROM adsb_completed_legs
      WHERE icao_hex IS NOT NULL AND departure_time IS NOT NULL
      GROUP BY icao_hex, departure_time
      HAVING dupes > 1
    )
  `).get() as { cnt: number };

  return {
    name: "duplicate_legs",
    status: row.cnt === 0 ? "pass" : row.cnt < 100 ? "warn" : "fail",
    count: row.cnt,
    details: `${row.cnt} aircraft+departure_time combinations with duplicate legs`,
  };
}

export function checkOrphanedRecords(db: Database.Database): CheckResult {
  const legsOrphans = db.prepare(`
    SELECT COUNT(*) as cnt FROM adsb_completed_legs
    WHERE tail_number IS NOT NULL AND tail_number != ''
      AND tail_number NOT IN (SELECT tail_number FROM faa_aircraft WHERE tail_number IS NOT NULL)
  `).get() as { cnt: number };

  // knowledge_graph may not exist — check safely
  let kgOrphans = 0;
  try {
    const kgRow = db.prepare(`
      SELECT COUNT(*) as cnt FROM knowledge_graph
      WHERE tail_number IS NOT NULL AND tail_number != ''
        AND tail_number NOT IN (SELECT tail_number FROM faa_aircraft WHERE tail_number IS NOT NULL)
    `).get() as { cnt: number };
    kgOrphans = kgRow.cnt;
  } catch {
    // table doesn't exist yet
  }

  const total = legsOrphans.cnt + kgOrphans;

  return {
    name: "orphaned_records",
    status: total === 0 ? "pass" : total < 100 ? "warn" : "fail",
    count: total,
    details: `${legsOrphans.cnt} orphaned legs + ${kgOrphans} orphaned knowledge_graph entries`,
  };
}

export function checkEmptyFields(db: Database.Database): CheckResult {
  const aircraft = db.prepare(`
    SELECT COUNT(*) as cnt FROM faa_aircraft
    WHERE manufacturer IS NULL OR model IS NULL
  `).get() as { cnt: number };

  const legs = db.prepare(`
    SELECT COUNT(*) as cnt FROM adsb_completed_legs
    WHERE origin_icao IS NULL OR destination_icao IS NULL
  `).get() as { cnt: number };

  const total = aircraft.cnt + legs.cnt;

  return {
    name: "empty_critical_fields",
    status: total === 0 ? "pass" : total < 100 ? "warn" : "fail",
    count: total,
    details: `${aircraft.cnt} aircraft missing manufacturer/model + ${legs.cnt} legs missing origin/destination`,
  };
}

export function checkStaleData(db: Database.Database): CheckResult {
  let issues = 0;
  const parts: string[] = [];

  // Stale ADS-B positions (last_seen > 24h ago)
  try {
    const stale = db.prepare(`
      SELECT COUNT(*) as cnt FROM adsb_aircraft_state
      WHERE last_seen < datetime('now', '-24 hours')
    `).get() as { cnt: number };
    // Stale positions are expected for aircraft that stopped flying —
    // only flag if there are zero recent positions at all
    const recent = db.prepare(`
      SELECT COUNT(*) as cnt FROM adsb_aircraft_state
      WHERE last_seen >= datetime('now', '-24 hours')
    `).get() as { cnt: number };
    if (recent.cnt === 0 && stale.cnt > 0) {
      issues++;
      parts.push("no ADS-B positions in last 24h");
    }
  } catch {
    // table may not exist
  }

  // Pipeline freshness
  try {
    const lastRun = db.prepare(`
      SELECT MAX(started_at) as last_run FROM pipeline_runs
    `).get() as { last_run: string | null };
    if (lastRun.last_run) {
      const hoursAgo = (Date.now() - new Date(lastRun.last_run).getTime()) / 3_600_000;
      if (hoursAgo > 25) {
        issues++;
        parts.push(`pipeline last ran ${Math.round(hoursAgo)}h ago`);
      }
    } else {
      issues++;
      parts.push("pipeline has never run");
    }
  } catch {
    // table may not exist
  }

  return {
    name: "stale_data",
    status: issues === 0 ? "pass" : "warn",
    count: issues,
    details: parts.length > 0 ? parts.join("; ") : "all data sources fresh",
  };
}

export function checkAnomalies(db: Database.Database): CheckResult {
  const tooLong = db.prepare(`
    SELECT COUNT(*) as cnt FROM adsb_completed_legs
    WHERE flight_time_min > 1440
  `).get() as { cnt: number };

  const tooFar = db.prepare(`
    SELECT COUNT(*) as cnt FROM adsb_completed_legs
    WHERE distance_nm > 10000
  `).get() as { cnt: number };

  const tooShort = db.prepare(`
    SELECT COUNT(*) as cnt FROM adsb_completed_legs
    WHERE flight_time_min < 1
  `).get() as { cnt: number };

  const total = tooLong.cnt + tooFar.cnt + tooShort.cnt;

  return {
    name: "anomalies",
    status: total === 0 ? "pass" : total < 100 ? "warn" : "fail",
    count: total,
    details: `${tooLong.cnt} flights >24h + ${tooFar.cnt} flights >10,000nm + ${tooShort.cnt} flights <1min`,
  };
}

// ── Full report ─────────────────────────────────────────────────────────────

export function runFullQualityReport(db: Database.Database): QualityReport {
  const checks = [
    checkTailNumbers(db),
    checkIcaoCodes(db),
    checkDuplicateLegs(db),
    checkOrphanedRecords(db),
    checkEmptyFields(db),
    checkStaleData(db),
    checkAnomalies(db),
  ];

  const totalIssues = checks.reduce((sum, c) => sum + c.count, 0);
  const hasFail = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");
  const overall: "green" | "yellow" | "red" = hasFail ? "red" : hasWarn ? "yellow" : "green";

  const report: QualityReport = {
    runAt: new Date().toISOString(),
    checks,
    overall,
    totalIssues,
  };

  // Persist to database
  db.prepare(`
    INSERT INTO data_quality_runs
    (malformed_tails, invalid_icao, duplicate_legs, orphaned_records,
     empty_fields, stale_data, anomalies, overall_status, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checks[0]!.count, checks[1]!.count, checks[2]!.count, checks[3]!.count,
    checks[4]!.count, checks[5]!.count, checks[6]!.count,
    overall,
    JSON.stringify(checks),
  );

  return report;
}

// Agent-side read path lives in src/analytics/quality-queries.ts (see file-level
// comment there). `data-quality.ts` stays compute-only so it can migrate
// cleanly to osa-data-platform at Phase 3 split time.

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const db = getDb();
  const t0 = Date.now();

  console.log("[quality] Running data quality checks...\n");

  const report = runFullQualityReport(db);

  // Print results
  const statusIcon = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  for (const check of report.checks) {
    const icon = statusIcon[check.status];
    console.log(`  [${icon}] ${check.name}: ${check.details}`);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[quality] Overall: ${report.overall.toUpperCase()} (${report.totalIssues} issues) — ${elapsed}s`);

  closeDb();
}

const isDirectRun = process.argv[1]?.includes("data-quality");
if (isDirectRun) {
  main().catch((err) => {
    log.fatal({ err }, "quality check fatal error");
    process.exit(1);
  });
}
