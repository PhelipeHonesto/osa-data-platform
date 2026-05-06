/**
 * Phase 3 follow-up #2 — Population breakdown of the 471 NULL-typed operators
 * by operator_identities.match_method.
 *
 * Path A — Stage 2 close-out per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Predecessors:
 *   - scripts/triage-null-typed-operators-2026-05-06.ts (Phase 3 primary)
 *   - scripts/triage-null-typed-cert-status-breakdown-2026-05-06.ts
 *
 * The cert-status breakdown showed all 321 M3 candidates sit in the
 * `has_active_operating` bucket — none are clean defunct candidates. So
 * Phase 4 mechanical-tag scope from M3 = 0. The right next move is to
 * understand the populations because the 471 NULL-typed isn't one
 * homogeneous problem — it's at least three different problems pretending
 * to be one (creation pattern):
 *
 *   POPULATION 1 (P1): self_creation_d085_seed (Apr 25 D085 burst)
 *     - Real operators seeded from a pre-May-1 D085 dump
 *     - A.5 Phase 3 only tagged operators whose certs appeared in the
 *       May 1 D085 attestation. Apr 25 ≠ May 1, so these were skipped.
 *     - Tagging strategy: re-run A.5 Phase 3 with corrected lookup that
 *       catches d085_seed source_ids, OR a fresh attestation against a
 *       current D085 snapshot.
 *
 *   POPULATION 2 (P2): Apr 19 burst (self_creation + faa_cert_direct +
 *                                    name_fuzzy)
 *     - Created by the unsafe loaders patched in A.6.5 (commit fe9fc17):
 *       * operator-resolver.ts writeNew (self_creation, name_fuzzy)
 *       * backfill-operators-canonical-faa.ts bulkInsertBatch
 *         (faa_cert_direct, with synthetic XXXX001-style source_ids)
 *     - Some are real operators that ALSO have a "safer" identity row
 *       on the same operator_id (e.g. Jet Linx — LJY via realfleet_merge
 *       as winner, 7OCA297N via faa_cert_direct as Apr 19 sibling).
 *     - Tagging strategy: per-operator. Some real Part 135 operators
 *       (with a safe sibling identity) should re-tag. Others may be
 *       freestanding bogus rows that need cleanup.
 *
 *   POPULATION 3 (P3): faa_operators_realfleet_merge (3 NULL-typed rows)
 *     - Smallest population. realfleet_merge is the safe loader.
 *     - If it created a row and A.5 Phase 3 didn't tag it, that's a real
 *       bug worth understanding case-by-case.
 *
 * Operators can appear in multiple populations (Jet Linx is in both P2
 * and P3). The script reports the overlap explicitly rather than forcing
 * a partition.
 *
 * Three population deep-dives:
 *
 *   D1. P1 May-1 D085 cross-check — for each d085_seed identity, does the
 *       source_id appear in the May 1 D085 attestation?
 *       Path A: canonical.certificates.faa_cert_number = oi.source_id,
 *               then canonical.certificate_identities[source='faa_d085_2026_05_01']
 *       Path B: canonical.certificate_identities[source='faa_d085_2026_05_01'].source_id
 *               directly equals oi.source_id (in case the two sources
 *               share a key encoding)
 *       Distinguishes "A.5 Phase 3 missed (cert exists on May 1)" from
 *       "cert not in May 1 attestation (different snapshot, real miss)".
 *
 *   D2. P2 multi-identity analysis — for each Apr 19 burst operator, does
 *       it ALSO have a "safer" sibling identity on the same operator_id?
 *       Subtypes:
 *         single_p2_only:  only one Apr 19 burst identity, nothing else
 *         multi_with_safer: has a realfleet_merge or *_normalized_match
 *                          sibling identity (the real-operator case)
 *         multi_other:     multiple identities but none "safer"
 *       Plus: Jet Linx specific lookup (one operator row or two?).
 *
 *   D3. P3 full enumerate — show all 3 realfleet_merge NULL-typed
 *       operators with full state (canonical_name, all identities, all
 *       ohc rows, faa_operator status, aircraft_count). Manually inspect.
 *
 * No writes. No CLI flags. Read-only by construction.
 *
 * Usage:
 *   npx tsx scripts/triage-null-typed-population-breakdown-2026-05-06.ts
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const SAMPLE_PER_BUCKET = 10;
const NULL_TYPED_INVARIANT = 471;
const D085_MAY1_SOURCE = "faa_d085_2026_05_01";

const P1_METHODS = ["self_creation_d085_seed"] as const;
const P2_METHODS = ["self_creation", "faa_cert_direct", "name_fuzzy"] as const;
const P3_METHODS = ["faa_operators_realfleet_merge"] as const;

// User's pre-A.8 verification baseline (per gate message):
const EXPECTED_MATCH_METHOD_COUNTS = {
  self_creation_d085_seed: 307,
  self_creation: 128,
  faa_cert_direct: 36,
  name_fuzzy: 16,
  faa_operators_realfleet_merge: 3,
  auto_resolved_post_normalize_match: 1,
} as const;

// ── Types ─────────────────────────────────────────────────────────────────

interface MatchMethodRow {
  match_method: string;
  n_identities: number;
  n_operators: number;
}

interface OverlapRow {
  is_p1: boolean;
  is_p2: boolean;
  is_p3: boolean;
  has_other: boolean;
  n_operators: number;
}

interface P1May1Row {
  may1_status: string;
  n: number;
}

interface P1SampleRow {
  id: string;
  canonical_name: string;
  source_id: string;
  name_as_provided: string;
  source_id_in_canonical_certs: boolean;
  canonical_cert_status: string | null;
  in_may1_d085: boolean;
  faa_operator_status: string | null;
  faa_aircraft_count: number | null;
  n_ohc_rows: number;
}

interface P2SubtypeRow {
  subtype: string;
  n: number;
}

interface P2SampleRow {
  id: string;
  canonical_name: string;
  match_methods_text: string;
  n_identities: number;
  has_safer_sibling: boolean;
  n_ohc_rows: number;
  open_cert_count: number;
  closed_cert_count: number;
  faa_operator_status: string | null;
  faa_aircraft_count: number | null;
}

interface P3FullRow {
  id: string;
  canonical_name: string;
  match_methods_text: string;
  source_ids_text: string;
  n_identities: number;
  n_ohc_rows: number;
  open_cert_count: number;
  closed_cert_count: number;
  closed_cert_statuses_text: string | null;
  faa_operator_status: string | null;
  faa_aircraft_count: number | null;
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

function delta(actual: number, ref: number): string {
  const d = actual - ref;
  if (d === 0) return "  0";
  return d > 0 ? `+${d}` : `${d}`;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  console.log("[pop] Mode: READ-ONLY ANALYSIS — no writes.");
  console.log("[pop] Predecessors: triage-null-typed-operators-2026-05-06.ts,");
  console.log("[pop]               triage-null-typed-cert-status-breakdown-2026-05-06.ts");
  console.log("");

  // ── Pre-flight: NULL-typed invariant ────────────────────────────────────

  const nullCount = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.operators WHERE operator_type IS NULL`,
  );
  const nullN = nullCount.rows[0]!.n;
  if (nullN !== NULL_TYPED_INVARIANT) {
    console.log(
      `[pop] ✗ INVARIANT VIOLATION: NULL-typed = ${nullN}, expected ${NULL_TYPED_INVARIANT}`,
    );
    await pool.end();
    process.exit(1);
  }
  console.log(`[pop] ✓ Invariant: NULL-typed operators = ${nullN}`);
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // M1. Match-method distribution across NULL-typed identities
  // ════════════════════════════════════════════════════════════════════════

  const m1 = await pool.query<MatchMethodRow>(`
    SELECT
      COALESCE(oi.match_method, '(NULL)') AS match_method,
      COUNT(*)::int                       AS n_identities,
      COUNT(DISTINCT oi.operator_id)::int AS n_operators
    FROM public.operator_identities oi
    JOIN public.operators o ON o.id = oi.operator_id
    WHERE o.operator_type IS NULL
    GROUP BY COALESCE(oi.match_method, '(NULL)')
    ORDER BY n_identities DESC
  `);
  console.log("[pop] M1 match_method distribution across NULL-typed operator_identities:");
  console.log(
    "    " +
      pad("match_method", 40) +
      rpad("n_identities", 14) +
      rpad("n_operators", 14) +
      rpad("expected", 12) +
      rpad("Δ", 8),
  );
  console.log("    " + "─".repeat(88));
  let totalIdentities = 0;
  for (const r of m1.rows) {
    totalIdentities += r.n_identities;
    const expected = (EXPECTED_MATCH_METHOD_COUNTS as Record<string, number>)[r.match_method];
    const expectedStr = expected !== undefined ? String(expected) : "—";
    const deltaStr = expected !== undefined ? delta(r.n_identities, expected) : "—";
    console.log(
      "    " +
        pad(r.match_method, 40) +
        rpad(r.n_identities, 14) +
        rpad(r.n_operators, 14) +
        rpad(expectedStr, 12) +
        rpad(deltaStr, 8),
    );
  }
  console.log("    " + "─".repeat(88));
  console.log("    " + pad("TOTAL identities", 40) + rpad(totalIdentities, 14));
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // O1. Population overlap matrix (operators can be in multiple populations)
  // ════════════════════════════════════════════════════════════════════════

  const o1 = await pool.query<OverlapRow>(`
    WITH null_typed_ops AS (
      SELECT id FROM public.operators WHERE operator_type IS NULL
    ),
    op_features AS (
      SELECT
        o.id,
        BOOL_OR(oi.match_method = 'self_creation_d085_seed')                        AS is_p1,
        BOOL_OR(oi.match_method IN ('self_creation', 'faa_cert_direct', 'name_fuzzy')) AS is_p2,
        BOOL_OR(oi.match_method = 'faa_operators_realfleet_merge')                  AS is_p3,
        BOOL_OR(oi.match_method NOT IN (
          'self_creation_d085_seed', 'self_creation', 'faa_cert_direct', 'name_fuzzy',
          'faa_operators_realfleet_merge'
        )) AS has_other
      FROM null_typed_ops o
      LEFT JOIN public.operator_identities oi ON oi.operator_id = o.id
      GROUP BY o.id
    )
    SELECT
      COALESCE(is_p1, FALSE)     AS is_p1,
      COALESCE(is_p2, FALSE)     AS is_p2,
      COALESCE(is_p3, FALSE)     AS is_p3,
      COALESCE(has_other, FALSE) AS has_other,
      COUNT(*)::int AS n_operators
    FROM op_features
    GROUP BY 1, 2, 3, 4
    ORDER BY n_operators DESC
  `);
  console.log("[pop] O1 population membership (each operator may belong to multiple):");
  console.log(
    "    " +
      pad("P1", 4) +
      pad("P2", 4) +
      pad("P3", 4) +
      pad("other", 8) +
      rpad("n_operators", 14),
  );
  console.log("    " + "─".repeat(34));
  let o1Sum = 0;
  for (const r of o1.rows) {
    o1Sum += r.n_operators;
    console.log(
      "    " +
        pad(r.is_p1 ? "✓" : "·", 4) +
        pad(r.is_p2 ? "✓" : "·", 4) +
        pad(r.is_p3 ? "✓" : "·", 4) +
        pad(r.has_other ? "✓" : "·", 8) +
        rpad(r.n_operators, 14),
    );
  }
  console.log("    " + "─".repeat(34));
  console.log("    " + pad("TOTAL", 20) + rpad(o1Sum, 14));
  if (o1Sum !== NULL_TYPED_INVARIANT) {
    console.log(`[pop] ⚠ O1 sum (${o1Sum}) ≠ NULL-typed (${NULL_TYPED_INVARIANT}) — investigate`);
  } else {
    console.log(`[pop] ✓ Partition: ${o1Sum} = ${NULL_TYPED_INVARIANT}`);
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // P1. d085_seed deep-dive — May 1 D085 cross-check
  // ════════════════════════════════════════════════════════════════════════

  // Walk three paths because d085_seed source_ids have a 'd085_seed:XXXX'
  // prefix encoding, so direct source_id equality with cert_number or
  // cert_identities.source_id will spuriously fail. We try:
  //   (a) direct source_id → certificate_identities.source_id
  //   (b) prefix-stripped source_id (drop 'd085_seed:') → faa_cert_number
  //   (c) operator-level walk via ohc → certificate_identities (the
  //       authoritative path A.5 Phase 3 actually used)
  const p1Cross = await pool.query<P1May1Row>(`
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1 FROM canonical.operator_holds_certificate ohc
          JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
          WHERE ohc.operator_id = o.id
            AND ci.source = '${D085_MAY1_SOURCE}'
        ) THEN 'op_walk_to_may1'
        WHEN EXISTS (
          SELECT 1 FROM canonical.certificate_identities ci
          WHERE ci.source = '${D085_MAY1_SOURCE}'
            AND ci.source_id = oi.source_id
        ) THEN 'src_id_direct_to_may1'
        WHEN EXISTS (
          SELECT 1 FROM canonical.certificates c
          JOIN canonical.certificate_identities ci ON ci.cert_id = c.cert_id
          WHERE c.faa_cert_number = REPLACE(oi.source_id, 'd085_seed:', '')
            AND ci.source = '${D085_MAY1_SOURCE}'
        ) THEN 'src_id_stripped_to_may1'
        WHEN EXISTS (
          SELECT 1 FROM canonical.operator_holds_certificate ohc
          WHERE ohc.operator_id = o.id
        ) THEN 'has_ohc_no_may1_attestation'
        ELSE 'no_ohc_at_all'
      END AS may1_status,
      COUNT(*)::int AS n
    FROM public.operator_identities oi
    JOIN public.operators o ON o.id = oi.operator_id
    WHERE o.operator_type IS NULL
      AND oi.match_method = 'self_creation_d085_seed'
    GROUP BY may1_status
    ORDER BY n DESC
  `);
  console.log("[pop] P1 (d085_seed) — May 1 D085 cross-check (multi-path):");
  console.log("    " + pad("may1_status", 36) + rpad("n_identities", 14));
  console.log("    " + "─".repeat(50));
  let p1Sum = 0;
  for (const r of p1Cross.rows) {
    p1Sum += r.n;
    let interp = "";
    switch (r.may1_status) {
      case "op_walk_to_may1":
        interp = "  → operator's ohc-linked cert IS in May 1 attestation (BUG: A.5 should have tagged)";
        break;
      case "src_id_direct_to_may1":
        interp = "  → source_id directly matches a May 1 attestation row (BUG-suspect)";
        break;
      case "src_id_stripped_to_may1":
        interp = "  → prefix-stripped source_id matches a May 1 cert (BUG-suspect)";
        break;
      case "has_ohc_no_may1_attestation":
        interp = "  → has cert link in canonical, but cert isn't in May 1 attestation";
        break;
      case "no_ohc_at_all":
        interp = "  → no canonical cert relationship; needs LLM ER or fresh attestation";
        break;
    }
    console.log("    " + pad(r.may1_status, 36) + rpad(r.n, 14) + interp);
  }
  console.log("    " + "─".repeat(50));
  console.log("    " + pad("TOTAL", 36) + rpad(p1Sum, 14));
  console.log("");

  // P1 samples — walk via ohc to get the actual cert info, since source_id
  // alone has prefix encoding mismatch
  const p1Samples = await pool.query<P1SampleRow>(`
    SELECT
      o.id::text                                AS id,
      o.canonical_name                          AS canonical_name,
      oi.source_id                              AS source_id,
      oi.name_as_provided                       AS name_as_provided,
      EXISTS (
        SELECT 1 FROM canonical.operator_holds_certificate ohc
        WHERE ohc.operator_id = o.id
      ) AS source_id_in_canonical_certs,
      (SELECT c.status FROM canonical.operator_holds_certificate ohc
        JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
        WHERE ohc.operator_id = o.id LIMIT 1) AS canonical_cert_status,
      EXISTS (
        SELECT 1 FROM canonical.operator_holds_certificate ohc
        JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
        WHERE ohc.operator_id = o.id
          AND ci.source = '${D085_MAY1_SOURCE}'
      ) AS in_may1_d085,
      (SELECT fo.status FROM canonical.operator_holds_certificate ohc
        JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
        JOIN public.faa_operators fo ON fo.certificate_number = c.faa_cert_number
        WHERE ohc.operator_id = o.id LIMIT 1) AS faa_operator_status,
      (SELECT fo.aircraft_count FROM canonical.operator_holds_certificate ohc
        JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
        JOIN public.faa_operators fo ON fo.certificate_number = c.faa_cert_number
        WHERE ohc.operator_id = o.id LIMIT 1) AS faa_aircraft_count,
      (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
        WHERE ohc.operator_id = o.id) AS n_ohc_rows
    FROM public.operator_identities oi
    JOIN public.operators o ON o.id = oi.operator_id
    WHERE o.operator_type IS NULL
      AND oi.match_method = 'self_creation_d085_seed'
    ORDER BY o.canonical_name
    LIMIT ${SAMPLE_PER_BUCKET}
  `);
  console.log(`[pop] P1 samples (${SAMPLE_PER_BUCKET} of ${p1Sum}):`);
  for (const r of p1Samples.rows) {
    console.log(
      `    ${pad(trunc(r.canonical_name, 40), 40)}  src_id=${pad(r.source_id, 14)}  cert_in_can=${pad(r.source_id_in_canonical_certs ? "yes" : "no", 4)}  cert_status=${pad(r.canonical_cert_status ?? "—", 18)}  may1=${pad(r.in_may1_d085 ? "yes" : "no", 4)}  faa_op=${pad(r.faa_operator_status ?? "—", 8)}  n_ac=${pad(r.faa_aircraft_count ?? "—", 4)}  ohc=${r.n_ohc_rows}`,
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // P2. Apr 19 burst deep-dive — multi-identity analysis
  // ════════════════════════════════════════════════════════════════════════

  const p2Subtype = await pool.query<P2SubtypeRow>(`
    WITH null_typed_ops AS (
      SELECT id FROM public.operators WHERE operator_type IS NULL
    ),
    p2_ops AS (
      SELECT DISTINCT o.id
      FROM null_typed_ops o
      JOIN public.operator_identities oi ON oi.operator_id = o.id
      WHERE oi.match_method IN ('self_creation', 'faa_cert_direct', 'name_fuzzy')
    ),
    p2_with_siblings AS (
      SELECT
        p.id,
        ARRAY_AGG(DISTINCT oi.match_method ORDER BY oi.match_method) AS match_methods,
        COUNT(*)::int                                                AS n_identities,
        BOOL_OR(oi.match_method IN (
          'faa_operators_realfleet_merge',
          'name_normalized_match',
          'faa_cert_normalized_match',
          'auto_resolved_post_dedup',
          'auto_resolved_post_normalize_match'
        )) AS has_safer_sibling
      FROM p2_ops p
      JOIN public.operator_identities oi ON oi.operator_id = p.id
      GROUP BY p.id
    )
    SELECT
      CASE
        WHEN n_identities = 1 THEN 'single_p2_only'
        WHEN has_safer_sibling THEN 'multi_with_safer_sibling'
        ELSE 'multi_no_safer_sibling'
      END AS subtype,
      COUNT(*)::int AS n
    FROM p2_with_siblings
    GROUP BY subtype
    ORDER BY n DESC
  `);
  console.log("[pop] P2 (Apr 19 burst) — multi-identity subtype:");
  console.log("    " + pad("subtype", 32) + rpad("n_operators", 14));
  console.log("    " + "─".repeat(46));
  let p2Sum = 0;
  for (const r of p2Subtype.rows) {
    p2Sum += r.n;
    let interp = "";
    switch (r.subtype) {
      case "single_p2_only":
        interp = "  → freestanding Apr 19 row, no safer sibling";
        break;
      case "multi_with_safer_sibling":
        interp = "  → Jet Linx-class case (real op, dual identity)";
        break;
      case "multi_no_safer_sibling":
        interp = "  → multiple Apr 19 burst identities, none safer";
        break;
    }
    console.log("    " + pad(r.subtype, 32) + rpad(r.n, 14) + interp);
  }
  console.log("    " + "─".repeat(46));
  console.log("    " + pad("TOTAL P2 operators", 32) + rpad(p2Sum, 14));
  console.log("");

  // P2 samples
  const p2Samples = await pool.query<P2SampleRow>(`
    WITH null_typed_ops AS (
      SELECT id, canonical_name FROM public.operators WHERE operator_type IS NULL
    ),
    p2_ops AS (
      SELECT DISTINCT o.id, o.canonical_name
      FROM null_typed_ops o
      JOIN public.operator_identities oi ON oi.operator_id = o.id
      WHERE oi.match_method IN ('self_creation', 'faa_cert_direct', 'name_fuzzy')
    ),
    p2_features AS (
      SELECT
        p.id::text         AS id,
        p.canonical_name,
        ARRAY_AGG(DISTINCT oi.match_method ORDER BY oi.match_method)::text AS match_methods_text,
        COUNT(*)::int      AS n_identities,
        BOOL_OR(oi.match_method IN (
          'faa_operators_realfleet_merge',
          'name_normalized_match',
          'faa_cert_normalized_match',
          'auto_resolved_post_dedup',
          'auto_resolved_post_normalize_match'
        )) AS has_safer_sibling,
        (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
          WHERE ohc.operator_id = p.id) AS n_ohc_rows,
        (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
          WHERE ohc.operator_id = p.id AND ohc.valid_to IS NULL) AS open_cert_count,
        (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
          WHERE ohc.operator_id = p.id AND ohc.valid_to IS NOT NULL) AS closed_cert_count,
        (SELECT fo.status FROM public.operator_identities oi2
          LEFT JOIN public.faa_operators fo ON fo.certificate_number = oi2.source_id
          WHERE oi2.operator_id = p.id AND oi2.source = 'faa' AND fo.certificate_number IS NOT NULL
          LIMIT 1) AS faa_operator_status,
        (SELECT fo.aircraft_count FROM public.operator_identities oi2
          LEFT JOIN public.faa_operators fo ON fo.certificate_number = oi2.source_id
          WHERE oi2.operator_id = p.id AND oi2.source = 'faa' AND fo.certificate_number IS NOT NULL
          LIMIT 1) AS faa_aircraft_count
      FROM p2_ops p
      JOIN public.operator_identities oi ON oi.operator_id = p.id
      GROUP BY p.id, p.canonical_name
    )
    SELECT * FROM p2_features ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}
  `);
  console.log(`[pop] P2 samples (${SAMPLE_PER_BUCKET} of ${p2Sum}):`);
  for (const r of p2Samples.rows) {
    console.log(
      `    ${pad(trunc(r.canonical_name, 40), 40)}  n_id=${pad(r.n_identities, 3)}  safer=${pad(r.has_safer_sibling ? "yes" : "no", 4)}  ohc=${pad(r.n_ohc_rows, 3)} (${r.open_cert_count}o/${r.closed_cert_count}c)  faa_op=${pad(r.faa_operator_status ?? "—", 8)}  n_ac=${pad(r.faa_aircraft_count ?? "—", 4)}`,
    );
    console.log(`        match_methods: ${r.match_methods_text}`);
  }
  console.log("");

  // P2 — Jet Linx specific check (one operator row or two?)
  const jlxRows = await pool.query<{ id: string; canonical_name: string; operator_type: string | null }>(`
    SELECT id::text AS id, canonical_name, operator_type
    FROM public.operators
    WHERE canonical_name ~* 'jet linx'
    ORDER BY canonical_name
  `);
  console.log(`[pop] P2 — Jet Linx canonical operator rows (${jlxRows.rows.length}):`);
  for (const r of jlxRows.rows) {
    console.log(`    id=${r.id}  canonical_name='${r.canonical_name}'  operator_type=${r.operator_type ?? "(NULL)"}`);
  }
  if (jlxRows.rows.length === 1) {
    const jlxId = jlxRows.rows[0]!.id;
    const jlxIdentities = await pool.query<{
      source: string;
      source_id: string;
      match_method: string;
      name_as_provided: string;
    }>(
      `SELECT source, source_id, match_method, name_as_provided
       FROM public.operator_identities
       WHERE operator_id = $1::uuid
       ORDER BY first_seen_at`,
      [jlxId],
    );
    console.log(`    → all identities on Jet Linx (${jlxIdentities.rows.length}):`);
    for (const r of jlxIdentities.rows) {
      console.log(
        `        source=${pad(r.source, 8)} src_id=${pad(r.source_id, 12)} method=${pad(r.match_method, 36)} name='${r.name_as_provided}'`,
      );
    }
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // P3. Full enumerate — 3 realfleet_merge NULL-typed
  // ════════════════════════════════════════════════════════════════════════

  const p3Full = await pool.query<P3FullRow>(`
    WITH null_typed_p3 AS (
      SELECT DISTINCT o.id, o.canonical_name
      FROM public.operators o
      JOIN public.operator_identities oi ON oi.operator_id = o.id
      WHERE o.operator_type IS NULL
        AND oi.match_method = 'faa_operators_realfleet_merge'
    )
    SELECT
      p.id::text AS id,
      p.canonical_name,
      (SELECT ARRAY_AGG(DISTINCT oi.match_method ORDER BY oi.match_method)
        FROM public.operator_identities oi
        WHERE oi.operator_id = p.id)::text AS match_methods_text,
      (SELECT ARRAY_AGG(oi.source_id)
        FROM public.operator_identities oi
        WHERE oi.operator_id = p.id)::text AS source_ids_text,
      (SELECT COUNT(*)::int FROM public.operator_identities oi
        WHERE oi.operator_id = p.id) AS n_identities,
      (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
        WHERE ohc.operator_id = p.id) AS n_ohc_rows,
      (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
        WHERE ohc.operator_id = p.id AND ohc.valid_to IS NULL) AS open_cert_count,
      (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
        WHERE ohc.operator_id = p.id AND ohc.valid_to IS NOT NULL) AS closed_cert_count,
      (SELECT ARRAY_AGG(DISTINCT c.status ORDER BY c.status)
        FROM canonical.operator_holds_certificate ohc
        JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
        WHERE ohc.operator_id = p.id AND ohc.valid_to IS NOT NULL)::text AS closed_cert_statuses_text,
      (SELECT fo.status FROM public.operator_identities oi
        LEFT JOIN public.faa_operators fo ON fo.certificate_number = oi.source_id
        WHERE oi.operator_id = p.id AND oi.source = 'faa' AND fo.certificate_number IS NOT NULL
        LIMIT 1) AS faa_operator_status,
      (SELECT fo.aircraft_count FROM public.operator_identities oi
        LEFT JOIN public.faa_operators fo ON fo.certificate_number = oi.source_id
        WHERE oi.operator_id = p.id AND oi.source = 'faa' AND fo.certificate_number IS NOT NULL
        LIMIT 1) AS faa_aircraft_count
    FROM null_typed_p3 p
    ORDER BY p.canonical_name
  `);
  console.log(`[pop] P3 (realfleet_merge NULL-typed) — full enumerate (${p3Full.rows.length}):`);
  for (const r of p3Full.rows) {
    console.log(`    canonical_name: ${r.canonical_name}`);
    console.log(`        operator_id:    ${r.id}`);
    console.log(`        n_identities:   ${r.n_identities}  match_methods=${r.match_methods_text}`);
    console.log(`        source_ids:     ${r.source_ids_text}`);
    console.log(
      `        ohc:            n=${r.n_ohc_rows} (${r.open_cert_count} open, ${r.closed_cert_count} closed)`,
    );
    console.log(`        closed_statuses:${r.closed_cert_statuses_text ?? "—"}`);
    console.log(
      `        public.faa_op:  status=${r.faa_operator_status ?? "—"}  aircraft_count=${r.faa_aircraft_count ?? "—"}`,
    );
    console.log("");
  }

  // ════════════════════════════════════════════════════════════════════════
  // Summary — Phase 4 scope per population
  // ════════════════════════════════════════════════════════════════════════

  console.log("[pop] ═══════ Phase 4 scope per population ═══════");
  console.log("");
  console.log(`  P1 (d085_seed):  ${m1.rows.find((r) => r.match_method === "self_creation_d085_seed")?.n_operators ?? 0} operators`);
  const p1InMay1 =
    (p1Cross.rows.find((r) => r.may1_status === "op_walk_to_may1")?.n ?? 0) +
    (p1Cross.rows.find((r) => r.may1_status === "src_id_direct_to_may1")?.n ?? 0) +
    (p1Cross.rows.find((r) => r.may1_status === "src_id_stripped_to_may1")?.n ?? 0);
  console.log(`     in_may1 (BUG candidates):              ${p1InMay1}`);
  console.log(`       op_walk_to_may1:                     ${p1Cross.rows.find((r) => r.may1_status === "op_walk_to_may1")?.n ?? 0}`);
  console.log(`       src_id_direct_to_may1:               ${p1Cross.rows.find((r) => r.may1_status === "src_id_direct_to_may1")?.n ?? 0}`);
  console.log(`       src_id_stripped_to_may1:             ${p1Cross.rows.find((r) => r.may1_status === "src_id_stripped_to_may1")?.n ?? 0}`);
  console.log(`     has_ohc_no_may1_attestation:           ${p1Cross.rows.find((r) => r.may1_status === "has_ohc_no_may1_attestation")?.n ?? 0}`);
  console.log(`     no_ohc_at_all:                         ${p1Cross.rows.find((r) => r.may1_status === "no_ohc_at_all")?.n ?? 0}`);
  console.log(`     → Phase 4a: depends on which path actually catches them. If`);
  console.log(`       op_walk_to_may1 > 0, A.5 Phase 3 had a bug. Otherwise these`);
  console.log(`       d085_seed operators legitimately weren't in May 1, and Phase`);
  console.log(`       4a would need a fresh D085 attestation against today's snapshot.`);
  console.log("");
  console.log(`  P2 (Apr 19 burst): ${p2Sum} operators`);
  console.log(`     single_p2_only (freestanding):        ${p2Subtype.rows.find((r) => r.subtype === "single_p2_only")?.n ?? 0}`);
  console.log(`     multi_with_safer_sibling (Jet Linx):  ${p2Subtype.rows.find((r) => r.subtype === "multi_with_safer_sibling")?.n ?? 0}`);
  console.log(`     multi_no_safer_sibling:               ${p2Subtype.rows.find((r) => r.subtype === "multi_no_safer_sibling")?.n ?? 0}`);
  console.log(`     → Phase 4b: case-by-case investigation. multi_with_safer_sibling`);
  console.log(`       gets re-tagged via the safer sibling's source. single_p2_only`);
  console.log(`       and multi_no_safer_sibling go to per-row review.`);
  console.log("");
  console.log(`  P3 (realfleet_merge): ${p3Full.rows.length} operators (manual investigation)`);
  console.log(`     → see full enumerate above; decide per-row at gate.`);
  console.log("");
  console.log("[pop] STOP — no Phase 4 tagging from this script. Gate review next.");

  await pool.end();
}

main().catch((err) => {
  console.error("[pop] FATAL:", err);
  process.exit(1);
});
