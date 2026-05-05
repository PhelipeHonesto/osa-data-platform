/**
 * Track 6 Step 2d (Session A.1) — backfill canonical.operator_aircraft_link
 * role='operator' by joining canonical.aircraft_on_certificate ×
 * canonical.operator_holds_certificate on cert_id.
 *
 * Per Invariant 7 (docs/invariants-2026-05-04.md): aircraft_on_certificate
 * encodes "this aircraft is authorized on this cert"; operator_aircraft_link
 * role='operator' encodes "this operator currently flies this aircraft." The
 * bridge between them is who holds the cert.
 *
 * Per row written to operator_aircraft_link:
 *   role        = 'operator'
 *   source      = 'faa_d085_via_cert_bridge'
 *   confidence  = LEAST(ohc.confidence, aoc.confidence)
 *   valid_from  = GREATEST(ohc.valid_from, aoc.valid_from)
 *   valid_to    = LEAST(ohc.valid_to, aoc.valid_to)  (NULL if both NULL)
 *
 * Pre-flight: refused-if-populated guard. If any operator_aircraft_link row
 * with source='faa_d085_via_cert_bridge' exists, exit cleanly. Manual rollback
 * required to re-run.
 *
 * Per-row pipeline (per Invariant 2 — EXCLUDE constraints, no ON CONFLICT):
 *   1. NOT EXISTS pre-filter against open/overlapping (aircraft_id, role='operator')
 *      rows in operator_aircraft_link → if hit, log cert_bridge_skipped_already_linked
 *      and skip.
 *   2. BEGIN transaction.
 *   3. INSERT into operator_aircraft_link.
 *      On EXCLUDE violation (Postgres SQLSTATE 23P01) → ROLLBACK + log
 *      cert_bridge_skipped_overlap. Per Invariant 10 (Stage 2c v2 not
 *      implemented), do NOT corroborate — first writer wins.
 *      On success → COMMIT + log cert_bridge_linked.
 *
 * Audit log writes go to canonical.operator_aircraft_resolution_log with
 * resolver_action drawn from the cert_bridge_* enum (added by migration
 * 2026-05-04-003).
 *
 * Per Invariant 6: this writer produces role='operator' only — never the
 * other six aircraft roles.
 *
 * Default --dry-run. --write commits.
 *
 * Usage:
 *   npx tsx scripts/backfill-operator-aircraft-link-from-cert-bridge.ts          # dry-run
 *   npx tsx scripts/backfill-operator-aircraft-link-from-cert-bridge.ts --write  # commit
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE = "faa_d085_via_cert_bridge";
const MATCH_METHOD = "cert_bridge_join";
const ROLE = "operator";
const CHECKPOINT = "track6_step2d_cert_bridge";

const PG_EXCLUSION_VIOLATION = "23P01";

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
}

interface CandidateRow {
  ohc_id: string;
  operator_id: string;
  ohc_confidence: string;
  ohc_source_url: string | null;
  ohc_valid_from: string;
  ohc_valid_to: string | null;
  aoc_id: string;
  aircraft_id: string;
  aoc_confidence: string;
  aoc_source_url: string | null;
  aoc_valid_from: string;
  aoc_valid_to: string | null;
  cert_id: string;
  valid_from: string;
  valid_to: string | null;
  confidence: string;
}

type Outcome = "linked" | "skipped_already_linked" | "skipped_overlap";

interface OutcomeBuckets {
  linked: number;
  skipped_already_linked: number;
  skipped_overlap: number;
}

interface RunSummary {
  candidate_rows: number;
  unique_aircraft: number;
  unique_operators: number;
  unique_certs: number;
  outcomes: OutcomeBuckets;
  confidence_histogram: Record<string, number>; // bucket → count
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  return { write: argv.includes("--write") };
}

// ── SQL ───────────────────────────────────────────────────────────────────

const CANDIDATES_SQL = `
SELECT
  ohc.id              AS ohc_id,
  ohc.operator_id     AS operator_id,
  ohc.confidence::text AS ohc_confidence,
  ohc.source_url      AS ohc_source_url,
  ohc.valid_from::text AS ohc_valid_from,
  ohc.valid_to::text  AS ohc_valid_to,
  aoc.id              AS aoc_id,
  aoc.aircraft_id     AS aircraft_id,
  aoc.confidence::text AS aoc_confidence,
  aoc.source_url      AS aoc_source_url,
  aoc.valid_from::text AS aoc_valid_from,
  aoc.valid_to::text  AS aoc_valid_to,
  ohc.cert_id         AS cert_id,
  GREATEST(ohc.valid_from, aoc.valid_from)::text AS valid_from,
  CASE
    WHEN ohc.valid_to IS NULL AND aoc.valid_to IS NULL THEN NULL
    WHEN ohc.valid_to IS NULL THEN aoc.valid_to::text
    WHEN aoc.valid_to IS NULL THEN ohc.valid_to::text
    ELSE LEAST(ohc.valid_to, aoc.valid_to)::text
  END                 AS valid_to,
  LEAST(ohc.confidence, aoc.confidence)::text AS confidence
FROM canonical.aircraft_on_certificate aoc
JOIN canonical.operator_holds_certificate ohc
  ON ohc.cert_id = aoc.cert_id
 AND daterange(ohc.valid_from, ohc.valid_to, '[)')
     && daterange(aoc.valid_from, aoc.valid_to, '[)')
WHERE aoc.source = 'faa_d085'
  AND ohc.source = 'faa_d085'
ORDER BY aoc.aircraft_id, valid_from
`;

const REFUSED_IF_POPULATED_SQL = `
SELECT
  (SELECT COUNT(*) FROM canonical.operator_aircraft_link  WHERE source = $1)::int AS link_rows,
  (SELECT COUNT(*) FROM canonical.operator_aircraft_resolution_log WHERE backfill_run_id LIKE $2)::int AS log_rows
`;

const NOT_EXISTS_OVERLAP_SQL = `
SELECT 1
FROM canonical.operator_aircraft_link
WHERE aircraft_id = $1
  AND role        = 'operator'
  AND daterange(valid_from, valid_to, '[)') && daterange($2::date, $3::date, '[)')
LIMIT 1
`;

const INSERT_LINK_SQL = `
INSERT INTO canonical.operator_aircraft_link
  (operator_id, aircraft_id, role, valid_from, valid_to,
   source, source_url, confidence, match_method, evidence)
VALUES
  ($1, $2, $3, $4::date, $5::date, $6, $7, $8::numeric, $9, $10::jsonb)
RETURNING id
`;

const INSERT_AUDIT_SQL = `
INSERT INTO canonical.operator_aircraft_resolution_log
  (aircraft_id, resolver_action, operator_id, signals, backfill_run_id)
VALUES
  ($1, $2, $3, $4::jsonb, $5)
`;

// ── Helpers ───────────────────────────────────────────────────────────────

function makeRunId(): string {
  return CHECKPOINT + "_" + new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
}

/**
 * Per-attempt audit-log key. The schema enforces UNIQUE (aircraft_id, backfill_run_id)
 * via index ux_oarl_aircraft_run, designed for Step 2c's "one resolution per
 * aircraft per run" model. Cert-bridge produces multiple (ohc, aoc) attempts
 * per aircraft (temporal windows, multiple cert assignments), so we encode
 * uniqueness into the run id itself.
 *
 * Format: <base>_<ohc_id[0:8]>_<aoc_id[0:8]>
 *
 * The base run id is recoverable via prefix matching:
 *   WHERE backfill_run_id LIKE '<base>%'
 *
 * The full per-attempt id maps back to the (ohc, aoc) pair so the signals
 * JSONB is sufficient to reconstruct any individual attempt.
 */
function attemptRunId(baseRunId: string, ohcId: string, aocId: string): string {
  return `${baseRunId}_${ohcId.slice(0, 8)}_${aocId.slice(0, 8)}`;
}

function buildEvidence(row: CandidateRow, runId: string): Record<string, unknown> {
  return {
    checkpoint: CHECKPOINT,
    ingest_run_id: runId,
    cert_id: row.cert_id,
    ohc_id: row.ohc_id,
    ohc_source_url: row.ohc_source_url,
    ohc_valid_from: row.ohc_valid_from,
    ohc_valid_to: row.ohc_valid_to,
    aoc_id: row.aoc_id,
    aoc_source_url: row.aoc_source_url,
    aoc_valid_from: row.aoc_valid_from,
    aoc_valid_to: row.aoc_valid_to,
    derived_valid_from: row.valid_from,
    derived_valid_to: row.valid_to,
    derived_confidence: row.confidence,
  };
}

function buildAuditSignals(
  row: CandidateRow,
  outcome: Outcome,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    cert_id: row.cert_id,
    ohc_id: row.ohc_id,
    aoc_id: row.aoc_id,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    confidence: row.confidence,
    outcome,
    ...(extra ?? {}),
  };
}

function confidenceBucket(c: string): string {
  const v = Number(c);
  if (Number.isNaN(v)) return "unknown";
  if (v >= 0.95) return "0.95+";
  if (v >= 0.85) return "[0.85,0.95)";
  if (v >= 0.75) return "[0.75,0.85)";
  if (v >= 0.5) return "[0.5,0.75)";
  return "<0.5";
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  const runId = makeRunId();
  console.log(`[cert-bridge] Mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[cert-bridge] Run id: ${runId}`);

  // ── Refused-if-populated guard ─────────────────────────────────────────

  const guardResult = await pool.query<{ link_rows: number; log_rows: number }>(
    REFUSED_IF_POPULATED_SQL,
    [SOURCE, CHECKPOINT + "%"],
  );
  const guard = guardResult.rows[0]!;
  if (guard.link_rows > 0 || guard.log_rows > 0) {
    console.error(
      `[cert-bridge] Refused: ` +
        `operator_aircraft_link source='${SOURCE}' has ${guard.link_rows} rows; ` +
        `operator_aircraft_resolution_log backfill_run_id LIKE '${CHECKPOINT}%' has ${guard.log_rows} rows. ` +
        `Manual rollback required to re-run.`,
    );
    await pool.end();
    process.exit(1);
  }
  console.log(`[cert-bridge] Refused-if-populated guard: clean (link_rows=0, log_rows=0).`);

  // ── Pull candidates ────────────────────────────────────────────────────

  const candidates = await pool.query<CandidateRow>(CANDIDATES_SQL);
  const summary: RunSummary = {
    candidate_rows: candidates.rows.length,
    unique_aircraft: new Set(candidates.rows.map((r) => r.aircraft_id)).size,
    unique_operators: new Set(candidates.rows.map((r) => r.operator_id)).size,
    unique_certs: new Set(candidates.rows.map((r) => r.cert_id)).size,
    outcomes: { linked: 0, skipped_already_linked: 0, skipped_overlap: 0 },
    confidence_histogram: {},
  };
  console.log(`[cert-bridge] Candidate rows: ${summary.candidate_rows}`);
  console.log(`  unique aircraft: ${summary.unique_aircraft}`);
  console.log(`  unique operators: ${summary.unique_operators}`);
  console.log(`  unique certs: ${summary.unique_certs}`);

  if (summary.candidate_rows === 0) {
    console.log("[cert-bridge] Nothing to do.");
    await pool.end();
    return;
  }

  // ── Per-row processing ─────────────────────────────────────────────────

  let processed = 0;
  for (const row of candidates.rows) {
    processed++;
    if (processed % 500 === 0) {
      console.log(`[cert-bridge] ... ${processed}/${summary.candidate_rows}`);
    }

    summary.confidence_histogram[confidenceBucket(row.confidence)] =
      (summary.confidence_histogram[confidenceBucket(row.confidence)] ?? 0) + 1;

    // ── NOT EXISTS pre-filter (read-only) ────────────────────────────────
    const perAttemptRunId = attemptRunId(runId, row.ohc_id, row.aoc_id);

    const existing = await pool.query(NOT_EXISTS_OVERLAP_SQL, [
      row.aircraft_id,
      row.valid_from,
      row.valid_to,
    ]);
    if ((existing.rowCount ?? 0) > 0) {
      summary.outcomes.skipped_already_linked++;
      if (args.write) {
        await pool.query(INSERT_AUDIT_SQL, [
          row.aircraft_id,
          "cert_bridge_skipped_already_linked",
          row.operator_id,
          JSON.stringify(buildAuditSignals(row, "skipped_already_linked")),
          perAttemptRunId,
        ]);
      }
      continue;
    }

    // ── DRY-RUN: report the planned action and continue ──────────────────
    if (!args.write) {
      summary.outcomes.linked++; // optimistic: would-link unless blocked
      continue;
    }

    // ── WRITE: per-row transaction ──────────────────────────────────────
    const client = await pool.connect();
    let txStarted = false;
    try {
      await client.query("BEGIN");
      txStarted = true;

      const insertResult = await client.query<{ id: string }>(INSERT_LINK_SQL, [
        row.operator_id,
        row.aircraft_id,
        ROLE,
        row.valid_from,
        row.valid_to,
        SOURCE,
        row.ohc_source_url ?? row.aoc_source_url,
        row.confidence,
        MATCH_METHOD,
        JSON.stringify(buildEvidence(row, runId)),
      ]);
      await client.query(INSERT_AUDIT_SQL, [
        row.aircraft_id,
        "cert_bridge_linked",
        row.operator_id,
        JSON.stringify(
          buildAuditSignals(row, "linked", { link_id: insertResult.rows[0]?.id }),
        ),
        perAttemptRunId,
      ]);

      await client.query("COMMIT");
      txStarted = false;
      summary.outcomes.linked++;
    } catch (err) {
      if (txStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Swallow — best effort. The connection may already be aborted.
        }
      }
      const code = (err as { code?: string }).code;
      if (code === PG_EXCLUSION_VIOLATION) {
        summary.outcomes.skipped_overlap++;
        // log the skip in its own (separate) tx so the audit lineage survives
        await pool.query(INSERT_AUDIT_SQL, [
          row.aircraft_id,
          "cert_bridge_skipped_overlap",
          row.operator_id,
          JSON.stringify(
            buildAuditSignals(row, "skipped_overlap", {
              error_code: code,
              error_message: (err as Error).message,
            }),
          ),
          perAttemptRunId,
        ]);
      } else {
        console.error(
          `[cert-bridge] FATAL on aircraft_id=${row.aircraft_id} operator_id=${row.operator_id}: ${(err as Error).message}`,
        );
        throw err; // finally releases client; outer catch exits the process
      }
    } finally {
      client.release();
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\n[cert-bridge] Final summary (${args.write ? "WRITE" : "DRY-RUN"}):`);
  console.log(`  candidate rows:                  ${summary.candidate_rows}`);
  console.log(`  unique aircraft:                 ${summary.unique_aircraft}`);
  console.log(`  unique operators:                ${summary.unique_operators}`);
  console.log(`  unique certs:                    ${summary.unique_certs}`);
  console.log(`  outcomes:`);
  console.log(`    cert_bridge_linked:                ${summary.outcomes.linked}`);
  console.log(`    cert_bridge_skipped_already_linked: ${summary.outcomes.skipped_already_linked}`);
  console.log(`    cert_bridge_skipped_overlap:       ${summary.outcomes.skipped_overlap}`);
  console.log(`  confidence histogram:`);
  for (const [bucket, count] of Object.entries(summary.confidence_histogram).sort()) {
    console.log(`    ${bucket}: ${count}`);
  }

  if (!args.write) {
    console.log(`\n[cert-bridge] DRY-RUN — no rows were inserted.`);
    console.log(`[cert-bridge] linked count above is optimistic ('would-link if EXCLUDE doesn't fire').`);
    console.log(`[cert-bridge] Re-run with --write to commit. Audit log will record cert_bridge_skipped_overlap`);
    console.log(`[cert-bridge] for any race-condition collision the dry-run pre-filter missed.`);
  } else {
    const writeVerify = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM canonical.operator_aircraft_link WHERE source = $1`,
      [SOURCE],
    );
    const auditVerify = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM canonical.operator_aircraft_resolution_log WHERE backfill_run_id LIKE $1`,
      [runId + "%"],
    );
    console.log(
      `\n[cert-bridge] Verify after WRITE:`,
      `\n  operator_aircraft_link source='${SOURCE}': ${writeVerify.rows[0]!.count} rows`,
      `\n  operator_aircraft_resolution_log backfill_run_id LIKE '${runId}%': ${auditVerify.rows[0]!.count} rows`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[cert-bridge] FATAL:", err);
  process.exit(1);
});
