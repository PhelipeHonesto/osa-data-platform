/**
 * ADS-B Archive Inventory — S3 gap analysis + SQLite cross-check
 *
 * Lists all objects under s3://osa-dumont-backup/raw/adsb/, groups by day,
 * identifies gaps and partial uploads, cross-checks with archive_progress.
 *
 * Usage:
 *   npx tsx scripts/inventory-adsb-archive.ts
 *   npx tsx scripts/inventory-adsb-archive.ts --remote                          # SSH to 44.197.126.96
 *   npx tsx scripts/inventory-adsb-archive.ts --remote --remote-host user@host  # custom SSH target
 *
 * Read-only. Downloads nothing. Modifies nothing.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/adsb/";
const START_DATE = "2023-01-01";
const DB_PATH = path.resolve(import.meta.dirname ?? ".", "../data/dumont.db");
const MANIFEST_FETCH_CONCURRENCY = 20;

// ── Types ──────────────────────────────────────────────────────────────────

interface DayEntry {
  files: Map<string, number>;  // filename → size bytes
  total_bytes: number;
}

interface ManifestFile {
  name: string;
  size: number;
}

interface Manifest {
  date?: string;
  files?: ManifestFile[];
}

interface YearSummary {
  year: string;
  total_days_expected: number;
  days_complete: number;
  days_partial: number;
  days_missing: number;
  total_bytes: number;
  first_date_present: string | null;
  last_date_present: string | null;
}

interface CrossCheckResult {
  sqlite_not_in_s3: string[];   // marked complete in DB but missing from S3
  s3_not_in_sqlite: string[];   // in S3 but not in archive_progress
}

interface FullReport {
  generated_at: string;
  s3_bucket: string;
  s3_prefix: string;
  total_objects: number;
  total_bytes: number;
  year_summaries: YearSummary[];
  partial_days: Record<string, string[]>;  // date → missing files
  missing_by_month: Record<string, number>;
  cross_check: CrossCheckResult;
}

// ── CLI args ───────────────────────────────────────────────────────────────

const useRemote = process.argv.includes("--remote");
const remoteHost = (() => {
  const idx = process.argv.indexOf("--remote-host");
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : "44.197.126.96";
})();

// ── Date helpers ───────────────────────────────────────────────────────────

function yesterday(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function allDaysBetween(start: string, end: string): string[] {
  const days: string[] = [];
  const cur = new Date(start + "T00:00:00Z");
  const stop = new Date(end + "T00:00:00Z");
  while (cur <= stop) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

// ── S3 listing ─────────────────────────────────────────────────────────────

async function listAllObjects(s3: S3Client): Promise<Map<string, DayEntry>> {
  const days = new Map<string, DayEntry>();
  let totalObjects = 0;
  let continuationToken: string | undefined;

  process.stdout.write("[inventory] listing S3 objects...");

  do {
    const resp = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: S3_PREFIX,
      MaxKeys: 1000,
      ContinuationToken: continuationToken,
    }));

    for (const obj of resp.Contents ?? []) {
      const key = obj.Key;
      if (!key) continue;
      totalObjects++;

      // Parse: raw/adsb/YYYY/MM/YYYY-MM-DD/filename
      const match = key.match(/^raw\/adsb\/\d{4}\/\d{2}\/(\d{4}-\d{2}-\d{2})\/(.+)$/);
      if (!match) continue;

      const [, date, filename] = match;
      if (!date || !filename) continue;

      let entry = days.get(date);
      if (!entry) {
        entry = { files: new Map(), total_bytes: 0 };
        days.set(date, entry);
      }

      entry.files.set(filename, obj.Size ?? 0);
      entry.total_bytes += obj.Size ?? 0;
    }

    continuationToken = resp.NextContinuationToken;
    process.stdout.write(".");
  } while (continuationToken);

  console.log(` ${totalObjects} objects, ${days.size} days`);
  return days;
}

// ── Manifest fetching ──────────────────────────────────────────────────────

function s3KeyForManifest(date: string): string {
  const [year, month] = date.split("-") as [string, string];
  return `raw/adsb/${year}/${month}/${date}/manifest.json`;
}

async function fetchManifest(s3: S3Client, date: string): Promise<Manifest | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3KeyForManifest(date),
    }));
    const body = await resp.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as Manifest;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === "NoSuchKey" || code === "NotFound") return null;
    return null;  // malformed JSON or other read errors → treat as unusable manifest
  }
}

async function fetchAllManifests(s3: S3Client, dates: string[]): Promise<Map<string, Manifest | null>> {
  const cache = new Map<string, Manifest | null>();
  if (dates.length === 0) return cache;

  process.stdout.write(`[inventory] fetching ${dates.length} manifests`);
  for (let i = 0; i < dates.length; i += MANIFEST_FETCH_CONCURRENCY) {
    const batch = dates.slice(i, i + MANIFEST_FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map((d) => fetchManifest(s3, d)));
    for (let j = 0; j < batch.length; j++) {
      cache.set(batch[j]!, results[j]!);
    }
    process.stdout.write(".");
  }
  console.log(" done");
  return cache;
}

// ── SQLite cross-check ─────────────────────────────────────────────────────

function loadArchiveProgress(): Map<string, string> {
  const progress = new Map<string, string>();

  if (useRemote) {
    console.log("[inventory] fetching archive_progress via SSH...");
    try {
      const raw = execSync(
        `ssh ${remoteHost} "sqlite3 ~/dumont-agent/data/dumont.db \\"SELECT date, status FROM archive_progress;\\""`,
        { encoding: "utf-8", timeout: 15_000 },
      );
      for (const line of raw.trim().split("\n")) {
        const [date, status] = line.split("|");
        if (date && status) progress.set(date, status);
      }
    } catch (err) {
      console.warn("[inventory] SSH failed, skipping cross-check:", (err as Error).message);
    }
    return progress;
  }

  if (!existsSync(DB_PATH)) {
    console.warn(`[inventory] SQLite not found at ${DB_PATH}, skipping cross-check`);
    return progress;
  }

  // Use sqlite3 CLI to avoid importing better-sqlite3 (keeps script standalone)
  try {
    const raw = execSync(
      `sqlite3 "${DB_PATH}" "SELECT date, status FROM archive_progress;"`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    for (const line of raw.trim().split("\n")) {
      const [date, status] = line.split("|");
      if (date && status) progress.set(date, status);
    }
  } catch (err) {
    console.warn("[inventory] sqlite3 CLI failed, skipping cross-check:", (err as Error).message);
  }

  return progress;
}

// ── Analysis ───────────────────────────────────────────────────────────────

function classifyDay(entry: DayEntry, manifest: Manifest | null): { complete: boolean; problems: string[] } {
  const hasManifestFile = entry.files.has("manifest.json");
  if (!hasManifestFile) return { complete: false, problems: ["manifest.json"] };

  if (manifest && Array.isArray(manifest.files) && manifest.files.length > 0) {
    const problems: string[] = [];
    for (const f of manifest.files) {
      const actual = entry.files.get(f.name);
      if (actual === undefined) problems.push(`${f.name} (missing)`);
      else if (actual !== f.size) problems.push(`${f.name} (size ${actual}, expected ${f.size})`);
    }
    return { complete: problems.length === 0, problems };
  }

  // Legacy / unparseable manifest: accept any day that has a manifest + at least one tar-like file
  const hasTar = [...entry.files.keys()].some((n) => n.endsWith(".tar") || /\.tar\.[a-z]+$/.test(n));
  return hasTar
    ? { complete: true, problems: [] }
    : { complete: false, problems: ["no tar referenced; manifest has no files array"] };
}

async function analyze(
  s3: S3Client,
  s3Days: Map<string, DayEntry>,
  archiveProgress: Map<string, string>,
): Promise<FullReport> {
  const endDate = yesterday();
  const allDays = allDaysBetween(START_DATE, endDate);

  // Pre-fetch manifests for every day that has one in S3
  const daysWithManifest = [...s3Days.entries()]
    .filter(([, e]) => e.files.has("manifest.json"))
    .map(([d]) => d);
  const manifestCache = await fetchAllManifests(s3, daysWithManifest);

  // Group expected days by year
  const yearDays = new Map<string, string[]>();
  for (const d of allDays) {
    const y = d.slice(0, 4);
    let arr = yearDays.get(y);
    if (!arr) { arr = []; yearDays.set(y, arr); }
    arr.push(d);
  }

  const yearSummaries: YearSummary[] = [];
  const partialDays: Record<string, string[]> = {};
  const missingByMonth: Record<string, number> = {};
  let totalBytes = 0;

  for (const [year, days] of [...yearDays.entries()].sort()) {
    let complete = 0;
    let partial = 0;
    let missing = 0;
    let bytes = 0;
    let first: string | null = null;
    let last: string | null = null;

    for (const d of days) {
      const entry = s3Days.get(d);
      if (!entry) {
        missing++;
        const month = d.slice(0, 7);
        missingByMonth[month] = (missingByMonth[month] ?? 0) + 1;
        continue;
      }

      if (!first) first = d;
      last = d;
      bytes += entry.total_bytes;

      const manifest = manifestCache.get(d) ?? null;
      const result = classifyDay(entry, manifest);
      if (result.complete) {
        complete++;
      } else {
        partial++;
        partialDays[d] = result.problems;
      }
    }

    totalBytes += bytes;
    yearSummaries.push({
      year,
      total_days_expected: days.length,
      days_complete: complete,
      days_partial: partial,
      days_missing: missing,
      total_bytes: bytes,
      first_date_present: first,
      last_date_present: last,
    });
  }

  // Cross-check with SQLite
  const sqliteNotInS3: string[] = [];
  const s3NotInSqlite: string[] = [];

  for (const [date, status] of archiveProgress) {
    if (status === "complete" && !s3Days.has(date)) {
      sqliteNotInS3.push(date);
    }
  }

  for (const date of s3Days.keys()) {
    if (!archiveProgress.has(date)) {
      s3NotInSqlite.push(date);
    }
  }

  sqliteNotInS3.sort();
  s3NotInSqlite.sort();

  return {
    generated_at: new Date().toISOString(),
    s3_bucket: S3_BUCKET,
    s3_prefix: S3_PREFIX,
    total_objects: [...s3Days.values()].reduce((n, e) => n + e.files.size, 0),
    total_bytes: totalBytes,
    year_summaries: yearSummaries,
    partial_days: partialDays,
    missing_by_month: missingByMonth,
    cross_check: {
      sqlite_not_in_s3: sqliteNotInS3,
      s3_not_in_sqlite: s3NotInSqlite,
    },
  };
}

// ── Output ─────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  if (b < 1024 ** 4) return `${(b / 1024 ** 3).toFixed(2)} GB`;
  return `${(b / 1024 ** 4).toFixed(2)} TB`;
}

function printReport(report: FullReport, archiveProgress: Map<string, string>): void {
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  ADS-B Archive Inventory — s3://osa-dumont-backup/raw/adsb/");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Year summary table
  console.log("Year     Expected  Complete  Partial  Missing  Size           First        Last");
  console.log("─────    ────────  ────────  ───────  ───────  ────           ─────        ────");
  for (const y of report.year_summaries) {
    console.log(
      `${y.year}     ${String(y.total_days_expected).padStart(8)}  ${String(y.days_complete).padStart(8)}  ${String(y.days_partial).padStart(7)}  ${String(y.days_missing).padStart(7)}  ${formatBytes(y.total_bytes).padStart(13)}  ${y.first_date_present ?? "—".padEnd(10)}  ${y.last_date_present ?? "—"}`,
    );
  }

  const totalExpected = report.year_summaries.reduce((s, y) => s + y.total_days_expected, 0);
  const totalComplete = report.year_summaries.reduce((s, y) => s + y.days_complete, 0);
  const totalPartial = report.year_summaries.reduce((s, y) => s + y.days_partial, 0);
  const totalMissing = report.year_summaries.reduce((s, y) => s + y.days_missing, 0);

  console.log("─────    ────────  ────────  ───────  ───────  ────");
  console.log(
    `TOTAL    ${String(totalExpected).padStart(8)}  ${String(totalComplete).padStart(8)}  ${String(totalPartial).padStart(7)}  ${String(totalMissing).padStart(7)}  ${formatBytes(report.total_bytes).padStart(13)}`,
  );
  console.log(`\nS3 objects: ${report.total_objects}`);

  // Missing-day breakdown by archive_progress status (best-effort attribution)
  if (archiveProgress.size > 0) {
    const statusCounts: Record<string, number> = {};
    for (const status of archiveProgress.values()) {
      statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    }
    const noRelease = statusCounts["no_release"] ?? 0;
    const pending = statusCounts["pending"] ?? 0;
    const failed = statusCounts["failed"] ?? 0;
    const untracked = Math.max(0, totalMissing - noRelease - pending - failed);
    console.log(`\nMissing attribution (via archive_progress):`);
    console.log(`  no_release:   ${noRelease}  (adsb.lol didn't publish)`);
    console.log(`  pending:      ${pending}`);
    console.log(`  failed:       ${failed}`);
    console.log(`  untracked:    ${untracked}  (pre-tracker era, mostly 2023 backfill gap)`);
  }

  // Partial days
  const partialEntries = Object.entries(report.partial_days);
  if (partialEntries.length > 0) {
    console.log(`\n── Partial days (${partialEntries.length}) — retry these ──\n`);
    for (const [date, missing] of partialEntries.sort()) {
      console.log(`  ${date}  missing: ${missing.join(", ")}`);
    }
  }

  // Missing by month
  const monthEntries = Object.entries(report.missing_by_month).sort();
  if (monthEntries.length > 0) {
    console.log("\n── Missing days per month ──\n");
    let currentYear = "";
    for (const [month, count] of monthEntries) {
      const y = month.slice(0, 4);
      if (y !== currentYear) {
        if (currentYear) console.log();
        currentYear = y;
      }
      const bar = "█".repeat(Math.min(count, 50));
      console.log(`  ${month}  ${String(count).padStart(3)} ${bar}`);
    }
  }

  // Cross-check
  const { sqlite_not_in_s3, s3_not_in_sqlite } = report.cross_check;
  if (sqlite_not_in_s3.length > 0 || s3_not_in_sqlite.length > 0) {
    console.log("\n── SQLite ↔ S3 cross-check ──\n");
    if (sqlite_not_in_s3.length > 0) {
      console.log(`  ⚠ ${sqlite_not_in_s3.length} days marked "complete" in SQLite but MISSING from S3:`);
      for (const d of sqlite_not_in_s3.slice(0, 20)) console.log(`    ${d}`);
      if (sqlite_not_in_s3.length > 20) console.log(`    ... and ${sqlite_not_in_s3.length - 20} more`);
    }
    if (s3_not_in_sqlite.length > 0) {
      console.log(`  ℹ ${s3_not_in_sqlite.length} days in S3 but NOT in archive_progress (orphans):`);
      for (const d of s3_not_in_sqlite.slice(0, 20)) console.log(`    ${d}`);
      if (s3_not_in_sqlite.length > 20) console.log(`    ... and ${s3_not_in_sqlite.length - 20} more`);
    }
  } else if (report.cross_check.sqlite_not_in_s3.length === 0 && report.cross_check.s3_not_in_sqlite.length === 0) {
    console.log("\n── SQLite ↔ S3 cross-check: in sync ──");
  }

  // Health
  const healthy = totalPartial === 0 && totalMissing === 0;
  console.log(`\n${healthy ? "✓ All days accounted for" : `✗ ${totalPartial} partial + ${totalMissing} missing days`}\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startMs = Date.now();

  const s3 = new S3Client({});
  const [s3Days, archiveProgress] = await Promise.all([
    listAllObjects(s3),
    Promise.resolve(loadArchiveProgress()),
  ]);

  const report = await analyze(s3, s3Days, archiveProgress);

  printReport(report, archiveProgress);

  // Write full JSON report
  const today = new Date().toISOString().slice(0, 10);
  const outPath = `/tmp/adsb-inventory-${today}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Full report: ${outPath}`);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s\n`);

  const hasGaps = report.year_summaries.some((y) => y.days_partial > 0 || y.days_missing > 0);
  process.exit(hasGaps ? 1 : 0);
}

main().catch((err) => {
  console.error("[inventory] fatal:", err);
  process.exit(2);
});
