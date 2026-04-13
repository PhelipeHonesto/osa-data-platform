/**
 * ADS-B Historical Backfill
 *
 * Downloads daily tars from github.com/adsblol/globe_history_{year} releases,
 * extracts trace files for charter-relevant aircraft (icao_hex in faa_aircraft),
 * runs the existing trace parser, and materializes completed legs.
 *
 * Release format: v{date}-planes-readsb-prod-0 with split tar parts (.tar.aa, .tar.ab)
 * Resume-safe: skips days already marked complete in backfill_progress.
 *
 * Usage: npm run backfill:history -- --from 2026-01-01 --to 2026-04-12
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDb, closeDb } from "../memory/database.js";
import {
  processFile,
  findNearestAirport,
  type IngestStats,
} from "./adsblol-ingest.js";
import { haversine } from "../utils/haversine.js";
import type Database from "better-sqlite3";

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(): { from: string; to: string } {
  const args = process.argv.slice(2);
  let from = "";
  let to = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) from = args[i + 1]!;
    if (args[i] === "--to" && args[i + 1]) to = args[i + 1]!;
  }
  if (!from || !to) {
    console.error("Usage: npm run backfill:history -- --from 2026-01-01 --to 2026-04-12");
    process.exit(1);
  }
  return { from, to };
}

// ── Date range generator ────────────────────────────────────────────────────

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const cur = new Date(start);
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

// ── Build set of charter-relevant ICAO hex codes from faa_aircraft ──────────

function loadCharterHexSet(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT icao_hex FROM faa_aircraft WHERE icao_hex IS NOT NULL")
    .all() as { icao_hex: string }[];
  return new Set(rows.map((r) => r.icao_hex.toLowerCase()));
}

// ── GitHub release discovery ────────────────────────────────────────────────
// Releases are tagged: v{date}-planes-readsb-{server}-0
// Assets are split tars: {tag}.tar.aa, {tag}.tar.ab, ...
// We prefer prod, fall back to staging

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

function discoverRelease(date: string): { tag: string; assets: ReleaseAsset[] } | null {
  const year = date.slice(0, 4);
  const dotDate = date.replaceAll("-", "."); // 2026-04-01 → 2026.04.01

  // Try prod first, then staging
  for (const server of ["prod", "staging"]) {
    const tag = `v${dotDate}-planes-readsb-${server}-0`;
    const apiUrl = `https://api.github.com/repos/adsblol/globe_history_${year}/releases/tags/${tag}`;

    try {
      const output = execSync(
        `curl -fSL -H "Accept: application/vnd.github+json" "${apiUrl}"`,
        { timeout: 30_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );
      const release = JSON.parse(output) as { assets?: ReleaseAsset[] };
      if (release.assets && release.assets.length > 0) {
        return { tag, assets: release.assets };
      }
    } catch {
      // Try next server type
    }
  }

  return null;
}

// ── Download and reassemble split tar ───────────────────────────────────────

function downloadDailyTar(date: string, destDir: string): string {
  const release = discoverRelease(date);
  if (!release) {
    throw new Error(`No release found for ${date}`);
  }

  console.log(`[backfill] Found release: ${release.tag} (${release.assets.length} assets)`);

  // Sort assets to ensure correct concatenation order (aa, ab, ac, ...)
  const tarAssets = release.assets
    .filter((a) => a.name.endsWith(".tar") || a.name.match(/\.tar\.[a-z]+$/))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (tarAssets.length === 0) {
    throw new Error(`No tar assets found in release ${release.tag}`);
  }

  const tarPath = join(destDir, `${date}.tar`);

  if (tarAssets.length === 1 && tarAssets[0]!.name.endsWith(".tar")) {
    // Single tar file — download directly
    console.log(`[backfill] Downloading ${tarAssets[0]!.name}`);
    execSync(
      `curl -fSL --retry 3 --retry-delay 5 -o "${tarPath}" "${tarAssets[0]!.browser_download_url}"`,
      { stdio: "inherit", timeout: 1_800_000 },
    );
  } else {
    // Split tar parts — download each, then concatenate
    const partPaths: string[] = [];
    for (const asset of tarAssets) {
      const partPath = join(destDir, asset.name);
      console.log(`[backfill] Downloading ${asset.name}`);
      execSync(
        `curl -fSL --retry 3 --retry-delay 5 -o "${partPath}" "${asset.browser_download_url}"`,
        { stdio: "inherit", timeout: 1_800_000 },
      );
      partPaths.push(partPath);
    }

    // Concatenate split parts into a single tar
    console.log(`[backfill] Reassembling ${partPaths.length} parts → ${date}.tar`);
    const parts = partPaths.map((p) => `"${p}"`).join(" ");
    execSync(`cat ${parts} > "${tarPath}"`, { timeout: 300_000 });

    // Remove parts to save space
    for (const p of partPaths) {
      rmSync(p, { force: true });
    }
  }

  return tarPath;
}

// ── Extract and filter trace files ──────────────────────────────────────────

function extractTraces(tarPath: string, extractDir: string): void {
  mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xf "${tarPath}" -C "${extractDir}"`, {
    stdio: "inherit",
    timeout: 600_000,
  });
}

function findTraceFiles(extractDir: string, charterHexes: Set<string>): string[] {
  const matched: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const st = statSync(fullPath);
        if (st.isDirectory()) {
          walk(fullPath);
        } else if (entry.startsWith("trace_full_") && entry.endsWith(".json")) {
          // Extract hex from filename: trace_full_AABBCC.json
          const hex = entry.replace("trace_full_", "").replace(".json", "").toLowerCase();
          if (charterHexes.has(hex)) {
            matched.push(fullPath);
          }
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  walk(extractDir);
  return matched;
}

// ── Day-scoped leg materialization ──────────────────────────────────────────

function materializeLegsForDay(
  db: Database.Database,
  processedHexes: Set<string>,
  sinceTimestamp: number,
  untilTimestamp: number,
): { totalLegs: number; charterLegs: number } {
  const insertLeg = db.prepare(`
    INSERT INTO adsb_completed_legs
    (icao_hex, tail_number, operator_name, aircraft_type, aircraft_class,
     origin_icao, destination_icao, departure_time, arrival_time, flight_time_min, distance_nm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalLegs = 0;
  let charterLegs = 0;

  for (const hex of processedHexes) {
    const ac = db
      .prepare(
        `SELECT a.tail_number, a.model as aircraft_type, a.aircraft_class, a.certificate_holder as operator_name
         FROM faa_aircraft a WHERE a.icao_hex = ?`,
      )
      .get(hex) as { tail_number: string | null; aircraft_type: string | null; aircraft_class: string | null; operator_name: string | null } | undefined;

    const positions = db
      .prepare(
        `SELECT latitude, longitude, altitude_ft, on_ground, timestamp
         FROM adsb_positions WHERE icao_hex = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp`,
      )
      .all(hex, sinceTimestamp, untilTimestamp) as {
        latitude: number; longitude: number; altitude_ft: number | null;
        on_ground: number; timestamp: number;
      }[];

    let legStart: { lat: number; lon: number; ts: number } | null = null;
    let wasGround = true;

    for (const pos of positions) {
      const isGround = pos.on_ground === 1;

      if (wasGround && !isGround && !legStart) {
        legStart = { lat: pos.latitude, lon: pos.longitude, ts: pos.timestamp };
      } else if (!wasGround && isGround && legStart) {
        const flightTimeMin = Math.round((pos.timestamp - legStart.ts) / 60);

        if (flightTimeMin >= 5) {
          const distNm = haversine(legStart.lat, legStart.lon, pos.latitude, pos.longitude);
          const originIcao = findNearestAirport(db, legStart.lat, legStart.lon) ?? null;
          const destIcao = findNearestAirport(db, pos.latitude, pos.longitude) ?? null;
          const depTime = new Date(legStart.ts * 1000).toISOString();
          const arrTime = new Date(pos.timestamp * 1000).toISOString();

          insertLeg.run(
            hex, ac?.tail_number ?? null, ac?.operator_name ?? null,
            ac?.aircraft_type ?? null, ac?.aircraft_class ?? null,
            originIcao, destIcao, depTime, arrTime, flightTimeMin, Math.round(distNm),
          );
          totalLegs++;
          if (ac?.aircraft_class) charterLegs++;
        }
        legStart = null;
      }
      wasGround = isGround;
    }
  }

  return { totalLegs, charterLegs };
}

// ── Backfill progress tracking ──────────────────────────────────────────────

function isDayComplete(db: Database.Database, date: string): boolean {
  const row = db
    .prepare("SELECT status FROM backfill_progress WHERE date = ?")
    .get(date) as { status: string } | undefined;
  return row?.status === "complete";
}

function markDay(
  db: Database.Database,
  date: string,
  status: "pending" | "processing" | "complete" | "failed",
  legsFound = 0,
  charterLegs = 0,
  durationSeconds = 0,
): void {
  db.prepare(`
    INSERT INTO backfill_progress (date, status, legs_found, charter_legs, duration_seconds, processed_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(date) DO UPDATE SET
      status = excluded.status,
      legs_found = excluded.legs_found,
      charter_legs = excluded.charter_legs,
      duration_seconds = excluded.duration_seconds,
      processed_at = excluded.processed_at
  `).run(date, status, legsFound, charterLegs, durationSeconds);
}

// ── Process a single day ────────────────────────────────────────────────────

function processDay(
  db: Database.Database,
  date: string,
  charterHexes: Set<string>,
  tmpBase: string,
): void {
  const startTime = Date.now();
  const extractDir = join(tmpBase, date);
  let tarPath = "";

  // Compute day timestamp boundaries for scoping positions
  const dayStartTs = Math.floor(new Date(date + "T00:00:00Z").getTime() / 1000);
  const dayEndTs = dayStartTs + 86400;

  markDay(db, date, "processing");

  try {
    // 1. Download daily tar (handles split parts and reassembly)
    tarPath = downloadDailyTar(date, tmpBase);

    // 2. Extract all trace files
    console.log(`[backfill] ${date}: Extracting tar...`);
    extractTraces(tarPath, extractDir);

    // Delete tar immediately after extraction to save space
    rmSync(tarPath, { force: true });
    tarPath = "";

    // 3. Find charter-relevant trace files
    const traceFiles = findTraceFiles(extractDir, charterHexes);
    console.log(`[backfill] ${date}: Found ${traceFiles.length} charter-relevant trace files`);

    // 4. Process trace files in batches
    const stats: IngestStats = {
      processed: 0,
      skippedNonUS: 0,
      usAircraft: 0,
      positionsIngested: 0,
      positionsRaw: 0,
      classCounts: {},
      unmatchedTypes: new Map<string, number>(),
      errors: 0,
    };

    const processedHexes = new Set<string>();
    const BATCH_SIZE = 100;

    for (let i = 0; i < traceFiles.length; i += BATCH_SIZE) {
      const batch = traceFiles.slice(i, i + BATCH_SIZE);
      const runBatch = db.transaction(() => {
        for (const file of batch) {
          try {
            const fileName = file.split("/").pop()!;
            const hex = fileName.replace("trace_full_", "").replace(".json", "").toLowerCase();
            processedHexes.add(hex);
            processFile(file, db, stats);
          } catch {
            stats.errors++;
          }
          stats.processed++;
        }
      });
      runBatch();

      if ((i + BATCH_SIZE) % 5000 === 0) {
        console.log(`[backfill] ${date}: Progress ${stats.processed}/${traceFiles.length} files`);
      }
    }

    // 5. Delete extracted files before materialization to save space
    rmSync(extractDir, { recursive: true, force: true });

    // 6. Materialize legs from this day's positions (scoped by day timestamp range)
    console.log(`[backfill] ${date}: Materializing legs...`);
    const { totalLegs, charterLegs: charterLegCount } = db.transaction(() =>
      materializeLegsForDay(db, processedHexes, dayStartTs, dayEndTs),
    )();

    // 7. Clean up positions for this day to save disk
    db.prepare("DELETE FROM adsb_positions WHERE timestamp >= ? AND timestamp < ?").run(dayStartTs, dayEndTs);

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    markDay(db, date, "complete", totalLegs, charterLegCount, durationSec);

    console.log(
      `[backfill] ${date}: done | ${totalLegs} legs (${charterLegCount} charter-class) | ` +
      `${stats.usAircraft} aircraft | ${stats.errors} errors | ${durationSec}s`,
    );
  } catch (err) {
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    markDay(db, date, "failed", 0, 0, durationSec);
    console.error(`[backfill] ${date}: FAILED —`, err instanceof Error ? err.message : err);
  } finally {
    // Clean up any remaining temp files
    if (tarPath && existsSync(tarPath)) {
      rmSync(tarPath, { force: true });
    }
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { from, to } = parseArgs();
  const dates = dateRange(from, to);

  console.log(`[backfill] ADS-B historical backfill: ${from} -> ${to} (${dates.length} days)`);

  const db = getDb();

  // Load charter-relevant hex codes
  const charterHexes = loadCharterHexSet(db);
  console.log(`[backfill] Loaded ${charterHexes.size} charter-relevant ICAO hex codes from faa_aircraft`);

  if (charterHexes.size === 0) {
    console.error("[backfill] No aircraft in faa_aircraft — run FAA ingest first");
    closeDb();
    process.exit(1);
  }

  // Temp directory for downloads/extraction
  const tmpBase = join(process.cwd(), "data", "backfill-tmp");
  mkdirSync(tmpBase, { recursive: true });

  let completed = 0;
  let skipped = 0;

  for (const date of dates) {
    if (isDayComplete(db, date)) {
      console.log(`[backfill] ${date}: already complete — skipping`);
      skipped++;
      continue;
    }

    processDay(db, date, charterHexes, tmpBase);
    completed++;
  }

  // Clean up tmp directory
  if (existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }

  // Summary
  const progress = db
    .prepare(
      `SELECT status, COUNT(*) as count, SUM(legs_found) as legs, SUM(charter_legs) as charter
       FROM backfill_progress GROUP BY status`,
    )
    .all() as { status: string; count: number; legs: number; charter: number }[];

  console.log("\n===================================================");
  console.log("ADS-B Historical Backfill Summary");
  console.log("===================================================");
  console.log(`Days processed: ${completed} | Skipped (already complete): ${skipped}`);
  for (const row of progress) {
    console.log(`  ${row.status}: ${row.count} days — ${row.legs ?? 0} legs (${row.charter ?? 0} charter)`);
  }

  closeDb();
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
