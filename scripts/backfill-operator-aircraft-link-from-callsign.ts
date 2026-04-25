/**
 * Stage 2c — backfill canonical.operator_aircraft_link from ADS-B callsigns.
 *
 * The trustee-unmask pathway: an aircraft registered to "BANK OF UTAH
 * TRUSTEE" (a bank, not an operator) but squawking EJA790 (NetJets'
 * ICAO designator) is operated by NetJets Aviation. Joining
 * adsb_positions.callsign back to operators.icao_callsign by the
 * 3-letter prefix recovers operator attribution for trustee-held fleets
 * that CP3's certificate_holder pathway leaves as no_match.
 *
 * Idempotent: skips aircraft that already have an open ('operator',
 * valid_to IS NULL) row in operator_aircraft_link, regardless of the
 * existing row's source. Re-runnable as adsb_positions accumulates.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:backfill-callsign-pathway
 *   DATABASE_TYPE=postgres npm run operators:backfill-callsign-pathway -- --commit
 *   DATABASE_TYPE=postgres npm run operators:backfill-callsign-pathway -- --commit --min-positions=3
 *
 * Rollback: schema/rollback/2026-04-24-callsign-pathway-rollback.sql
 *   (filter by evidence->>'backfill_run_id')
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("callsign-pathway-backfill");

// ── Pure helpers (testable) ──────────────────────────────────────────────

export interface Args {
  commit: boolean;
  minPositions: number;
}

export function parseArgs(argv: string[]): Args {
  const minFlag = argv.find((a) => a.startsWith("--min-positions="));
  const minPositions = minFlag ? Number.parseInt(minFlag.split("=")[1] ?? "1", 10) : 1;
  if (!Number.isFinite(minPositions) || minPositions < 1) {
    throw new Error(`invalid --min-positions value: ${minFlag}`);
  }
  return {
    commit: argv.includes("--commit"),
    minPositions,
  };
}

/**
 * Normalize an ADS-B icao_hex to the canonical bare-lowercase form.
 * adsb.lol uses a leading '~' for non-standard Mode S addresses
 * (military, anonymous, FAA-temporary); strip it for the JOIN.
 */
export function normalizeHex(h: string | null | undefined): string | null {
  if (h === null || h === undefined) return null;
  const stripped = h.replace(/^~/, "");
  if (stripped === "") return null;
  return stripped.toLowerCase();
}

/**
 * Extract the 3-letter ICAO airline designator from the start of a
 * callsign. Returns null when the callsign does not begin with exactly
 * three uppercase letters.
 */
export function extractIcao(callsign: string | null | undefined): string | null {
  if (callsign === null || callsign === undefined) return null;
  const match = callsign.match(/^([A-Z]{3})/);
  return match ? match[1]! : null;
}

/**
 * Position-count → confidence ladder. More observations → tighter
 * attribution. Bare 1-2 positions still gets written (this is a
 * 62-second snapshot worth of data; even 1 position is signal) but at
 * lower confidence so downstream consumers can filter.
 */
export function confidenceForPositionCount(n: number): number {
  if (n >= 50) return 0.95;
  if (n >= 10) return 0.85;
  if (n >= 3) return 0.75;
  return 0.6;
}

export interface EvidenceShape {
  callsign_observed: string[];
  position_count: number;
  icao_designator: string;
  backfill_run_id: string;
  first_seen: string;
  last_seen: string;
}

export function buildEvidence(
  callsigns: string[],
  positionCount: number,
  icaoDesignator: string,
  runId: string,
  firstSeen: Date,
  lastSeen: Date,
): EvidenceShape {
  return {
    callsign_observed: callsigns,
    position_count: positionCount,
    icao_designator: icaoDesignator,
    backfill_run_id: runId,
    first_seen: firstSeen.toISOString(),
    last_seen: lastSeen.toISOString(),
  };
}

// ── DB I/O ───────────────────────────────────────────────────────────────

interface Candidate {
  aircraft_id: string;
  operator_id: string;
  canonical_name: string;
  icao_callsign: string;
  normalized_hex: string;
  position_count: number;
  callsigns_observed: string[];
  first_seen: Date;
  last_seen: Date;
}

async function loadCandidates(client: pg.PoolClient, minPositions: number): Promise<Candidate[]> {
  const res = await client.query<{
    aircraft_id: string;
    operator_id: string;
    canonical_name: string;
    icao_callsign: string;
    normalized_hex: string;
    position_count: string;
    callsigns_observed: string[];
    first_seen: Date;
    last_seen: Date;
  }>(
    `WITH position_attributions AS (
       SELECT
         LOWER(REGEXP_REPLACE(p.icao_hex, '^~', '')) AS normalized_hex,
         SUBSTRING(p.callsign FROM '^([A-Z]{3})') AS icao_prefix,
         COUNT(*) AS position_count,
         array_agg(DISTINCT p.callsign ORDER BY p.callsign) AS callsigns_observed,
         MIN(p.created_at) AS first_seen,
         MAX(p.created_at) AS last_seen
       FROM public.adsb_positions p
       WHERE p.callsign IS NOT NULL
         AND p.callsign <> ''
         AND p.callsign ~ '^[A-Z]{3}'
       GROUP BY normalized_hex, icao_prefix
     )
     SELECT
       ca.aircraft_id,
       o.id AS operator_id,
       o.canonical_name,
       o.icao_callsign,
       pa.normalized_hex,
       pa.position_count::TEXT AS position_count,
       pa.callsigns_observed,
       pa.first_seen,
       pa.last_seen
     FROM position_attributions pa
     JOIN public.operators o ON o.icao_callsign = pa.icao_prefix
     JOIN canonical.aircraft ca ON ca.icao_hex = pa.normalized_hex
     WHERE pa.position_count >= $1
       AND NOT EXISTS (
         SELECT 1 FROM canonical.operator_aircraft_link l
         WHERE l.aircraft_id = ca.aircraft_id
           AND l.role = 'operator'
           AND l.valid_to IS NULL
       )
     ORDER BY o.canonical_name, pa.normalized_hex`,
    [minPositions],
  );
  return res.rows.map((r) => ({
    ...r,
    position_count: Number.parseInt(r.position_count, 10),
  }));
}

async function insertLink(
  client: pg.PoolClient,
  cand: Candidate,
  runId: string,
): Promise<string | null> {
  const evidence = buildEvidence(
    cand.callsigns_observed,
    cand.position_count,
    cand.icao_callsign,
    runId,
    cand.first_seen,
    cand.last_seen,
  );
  const confidence = confidenceForPositionCount(cand.position_count);
  const validFrom = new Date(cand.first_seen);
  validFrom.setUTCHours(0, 0, 0, 0);

  const res = await client.query<{ id: string }>(
    `INSERT INTO canonical.operator_aircraft_link
       (operator_id, aircraft_id, role, valid_from, valid_to,
        source, source_timestamp, ingestion_date,
        confidence, match_method, evidence)
     VALUES ($1, $2, 'operator', $3::date, NULL,
             'adsb_callsign', $4, NOW(),
             $5, 'adsb_callsign_prefix', $6::jsonb)
     RETURNING id`,
    [
      cand.operator_id,
      cand.aircraft_id,
      validFrom,
      cand.last_seen,
      confidence,
      JSON.stringify(evidence),
    ],
  );
  return res.rows[0]?.id ?? null;
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

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("requires DATABASE_TYPE=postgres");
  }

  initSentry();
  installProcessHandlers("callsign-pathway-backfill");

  const args = parseArgs(process.argv.slice(2));
  const runId = randomUUID();
  const t0 = Date.now();

  console.log(`[callsign] commit=${args.commit}  min_positions=${args.minPositions}  run_id=${runId}`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    const candidates = await loadCandidates(client, args.minPositions);
    console.log(`[callsign] Candidate attributions: ${candidates.length}`);
    if (candidates.length === 0) {
      console.log(`[callsign] Nothing to write.`);
      await closePg();
      await flushSentry();
      return;
    }

    // Per-operator preview.
    const perOperator = new Map<string, { count: number; tails: string[] }>();
    for (const c of candidates) {
      const key = `${c.canonical_name} (${c.icao_callsign})`;
      const entry = perOperator.get(key) ?? { count: 0, tails: [] };
      entry.count += 1;
      perOperator.set(key, entry);
    }
    console.log(`[callsign] Per-operator attribution count:`);
    for (const [k, v] of [...perOperator.entries()].sort((a, b) => b[1].count - a[1].count)) {
      console.log(`  ${String(v.count).padStart(4)}  ${k}`);
    }

    if (!args.commit) {
      console.log(`[callsign] Top 50 candidates (dry-run preview):`);
      candidates.slice(0, 50).forEach((c, i) => {
        const conf = confidenceForPositionCount(c.position_count);
        console.log(
          `  ${i + 1}. ${c.normalized_hex}  ${c.callsigns_observed[0] ?? "?"}  → ${c.canonical_name}  positions=${c.position_count}  conf=${conf}`,
        );
      });
      console.log(`[callsign] Dry run complete. Pass --commit to write.`);
      await closePg();
      await flushSentry();
      return;
    }

    let written = 0;
    let skipped = 0;
    await client.query("BEGIN");
    try {
      for (const cand of candidates) {
        try {
          const id = await insertLink(client, cand, runId);
          if (id) written += 1;
        } catch (err) {
          // EXCLUDE-constraint conflict (race or pre-filter miss) — log and continue.
          if (err instanceof Error && err.message.includes("operator_aircraft_link_no_overlap")) {
            console.log(`[callsign] EXCLUDE conflict on aircraft_id=${cand.aircraft_id} — skipping`);
            skipped += 1;
            await client.query("ROLLBACK");
            await client.query("BEGIN");
          } else {
            throw err;
          }
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }

    const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[callsign] Wrote ${written} operator_aircraft_link rows  skipped=${skipped}  ${dtSec}s`);
    console.log(`[callsign] backfill_run_id=${runId}`);
    console.log(
      `[callsign] Rollback: psql "$SUPABASE_DATABASE_URL" -v run_id='${runId}' -f schema/rollback/2026-04-24-callsign-pathway-rollback.sql`,
    );
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "callsign-pathway-backfill fatal error");
    process.exit(1);
  });
}
