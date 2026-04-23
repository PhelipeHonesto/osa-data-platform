/**
 * Cross-validation — Phase 2 Deliverable 4.
 *
 * Compares our daily position archive to adsb.lol's published daily tar.
 * Writes a row to validation_reports with aircraft overlap + position
 * density metrics.
 *
 * Inputs (S3):
 *   osa tar:     s3://osa-dumont-backup/raw/adsb-osa/YYYY/MM/YYYY-MM-DD/prod-0.tar
 *   adsb.lol:    s3://osa-dumont-backup/raw/adsb/YYYY/MM/YYYY-MM-DD/prod-0.tar
 *                (or prod-0.tar.aa/.ab — concatenated locally before reading)
 *
 * Usage:
 *   npx tsx src/ingestion/cross-validate.ts --date 2026-04-16
 *   npx tsx src/ingestion/cross-validate.ts --date yesterday
 *   npx tsx src/ingestion/cross-validate.ts --date 2026-04-10 --dry-run
 *   npx tsx src/ingestion/cross-validate.ts \
 *     --osa-tar-local /tmp/ours.tar --adsblol-tar-local /tmp/theirs.tar --date 2026-04-16 --dry-run
 */

import { mkdirSync, readFileSync, rmSync, statSync, createWriteStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import pg from "pg";
import { createStandaloneClient } from "../db/pg-database.js";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as tar from "tar";
import { childLogger } from "../utils/logger.js";

const log = childLogger("cross-validate");

// ── Constants ──────────────────────────────────────────────────────────────

const S3_BUCKET = "osa-dumont-backup";
const OSA_PREFIX = "raw/adsb-osa";
const ADSBLOL_PREFIX = "raw/adsb";
const TMP_ROOT = "/tmp";
const SAMPLE_SIZE = 20;
const MAX_RSS_MB = parseInt(process.env["MAX_VALIDATE_RSS_MB"] ?? "300", 10);

// ── Env load ───────────────────────────────────────────────────────────────

try {
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
  date?: string;
  dryRun: boolean;
  osaTarLocal?: string;
  adsblolTarLocal?: string;
  keepTemp: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const flag = (n: string) => argv.includes(n);
  const val = (n: string) => {
    const i = argv.indexOf(n);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const args: Args = {
    date: val("--date"),
    dryRun: flag("--dry-run"),
    osaTarLocal: val("--osa-tar-local"),
    adsblolTarLocal: val("--adsblol-tar-local"),
    keepTemp: flag("--keep-temp"),
  };
  if (!args.date) {
    console.error("Usage: --date YYYY-MM-DD | --date yesterday");
    process.exit(1);
  }
  return args;
}

function resolveDate(d: string): string {
  if (d === "yesterday") {
    const x = new Date();
    x.setUTCDate(x.getUTCDate() - 1);
    return x.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`invalid --date: ${d}`);
  return d;
}

// ── Memory + phase logging ─────────────────────────────────────────────────

function logMemory(ctx: { phase?: string; note?: string } = {}): void {
  const m = process.memoryUsage();
  const rssMB = Math.round(m.rss / 1024 / 1024);
  const heapMB = Math.round(m.heapUsed / 1024 / 1024);
  const parts: string[] = [];
  if (ctx.phase) parts.push(`phase=${ctx.phase}`);
  if (ctx.note) parts.push(ctx.note);
  parts.push(`rss=${rssMB}MB`, `heap=${heapMB}MB`);
  console.log(`[validate] ${parts.join(" ")}`);
  if (rssMB > MAX_RSS_MB) {
    throw new Error(`validator memory ceiling exceeded: rss=${rssMB}MB > limit=${MAX_RSS_MB}MB`);
  }
}

function startPhase(name: string): { name: string; start: number } {
  logMemory({ phase: `${name}:start` });
  return { name, start: Date.now() };
}

function endPhase(p: { name: string; start: number }, stats: Record<string, number | string> = {}): void {
  const duration = ((Date.now() - p.start) / 1000).toFixed(1);
  const statStr = Object.entries(stats).map(([k, v]) => `${k}=${typeof v === "number" ? v.toLocaleString() : v}`).join(" ");
  const m = process.memoryUsage();
  console.log(`[validate] phase=${p.name} duration=${duration}s rss=${Math.round(m.rss / 1024 / 1024)}MB ${statStr}`);
  if (m.rss / 1024 / 1024 > MAX_RSS_MB) {
    throw new Error(`validator memory ceiling exceeded at end of ${p.name}`);
  }
}

// ── Postgres ───────────────────────────────────────────────────────────────

async function connectPg(): Promise<pg.Client> {
  const c = createStandaloneClient();
  await c.connect();
  return c;
}

async function ensureReportTable(c: pg.Client): Promise<void> {
  await c.query(`
    CREATE TABLE IF NOT EXISTS validation_reports (
      date TEXT PRIMARY KEY,
      validated_at TIMESTAMPTZ DEFAULT NOW(),
      status TEXT NOT NULL,
      osa_aircraft INTEGER,
      adsblol_aircraft INTEGER,
      aircraft_in_both INTEGER,
      aircraft_only_osa INTEGER,
      aircraft_only_adsblol INTEGER,
      osa_positions INTEGER,
      adsblol_positions INTEGER,
      avg_positions_per_aircraft_osa REAL,
      avg_positions_per_aircraft_adsblol REAL,
      aircraft_overlap_pct REAL,
      position_density_ratio REAL,
      sample_missing_hex_osa JSONB,
      sample_missing_hex_adsblol JSONB,
      sample_hex_both JSONB,
      osa_tar_s3_key TEXT,
      adsblol_tar_s3_key TEXT,
      error_message TEXT
    )
  `);
}

// ── S3 → local ─────────────────────────────────────────────────────────────

async function downloadKey(s3: S3Client, key: string, localPath: string): Promise<number> {
  const r = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  if (!r.Body) throw new Error(`empty body for ${key}`);
  await pipeline(r.Body as Readable, createWriteStream(localPath));
  return statSync(localPath).size;
}

async function listTarsUnderPrefix(s3: S3Client, prefix: string): Promise<string[]> {
  const r = await s3.send(new ListObjectsV2Command({
    Bucket: S3_BUCKET,
    Prefix: prefix,
  }));
  return (r.Contents ?? [])
    .map((o) => o.Key ?? "")
    .filter((k) => /\.tar(\.[a-z]+)?$/.test(k))
    .sort();
}

/** Downloads a single `.tar` or concatenates split parts, returning local path.
 *  Returns null if no tar was found under the prefix. */
async function fetchTarOrNull(
  s3: S3Client,
  prefix: string,
  workDir: string,
  outName: string,
): Promise<{ localPath: string; s3Key: string } | null> {
  const keys = await listTarsUnderPrefix(s3, prefix);
  if (keys.length === 0) return null;

  const outPath = path.join(workDir, outName);
  if (keys.length === 1) {
    const size = await downloadKey(s3, keys[0]!, outPath);
    console.log(`[validate] downloaded ${keys[0]} (${(size / 1024 ** 2).toFixed(1)} MB) → ${outName}`);
    return { localPath: outPath, s3Key: keys[0]! };
  }

  // Split: download each, then cat
  const partPaths: string[] = [];
  for (const k of keys) {
    const partPath = path.join(workDir, `${outName}.${path.basename(k)}`);
    const size = await downloadKey(s3, k, partPath);
    console.log(`[validate] downloaded ${k} (${(size / 1024 ** 2).toFixed(1)} MB) part`);
    partPaths.push(partPath);
  }
  execSync(`cat ${partPaths.map((p) => JSON.stringify(p)).join(" ")} > ${JSON.stringify(outPath)}`);
  for (const p of partPaths) rmSync(p, { force: true });
  console.log(`[validate] concatenated ${keys.length} parts → ${outName} (${(statSync(outPath).size / 1024 ** 2).toFixed(1)} MB)`);
  return { localPath: outPath, s3Key: keys.join("+") };
}

// ── Aircraft index extraction ──────────────────────────────────────────────

const TRACE_FILE_RE = /trace_full_(~?[0-9a-f]{6,7})\.json\.gz$/i;

async function extractAircraftIndex(tarPath: string): Promise<Map<string, number>> {
  const index = new Map<string, number>();
  const seenIcaos = new Set<string>();
  let skipped = 0;

  await tar.list({
    file: tarPath,
    onentry: (entry) => {
      const m = TRACE_FILE_RE.exec(entry.path);
      if (!m || entry.type !== "File") {
        skipped++;
        entry.resume();
        return;
      }
      seenIcaos.add(m[1]!.toLowerCase());
      const icao = m[1]!.toLowerCase();
      const chunks: Buffer[] = [];
      entry.on("data", (c: Buffer) => chunks.push(c));
      entry.on("end", () => {
        if (index.has(icao)) return; // node-tar can fire 'end' twice; don't double-parse
        try {
          const gz = Buffer.concat(chunks);
          const json = gunzipSync(gz).toString("utf-8");
          const doc = JSON.parse(json) as { trace?: unknown[] };
          const traceLen = Array.isArray(doc.trace) ? doc.trace.length : 0;
          index.set(icao, traceLen);
          if (index.size % 10_000 === 0) logMemory({ note: `extracted ${index.size.toLocaleString()} aircraft` });
        } catch {
          // Leave out of index; summary will show the delta.
        }
      });
    },
  });

  const failed = seenIcaos.size - index.size;
  console.log(`[validate] index: ${index.size.toLocaleString()} aircraft parsed, ${skipped} non-trace entries skipped, ${failed} failed`);
  return index;
}

// ── Comparison ─────────────────────────────────────────────────────────────

interface Metrics {
  osa_aircraft: number;
  adsblol_aircraft: number;
  aircraft_in_both: number;
  aircraft_only_osa: number;
  aircraft_only_adsblol: number;
  osa_positions: number;
  adsblol_positions: number;
  avg_positions_per_aircraft_osa: number;
  avg_positions_per_aircraft_adsblol: number;
  aircraft_overlap_pct: number;
  position_density_ratio: number;
  sample_missing_hex_osa: string[];       // in adsblol, not in osa
  sample_missing_hex_adsblol: string[];   // in osa, not in adsblol
  sample_hex_both: string[];
}

function compare(osa: Map<string, number>, adsblol: Map<string, number>): Metrics {
  const osaKeys = new Set(osa.keys());
  const adsblolKeys = new Set(adsblol.keys());
  const inBoth: string[] = [];
  const onlyOsa: string[] = [];
  const onlyAdsblol: string[] = [];
  for (const k of osaKeys) (adsblolKeys.has(k) ? inBoth : onlyOsa).push(k);
  for (const k of adsblolKeys) if (!osaKeys.has(k)) onlyAdsblol.push(k);

  const osaPositions = [...osa.values()].reduce((s, n) => s + n, 0);
  const adsblolPositions = [...adsblol.values()].reduce((s, n) => s + n, 0);

  const maxAircraft = Math.max(osaKeys.size, adsblolKeys.size, 1);
  const overlap = inBoth.length / maxAircraft;
  const density = adsblolPositions > 0 ? osaPositions / adsblolPositions : 0;

  return {
    osa_aircraft: osaKeys.size,
    adsblol_aircraft: adsblolKeys.size,
    aircraft_in_both: inBoth.length,
    aircraft_only_osa: onlyOsa.length,
    aircraft_only_adsblol: onlyAdsblol.length,
    osa_positions: osaPositions,
    adsblol_positions: adsblolPositions,
    avg_positions_per_aircraft_osa: osaKeys.size ? osaPositions / osaKeys.size : 0,
    avg_positions_per_aircraft_adsblol: adsblolKeys.size ? adsblolPositions / adsblolKeys.size : 0,
    aircraft_overlap_pct: overlap,
    position_density_ratio: density,
    sample_missing_hex_osa: onlyAdsblol.slice(0, SAMPLE_SIZE),
    sample_missing_hex_adsblol: onlyOsa.slice(0, SAMPLE_SIZE),
    sample_hex_both: inBoth.slice(0, SAMPLE_SIZE),
  };
}

// ── Upsert ─────────────────────────────────────────────────────────────────

async function upsertReport(
  c: pg.Client,
  date: string,
  status: "complete" | "failed" | "missing_source",
  metrics: Partial<Metrics> = {},
  osaKey: string | null,
  adsblolKey: string | null,
  errorMessage: string | null,
): Promise<void> {
  await c.query(`
    INSERT INTO validation_reports (
      date, validated_at, status,
      osa_aircraft, adsblol_aircraft, aircraft_in_both,
      aircraft_only_osa, aircraft_only_adsblol,
      osa_positions, adsblol_positions,
      avg_positions_per_aircraft_osa, avg_positions_per_aircraft_adsblol,
      aircraft_overlap_pct, position_density_ratio,
      sample_missing_hex_osa, sample_missing_hex_adsblol, sample_hex_both,
      osa_tar_s3_key, adsblol_tar_s3_key, error_message
    ) VALUES (
      $1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14::jsonb, $15::jsonb, $16::jsonb, $17, $18, $19
    )
    ON CONFLICT (date) DO UPDATE SET
      validated_at = NOW(),
      status = EXCLUDED.status,
      osa_aircraft = EXCLUDED.osa_aircraft,
      adsblol_aircraft = EXCLUDED.adsblol_aircraft,
      aircraft_in_both = EXCLUDED.aircraft_in_both,
      aircraft_only_osa = EXCLUDED.aircraft_only_osa,
      aircraft_only_adsblol = EXCLUDED.aircraft_only_adsblol,
      osa_positions = EXCLUDED.osa_positions,
      adsblol_positions = EXCLUDED.adsblol_positions,
      avg_positions_per_aircraft_osa = EXCLUDED.avg_positions_per_aircraft_osa,
      avg_positions_per_aircraft_adsblol = EXCLUDED.avg_positions_per_aircraft_adsblol,
      aircraft_overlap_pct = EXCLUDED.aircraft_overlap_pct,
      position_density_ratio = EXCLUDED.position_density_ratio,
      sample_missing_hex_osa = EXCLUDED.sample_missing_hex_osa,
      sample_missing_hex_adsblol = EXCLUDED.sample_missing_hex_adsblol,
      sample_hex_both = EXCLUDED.sample_hex_both,
      osa_tar_s3_key = EXCLUDED.osa_tar_s3_key,
      adsblol_tar_s3_key = EXCLUDED.adsblol_tar_s3_key,
      error_message = EXCLUDED.error_message
  `, [
    date, status,
    metrics.osa_aircraft ?? null, metrics.adsblol_aircraft ?? null, metrics.aircraft_in_both ?? null,
    metrics.aircraft_only_osa ?? null, metrics.aircraft_only_adsblol ?? null,
    metrics.osa_positions ?? null, metrics.adsblol_positions ?? null,
    metrics.avg_positions_per_aircraft_osa ?? null, metrics.avg_positions_per_aircraft_adsblol ?? null,
    metrics.aircraft_overlap_pct ?? null, metrics.position_density_ratio ?? null,
    JSON.stringify(metrics.sample_missing_hex_osa ?? []),
    JSON.stringify(metrics.sample_missing_hex_adsblol ?? []),
    JSON.stringify(metrics.sample_hex_both ?? []),
    osaKey, adsblolKey, errorMessage,
  ]);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const date = resolveDate(args.date!);
  const [y, m] = date.split("-");

  const workDir = path.join(TMP_ROOT, `validate-${date}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });

  console.log(`[validate] date=${date} dry_run=${args.dryRun} local_override=${Boolean(args.osaTarLocal || args.adsblolTarLocal)}`);
  console.log(`[validate] work dir: ${workDir}`);
  console.log(`[validate] memory ceiling: ${MAX_RSS_MB} MB rss`);
  logMemory({ phase: "startup" });

  const pgClient = args.dryRun ? null : await connectPg();
  if (pgClient) await ensureReportTable(pgClient);

  let osaKey: string | null = null;
  let adsblolKey: string | null = null;

  try {
    // ── Fetch both tars ──
    const p1 = startPhase("fetch_tars");
    const s3 = new S3Client({});

    let osaTarPath: string | null = null;
    let adsblolTarPath: string | null = null;

    if (args.osaTarLocal) {
      osaTarPath = args.osaTarLocal;
      osaKey = `local:${args.osaTarLocal}`;
      console.log(`[validate] using local OSA tar: ${osaTarPath}`);
    } else {
      const osaResult = await fetchTarOrNull(
        s3, `${OSA_PREFIX}/${y}/${m}/${date}/`, workDir, "osa.tar",
      );
      if (osaResult) { osaTarPath = osaResult.localPath; osaKey = osaResult.s3Key; }
    }

    if (args.adsblolTarLocal) {
      adsblolTarPath = args.adsblolTarLocal;
      adsblolKey = `local:${args.adsblolTarLocal}`;
      console.log(`[validate] using local adsb.lol tar: ${adsblolTarPath}`);
    } else {
      const adsblolResult = await fetchTarOrNull(
        s3, `${ADSBLOL_PREFIX}/${y}/${m}/${date}/`, workDir, "adsblol.tar",
      );
      if (adsblolResult) { adsblolTarPath = adsblolResult.localPath; adsblolKey = adsblolResult.s3Key; }
    }
    endPhase(p1, { osa: osaTarPath ? "found" : "missing", adsblol: adsblolTarPath ? "found" : "missing" });

    // ── Missing source handling ──
    if (!osaTarPath || !adsblolTarPath) {
      const missing = !osaTarPath && !adsblolTarPath ? "both"
        : !osaTarPath ? "osa" : "adsblol";
      log.warn({ missing }, "missing source(s) — recording missing_source row and exiting 0");
      if (pgClient) {
        await upsertReport(pgClient, date, "missing_source", {}, osaKey, adsblolKey,
          `missing source tar(s): ${missing}`);
        await pgClient.end();
      }
      if (!args.keepTemp) rmSync(workDir, { recursive: true, force: true });
      process.exit(0);
    }

    // ── Extract indices ──
    const p2 = startPhase("extract_osa");
    const osaIndex = await extractAircraftIndex(osaTarPath);
    endPhase(p2, { aircraft: osaIndex.size });

    const p3 = startPhase("extract_adsblol");
    const adsblolIndex = await extractAircraftIndex(adsblolTarPath);
    endPhase(p3, { aircraft: adsblolIndex.size });

    // ── Compare ──
    const p4 = startPhase("compare");
    const metrics = compare(osaIndex, adsblolIndex);
    endPhase(p4, {
      overlap_pct: (metrics.aircraft_overlap_pct * 100).toFixed(2),
      density_ratio: metrics.position_density_ratio.toFixed(3),
      in_both: metrics.aircraft_in_both,
      only_osa: metrics.aircraft_only_osa,
      only_adsblol: metrics.aircraft_only_adsblol,
    });

    // ── Persist ──
    if (args.dryRun) {
      console.log("[validate] --dry-run: not writing validation_reports");
      console.log("[validate] metrics:", JSON.stringify(metrics, null, 2));
    } else if (pgClient) {
      await upsertReport(pgClient, date, "complete", metrics, osaKey, adsblolKey, null);
      await pgClient.end();
      console.log(`[validate] upserted validation_reports row for ${date}`);
    }

    if (!args.keepTemp) rmSync(workDir, { recursive: true, force: true });
    console.log(`[validate] done.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.error({ err, stack }, "cross-validate failed");
    if (!args.dryRun && pgClient) {
      try {
        await upsertReport(pgClient, date, "failed", {}, osaKey, adsblolKey, msg);
      } catch { /* ignore */ }
      await pgClient.end().catch(() => {});
    }
    log.error({ work_dir: workDir }, "work dir preserved for inspection");
    process.exit(1);
  }
}

main().catch((err) => {
  log.fatal({ err }, "cross-validate fatal error");
  process.exit(1);
});
