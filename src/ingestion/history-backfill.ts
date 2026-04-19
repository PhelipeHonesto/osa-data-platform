/**
 * ADS-B Historical Backfill — Postgres
 *
 * Tars are preferentially read from our S3 archive
 * (s3://osa-dumont-backup/raw/adsb/YYYY/MM/YYYY-MM-DD/). If a day isn't in
 * S3, falls back to downloading from the adsblol/globe_history_{year}
 * GitHub release — unless --s3-only is passed, in which case missing-in-S3
 * days are skipped.
 *
 * For each day: extracts trace files for charter-relevant aircraft (icao_hex
 * in faa_aircraft), parses positions in-memory, detects completed legs, and
 * bulk-inserts them into adsb_completed_legs in Postgres.
 *
 * Does NOT write positions to adsb_positions — that table has a 48h TTL,
 * so historical timestamps would be deleted immediately. For the full
 * per-day-parquet backfill story, see the packager (D2) design notes;
 * a future deliverable will run the packager against a historical tar's
 * positions directly. This version only fills the legs gap.
 *
 * Resume-safe: skips days already marked complete in backfill_progress.
 *
 * Usage:
 *   npm run backfill:history -- --from 2026-01-01 --to 2026-04-12
 *   npm run backfill:history -- --from 2026-01-01 --to 2026-04-12 --s3-only
 */

import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
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

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/adsb";

// ── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs(): { from: string; to: string; s3Only: boolean } {
  const args = process.argv.slice(2);
  let from = "";
  let to = "";
  let s3Only = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) from = args[i + 1]!;
    if (args[i] === "--to" && args[i + 1]) to = args[i + 1]!;
    if (args[i] === "--s3-only") s3Only = true;
  }
  if (!from || !to) {
    console.error("Usage: npm run backfill:history -- --from 2026-01-01 --to 2026-04-12 [--s3-only]");
    process.exit(1);
  }
  return { from, to, s3Only };
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

// ── S3 archive (preferred source) ──────────────────────────────────────────

/** List tar objects under raw/adsb/YYYY/MM/YYYY-MM-DD/ in our S3 archive.
 *  Returns sorted keys so split parts (.tar.aa, .tar.ab) concatenate in order. */
async function checkS3HasTars(
  s3: S3Client,
  date: string,
): Promise<{ exists: boolean; keys: string[] }> {
  const [year, month] = date.split("-") as [string, string];
  const prefix = `${S3_PREFIX}/${year}/${month}/${date}/`;
  try {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
    }));
    const keys = (resp.Contents ?? [])
      .map((o) => o.Key ?? "")
      .filter((k) => /\.tar(\.[a-z]+)?$/.test(k))
      .sort();
    return { exists: keys.length > 0, keys };
  } catch (err) {
    // Permission issue or bucket unavailable — treat as "not in S3" so the
    // GitHub fallback kicks in (or --s3-only cleanly skips the day).
    console.warn(`[backfill] S3 list failed for ${date}: ${(err as Error).message}`);
    return { exists: false, keys: [] };
  }
}

async function downloadS3Key(s3: S3Client, key: string, localPath: string): Promise<void> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  if (!r.Body) throw new Error(`empty body for s3://${S3_BUCKET}/${key}`);
  await pipeline(r.Body as Readable, createWriteStream(localPath));
}

/** Streaming-download one or more tar parts from S3 and concat into a single
 *  `.tar` file in `destDir`. Mirrors the output shape of downloadDailyTar()
 *  so the caller can use the returned path identically. */
async function downloadDailyTarFromS3(
  s3: S3Client,
  date: string,
  s3Keys: string[],
  destDir: string,
): Promise<string> {
  const tarPath = join(destDir, `${date}.tar`);

  if (s3Keys.length === 1 && s3Keys[0]!.endsWith(".tar")) {
    const key = s3Keys[0]!;
    console.log(`[backfill] Downloading s3://${S3_BUCKET}/${key}`);
    await downloadS3Key(s3, key, tarPath);
  } else {
    const partPaths: string[] = [];
    for (const key of s3Keys) {
      const partPath = join(destDir, basename(key));
      console.log(`[backfill] Downloading s3://${S3_BUCKET}/${key}`);
      await downloadS3Key(s3, key, partPath);
      partPaths.push(partPath);
    }
    console.log(`[backfill] Reassembling ${partPaths.length} parts → ${date}.tar`);
    const parts = partPaths.map((p) => `"${p}"`).join(" ");
    execSync(`cat ${parts} > "${tarPath}"`, { timeout: 300_000 });
    for (const p of partPaths) rmSync(p, { force: true });
  }

  return tarPath;
}

// ── GitHub release discovery (fallback) ────────────────────────────────────

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
  s3: S3Client,
  date: string,
  charterHexes: Set<string>,
  airports: Airport[],
  tmpBase: string,
  s3Only: boolean,
): Promise<"processed" | "skipped"> {
  const startTime = Date.now();
  const extractDir = join(tmpBase, date);
  let tarPath = "";

  // 0. Prefer S3; fall back to GitHub unless --s3-only was passed.
  const s3Check = await checkS3HasTars(s3, date);
  if (!s3Check.exists && s3Only) {
    console.log(`[backfill] ${date}: not in S3 and --s3-only set — skipping`);
    return "skipped";
  }

  await markDay(db, date, "processing");

  try {
    // 1. Download daily tar (handles split parts and reassembly)
    if (s3Check.exists) {
      console.log(`[backfill] ${date}: found in S3 (${s3Check.keys.length} object${s3Check.keys.length === 1 ? "" : "s"}), using archive`);
      tarPath = await downloadDailyTarFromS3(s3, date, s3Check.keys, tmpBase);
    } else {
      console.log(`[backfill] ${date}: not in S3, downloading from GitHub`);
      tarPath = downloadDailyTar(date, tmpBase);
    }

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
      processed: 0, skippedNonUS: 0, skippedOversized: 0, usAircraft: 0,
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

    const oversizedSuffix = stats.skippedOversized > 0 ? ` | ${stats.skippedOversized} skipped (size)` : "";
    console.log(
      `[backfill] ${date}: done | ${totalLegs} legs (${charterLegCount} charter) | ` +
      `${stats.usAircraft} aircraft | ${stats.errors} errors${oversizedSuffix} | ${durationSec}s`,
    );
    return "processed";
  } catch (err) {
    const durationSec = Math.round((Date.now() - startTime) / 1000);
    await markDay(db, date, "failed", 0, 0, durationSec);
    console.error(`[backfill] ${date}: FAILED —`, err instanceof Error ? err.message : err);
    return "processed";  // processed-with-failure; still counts as "not-skipped"
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
  const s3 = new S3Client({});

  const { from, to, s3Only } = parseArgs();
  const dates = dateRange(from, to);

  console.log(`[backfill] ADS-B historical backfill: ${from} -> ${to} (${dates.length} days)`);
  console.log(`[backfill] Source: S3 preferred${s3Only ? " (--s3-only: no GitHub fallback)" : ", GitHub fallback"}`);

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
    const outcome = await processDay(db, s3, date, charterHexes, airports, tmpBase, s3Only);
    if (outcome === "skipped") skipped++;
    else completed++;
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
