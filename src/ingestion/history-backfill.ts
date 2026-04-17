/**
 * ADS-B Historical Backfill — Postgres
 *
 * Downloads daily tars from github.com/adsblol/globe_history_{year} releases,
 * extracts trace files for charter-relevant aircraft (icao_hex in faa_aircraft),
 * parses positions in-memory, detects completed legs, and bulk-inserts them
 * into adsb_completed_legs in Postgres.
 *
 * Does NOT write positions to adsb_positions — that table has a 48h TTL,
 * so historical timestamps would be deleted immediately. For the full
 * per-day-parquet backfill story, see the packager (D2) design notes;
 * a future deliverable will run the packager against a historical tar's
 * positions directly. This version only fills the legs gap.
 *
 * Release format: v{date}-planes-readsb-prod-0 with split tar parts (.tar.aa, .tar.ab)
 * Resume-safe: skips days already marked complete in backfill_progress.
 *
 * Usage: npm run backfill:history -- --from 2026-01-01 --to 2026-04-12
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg, type DbBridge } from "../memory/pg-database.js";
import {
  parseTraceFile,
  detectLegs,
  bulkInsertLegs,
  bulkUpsertAircraft,
  loadAirports,
  type IngestStats,
  type Airport,
  type ParsedTrace,
  type DetectedLeg,
} from "./adsblol-ingest.js";

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

async function loadCharterHexSet(db: DbBridge): Promise<Set<string>> {
  const rows = await db
    .prepare("SELECT icao_hex FROM faa_aircraft WHERE icao_hex IS NOT NULL")
    .all() as { icao_hex: string }[];
  return new Set(rows.map((r) => r.icao_hex.toLowerCase()));
}

// ── GitHub release discovery ────────────────────────────────────────────────

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

function discoverRelease(date: string): { tag: string; assets: ReleaseAsset[] } | null {
  const year = date.slice(0, 4);
  const dotDate = date.replaceAll("-", ".");

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

  const tarAssets = release.assets
    .filter((a) => a.name.endsWith(".tar") || a.name.match(/\.tar\.[a-z]+$/))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (tarAssets.length === 0) {
    throw new Error(`No tar assets found in release ${release.tag}`);
  }

  const tarPath = join(destDir, `${date}.tar`);

  if (tarAssets.length === 1 && tarAssets[0]!.name.endsWith(".tar")) {
    console.log(`[backfill] Downloading ${tarAssets[0]!.name}`);
    execSync(
      `curl -fSL --retry 3 --retry-delay 5 -o "${tarPath}" "${tarAssets[0]!.browser_download_url}"`,
      { stdio: "inherit", timeout: 1_800_000 },
    );
  } else {
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
    console.log(`[backfill] Reassembling ${partPaths.length} parts → ${date}.tar`);
    const parts = partPaths.map((p) => `"${p}"`).join(" ");
    execSync(`cat ${parts} > "${tarPath}"`, { timeout: 300_000 });
    for (const p of partPaths) rmSync(p, { force: true });
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
        } else if (entry.startsWith("trace_full_") && (entry.endsWith(".json") || entry.endsWith(".json.gz"))) {
          const hex = entry
            .replace("trace_full_", "")
            .replace(".json.gz", "")
            .replace(".json", "")
            .toLowerCase();
          if (charterHexes.has(hex)) matched.push(fullPath);
        }
      } catch {
        // skip unreadable entries
      }
    }
  }

  walk(extractDir);
  return matched;
}

// ── Backfill progress tracking ──────────────────────────────────────────────

async function isDayComplete(db: DbBridge, date: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT status FROM backfill_progress WHERE date = ?")
    .get(date) as { status: string } | undefined;
  return row?.status === "complete";
}

async function markDay(
  db: DbBridge,
  date: string,
  status: "pending" | "processing" | "complete" | "failed",
  legsFound = 0,
  charterLegs = 0,
  durationSeconds = 0,
): Promise<void> {
  await db.prepare(`
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

async function processDay(
  db: DbBridge,
  date: string,
  charterHexes: Set<string>,
  airports: Airport[],
  tmpBase: string,
): Promise<void> {
  const startTime = Date.now();
  const extractDir = join(tmpBase, date);
  let tarPath = "";

  await markDay(db, date, "processing");

  try {
    // 1. Download daily tar (handles split parts and reassembly)
    tarPath = downloadDailyTar(date, tmpBase);

    // 2. Extract
    console.log(`[backfill] ${date}: Extracting tar...`);
    extractTraces(tarPath, extractDir);
    rmSync(tarPath, { force: true });
    tarPath = "";

    // 3. Find charter-relevant trace files
    const traceFiles = findTraceFiles(extractDir, charterHexes);
    console.log(`[backfill] ${date}: ${traceFiles.length} charter-relevant trace files`);

    // 4. Process in chunks: parse → detect legs in memory → bulk write
    const stats: IngestStats = {
      processed: 0, skippedNonUS: 0, usAircraft: 0,
      positionsIngested: 0, positionsRaw: 0,
      classCounts: {},
      unmatchedTypes: new Map<string, number>(),
      errors: 0,
    };

    let totalLegs = 0;
    let charterLegCount = 0;
    const CHUNK = 500;

    for (let i = 0; i < traceFiles.length; i += CHUNK) {
      const chunk = traceFiles.slice(i, i + CHUNK);
      const parsedBatch: ParsedTrace[] = [];
      const legBatch: DetectedLeg[] = [];

      for (const file of chunk) {
        try {
          const p = parseTraceFile(file, stats);
          if (!p) { stats.processed++; continue; }
          parsedBatch.push(p);
          for (const leg of detectLegs(p, airports)) legBatch.push(leg);
        } catch {
          stats.errors++;
        }
        stats.processed++;
      }

      await bulkUpsertAircraft(db, parsedBatch);
      await bulkInsertLegs(db, legBatch);
      totalLegs += legBatch.length;
      charterLegCount += legBatch.filter((l) => l.aircraftClass != null).length;

      if ((i + CHUNK) % 5000 === 0 || i + CHUNK >= traceFiles.length) {
        console.log(
          `[backfill] ${date}: ${stats.processed}/${traceFiles.length} files | ${totalLegs} legs so far`,
        );
      }
    }

    // 5. Clean up extracted files
    rmSync(extractDir, { recursive: true, force: true });

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    await markDay(db, date, "complete", totalLegs, charterLegCount, durationSec);

    console.log(
      `[backfill] ${date}: done | ${totalLegs} legs (${charterLegCount} charter) | ` +
      `${stats.usAircraft} aircraft | ${stats.errors} errors | ${durationSec}s`,
    );
  } catch (err) {
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    await markDay(db, date, "failed", 0, 0, durationSec);
    console.error(`[backfill] ${date}: FAILED —`, err instanceof Error ? err.message : err);
  } finally {
    if (tarPath && existsSync(tarPath)) rmSync(tarPath, { force: true });
    if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "history-backfill requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  const { from, to } = parseArgs();
  const dates = dateRange(from, to);

  console.log(`[backfill] ADS-B historical backfill: ${from} -> ${to} (${dates.length} days)`);

  const charterHexes = await loadCharterHexSet(db);
  console.log(`[backfill] Loaded ${charterHexes.size} charter-relevant ICAO hex codes from faa_aircraft`);

  if (charterHexes.size === 0) {
    console.error("[backfill] No aircraft in faa_aircraft — run FAA ingest first");
    await closePg();
    process.exit(1);
  }

  const airports = await loadAirports(db);
  console.log(`[backfill] Loaded ${airports.length} airports`);

  const tmpBase = join(process.cwd(), "data", "backfill-tmp");
  mkdirSync(tmpBase, { recursive: true });

  let completed = 0;
  let skipped = 0;

  for (const date of dates) {
    if (await isDayComplete(db, date)) {
      console.log(`[backfill] ${date}: already complete — skipping`);
      skipped++;
      continue;
    }
    await processDay(db, date, charterHexes, airports, tmpBase);
    completed++;
  }

  if (existsSync(tmpBase)) rmSync(tmpBase, { recursive: true, force: true });

  // Summary
  const progress = await db
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

  await closePg();
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
