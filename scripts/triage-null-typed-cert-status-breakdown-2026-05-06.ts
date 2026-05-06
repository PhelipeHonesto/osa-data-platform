/**
 * Phase 3 follow-up — cert-status breakdown of the 321 M3 candidates.
 *
 * Path A — Stage 2 close-out per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Predecessor: scripts/triage-null-typed-operators-2026-05-06.ts (Phase 3
 * primary; surfaced 321 NULL-typed operators in has_closed_cert_only with
 * operating_part EXACTLY {'135'} as the dominant mechanical-tag candidate).
 *
 * The Phase 3 primary ran into a question: "closed cert with
 * operating_part='135'" doesn't reliably mean "defunct operator." Three
 * failure modes to defend against before any mechanical defunct-tag:
 *
 *   1. Cert transferred / consolidated — operator persists under the
 *      successor cert. Tagging defunct flattens a Stage 5 cert_transfer
 *      event into a wrong type.
 *
 *   2. Stale closed cert — A.5 closed the cert on May 1 D085 non-presence,
 *      but the operator is actually alive (different cert, different
 *      relationship). Tagging defunct would be plain wrong.
 *
 *   3. Truly defunct — operator dissolved, cert surrendered/revoked.
 *      defunct is the right tag.
 *
 * This script breaks the 321 down by canonical.certificates.status across
 * each operator's closed certs, and cross-checks against
 * public.faa_operators.status (where the operator has an faa-source
 * operator_identities row whose source_id matches a faa cert number).
 *
 * Buckets surfaced (proposal — gate decides Phase 4 scope):
 *   - all_ended (every closed cert is surrendered or revoked)
 *       → mechanical defunct candidate, conf 0.95
 *   - has_consolidated (any closed cert is consolidated)
 *       → DO NOT tag. Stage 5 cert_transfer / operator_event treatment.
 *   - has_active_operating (any closed cert is still active in canonical)
 *       → DO NOT tag. Stale closed-cert investigation (canonical-vs-public
 *       inconsistency case).
 *   - has_pending (any closed cert is in pending status)
 *       → DO NOT tag. Review case.
 *   - other (mixed combinations not covered above)
 *       → DO NOT tag. Review case-by-case.
 *
 * canonical.certificates.status enum (from schema):
 *   ('active_operating','surrendered','revoked','consolidated','pending')
 *   NOT NULL DEFAULT 'pending'.
 *
 * Cross-check: faa_operators.status (default 'active'). For each M3
 * operator, check if any of their faa-source operator_identities has
 * source_id matching a public.faa_operators.certificate_number, and if
 * so, what's the faa_operators.status. Surface count of M3 operators
 * where any matched faa_operator has status='active' — these are the
 * canonical-vs-public inconsistency cases.
 *
 * No writes. No --write, no --dry-run flags. Read-only by construction.
 *
 * Usage:
 *   npx tsx scripts/triage-null-typed-cert-status-breakdown-2026-05-06.ts
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const SAMPLE_PER_BUCKET = 5;
const M3_EXPECTED = 321;
const NULL_TYPED_INVARIANT = 471;

// ── Types ─────────────────────────────────────────────────────────────────

type StatusBucket =
  | "all_ended"
  | "has_consolidated"
  | "has_active_operating"
  | "has_pending"
  | "other";

interface RawStatusRow {
  cert_statuses_text: string;
  n: number;
}

interface BucketRow {
  status_bucket: StatusBucket;
  n: number;
}

interface SampleRow {
  id: string;
  canonical_name: string;
  cert_statuses_text: string;
  n_closed_certs: number;
  faa_statuses_text: string | null;
}

interface FaaCrossRow {
  cross_bucket: string;
  n: number;
}

interface FaaActiveSampleRow {
  id: string;
  canonical_name: string;
  cert_statuses_text: string;
  faa_statuses_text: string;
  faa_cert_numbers: string[];
}

// ── SQL ───────────────────────────────────────────────────────────────────

/**
 * Restricts to the 321 M3 candidates: NULL-typed operators in
 * has_closed_cert_only with closed_parts_set = {'135'} exactly. Then
 * aggregates per-operator cert-status info from the closed certs they
 * hold, plus a faa-side cross-check.
 *
 * status enum: active_operating | surrendered | revoked | consolidated | pending
 */
const M3_CTE = `
WITH null_typed_ops AS (
  SELECT id, canonical_name
  FROM public.operators
  WHERE operator_type IS NULL
),
op_cert_features AS (
  SELECT
    o.id,
    BOOL_OR(ohc.id IS NOT NULL AND ohc.valid_to IS NULL) AS has_open_cert,
    BOOL_OR(ohc.id IS NOT NULL)                          AS has_any_cert,
    ARRAY(
      SELECT DISTINCT unnest(string_to_array(c2.operating_part, ','))
      FROM canonical.operator_holds_certificate ohc2
      JOIN canonical.certificates c2 ON c2.cert_id = ohc2.cert_id
      WHERE ohc2.operator_id = o.id
        AND ohc2.valid_to IS NOT NULL
        AND c2.operating_part IS NOT NULL
      ORDER BY 1
    ) AS closed_parts_set
  FROM null_typed_ops o
  LEFT JOIN canonical.operator_holds_certificate ohc ON ohc.operator_id = o.id
  GROUP BY o.id
),
m3_operators AS (
  SELECT o.id, o.canonical_name
  FROM null_typed_ops o
  JOIN op_cert_features c ON c.id = o.id
  WHERE NOT COALESCE(c.has_open_cert, FALSE)
    AND COALESCE(c.has_any_cert, FALSE)
    AND array_length(c.closed_parts_set, 1) = 1
    AND c.closed_parts_set[1] = '135'
),
m3_with_cert_status AS (
  SELECT
    m.id,
    m.canonical_name,
    ARRAY_AGG(DISTINCT c.status ORDER BY c.status) AS cert_statuses,
    COUNT(DISTINCT ohc.cert_id)::int AS n_closed_certs,
    ARRAY_AGG(DISTINCT c.faa_cert_number ORDER BY c.faa_cert_number)
      FILTER (WHERE c.faa_cert_number IS NOT NULL) AS canonical_faa_cert_numbers
  FROM m3_operators m
  JOIN canonical.operator_holds_certificate ohc ON ohc.operator_id = m.id
  JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
  WHERE ohc.valid_to IS NOT NULL
  GROUP BY m.id, m.canonical_name
),
m3_faa_cross AS (
  SELECT
    m.id,
    -- Path A: faa-source operator_identities → faa_operators by cert number
    ARRAY_AGG(DISTINCT fo_a.status ORDER BY fo_a.status)
      FILTER (WHERE fo_a.certificate_number IS NOT NULL) AS faa_statuses_via_identities,
    ARRAY_AGG(DISTINCT fo_a.certificate_number ORDER BY fo_a.certificate_number)
      FILTER (WHERE fo_a.certificate_number IS NOT NULL) AS faa_cert_numbers_via_identities
  FROM m3_with_cert_status m
  LEFT JOIN public.operator_identities oi
    ON oi.operator_id = m.id AND oi.source = 'faa'
  LEFT JOIN public.faa_operators fo_a
    ON fo_a.certificate_number = oi.source_id
  GROUP BY m.id
),
m3_full AS (
  SELECT
    m.id,
    m.canonical_name,
    m.cert_statuses,
    m.n_closed_certs,
    m.canonical_faa_cert_numbers,
    COALESCE(f.faa_statuses_via_identities, ARRAY[]::text[]) AS faa_statuses,
    COALESCE(f.faa_cert_numbers_via_identities, ARRAY[]::text[]) AS faa_cert_numbers,
    -- Bucket classification (priority order matters)
    CASE
      WHEN m.cert_statuses @> ARRAY['consolidated']::text[] THEN 'has_consolidated'
      WHEN m.cert_statuses @> ARRAY['active_operating']::text[] THEN 'has_active_operating'
      WHEN m.cert_statuses @> ARRAY['pending']::text[] THEN 'has_pending'
      WHEN m.cert_statuses <@ ARRAY['surrendered','revoked']::text[]
           AND array_length(m.cert_statuses, 1) > 0 THEN 'all_ended'
      ELSE 'other'
    END AS status_bucket
  FROM m3_with_cert_status m
  LEFT JOIN m3_faa_cross f ON f.id = m.id
)
`;

// ── Output helpers ────────────────────────────────────────────────────────

function pad(s: string | null | number, n: number): string {
  const str = s === null ? "—" : String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function rpad(s: string | null | number, n: number): string {
  const str = s === null ? "—" : String(s);
  return str.length >= n ? str.slice(0, n) : " ".repeat(n - str.length) + str;
}

function trunc(s: string | null, n: number): string {
  if (s === null || s === undefined) return "—";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  console.log("[m3-status] Mode: READ-ONLY ANALYSIS — no writes.");
  console.log("[m3-status] Predecessor: scripts/triage-null-typed-operators-2026-05-06.ts");
  console.log("");

  // ── Pre-flight: confirm M3 = 321 still ────────────────────────────────

  const m3Count = await pool.query<{ n: number }>(`
    ${M3_CTE}
    SELECT COUNT(*)::int AS n FROM m3_full
  `);
  const m3n = m3Count.rows[0]!.n;
  console.log(`[m3-status] Pre-flight: M3 candidate count = ${m3n}  (expected ${M3_EXPECTED} from primary)`);
  if (m3n !== M3_EXPECTED) {
    console.log(
      `[m3-status]   ⚠ drift from primary count — investigate before relying on bucket counts`,
    );
  }
  // Confirm NULL-typed invariant (defensive)
  const nullCount = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.operators WHERE operator_type IS NULL`,
  );
  const nullN = nullCount.rows[0]!.n;
  if (nullN !== NULL_TYPED_INVARIANT) {
    console.log(
      `[m3-status] ✗ INVARIANT VIOLATION: NULL-typed = ${nullN}, expected ${NULL_TYPED_INVARIANT}.`,
    );
    await pool.end();
    process.exit(1);
  }
  console.log(`[m3-status] ✓ Invariant: NULL-typed = ${nullN}`);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // R1. Raw cert_statuses combinations (operator-level distinct sorted set)
  // ════════════════════════════════════════════════════════════════════════

  const r1 = await pool.query<RawStatusRow>(`
    ${M3_CTE}
    SELECT cert_statuses::text AS cert_statuses_text, COUNT(*)::int AS n
    FROM m3_full
    GROUP BY cert_statuses::text
    ORDER BY n DESC, cert_statuses::text
  `);
  console.log("[m3-status] R1 raw cert_statuses combinations (per operator, distinct sorted set):");
  console.log("    " + pad("cert_statuses (set)", 50) + rpad("n", 8));
  console.log("    " + "─".repeat(58));
  let r1Sum = 0;
  for (const r of r1.rows) {
    r1Sum += r.n;
    console.log("    " + pad(r.cert_statuses_text, 50) + rpad(r.n, 8));
  }
  console.log("    " + "─".repeat(58));
  console.log("    " + pad("TOTAL", 50) + rpad(r1Sum, 8));
  if (r1Sum !== m3n) {
    console.log(`[m3-status] ⚠ R1 sum (${r1Sum}) ≠ M3 count (${m3n}) — investigate`);
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // B1. Bucket interpretation per the user's mapping
  // ════════════════════════════════════════════════════════════════════════

  const b1 = await pool.query<BucketRow>(`
    ${M3_CTE}
    SELECT status_bucket, COUNT(*)::int AS n
    FROM m3_full
    GROUP BY status_bucket
    ORDER BY
      CASE status_bucket
        WHEN 'all_ended' THEN 1
        WHEN 'has_consolidated' THEN 2
        WHEN 'has_active_operating' THEN 3
        WHEN 'has_pending' THEN 4
        WHEN 'other' THEN 5
        ELSE 6
      END
  `);
  console.log("[m3-status] B1 bucket interpretation (Phase 4 mapping):");
  console.log(
    "    " +
      pad("bucket", 24) +
      rpad("n", 6) +
      "  recommendation",
  );
  console.log("    " + "─".repeat(76));
  let b1Sum = 0;
  const bucketCounts: Record<string, number> = {};
  for (const r of b1.rows) {
    bucketCounts[r.status_bucket] = r.n;
    b1Sum += r.n;
    let rec = "";
    switch (r.status_bucket) {
      case "all_ended":
        rec = "→ Phase 4 mechanical: defunct, conf 0.95";
        break;
      case "has_consolidated":
        rec = "→ Stage 5 cert_transfer / operator_event (DO NOT TAG)";
        break;
      case "has_active_operating":
        rec = "→ canonical-vs-public inconsistency (DO NOT TAG, investigate)";
        break;
      case "has_pending":
        rec = "→ review (DO NOT TAG)";
        break;
      case "other":
        rec = "→ review case-by-case (DO NOT TAG)";
        break;
    }
    console.log("    " + pad(r.status_bucket, 24) + rpad(r.n, 6) + "  " + rec);
  }
  console.log("    " + "─".repeat(76));
  console.log("    " + pad("TOTAL", 24) + rpad(b1Sum, 6));
  if (b1Sum !== m3n) {
    console.log(`[m3-status] ⚠ B1 sum (${b1Sum}) ≠ M3 count (${m3n}) — partition broken`);
  } else {
    console.log(`[m3-status] ✓ Partition: ${b1Sum} = ${m3n}`);
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // S1. Sample rows per bucket
  // ════════════════════════════════════════════════════════════════════════

  const s1 = await pool.query<SampleRow & { status_bucket: StatusBucket; rn: number }>(`
    ${M3_CTE}
    , ranked AS (
      SELECT
        status_bucket,
        id::text,
        canonical_name,
        cert_statuses::text AS cert_statuses_text,
        n_closed_certs,
        CASE
          WHEN array_length(faa_statuses, 1) IS NULL THEN NULL
          ELSE faa_statuses::text
        END AS faa_statuses_text,
        ROW_NUMBER() OVER (PARTITION BY status_bucket ORDER BY canonical_name) AS rn
      FROM m3_full
    )
    SELECT * FROM ranked
    WHERE rn <= ${SAMPLE_PER_BUCKET}
    ORDER BY
      CASE status_bucket
        WHEN 'all_ended' THEN 1
        WHEN 'has_consolidated' THEN 2
        WHEN 'has_active_operating' THEN 3
        WHEN 'has_pending' THEN 4
        WHEN 'other' THEN 5
        ELSE 6
      END,
      rn
  `);
  console.log("[m3-status] S1 samples (up to 5 per bucket):");
  let prevBucket = "";
  for (const r of s1.rows) {
    if (r.status_bucket !== prevBucket) {
      console.log(`    ${r.status_bucket}`);
      prevBucket = r.status_bucket;
    }
    console.log(
      `        ${pad(trunc(r.canonical_name, 44), 44)}  cert_status=${r.cert_statuses_text}  n_closed=${r.n_closed_certs}  faa_status=${r.faa_statuses_text ?? "—"}`,
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // X1. FAA cross-check — count by canonical-vs-public consistency
  // ════════════════════════════════════════════════════════════════════════

  const x1 = await pool.query<FaaCrossRow>(`
    ${M3_CTE}
    SELECT
      CASE
        WHEN array_length(faa_statuses, 1) IS NULL OR array_length(faa_statuses, 1) = 0
          THEN 'no_faa_match'
        WHEN faa_statuses @> ARRAY['active']::text[] THEN 'faa_active'
        WHEN faa_statuses <@ ARRAY['inactive', 'closed']::text[] THEN 'faa_inactive_only'
        ELSE 'faa_other'
      END AS cross_bucket,
      COUNT(*)::int AS n
    FROM m3_full
    GROUP BY cross_bucket
    ORDER BY n DESC
  `);
  console.log("[m3-status] X1 FAA cross-check (via faa-source operator_identities → faa_operators):");
  console.log("    " + pad("cross_bucket", 24) + rpad("n", 8));
  console.log("    " + "─".repeat(32));
  let x1Sum = 0;
  const crossCounts: Record<string, number> = {};
  for (const r of x1.rows) {
    crossCounts[r.cross_bucket] = r.n;
    x1Sum += r.n;
    console.log("    " + pad(r.cross_bucket, 24) + rpad(r.n, 8));
  }
  console.log("    " + "─".repeat(32));
  console.log("    " + pad("TOTAL", 24) + rpad(x1Sum, 8));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // X2. Inconsistency cases — canonical closed cert × faa_active
  // ════════════════════════════════════════════════════════════════════════

  const x2 = await pool.query<{
    status_bucket: StatusBucket;
    n: number;
  }>(`
    ${M3_CTE}
    SELECT status_bucket, COUNT(*)::int AS n
    FROM m3_full
    WHERE 'active' = ANY(faa_statuses)
    GROUP BY status_bucket
    ORDER BY n DESC
  `);
  console.log("[m3-status] X2 canonical-vs-public inconsistency (canonical closed × faa_status='active'):");
  console.log("    " + pad("canonical status_bucket", 24) + rpad("n_with_faa_active", 20));
  console.log("    " + "─".repeat(44));
  let x2Sum = 0;
  for (const r of x2.rows) {
    x2Sum += r.n;
    console.log("    " + pad(r.status_bucket, 24) + rpad(r.n, 20));
  }
  console.log("    " + "─".repeat(44));
  console.log("    " + pad("TOTAL", 24) + rpad(x2Sum, 20));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // X3. Samples of inconsistency cases (canonical=all_ended × faa_active)
  // ════════════════════════════════════════════════════════════════════════

  const x3 = await pool.query<FaaActiveSampleRow>(`
    ${M3_CTE}
    SELECT
      id::text,
      canonical_name,
      cert_statuses::text   AS cert_statuses_text,
      faa_statuses::text    AS faa_statuses_text,
      faa_cert_numbers
    FROM m3_full
    WHERE 'active' = ANY(faa_statuses)
    ORDER BY canonical_name
    LIMIT 10
  `);
  if (x3.rows.length > 0) {
    console.log("[m3-status] X3 samples of canonical-vs-public inconsistency (up to 10):");
    for (const r of x3.rows) {
      console.log(
        `    ${pad(trunc(r.canonical_name, 44), 44)}  canonical=${r.cert_statuses_text}  faa=${r.faa_statuses_text}`,
      );
      console.log(`        faa_cert_numbers: ${r.faa_cert_numbers.join(", ")}`);
    }
    console.log("");
  }

  // ════════════════════════════════════════════════════════════════════════
  // Summary — Phase 4 recommendation per user mapping
  // ════════════════════════════════════════════════════════════════════════

  console.log("[m3-status] ═══════ Phase 4 mechanical-tag recommendation ═══════");
  console.log("");
  const allEnded = bucketCounts.all_ended ?? 0;
  const hasConsolidated = bucketCounts.has_consolidated ?? 0;
  const hasActive = bucketCounts.has_active_operating ?? 0;
  const hasPending = bucketCounts.has_pending ?? 0;
  const other = bucketCounts.other ?? 0;
  const faaActiveTotal = x2Sum;

  console.log(`  Phase 4 mechanical defunct-tag candidates: ${allEnded}`);
  console.log(`    rule: cert_statuses ⊆ {surrendered, revoked} AND non-empty`);
  console.log(`    target: operator_type='defunct', data_confidence_score=0.95`);
  console.log(`    rationale: authoritative single-source FAA cert evidence (cert ended,`);
  console.log(`               operator dissolved with their cert)`);
  console.log("");
  console.log(`  DEFER to Stage 5 (cert_transfer / operator_event):  ${hasConsolidated}`);
  console.log(`    rule: any cert_status='consolidated'`);
  console.log(`    rationale: cert was rolled into a successor; operator may persist under`);
  console.log(`               the surviving cert. Treating these as defunct flattens an`);
  console.log(`               event into a wrong type.`);
  console.log("");
  console.log(`  INVESTIGATE (canonical-vs-public inconsistency):    ${hasActive}`);
  console.log(`    rule: any cert_status='active_operating'`);
  console.log(`    rationale: canonical closed the operator's hold but the cert is still`);
  console.log(`               active. Needs investigation before bulk action.`);
  console.log("");
  console.log(`  REVIEW (pending status):                            ${hasPending}`);
  console.log(`    rule: any cert_status='pending'`);
  console.log(`    rationale: cert ingested but not vetted; status unreliable for type`);
  console.log(`               assignment.`);
  console.log("");
  console.log(`  REVIEW (other combinations):                        ${other}`);
  console.log("");
  console.log(`  Cross-check: ${faaActiveTotal} of ${m3n} M3 operators ALSO show as faa_active`);
  console.log(`    in public.faa_operators. Read this against the canonical bucket above —`);
  console.log(`    if all_ended × faa_active > 0, the FAA registry contradicts the canonical`);
  console.log(`    closed status; investigate the inconsistency.`);
  console.log("");

  console.log("[m3-status] ═══════ Gate confirmation ═══════");
  console.log("");
  console.log(`  Phase 3 dominant mechanical-tag scope after this breakdown:`);
  console.log(`    only ${allEnded} of the original 321 M3 candidates are clean defunct cases.`);
  console.log(`    ${m3n - allEnded} go to Stage 5 / investigation / review (not Phase 4).`);
  console.log("");
  console.log(`  Phase 5 input set additions (operators with cert_status='consolidated'):`);
  console.log(`    ${hasConsolidated} operators carrying cert_transfer events. These belong`);
  console.log(`    in canonical.certificate_events with event_type='transferred' once the`);
  console.log(`    Stage 5 schema lands.`);
  console.log("");
  console.log("[m3-status] STOP — no Phase 4 tagging from this script. Gate review next.");

  await pool.end();
}

main().catch((err) => {
  console.error("[m3-status] FATAL:", err);
  process.exit(1);
});
