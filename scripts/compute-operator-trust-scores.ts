/**
 * Batch-compute both trust scores on every operators row:
 *   - data_confidence_score (meta)      via trust-score.ts
 *   - operator_trust_score  (substantive) via operator-trust-score.ts
 *
 * Phase 1 commit 10. One-shot job; re-run any time the inputs change.
 *
 * Per-operator inputs:
 *   sources: array of distinct operator_identities.source values
 *   mostRecentVerifiedAt: max(last_verified_at) across identities
 *   populatedFields / expectedFields: for completeness score
 *   accidentsInLast10y: NTSB accidents on aircraft linked to the operator
 *                        (via faa_aircraft.certificate_number → FAA identity
 *                        → operator). Phase-1 limitation: only FAA-linked
 *                        aircraft counted; non-US and synthetic-cert operators
 *                        get 0 accidents regardless of reality. Documented.
 *   firstSeenAt: operators.first_seen_at
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:trust-scores              # dry run
 *   DATABASE_TYPE=postgres npm run operators:trust-scores -- --commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { computeDataConfidenceScore } from "../src/entity-resolution/trust-score.js";
import {
  computeOperatorTrustScore,
  operatorTrustBreakdown,
} from "../src/entity-resolution/operator-trust-score.js";
import type { Source } from "../src/entity-resolution/operator-field-priority.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("operators-trust-scores");

const ACCIDENT_WINDOW_CUTOFF_ISO = "2016-04-19"; // 10 years before today for v0.

// ── Types ────────────────────────────────────────────────────────────────

interface OperatorRow {
  id: string;
  canonical_name: string;
  first_seen_at: string;
}

interface IdentitySummary {
  operator_id: string;
  sources: Source[];
  most_recent_verified_at: Date | null;
  populated_count: number; // # of canonical fields populated (name, hq_icao, type_tags non-empty)
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { commit: boolean } {
  return { commit: argv.includes("--commit") };
}

/**
 * Count how many of the 3 canonical fields an operators row populates:
 *   canonical_name (always populated), headquarters_icao, type_tags (non-empty).
 * Returns 0..3. first_seen_at is structural, not a data field for this purpose.
 */
export function countPopulatedFields(row: {
  canonical_name: string | null;
  headquarters_icao: string | null;
  type_tags: string[];
}): number {
  let n = 0;
  if (row.canonical_name && row.canonical_name.trim().length > 0) n++;
  if (row.headquarters_icao) n++;
  if (row.type_tags && row.type_tags.length > 0) n++;
  return n;
}

export const EXPECTED_FIELDS_PER_OPERATOR = 3;

// ── DB queries ───────────────────────────────────────────────────────────

async function loadOperators(client: pg.PoolClient): Promise<Array<OperatorRow & { headquarters_icao: string | null; type_tags: string[] }>> {
  const res = await client.query<OperatorRow & { headquarters_icao: string | null; type_tags: string[] }>(
    `SELECT id, canonical_name, first_seen_at::text, headquarters_icao, type_tags
       FROM operators
       ORDER BY canonical_name`,
  );
  return res.rows;
}

async function loadIdentitySummaries(
  client: pg.PoolClient,
  operatorIds: ReadonlyArray<string>,
): Promise<Map<string, IdentitySummary>> {
  if (operatorIds.length === 0) return new Map();
  const res = await client.query<{
    operator_id: string;
    sources: string[];
    most_recent_verified_at: string | null;
  }>(
    `SELECT operator_id,
            ARRAY_AGG(DISTINCT source ORDER BY source) AS sources,
            MAX(last_verified_at)::text AS most_recent_verified_at
       FROM operator_identities
      WHERE operator_id = ANY($1::UUID[])
      GROUP BY operator_id`,
    [[...operatorIds]],
  );
  const out = new Map<string, IdentitySummary>();
  for (const r of res.rows) {
    out.set(r.operator_id, {
      operator_id: r.operator_id,
      sources: r.sources as Source[],
      most_recent_verified_at: r.most_recent_verified_at ? new Date(r.most_recent_verified_at) : null,
      populated_count: 0, // filled in from operators row below
    });
  }
  return out;
}

/**
 * Per-operator accident count in the 10-year window. Joins:
 *   ntsb_accidents.registration_number → faa_aircraft.tail_number
 *   → faa_aircraft.certificate_number → operator_identities.source_id
 *     where source='faa' → operator_id.
 *
 * Returns a Map<operator_id, count>. Operators with no FAA identity or no
 * linked aircraft get 0 (their accidentsInLast10y input is 0 →
 * accident_history_score = 1.0). Documented limitation — non-US operators
 * and synthetic-cert operators read as "no accidents" regardless of reality.
 */
async function loadAccidentCounts(
  client: pg.PoolClient,
  operatorIds: ReadonlyArray<string>,
): Promise<Map<string, number>> {
  if (operatorIds.length === 0) return new Map();
  const res = await client.query<{ operator_id: string; cnt: string }>(
    `SELECT oi.operator_id,
            COUNT(*)::TEXT AS cnt
       FROM ntsb_accidents na
       JOIN faa_aircraft fa ON fa.tail_number = na.registration_number
       JOIN operator_identities oi ON oi.source = 'faa' AND oi.source_id = fa.certificate_number
      WHERE oi.operator_id = ANY($1::UUID[])
        AND na.event_date >= $2
      GROUP BY oi.operator_id`,
    [[...operatorIds], ACCIDENT_WINDOW_CUTOFF_ISO],
  );
  const out = new Map<string, number>();
  for (const r of res.rows) out.set(r.operator_id, Number(r.cnt));
  return out;
}

// ── Env load ─────────────────────────────────────────────────────────────

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
    /* .env not found */
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:trust-scores requires DATABASE_TYPE=postgres");
  }
  const { commit } = parseArgs(process.argv.slice(2));
  const now = new Date();

  const pool = getPool();
  const client = await pool.connect();
  try {
    console.log("[trust-scores] Loading operators...");
    const operators = await loadOperators(client);
    console.log(`[trust-scores] ${operators.length} operators`);

    const ids = operators.map((o) => o.id);
    const [identityMap, accidentMap] = await Promise.all([
      loadIdentitySummaries(client, ids),
      loadAccidentCounts(client, ids),
    ]);

    const updates: Array<{
      id: string;
      name: string;
      data_confidence: number;
      operator_trust: number;
      breakdown: ReturnType<typeof operatorTrustBreakdown>;
    }> = [];

    for (const op of operators) {
      const idSum = identityMap.get(op.id) ?? { sources: [], most_recent_verified_at: null, populated_count: 0, operator_id: op.id };
      const populated = countPopulatedFields(op);

      const dataConfidence = computeDataConfidenceScore({
        sources: idSum.sources,
        mostRecentVerifiedAt: idSum.most_recent_verified_at,
        now,
        populatedFields: populated,
        expectedFields: EXPECTED_FIELDS_PER_OPERATOR,
      });
      const accidentsInLast10y = accidentMap.get(op.id) ?? 0;
      const breakdown = operatorTrustBreakdown({
        sources: idSum.sources,
        accidentsInLast10y,
        firstSeenAt: new Date(op.first_seen_at),
        now,
      });
      const operatorTrust = computeOperatorTrustScore({
        sources: idSum.sources,
        accidentsInLast10y,
        firstSeenAt: new Date(op.first_seen_at),
        now,
      });

      updates.push({
        id: op.id,
        name: op.canonical_name,
        data_confidence: dataConfidence,
        operator_trust: operatorTrust,
        breakdown,
      });
    }

    // Report preview
    console.log(`\n[trust-scores] Preview — top 10 by operator_trust_score:`);
    const top = [...updates].sort((a, b) => b.operator_trust - a.operator_trust).slice(0, 10);
    for (const u of top) {
      console.log(
        `  ${u.operator_trust.toFixed(2)}  ${u.name.padEnd(32)}  data_conf=${u.data_confidence.toFixed(2)}  (safety=${u.breakdown.safetyRating.toFixed(2)}, accidents=${u.breakdown.accidentHistory.toFixed(2)}, sources=${u.breakdown.sourceCount.toFixed(2)}, stability=${u.breakdown.identityStability.toFixed(2)})`,
      );
    }

    const histogram: Record<string, number> = { "0.0-0.2": 0, "0.2-0.4": 0, "0.4-0.6": 0, "0.6-0.8": 0, "0.8-1.0": 0 };
    for (const u of updates) {
      const bucket =
        u.operator_trust < 0.2 ? "0.0-0.2" :
        u.operator_trust < 0.4 ? "0.2-0.4" :
        u.operator_trust < 0.6 ? "0.4-0.6" :
        u.operator_trust < 0.8 ? "0.6-0.8" :
        "0.8-1.0";
      histogram[bucket]!++;
    }
    console.log(`\n[trust-scores] operator_trust_score distribution:`);
    for (const [bucket, count] of Object.entries(histogram)) {
      console.log(`  ${bucket}: ${count}`);
    }

    if (!commit) {
      console.log(`\n[trust-scores] Dry run complete. Use --commit to write.`);
      return;
    }

    console.log(`\n[trust-scores] Writing ${updates.length} rows (batched)...`);
    await client.query("BEGIN");
    try {
      for (const u of updates) {
        await client.query(
          `UPDATE operators
              SET data_confidence_score = $1,
                  operator_trust_score = $2,
                  last_updated_at = NOW()
            WHERE id = $3`,
          [u.data_confidence, u.operator_trust, u.id],
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
    console.log(`[trust-scores] Done.`);
  } finally {
    client.release();
    await closePg();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "trust-scores fatal error");
    process.exit(1);
  });
}
