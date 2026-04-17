/**
 * Nightly position packager — Phase 2 Deliverable 2.
 *
 * Reads a UTC day's adsb_positions from Postgres and produces three S3 outputs:
 *   s3://osa-dumont-backup/raw/adsb-osa/YYYY/MM/YYYY-MM-DD/
 *     - positions.parquet   (column-oriented, for DuckDB cold queries)
 *     - prod-0.tar          (adsb.lol-format per-aircraft gzipped traces, for peer parity)
 *     - manifest.json       (same schema family as archive-adsb-raw manifests)
 *
 * Writes an audit row to osa_position_archive (one row per UTC day).
 *
 * Usage:
 *   npx tsx src/ingestion/package-positions.ts --date 2026-04-16
 *   npx tsx src/ingestion/package-positions.ts --date yesterday
 *   npx tsx src/ingestion/package-positions.ts --test-window 10m         # /tmp only
 *   npx tsx src/ingestion/package-positions.ts --test-window 1h --upload # override
 *   npx tsx src/ingestion/package-positions.ts --date 2026-04-16 --no-upload
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { S3Client, PutObjectCommand, type StorageClass } from "@aws-sdk/client-s3";
import parquet from "@dsnp/parquetjs";

const { ParquetSchema, ParquetWriter } = parquet;

// ── Constants ──────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const S3_PREFIX = "raw/adsb-osa";
const TAR_SPLIT_BYTES = 2 * 1024 ** 3;   // adsb.lol splits at 2GB into .tar.aa/.ab
const TMP_ROOT = "/tmp";

// ── Env load (same pattern as wingx-engine.ts for CLI usage) ───────────────

try {
  const { readFileSync } = await import("node:fs");
  const envContent = readFileSync(path.resolve(process.cwd(), ".env"), "utf-8");
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

// ── CLI ────────────────────────────────────────────────────────────────────

interface Args {
  date?: string;                     // YYYY-MM-DD or "yesterday"
  testWindow?: string;               // e.g. "10m", "1h", "30s"
  upload: boolean;
  keepTemp: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const val = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const args: Args = {
    date: val("--date"),
    testWindow: val("--test-window"),
    upload: !flag("--no-upload"),
    keepTemp: flag("--keep-temp"),
  };
  if (args.testWindow && !flag("--upload")) args.upload = false; // test runs default to no-upload
  if (!args.date && !args.testWindow) {
    console.error("Usage: --date YYYY-MM-DD | --date yesterday | --test-window <duration>");
    process.exit(1);
  }
  return args;
}

function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s);
  if (!m) throw new Error(`invalid --test-window: ${s} (expected like 10m, 1h, 30s)`);
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!;
  return unit === "s" ? n : unit === "m" ? n * 60 : n * 3600;
}

function resolveWindow(args: Args): { startEpoch: number; endEpoch: number; label: string; utcDate: string | null } {
  if (args.testWindow) {
    const secs = parseDuration(args.testWindow);
    const end = Math.floor(Date.now() / 1000);
    const start = end - secs;
    return { startEpoch: start, endEpoch: end, label: `last ${args.testWindow}`, utcDate: null };
  }
  let d = args.date!;
  if (d === "yesterday") {
    const x = new Date();
    x.setUTCDate(x.getUTCDate() - 1);
    d = x.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`invalid --date: ${d}`);
  const startEpoch = Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);
  const endEpoch = startEpoch + 86_400;
  return { startEpoch, endEpoch, label: d, utcDate: d };
}

// ── Parquet schema ─────────────────────────────────────────────────────────
// Mirrors adsb_positions columns (minus serial id + created_at audit fields).

const parquetSchema = new ParquetSchema({
  icao_hex:          { type: "UTF8" },
  tail_number:       { type: "UTF8",   optional: true },
  callsign:          { type: "UTF8",   optional: true },
  latitude:          { type: "DOUBLE" },
  longitude:         { type: "DOUBLE" },
  altitude_ft:       { type: "DOUBLE", optional: true },
  ground_speed_kts:  { type: "DOUBLE", optional: true },
  heading:           { type: "DOUBLE", optional: true },
  vertical_rate:     { type: "DOUBLE", optional: true },
  on_ground:         { type: "BOOLEAN" },
  nearest_airport:   { type: "UTF8",   optional: true },
  timestamp:         { type: "INT64" },
});

// ── Types ──────────────────────────────────────────────────────────────────

interface PositionRow {
  icao_hex: string;
  tail_number: string | null;
  callsign: string | null;
  latitude: number;
  longitude: number;
  altitude_ft: number | null;
  ground_speed_kts: number | null;
  heading: number | null;
  vertical_rate: number | null;
  on_ground: boolean;
  nearest_airport: string | null;
  timestamp: number;
}

interface FaaMeta {
  tail: string | null;
  type: string | null;      // ICAO aircraft type code (model)
  desc: string | null;      // description
  ownOp: string | null;     // operator / certificate holder
}

// ── Postgres ───────────────────────────────────────────────────────────────

async function connectPg(): Promise<pg.Client> {
  const url = process.env["SUPABASE_DATABASE_URL"];
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

async function ensureArchiveTable(pg: pg.Client): Promise<void> {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS osa_position_archive (
      date TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      rows INTEGER,
      distinct_aircraft INTEGER,
      compressed_bytes BIGINT,
      positions_sha256 TEXT,
      tar_sha256 TEXT,
      s3_parquet_key TEXT,
      s3_tar_key TEXT,
      s3_manifest_key TEXT,
      packaged_at TIMESTAMPTZ DEFAULT NOW(),
      error_message TEXT
    )
  `);
}

async function loadFaaMeta(pg: pg.Client): Promise<Map<string, FaaMeta>> {
  const r = await pg.query(`
    SELECT icao_hex, tail_number, model, certificate_holder
    FROM faa_aircraft WHERE icao_hex IS NOT NULL
  `);
  const map = new Map<string, FaaMeta>();
  for (const row of r.rows) {
    map.set(String(row.icao_hex).toLowerCase(), {
      tail: row.tail_number ?? null,
      type: row.model ?? null,
      desc: row.model ?? null,
      ownOp: row.certificate_holder ?? null,
    });
  }
  return map;
}

async function fetchPositions(
  pg: pg.Client,
  startEpoch: number,
  endEpoch: number,
): Promise<PositionRow[]> {
  const r = await pg.query(`
    SELECT icao_hex, tail_number, callsign, latitude, longitude,
           altitude_ft, ground_speed_kts, heading, vertical_rate,
           on_ground, nearest_airport, timestamp
    FROM adsb_positions
    WHERE timestamp >= $1 AND timestamp < $2
    ORDER BY icao_hex, timestamp
  `, [startEpoch, endEpoch]);
  return r.rows as PositionRow[];
}

// ── Parquet writer ─────────────────────────────────────────────────────────

async function writeParquet(rows: PositionRow[], outPath: string): Promise<void> {
  const writer = await ParquetWriter.openFile(parquetSchema, outPath);
  for (const r of rows) {
    await writer.appendRow({
      icao_hex: r.icao_hex,
      tail_number: r.tail_number ?? undefined,
      callsign: r.callsign ?? undefined,
      latitude: r.latitude,
      longitude: r.longitude,
      altitude_ft: r.altitude_ft ?? undefined,
      ground_speed_kts: r.ground_speed_kts ?? undefined,
      heading: r.heading ?? undefined,
      vertical_rate: r.vertical_rate ?? undefined,
      on_ground: r.on_ground,
      nearest_airport: r.nearest_airport ?? undefined,
      timestamp: r.timestamp,
    });
  }
  await writer.close();
}

// ── Tar builder (adsb.lol trace format) ────────────────────────────────────

function buildTraces(rows: PositionRow[], faa: Map<string, FaaMeta>, tracesDir: string): number {
  // Group positions by icao_hex. Input is already sorted by (icao_hex, timestamp).
  mkdirSync(tracesDir, { recursive: true });

  let currentIcao: string | null = null;
  let bucket: PositionRow[] = [];
  let aircraftCount = 0;

  const flush = () => {
    if (!currentIcao || bucket.length === 0) return;
    const icao = currentIcao.toLowerCase();
    const prefix = icao.slice(0, 2);
    const dir = path.join(tracesDir, prefix);
    mkdirSync(dir, { recursive: true });

    const base = bucket[0]!.timestamp;
    const meta = faa.get(icao);
    const trace = bucket.map((p) => [
      p.timestamp - base,                        // seconds offset
      p.latitude,
      p.longitude,
      p.on_ground ? "ground" : (p.altitude_ft ?? null),   // alt_baro
      p.ground_speed_kts ?? null,                // gs
      p.heading ?? null,                         // track
      p.on_ground ? 1 : 0,                       // flags (bit 0 = on_ground)
      p.altitude_ft ?? null,                     // alt_geom (we don't have separate; reuse)
      null,                                      // ias
      null,                                      // roll
      p.vertical_rate ?? null,                   // baro_rate
      null,                                      // details
    ]);

    const doc = {
      icao,
      r: meta?.tail ?? bucket[0]!.tail_number ?? null,
      t: meta?.type ?? null,
      desc: meta?.desc ?? null,
      ownOp: meta?.ownOp ?? null,
      timestamp: base,
      trace,
    };

    const gz = gzipSync(Buffer.from(JSON.stringify(doc), "utf-8"));
    writeFileSync(path.join(dir, `trace_full_${icao}.json.gz`), gz);
    aircraftCount++;
  };

  for (const row of rows) {
    const icao = row.icao_hex.toLowerCase();
    if (icao !== currentIcao) {
      flush();
      currentIcao = icao;
      bucket = [];
    }
    bucket.push(row);
  }
  flush();

  return aircraftCount;
}

function tarTraces(workDir: string, outTar: string): { size: number; split: string[] } {
  // `tar -cf out.tar -C workDir traces/` → produces archive with "traces/..." paths
  execSync(`tar -cf ${JSON.stringify(outTar)} -C ${JSON.stringify(workDir)} traces`, { stdio: "pipe" });
  const size = statSync(outTar).size;
  if (size <= TAR_SPLIT_BYTES) return { size, split: [outTar] };

  // > 2GB → split into prod-0.tar.aa / .ab / ... using POSIX split.
  // Both BSD (macOS) and GNU (Linux) split accept -b N and produce <prefix>aa, <prefix>ab, ...
  const prefix = `${outTar}.`;
  execSync(`split -b ${TAR_SPLIT_BYTES} ${JSON.stringify(outTar)} ${JSON.stringify(prefix)}`, { stdio: "pipe" });
  rmSync(outTar);
  const parts = readdirSync(path.dirname(outTar))
    .filter((n) => n.startsWith(path.basename(prefix)))
    .sort()
    .map((n) => path.join(path.dirname(outTar), n));
  return { size, split: parts };
}

// ── Hashing & manifest ─────────────────────────────────────────────────────

function sha256File(p: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(p));
  return h.digest("hex");
}

interface FileEntry {
  name: string;
  s3_key: string;
  size: number;
  sha256: string;
  rows?: number;
  distinct_aircraft?: number;
  time_start?: string;
  time_end?: string;
}

interface Manifest {
  date: string;
  source: string;
  files: FileEntry[];
  total_bytes: number;
  distinct_aircraft: number;
  positions: number;
  time_start: string;
  time_end: string;
  archived_at: string;
}

// ── S3 upload (mirrors archive-adsb-raw.ts pattern) ────────────────────────

async function uploadToS3(
  s3: S3Client,
  localPath: string,
  s3Key: string,
  storageClass: StorageClass = "STANDARD",
): Promise<void> {
  const body = readFileSync(localPath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    Body: body,
    StorageClass: storageClass,
  }));
}

// ── Archive_progress tracking ─────────────────────────────────────────────

async function recordRun(
  pg: pg.Client,
  date: string,
  status: "complete" | "failed",
  stats: Partial<{
    rows: number;
    distinct_aircraft: number;
    compressed_bytes: number;
    positions_sha256: string | null;
    tar_sha256: string | null;
    s3_parquet_key: string | null;
    s3_tar_key: string | null;
    s3_manifest_key: string | null;
    error_message: string | null;
  }> = {},
): Promise<void> {
  await pg.query(`
    INSERT INTO osa_position_archive (
      date, status, rows, distinct_aircraft, compressed_bytes,
      positions_sha256, tar_sha256,
      s3_parquet_key, s3_tar_key, s3_manifest_key,
      packaged_at, error_message
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(), $11)
    ON CONFLICT (date) DO UPDATE SET
      status = EXCLUDED.status,
      rows = EXCLUDED.rows,
      distinct_aircraft = EXCLUDED.distinct_aircraft,
      compressed_bytes = EXCLUDED.compressed_bytes,
      positions_sha256 = EXCLUDED.positions_sha256,
      tar_sha256 = EXCLUDED.tar_sha256,
      s3_parquet_key = EXCLUDED.s3_parquet_key,
      s3_tar_key = EXCLUDED.s3_tar_key,
      s3_manifest_key = EXCLUDED.s3_manifest_key,
      packaged_at = NOW(),
      error_message = EXCLUDED.error_message
  `, [
    date, status, stats.rows ?? null, stats.distinct_aircraft ?? null, stats.compressed_bytes ?? null,
    stats.positions_sha256 ?? null, stats.tar_sha256 ?? null,
    stats.s3_parquet_key ?? null, stats.s3_tar_key ?? null, stats.s3_manifest_key ?? null,
    stats.error_message ?? null,
  ]);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const win = resolveWindow(args);
  const dateLabel = win.utcDate ?? `test-${win.label.replace(/\s+/g, "-")}`;
  const workDir = path.join(TMP_ROOT, `pkg-${dateLabel}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.join(workDir, "traces"), { recursive: true });

  console.log(`[pkg] window: ${win.label} (epoch ${win.startEpoch} → ${win.endEpoch})`);
  console.log(`[pkg] work dir: ${workDir}`);
  console.log(`[pkg] upload: ${args.upload ? "YES → S3" : "NO (local only)"}`);

  const pgClient = await connectPg();
  if (win.utcDate && args.upload) {
    await ensureArchiveTable(pgClient);
    await recordRun(pgClient, win.utcDate, "failed", { error_message: "pending" });
  }

  try {
    const tFetch = Date.now();
    const rows = await fetchPositions(pgClient, win.startEpoch, win.endEpoch);
    console.log(`[pkg] fetched ${rows.length} positions in ${((Date.now() - tFetch) / 1000).toFixed(1)}s`);

    if (rows.length === 0) {
      console.warn(`[pkg] no positions in window — exiting (not a failure; feed may have been down)`);
      if (win.utcDate && args.upload) {
        await recordRun(pgClient, win.utcDate, "complete", { rows: 0, error_message: "no positions in window" });
      }
      await pgClient.end();
      if (!args.keepTemp) rmSync(workDir, { recursive: true, force: true });
      process.exit(0);
    }

    const faa = await loadFaaMeta(pgClient);
    console.log(`[pkg] faa enrichment: ${faa.size} rows`);

    // ── Parquet ──
    const parquetPath = path.join(workDir, "positions.parquet");
    const tParquet = Date.now();
    await writeParquet(rows, parquetPath);
    const parquetSize = statSync(parquetPath).size;
    const parquetSha = sha256File(parquetPath);
    console.log(`[pkg] parquet: ${(parquetSize / 1024 ** 2).toFixed(1)} MB, sha256 ${parquetSha.slice(0, 16)}…, ${((Date.now() - tParquet) / 1000).toFixed(1)}s`);

    // ── Tar (adsb.lol format) ──
    const tTar = Date.now();
    const aircraftCount = buildTraces(rows, faa, path.join(workDir, "traces"));
    const tarPath = path.join(workDir, "prod-0.tar");
    const { size: tarSize, split: tarParts } = tarTraces(workDir, tarPath);
    const tarSha = tarParts.length === 1 ? sha256File(tarParts[0]!) : null;  // split: hash each part separately below
    console.log(`[pkg] tar: ${(tarSize / 1024 ** 2).toFixed(1)} MB across ${tarParts.length} file(s), ${aircraftCount} aircraft, ${((Date.now() - tTar) / 1000).toFixed(1)}s`);

    // ── Manifest ──
    const yearMonth = win.utcDate ? `${win.utcDate.slice(0, 4)}/${win.utcDate.slice(5, 7)}/${win.utcDate}` : `test/${dateLabel}`;
    const s3DayPrefix = `${S3_PREFIX}/${yearMonth}`;
    const files: FileEntry[] = [];
    files.push({
      name: "positions.parquet",
      s3_key: `${s3DayPrefix}/positions.parquet`,
      size: parquetSize,
      sha256: parquetSha,
      rows: rows.length,
      distinct_aircraft: aircraftCount,
    });
    for (const part of tarParts) {
      files.push({
        name: path.basename(part),
        s3_key: `${s3DayPrefix}/${path.basename(part)}`,
        size: statSync(part).size,
        sha256: sha256File(part),
      });
    }
    const manifest: Manifest = {
      date: win.utcDate ?? dateLabel,
      source: "osa-dumont-live-feed",
      files,
      total_bytes: files.reduce((s, f) => s + f.size, 0),
      distinct_aircraft: aircraftCount,
      positions: rows.length,
      time_start: new Date(win.startEpoch * 1000).toISOString(),
      time_end: new Date(win.endEpoch * 1000).toISOString(),
      archived_at: new Date().toISOString(),
    };
    const manifestPath = path.join(workDir, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[pkg] manifest: ${files.length} file entries`);

    // ── Upload ──
    if (args.upload) {
      const s3 = new S3Client({});
      const tUpload = Date.now();
      for (const f of files) {
        await uploadToS3(s3, path.join(workDir, f.name), f.s3_key, "STANDARD");
        console.log(`[pkg] uploaded → s3://${S3_BUCKET}/${f.s3_key} (${(f.size / 1024 ** 2).toFixed(1)} MB)`);
      }
      const manifestKey = `${s3DayPrefix}/manifest.json`;
      await uploadToS3(s3, manifestPath, manifestKey, "STANDARD");
      console.log(`[pkg] uploaded manifest → s3://${S3_BUCKET}/${manifestKey} (${((Date.now() - tUpload) / 1000).toFixed(1)}s total)`);

      if (win.utcDate) {
        await recordRun(pgClient, win.utcDate, "complete", {
          rows: rows.length,
          distinct_aircraft: aircraftCount,
          compressed_bytes: manifest.total_bytes,
          positions_sha256: parquetSha,
          tar_sha256: tarSha,
          s3_parquet_key: files[0]!.s3_key,
          s3_tar_key: tarParts.length === 1 ? files[1]!.s3_key : null,
          s3_manifest_key: manifestKey,
        });
      }
    } else {
      console.log(`[pkg] local outputs:`);
      console.log(`  parquet:  ${parquetPath}`);
      for (const p of tarParts) console.log(`  tar:      ${p}`);
      console.log(`  manifest: ${manifestPath}`);
    }

    await pgClient.end();
    if (!args.keepTemp && args.upload) rmSync(workDir, { recursive: true, force: true });

    console.log(`[pkg] done.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[pkg] FAILED: ${msg}`);
    if (win.utcDate && args.upload) {
      try { await recordRun(pgClient, win.utcDate, "failed", { error_message: msg }); } catch { /* ignore */ }
    }
    await pgClient.end().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[pkg] fatal:", err);
  process.exit(1);
});
