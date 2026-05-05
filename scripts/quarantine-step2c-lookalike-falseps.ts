/**
 * Quarantine Step 2c lookalike false positives — A.0.6.
 *
 * Moves 6 confirmed false-positive rows from canonical.operator_holds_certificate
 * to canonical.operator_holds_certificate_pending with reason='lookalike_misresolution'
 * (new enum value, added by migration 2026-05-04-002).
 *
 * The 6 ids are hardcoded — surfaced by the A.0 + A.0.5 audit
 * (.work/llm-er-pass/a0-step2c-lookalike-audit-2026-05-04.md). Hardcoding is
 * intentional: this is a one-time corrective sweep, not a recurring backfill.
 * No risk of accidental over-deletion. To re-run after a future Step 2c re-pass,
 * generate a new script with a new audit doc.
 *
 * Per-row transaction:
 *   1. SELECT the canonical row (FOR UPDATE).
 *   2. INSERT into pending sidecar with original_ohc_id back-pointer + audit metadata.
 *   3. DELETE the canonical row.
 *   4. COMMIT.
 *
 * Refuses to run if any of the 6 ids:
 *   - is missing from canonical.operator_holds_certificate (already deleted somehow);
 *   - has source != 'faa_d085' (wrong row);
 *   - has confidence != 0.95 (wrong tier);
 *   - already has a pending row with original_ohc_id pointing back to it
 *     (already quarantined by a prior run).
 *
 * Default --dry-run. --write commits.
 *
 * Usage:
 *   tsx scripts/quarantine-step2c-lookalike-falseps.ts            # dry-run
 *   tsx scripts/quarantine-step2c-lookalike-falseps.ts --write    # commit
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const AUDIT_RUN_ID = "A.0-2026-05-04";
const AUDIT_DOC = ".work/llm-er-pass/a0-step2c-lookalike-audit-2026-05-04.md";
const REVIEWER = "claude-opus-4-7";
const QUARANTINE_REASON = "lookalike_misresolution";

interface QuarantineTarget {
  ohc_id: string;
  cert_designator: string;          // for the audit log only
  expected_canonical_name: string;  // sanity-check the row hasn't drifted
  expected_holder_name: string;     // sanity-check the FAA-side string
  notes: string;                    // free text — appears in evidence JSONB
}

const TARGETS: QuarantineTarget[] = [
  {
    ohc_id: "6cf9fcd7-21f7-4ab7-90c3-fb39ac90849a",
    cert_designator: "FJTA",
    expected_canonical_name: "Corporate Aircraft Management Inc.",
    expected_holder_name: "Corporate Flight Management, Inc.",
    notes: "Aircraft Management != Flight Management. Both Tennessee-area Part 135 brands; distinct legal entities.",
  },
  {
    ohc_id: "7ca8f5f4-6b03-476b-8f4a-5b5101b4e212",
    cert_designator: "GQ9C",
    expected_canonical_name: "ENG Aviation Inc.",
    expected_holder_name: "GQ Aviation, Inc.",
    notes: "Cert designator GQ9C encodes the right operator's name prefix (GQ). Resolver matched to lexically-similar ENG.",
  },
  {
    ohc_id: "61547d3a-5921-43ea-a291-f8351670a7f9",
    cert_designator: "TCHA",
    expected_canonical_name: "Executive Jet Management",
    expected_holder_name: "Executive Flight Management",
    notes: "Phase-2-eval-summary case 4. EJM (NetJets/Berkshire subsidiary) != Executive Flight Management (single Baron 58P, Sugar Grove IL). 2023-01-25 to 2024-09-27 window.",
  },
  {
    ohc_id: "a243f7f1-01c6-4376-a1d8-9135fdb2d14c",
    cert_designator: "TCHA",
    expected_canonical_name: "Executive Jet Management",
    expected_holder_name: "Executive Flight Management",
    notes: "Same false positive as 61547d3a — second temporal window from a snapshot gap. 2025-03-21 to current.",
  },
  {
    ohc_id: "2908debf-0511-4495-a818-2958c074c6c7",
    cert_designator: "70TA",
    expected_canonical_name: "Triton Airways, LLC",
    expected_holder_name: "Triton Air LLC",
    notes: "Airways != Air. Distinct legal name suffixes in aviation. NULL runner-up — no competitor candidate, resolver picked closest lexical neighbor.",
  },
  {
    ohc_id: "176ea63f-6ff4-4384-a744-38c06df7b8a8",
    cert_designator: "OW6A",
    expected_canonical_name: "Arrow Aviation",
    expected_holder_name: "Arrow West Aviation",
    notes: "West is a load-bearing word. Distinct branding/geography. NULL runner-up.",
  },
];

// ── Types ─────────────────────────────────────────────────────────────────

interface OhcRow {
  id: string;
  operator_id: string;
  cert_id: string;
  role: string;
  valid_from: string;       // DATE serializes as YYYY-MM-DD string from pg
  valid_to: string | null;
  source: string;
  source_url: string | null;
  source_timestamp: string | null;
  confidence: string;       // numeric → string from pg
  match_method: string | null;
  evidence: Record<string, unknown> | null;
}

interface Args {
  write: boolean;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const write = argv.includes("--write");
  return { write };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function getCanonicalNameFromEvidence(ev: Record<string, unknown> | null): string | null {
  if (!ev || typeof ev !== "object") return null;
  const v = (ev as { canonical_name?: unknown }).canonical_name;
  return typeof v === "string" ? v : null;
}

function getFirstHolderName(ev: Record<string, unknown> | null): string | null {
  if (!ev || typeof ev !== "object") return null;
  const arr = (ev as { holder_names_in_window?: unknown }).holder_names_in_window;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const v = arr[0];
  return typeof v === "string" ? v : null;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) {
    throw new Error("SUPABASE_DATABASE_URL not set");
  }

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`[quarantine] Mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[quarantine] Audit run: ${AUDIT_RUN_ID}`);
  console.log(`[quarantine] Audit doc: ${AUDIT_DOC}`);
  console.log(`[quarantine] Targets: ${TARGETS.length}`);

  // ── Pre-flight: verify all 6 targets exist with expected shape ──────────

  const ids = TARGETS.map((t) => t.ohc_id);
  const preflight = await pool.query<OhcRow>(
    `SELECT id, operator_id, cert_id, role, valid_from::text, valid_to::text,
            source, source_url, source_timestamp, confidence::text,
            match_method, evidence
     FROM canonical.operator_holds_certificate
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const found = new Map(preflight.rows.map((r) => [r.id, r]));

  let preflightFailed = false;
  for (const t of TARGETS) {
    const row = found.get(t.ohc_id);
    if (!row) {
      console.error(`  [FAIL] ${t.ohc_id} (${t.cert_designator}): NOT FOUND in canonical.operator_holds_certificate`);
      preflightFailed = true;
      continue;
    }
    if (row.source !== "faa_d085") {
      console.error(`  [FAIL] ${t.ohc_id} (${t.cert_designator}): source='${row.source}' (expected 'faa_d085')`);
      preflightFailed = true;
      continue;
    }
    if (Number(row.confidence) !== 0.95) {
      console.error(`  [FAIL] ${t.ohc_id} (${t.cert_designator}): confidence=${row.confidence} (expected 0.95)`);
      preflightFailed = true;
      continue;
    }
    const canonName = getCanonicalNameFromEvidence(row.evidence);
    const holderName = getFirstHolderName(row.evidence);
    if (canonName !== t.expected_canonical_name) {
      console.error(`  [FAIL] ${t.ohc_id}: canonical_name '${canonName}' != expected '${t.expected_canonical_name}'`);
      preflightFailed = true;
      continue;
    }
    if (holderName !== t.expected_holder_name) {
      console.error(`  [FAIL] ${t.ohc_id}: holder_name '${holderName}' != expected '${t.expected_holder_name}'`);
      preflightFailed = true;
      continue;
    }
    console.log(`  [OK]   ${t.ohc_id} (${t.cert_designator}) ${canonName} <- FAA ${holderName}`);
  }

  if (preflightFailed) {
    console.error("\n[quarantine] Pre-flight failed. Aborting. No rows were modified.");
    await pool.end();
    process.exit(1);
  }

  // ── Pre-flight: refuse if any target is already quarantined ─────────────

  const alreadyQuarantined = await pool.query<{ original_ohc_id: string }>(
    `SELECT evidence->>'original_ohc_id' AS original_ohc_id
     FROM canonical.operator_holds_certificate_pending
     WHERE reason = $1
       AND evidence->>'original_ohc_id' = ANY($2::text[])`,
    [QUARANTINE_REASON, ids],
  );
  if (alreadyQuarantined.rows.length > 0) {
    console.error("\n[quarantine] Some targets are already quarantined:");
    for (const r of alreadyQuarantined.rows) console.error(`  - ${r.original_ohc_id}`);
    console.error("[quarantine] Aborting. No rows modified.");
    await pool.end();
    process.exit(1);
  }

  console.log("\n[quarantine] All preflight checks passed.");

  // ── Per-row transaction: INSERT pending → DELETE canonical → COMMIT ─────

  for (const t of TARGETS) {
    const row = found.get(t.ohc_id)!; // preflight ensured presence
    const holderName = getFirstHolderName(row.evidence)!;
    const canonName = getCanonicalNameFromEvidence(row.evidence)!;

    const evidence = {
      audit_run_id: AUDIT_RUN_ID,
      audit_doc: AUDIT_DOC,
      reviewer: REVIEWER,
      quarantined_at: new Date().toISOString(),
      original_ohc_id: t.ohc_id,
      original_canonical_match: {
        operator_id: row.operator_id,
        canonical_name: canonName,
      },
      cert_designator: t.cert_designator,
      notes: t.notes,
      original_evidence: row.evidence,
    };

    if (!args.write) {
      console.log(`\n[DRY-RUN] Would quarantine ${t.ohc_id}`);
      console.log(`  cert_id=${row.cert_id} valid_from=${row.valid_from} valid_to=${row.valid_to ?? "(open)"}`);
      console.log(`  INSERT pending: holder='${holderName}' reason='${QUARANTINE_REASON}'`);
      console.log(`  DELETE canonical: id=${t.ohc_id}`);
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertResult = await client.query<{ id: string }>(
        `INSERT INTO canonical.operator_holds_certificate_pending
           (cert_id, holder_name_as_provided, holder_name_normalized,
            valid_from, valid_to, source, source_url, source_timestamp,
            evidence, reason)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8::timestamptz, $9::jsonb, $10)
         RETURNING id`,
        [
          row.cert_id,
          holderName,
          holderName.toUpperCase(),
          row.valid_from,
          row.valid_to,
          row.source,
          row.source_url,
          row.source_timestamp,
          JSON.stringify(evidence),
          QUARANTINE_REASON,
        ],
      );
      const newPendingId = insertResult.rows[0]?.id;

      const deleteResult = await client.query(
        `DELETE FROM canonical.operator_holds_certificate WHERE id = $1`,
        [t.ohc_id],
      );
      if (deleteResult.rowCount !== 1) {
        throw new Error(
          `DELETE rowCount=${deleteResult.rowCount} for ohc_id=${t.ohc_id} (expected 1)`,
        );
      }

      await client.query("COMMIT");
      console.log(`[WRITE] ${t.ohc_id} (${t.cert_designator}): quarantined → pending_id=${newPendingId}`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[ERROR] ${t.ohc_id}: rollback. ${(err as Error).message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  const remaining = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM canonical.operator_holds_certificate
     WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const newPending = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM canonical.operator_holds_certificate_pending
     WHERE reason = $1 AND evidence->>'audit_run_id' = $2`,
    [QUARANTINE_REASON, AUDIT_RUN_ID],
  );

  console.log(`\n[quarantine] Final state:`);
  console.log(`  canonical.operator_holds_certificate: ${remaining.rows[0]!.count} of ${TARGETS.length} targets remain (expect 0 after --write, ${TARGETS.length} after dry-run)`);
  console.log(`  canonical.operator_holds_certificate_pending (audit_run_id=${AUDIT_RUN_ID}): ${newPending.rows[0]!.count} rows (expect ${TARGETS.length} after --write, 0 after dry-run)`);

  await pool.end();
}

main().catch((err) => {
  console.error("[quarantine] FATAL:", err);
  process.exit(1);
});
