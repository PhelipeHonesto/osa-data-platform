/**
 * Phase 3 follow-up #3 — Pre-flight enumeration of Phase 4a Stage 1 ohc
 * re-open candidates.
 *
 * Path A — Stage 2 close-out per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Predecessors:
 *   - scripts/triage-null-typed-operators-2026-05-06.ts (Phase 3 primary)
 *   - scripts/triage-null-typed-cert-status-breakdown-2026-05-06.ts
 *   - scripts/triage-null-typed-population-breakdown-2026-05-06.ts
 *
 * Phase 4a Stage 1 plan (per gate decision): re-open the closed ohc rows
 * where ALL THREE conditions hold:
 *
 *   C1. canonical.certificates.status = 'active_operating'
 *   C2. cert appears in canonical.certificate_identities[source =
 *       'faa_d085_2026_05_01']
 *   C3. linked operator's operator_type IS NULL
 *
 * The expected count is 141 (from Phase 3 follow-up #2's "op_walk_to_may1"
 * P1 cross-check). This script confirms or refutes that expectation by
 * enumerating exactly which closed ohc rows pass all three guards across
 * the FULL NULL-typed operator set (not restricted to P1), and compares
 * vs P1/P2/P3 populations.
 *
 * If the count is 141 exactly and is all P1: ship Phase 4a as-is.
 *
 * If the count is > 141 (e.g. P2/P3 operators with closed ohc rows that
 * also pass the three guards): the bigger set is also a valid Phase 4a
 * target — the three guards are independent of population — so the
 * re-open scope expands accordingly. Decide at gate.
 *
 * If the count is < 141: there's a discrepancy with Phase 3 follow-up
 * #2's count. Investigate before re-opening.
 *
 * No writes. No CLI flags. Read-only by construction.
 *
 * Usage:
 *   npx tsx scripts/triage-phase4a-reopen-candidates-2026-05-06.ts
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const SAMPLE_PER_BUCKET = 10;
const NULL_TYPED_INVARIANT = 471;
const D085_MAY1_SOURCE = "faa_d085_2026_05_01";
const EXPECTED_REOPEN_COUNT = 141;

// ── Types ─────────────────────────────────────────────────────────────────

interface GuardCrossTabRow {
  cond_cert_active: boolean;
  cond_in_may1: boolean;
  cond_op_null_typed: boolean;
  n_ohc_rows: number;
  n_distinct_operators: number;
}

interface ReopenCandidateRow {
  ohc_id: string;
  operator_id: string;
  cert_id: string;
  canonical_name: string;
  faa_cert_number: string;
  cert_status: string;
  ohc_role: string;
  ohc_source: string;
  ohc_valid_from: string;
  ohc_valid_to: string;
  is_p1: boolean;
  is_p2: boolean;
  is_p3: boolean;
}

interface PopulationBreakdownRow {
  population: string;
  n_operators: number;
}

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

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  // Postgres returns DATE as ISO with time; trim to date portion
  return s.length > 10 ? s.slice(0, 10) : s;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  console.log("[reopen] Mode: READ-ONLY ANALYSIS — no writes.");
  console.log("[reopen] Predecessors: triage-null-typed-{operators,cert-status-breakdown,");
  console.log("[reopen]                                    population-breakdown}-2026-05-06.ts");
  console.log("");

  // ── Pre-flight invariant ──────────────────────────────────────────────

  const nullCount = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.operators WHERE operator_type IS NULL`,
  );
  const nullN = nullCount.rows[0]!.n;
  if (nullN !== NULL_TYPED_INVARIANT) {
    console.log(`[reopen] ✗ INVARIANT: NULL-typed = ${nullN}, expected ${NULL_TYPED_INVARIANT}`);
    await pool.end();
    process.exit(1);
  }
  console.log(`[reopen] ✓ Invariant: NULL-typed = ${nullN}`);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // G1. Three-guard cross-tab on closed ohc rows for NULL-typed operators
  // ════════════════════════════════════════════════════════════════════════

  const g1 = await pool.query<GuardCrossTabRow>(`
    WITH candidate_ohcs AS (
      SELECT
        ohc.id           AS ohc_id,
        ohc.operator_id  AS operator_id,
        ohc.cert_id      AS cert_id,
        c.status         AS cert_status,
        o.operator_type,
        (c.status = 'active_operating') AS cond_cert_active,
        EXISTS (
          SELECT 1 FROM canonical.certificate_identities ci
          WHERE ci.cert_id = ohc.cert_id
            AND ci.source = '${D085_MAY1_SOURCE}'
        ) AS cond_in_may1,
        (o.operator_type IS NULL) AS cond_op_null_typed
      FROM canonical.operator_holds_certificate ohc
      JOIN public.operators o ON o.id = ohc.operator_id
      JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
      WHERE ohc.valid_to IS NOT NULL
    )
    SELECT
      cond_cert_active,
      cond_in_may1,
      cond_op_null_typed,
      COUNT(*)::int                             AS n_ohc_rows,
      COUNT(DISTINCT operator_id)::int          AS n_distinct_operators
    FROM candidate_ohcs
    GROUP BY 1, 2, 3
    ORDER BY 1 DESC, 2 DESC, 3 DESC
  `);
  console.log("[reopen] G1 three-guard cross-tab on closed ohc rows (all NULL-typed candidates):");
  console.log(
    "    " +
      pad("cert_active", 14) +
      pad("in_may1", 12) +
      pad("op_null", 12) +
      rpad("n_ohc", 8) +
      rpad("n_ops", 8) +
      "  meets all three?",
  );
  console.log("    " + "─".repeat(76));
  let totalAllPass = 0;
  let totalAllPassOps = 0;
  for (const r of g1.rows) {
    const allPass = r.cond_cert_active && r.cond_in_may1 && r.cond_op_null_typed;
    if (allPass) {
      totalAllPass = r.n_ohc_rows;
      totalAllPassOps = r.n_distinct_operators;
    }
    console.log(
      "    " +
        pad(r.cond_cert_active ? "TRUE" : "false", 14) +
        pad(r.cond_in_may1 ? "TRUE" : "false", 12) +
        pad(r.cond_op_null_typed ? "TRUE" : "false", 12) +
        rpad(r.n_ohc_rows, 8) +
        rpad(r.n_distinct_operators, 8) +
        (allPass ? "  ← ALL THREE TRUE (re-open candidates)" : ""),
    );
  }
  console.log("    " + "─".repeat(76));
  console.log("");
  console.log(`[reopen] G1 summary:`);
  console.log(`    closed ohc rows where all three guards pass: ${totalAllPass}`);
  console.log(`    distinct operators in that set:              ${totalAllPassOps}`);
  console.log(`    expected (from Phase 3 follow-up #2):         ${EXPECTED_REOPEN_COUNT}`);
  if (totalAllPass === EXPECTED_REOPEN_COUNT) {
    console.log(`    → ✓ Exact match. Phase 4a Stage 1 re-open scope confirmed.`);
  } else if (totalAllPass > EXPECTED_REOPEN_COUNT) {
    const extra = totalAllPass - EXPECTED_REOPEN_COUNT;
    console.log(`    → +${extra} extra rows beyond the 141 P1 expectation.`);
    console.log(`      Likely P2/P3 operators with closed ohc rows that also pass the guards.`);
    console.log(`      The three guards are population-agnostic — these are valid candidates.`);
    console.log(`      Decide at gate whether to expand Phase 4a scope.`);
  } else {
    const missing = EXPECTED_REOPEN_COUNT - totalAllPass;
    console.log(`    → −${missing} fewer rows than the 141 P1 expectation.`);
    console.log(`      Possible discrepancy in how Phase 3 follow-up #2 counted "op_walk_to_may1"`);
    console.log(`      vs strict three-guard pass. INVESTIGATE before shipping Phase 4a.`);
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // P1. Population breakdown of re-open candidates
  // ════════════════════════════════════════════════════════════════════════

  const p1 = await pool.query<PopulationBreakdownRow>(`
    WITH null_typed_ops AS (
      SELECT id FROM public.operators WHERE operator_type IS NULL
    ),
    op_populations AS (
      SELECT
        o.id,
        BOOL_OR(oi.match_method = 'self_creation_d085_seed')                        AS is_p1,
        BOOL_OR(oi.match_method IN ('self_creation', 'faa_cert_direct', 'name_fuzzy')) AS is_p2,
        BOOL_OR(oi.match_method = 'faa_operators_realfleet_merge')                  AS is_p3
      FROM null_typed_ops o
      LEFT JOIN public.operator_identities oi ON oi.operator_id = o.id
      GROUP BY o.id
    ),
    candidate_ohcs AS (
      SELECT DISTINCT ohc.operator_id
      FROM canonical.operator_holds_certificate ohc
      JOIN public.operators o ON o.id = ohc.operator_id
      JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
      LEFT JOIN canonical.certificate_identities ci
        ON ci.cert_id = ohc.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
      WHERE ohc.valid_to IS NOT NULL
        AND c.status = 'active_operating'
        AND ci.cert_id IS NOT NULL
        AND o.operator_type IS NULL
    )
    SELECT
      CASE
        WHEN p.is_p1 AND NOT p.is_p2 AND NOT p.is_p3 THEN 'P1_only'
        WHEN p.is_p2 AND p.is_p3 THEN 'P2_AND_P3'
        WHEN p.is_p2 AND NOT p.is_p3 THEN 'P2_only'
        WHEN p.is_p3 AND NOT p.is_p2 THEN 'P3_only'
        WHEN p.is_p1 AND p.is_p2 THEN 'P1_AND_P2'
        WHEN p.is_p1 AND p.is_p3 THEN 'P1_AND_P3'
        ELSE 'other'
      END AS population,
      COUNT(*)::int AS n_operators
    FROM op_populations p
    JOIN candidate_ohcs c ON c.operator_id = p.id
    GROUP BY 1
    ORDER BY n_operators DESC
  `);
  console.log("[reopen] P1 population breakdown of re-open candidate operators:");
  console.log("    " + pad("population", 16) + rpad("n_operators", 14));
  console.log("    " + "─".repeat(30));
  let p1Sum = 0;
  for (const r of p1.rows) {
    p1Sum += r.n_operators;
    console.log("    " + pad(r.population, 16) + rpad(r.n_operators, 14));
  }
  console.log("    " + "─".repeat(30));
  console.log("    " + pad("TOTAL", 16) + rpad(p1Sum, 14));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // C1. Sample of re-open candidate ohc rows (first 10 alphabetical)
  // ════════════════════════════════════════════════════════════════════════

  const c1 = await pool.query<ReopenCandidateRow>(`
    WITH null_typed_ops AS (
      SELECT id, canonical_name FROM public.operators WHERE operator_type IS NULL
    ),
    op_populations AS (
      SELECT
        o.id,
        BOOL_OR(oi.match_method = 'self_creation_d085_seed')                        AS is_p1,
        BOOL_OR(oi.match_method IN ('self_creation', 'faa_cert_direct', 'name_fuzzy')) AS is_p2,
        BOOL_OR(oi.match_method = 'faa_operators_realfleet_merge')                  AS is_p3
      FROM null_typed_ops o
      LEFT JOIN public.operator_identities oi ON oi.operator_id = o.id
      GROUP BY o.id
    )
    SELECT
      ohc.id::text                AS ohc_id,
      ohc.operator_id::text       AS operator_id,
      ohc.cert_id::text           AS cert_id,
      o.canonical_name,
      c.faa_cert_number,
      c.status                    AS cert_status,
      ohc.role                    AS ohc_role,
      ohc.source                  AS ohc_source,
      ohc.valid_from::text        AS ohc_valid_from,
      ohc.valid_to::text          AS ohc_valid_to,
      COALESCE(p.is_p1, FALSE)    AS is_p1,
      COALESCE(p.is_p2, FALSE)    AS is_p2,
      COALESCE(p.is_p3, FALSE)    AS is_p3
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
    JOIN canonical.certificate_identities ci
      ON ci.cert_id = ohc.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
    JOIN op_populations p ON p.id = ohc.operator_id
    WHERE ohc.valid_to IS NOT NULL
      AND c.status = 'active_operating'
      AND o.operator_type IS NULL
    ORDER BY o.canonical_name
    LIMIT ${SAMPLE_PER_BUCKET}
  `);
  console.log(`[reopen] C1 sample re-open candidate rows (first ${SAMPLE_PER_BUCKET} alphabetical):`);
  for (const r of c1.rows) {
    const pop = [
      r.is_p1 ? "P1" : null,
      r.is_p2 ? "P2" : null,
      r.is_p3 ? "P3" : null,
    ].filter(Boolean).join("+") || "?";
    console.log(
      `    ${pad(trunc(r.canonical_name, 38), 38)}  cert=${pad(r.faa_cert_number, 10)}  role=${pad(r.ohc_role, 16)}  closed=${fmtDate(r.ohc_valid_to)}  pop=${pop}`,
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // V1. Verify each guard's individual contribution (sanity check)
  // ════════════════════════════════════════════════════════════════════════

  const v1 = await pool.query<{ guard: string; n: number }>(`
    SELECT 'closed_ohc_total'::text AS guard,
           COUNT(*)::int AS n
    FROM canonical.operator_holds_certificate ohc
    WHERE ohc.valid_to IS NOT NULL
    UNION ALL
    SELECT 'closed_ohc_op_null_typed', COUNT(*)::int
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    WHERE ohc.valid_to IS NOT NULL AND o.operator_type IS NULL
    UNION ALL
    SELECT 'closed_ohc_op_null_typed_cert_active', COUNT(*)::int
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
    WHERE ohc.valid_to IS NOT NULL
      AND o.operator_type IS NULL
      AND c.status = 'active_operating'
    UNION ALL
    SELECT 'closed_ohc_op_null_typed_cert_active_in_may1', COUNT(*)::int
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
    JOIN canonical.certificate_identities ci
      ON ci.cert_id = ohc.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
    WHERE ohc.valid_to IS NOT NULL
      AND o.operator_type IS NULL
      AND c.status = 'active_operating'
  `);
  console.log("[reopen] V1 progressive guard application (each row narrows the previous):");
  console.log("    " + pad("filter applied", 52) + rpad("n_ohc_rows", 12));
  console.log("    " + "─".repeat(64));
  for (const r of v1.rows) {
    console.log("    " + pad(r.guard, 52) + rpad(r.n, 12));
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // R1. Ohc role distribution (sanity — A.5 used role='holder_of_record')
  // ════════════════════════════════════════════════════════════════════════

  const r1 = await pool.query<{ ohc_role: string; n: number }>(`
    SELECT
      ohc.role AS ohc_role,
      COUNT(*)::int AS n
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
    JOIN canonical.certificate_identities ci
      ON ci.cert_id = ohc.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
    WHERE ohc.valid_to IS NOT NULL
      AND o.operator_type IS NULL
      AND c.status = 'active_operating'
    GROUP BY ohc.role
    ORDER BY n DESC
  `);
  console.log("[reopen] R1 ohc.role distribution among re-open candidates:");
  console.log("    " + pad("role", 24) + rpad("n", 8));
  console.log("    " + "─".repeat(32));
  let r1Sum = 0;
  for (const r of r1.rows) {
    r1Sum += r.n;
    console.log("    " + pad(r.ohc_role, 24) + rpad(r.n, 8));
  }
  console.log("    " + "─".repeat(32));
  console.log("    " + pad("TOTAL", 24) + rpad(r1Sum, 8));
  console.log(`    note: A.5 Phase 3 ALSO required ohc.role = 'holder_of_record'.`);
  console.log(`    Phase 4a Stage 2's re-run will apply that filter again, so any`);
  console.log(`    non-holder_of_record rows here would be re-opened but not tagged.`);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════════

  console.log("[reopen] ═══════ Phase 4a Stage 1 scope confirmation ═══════");
  console.log("");
  console.log(`  closed ohc rows passing all three guards:    ${totalAllPass}`);
  console.log(`  distinct operators in that set:              ${totalAllPassOps}`);
  console.log(`  expected per Phase 3 follow-up #2:           ${EXPECTED_REOPEN_COUNT}`);
  console.log("");
  if (totalAllPass === EXPECTED_REOPEN_COUNT) {
    console.log(`  ✓ Match. Phase 4a Stage 1 ready to ship:`);
    console.log(`    - Re-open ${totalAllPass} ohc rows under transactional UPDATE`);
    console.log(`    - Audit trail in evidence JSONB (original valid_to, three guard`);
    console.log(`      values, reason='reopened_post_a8_phase3_finding')`);
    console.log(`    - Then Stage 2: re-run A.5 Phase 3's UPDATE_SQL exactly as-is.`);
    console.log(`      A.5's role='holder_of_record' filter will catch them only if`);
    console.log(`      the re-opened rows are holder_of_record (see R1 above).`);
  } else if (totalAllPass > EXPECTED_REOPEN_COUNT) {
    console.log(`  ⚠ ${totalAllPass - EXPECTED_REOPEN_COUNT} extra rows beyond expectation. Decision needed:`);
    console.log(`    - Expand Phase 4a scope to ${totalAllPass} ohc rows`);
    console.log(`    - OR restrict to P1 only (${p1.rows.find((r) => r.population === "P1_only")?.n_operators ?? 0})`);
  } else {
    console.log(`  ⚠ ${EXPECTED_REOPEN_COUNT - totalAllPass} fewer rows than expected.`);
    console.log(`    Investigate before re-opening — Phase 3 follow-up #2's count may`);
    console.log(`    have used a slightly different join path. Reconcile first.`);
  }
  console.log("");
  console.log(`  Note: Silver Air and Solairus Aviation (P3) have 0 ohc rows, so`);
  console.log(`  they cannot be re-opened. They need a separate Phase 4a path to`);
  console.log(`  reach part_135 — likely a direct INSERT of an ohc row from the`);
  console.log(`  realfleet_merge identity's source_id, then standard A.5 re-run.`);
  console.log("");
  console.log("[reopen] STOP — no Phase 4a writes. Gate review before Phase 4a build.");

  await pool.end();
}

main().catch((err) => {
  console.error("[reopen] FATAL:", err);
  process.exit(1);
});
