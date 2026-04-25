/**
 * Backfill public.operators.icao_callsign from public.faa_operators.dba_name.
 *
 * For every operator with a faa-source identity whose corresponding
 * faa_operators row has a 3-letter ICAO designator in dba_name, set
 * operators.icao_callsign = that designator. Idempotent via the
 * `icao_callsign IS NULL` guard — re-runs are no-ops on previously-set rows.
 *
 * Re-run this script after each operator merge to populate newly-merged
 * operators' callsigns. The deferred list printed at the end is the
 * input set for future curated operator merges.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:backfill-icao-callsign
 *   DATABASE_TYPE=postgres npm run operators:backfill-icao-callsign -- --commit
 *
 * Companion migration: schema/migrations/2026-04-24-001-operators-icao-callsign.sql
 * Rollback:           schema/rollback/2026-04-24-icao-callsign-rollback.sql
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("icao-callsign-backfill");

const ICAO_CALLSIGN_REGEX = /^[A-Z]{3}$/;

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { commit: boolean } {
  return { commit: argv.includes("--commit") };
}

export function isIcaoCallsign(s: string | null | undefined): boolean {
  if (s === null || s === undefined) return false;
  return ICAO_CALLSIGN_REGEX.test(s);
}

export function decideCallsign(row: { dba_name: string | null }): { callsign: string } | null {
  if (!isIcaoCallsign(row.dba_name)) return null;
  return { callsign: row.dba_name as string };
}

// ── DB I/O ───────────────────────────────────────────────────────────────

interface UpdatedRow {
  id: string;
  canonical_name: string;
  icao_callsign: string;
}

interface DeferredRow {
  certificate_number: string;
  name: string;
  would_be_callsign: string;
  aircraft_count: number | null;
}

async function previewUpdates(client: pg.PoolClient): Promise<UpdatedRow[]> {
  const res = await client.query<UpdatedRow>(
    `SELECT o.id, o.canonical_name, fo.dba_name AS icao_callsign
     FROM public.operators o
     JOIN public.operator_identities oi ON oi.operator_id = o.id
     JOIN public.faa_operators fo
       ON oi.source = 'faa' AND oi.source_id = fo.certificate_number
     WHERE o.icao_callsign IS NULL
       AND fo.dba_name ~ '^[A-Z]{3}$'
     ORDER BY o.canonical_name`,
  );
  return res.rows;
}

async function applyUpdates(client: pg.PoolClient): Promise<UpdatedRow[]> {
  const res = await client.query<UpdatedRow>(
    `UPDATE public.operators o
     SET icao_callsign = fo.dba_name,
         last_updated_at = NOW()
     FROM public.operator_identities oi
     JOIN public.faa_operators fo
       ON oi.source = 'faa' AND oi.source_id = fo.certificate_number
     WHERE oi.operator_id = o.id
       AND o.icao_callsign IS NULL
       AND fo.dba_name ~ '^[A-Z]{3}$'
     RETURNING o.id, o.canonical_name, fo.dba_name AS icao_callsign`,
  );
  return res.rows;
}

async function loadDeferred(client: pg.PoolClient): Promise<DeferredRow[]> {
  const res = await client.query<DeferredRow>(
    `SELECT fo.certificate_number, fo.name,
            fo.dba_name AS would_be_callsign,
            fo.aircraft_count
     FROM public.faa_operators fo
     WHERE fo.dba_name ~ '^[A-Z]{3}$'
       AND NOT EXISTS (
         SELECT 1 FROM public.operator_identities oi
         WHERE oi.source = 'faa' AND oi.source_id = fo.certificate_number
       )
     ORDER BY fo.aircraft_count DESC NULLS LAST, fo.certificate_number`,
  );
  return res.rows.map((r) => ({
    ...r,
    aircraft_count: r.aircraft_count === null ? null : Number(r.aircraft_count),
  }));
}

// ── Env load (matches sibling scripts) ──────────────────────────────────

function loadEnv(): void {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env absent — env may be set directly
  }
}

function printUpdates(rows: UpdatedRow[], header: string): void {
  console.log(`\n[icao-backfill] ${header}: ${rows.length} rows`);
  for (const r of rows) {
    console.log(`  ${r.icao_callsign}  ${r.canonical_name}`);
  }
}

function printDeferred(rows: DeferredRow[]): void {
  console.log(`\n[icao-backfill] Deferred (operator not in canonical yet): ${rows.length} rows`);
  for (const r of rows) {
    const fleet = r.aircraft_count !== null ? `fleet=${r.aircraft_count}` : "fleet=NULL";
    console.log(`  ${r.would_be_callsign}  ${r.name.padEnd(50)}  ${fleet}  cert=${r.certificate_number}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:backfill-icao-callsign requires DATABASE_TYPE=postgres");
  }

  initSentry();
  installProcessHandlers("icao-callsign-backfill");

  const { commit } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  console.log(`[icao-backfill] commit=${commit}`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    if (!commit) {
      const preview = await previewUpdates(client);
      printUpdates(preview, "Would update");
      const deferred = await loadDeferred(client);
      printDeferred(deferred);
      console.log(
        `\n[icao-backfill] Audit arithmetic: ${preview.length} updated + ${deferred.length} deferred = ${preview.length + deferred.length} total 3-letter dba rows`,
      );
      console.log(`[icao-backfill] Dry run complete. Pass --commit to write.`);
      await closePg();
      await flushSentry();
      return;
    }

    await client.query("BEGIN");
    let updated: UpdatedRow[];
    try {
      updated = await applyUpdates(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    printUpdates(updated, "Updated");

    const deferred = await loadDeferred(client);
    printDeferred(deferred);

    const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `\n[icao-backfill] Audit arithmetic: ${updated.length} updated + ${deferred.length} deferred = ${updated.length + deferred.length} total 3-letter dba rows`,
    );
    console.log(`[icao-backfill] Done. ${dtSec}s`);
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "icao-callsign-backfill fatal error");
    process.exit(1);
  });
}
