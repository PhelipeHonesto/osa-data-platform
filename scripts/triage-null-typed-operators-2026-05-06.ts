/**
 * Phase 3 — Triage 471 NULL-typed operators.
 *
 * Path A — Stage 2 close-out per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Read-only decomposition of the 471 NULL-typed operators along three
 * dimensions, plus cross-tabs and a mechanically-tagable subset proposal.
 * No writes. We review the output at the gate before any Phase 4 tagging.
 *
 * Dimensions:
 *
 *   D1. Identity source mix (partitioned, each operator in exactly one):
 *     faa_only / wyvern_only / argus_only / other_single_source /
 *     multi_source / no_source.
 *
 *   D2. Cert relationship (partitioned, each operator in exactly one):
 *     has_open_cert / has_closed_cert_only / no_cert_relationship.
 *     Plus per-operator open_parts_set / closed_parts_set / on_d085 flag.
 *     `*_parts_set` is the union of comma-split operating_part elements
 *     across all certs of that side (open vs closed). This is the right
 *     unit of mechanical tagging — `'135'` vs `'135,91K'` are distinct
 *     for type-discrimination purposes.
 *
 *   D3. Name pattern flags (orthogonal — operators may match multiple):
 *     has_LLC / has_INC / has_GROUP / has_HOLDINGS / has_SERVICES /
 *     has_MANAGEMENT / has_LEASING / has_CAPITAL. Case-insensitive,
 *     whole-word.
 *
 * Pre-flight invariant gate: NULL-typed total must equal 471. If it has
 * moved, abort and investigate. Source-mix drift relative to the parent
 * plan's 343/128/15 reference is EXPECTED post-A.7 (the parent plan's
 * numbers were "with identities of source X" counts, not partitioned
 * buckets, and A.7 attached 20 operator_identities rows that converted
 * some single-source NULL-typed operators into multi_source).
 *
 * Live post-A.7 reference (queried 2026-05-06):
 *   faa_only=332, wyvern_only=113, argus_only=11, multi_source=15,
 *   other_single_source=0, no_source=0, total=471.
 *
 * Cross-tabs produced:
 *   T1. source_mix × cert_rel matrix (cells partition the 471).
 *   T2. has_open_cert ∩ on_d085 × part_class (A.5 bug investigation).
 *   T3. has_closed_cert_only × part_class (defunct candidates).
 *   T4. no_cert_relationship × source_mix (LLM ER candidates).
 *   T5. Name pattern flag totals (broad signal, no tagging proposal).
 *
 * Mechanically-tagable subsets surfaced (proposal — gate decides):
 *   - Open cert with operating_part EXACTLY {'121'} → part_121, conf 0.95
 *   - Open cert with operating_part EXACTLY {'91K'} → part_91k, conf 0.95
 *   - on_d085 ∩ open_contains_135 cell — DO NOT tag, A.5 reconciliation
 *
 * Closed-only candidates (defunct subtype, gate decides scope):
 *   - Closed-only with operating_part EXACTLY {'135'} → defunct
 *   - Closed-only with operating_part EXACTLY {'121'} → defunct
 *   - Closed-only with operating_part EXACTLY {'91K'} → defunct
 *
 * No writes. No --write, no --dry-run flags. Read-only by construction.
 *
 * Usage:
 *   npx tsx scripts/triage-null-typed-operators-2026-05-06.ts
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const SAMPLE_PER_BUCKET = 5;

const PARENT_PLAN_REF = {
  faa_only: 343,
  wyvern_only: 128,
  argus_only: 15,
  multi_source: 0,
  other_single_source: 0,
  no_source: 0,
} as const;

const POST_A7_REF = {
  faa_only: 332,
  wyvern_only: 113,
  argus_only: 11,
  multi_source: 15,
  other_single_source: 0,
  no_source: 0,
} as const;

const NULL_TYPED_INVARIANT = 471;
const TOTAL_OPERATORS_EXPECTED = 1937;
const PART_135_EXPECTED = 1461;

const D085_SOURCE = "faa_d085_2026_05_01";

// ── Types ─────────────────────────────────────────────────────────────────

type SourceMix =
  | "faa_only"
  | "wyvern_only"
  | "argus_only"
  | "other_single_source"
  | "multi_source"
  | "no_source";

type CertRel = "has_open_cert" | "has_closed_cert_only" | "no_cert_relationship";

type PartClass =
  | "contains_135"
  | "contains_121"
  | "contains_91K"
  | "contains_135_AND_121"
  | "contains_135_AND_91K"
  | "contains_121_AND_91K"
  | "contains_all_three"
  | "contains_other_only";

interface OperatorTypeRow {
  operator_type: string | null;
  n: number;
}

interface SourceMixRow {
  source_mix: SourceMix;
  n: number;
}

interface T1Row {
  source_mix: SourceMix;
  cert_rel: CertRel;
  n: number;
}

interface T2Row {
  d085: "on_d085" | "not_on_d085";
  part_class: PartClass;
  n: number;
}

interface T3Row {
  part_class: PartClass;
  n: number;
}

interface T4Row {
  source_mix: SourceMix;
  n: number;
}

interface T5Row {
  has_llc: number;
  has_inc: number;
  has_group: number;
  has_holdings: number;
  has_services: number;
  has_management: number;
  has_leasing: number;
  has_capital: number;
}

interface SampleRow {
  id: string;
  canonical_name: string;
  sources: string[] | null;
  open_parts_set: string[] | null;
  closed_parts_set: string[] | null;
  open_on_d085: boolean;
}

interface MechanicalSubsetRow {
  n: number;
}

// ── SQL ───────────────────────────────────────────────────────────────────

/**
 * Shared CTE: materializes per-operator features for the 471 NULL-typed
 * operators. Reused across cross-tab queries by string concatenation.
 *
 * `open_parts_set` and `closed_parts_set` are the union of comma-split
 * operating_part elements across all open / closed certs respectively.
 * This is the correct mechanical-tagging unit: an operator with
 * operating_part='135,91K' belongs to both Part 135 and Part 91K
 * simultaneously, and an unambiguous mechanical tag requires the set to
 * have exactly one element.
 */
const FEATURES_CTE = `
WITH null_typed_ops AS (
  SELECT id, canonical_name
  FROM public.operators
  WHERE operator_type IS NULL
),
op_sources AS (
  SELECT
    o.id,
    ARRAY_AGG(DISTINCT oi.source ORDER BY oi.source)
      FILTER (WHERE oi.source IS NOT NULL) AS sources
  FROM null_typed_ops o
  LEFT JOIN public.operator_identities oi ON oi.operator_id = o.id
  GROUP BY o.id
),
op_cert_features AS (
  SELECT
    o.id,
    BOOL_OR(ohc.id IS NOT NULL AND ohc.valid_to IS NULL)     AS has_open_cert,
    BOOL_OR(ohc.id IS NOT NULL)                              AS has_any_cert,
    ARRAY(
      SELECT DISTINCT unnest(string_to_array(c2.operating_part, ','))
      FROM canonical.operator_holds_certificate ohc2
      JOIN canonical.certificates c2 ON c2.cert_id = ohc2.cert_id
      WHERE ohc2.operator_id = o.id
        AND ohc2.valid_to IS NULL
        AND c2.operating_part IS NOT NULL
      ORDER BY 1
    ) AS open_parts_set,
    ARRAY(
      SELECT DISTINCT unnest(string_to_array(c2.operating_part, ','))
      FROM canonical.operator_holds_certificate ohc2
      JOIN canonical.certificates c2 ON c2.cert_id = ohc2.cert_id
      WHERE ohc2.operator_id = o.id
        AND ohc2.valid_to IS NOT NULL
        AND c2.operating_part IS NOT NULL
      ORDER BY 1
    ) AS closed_parts_set,
    BOOL_OR(
      ohc.valid_to IS NULL
      AND EXISTS (
        SELECT 1 FROM canonical.certificate_identities ci
        WHERE ci.cert_id = ohc.cert_id AND ci.source = '${D085_SOURCE}'
      )
    ) AS open_on_d085
  FROM null_typed_ops o
  LEFT JOIN canonical.operator_holds_certificate ohc ON ohc.operator_id = o.id
  GROUP BY o.id
),
features AS (
  SELECT
    o.id,
    o.canonical_name,
    COALESCE(s.sources, ARRAY[]::text[]) AS sources,
    CASE
      WHEN s.sources IS NULL OR array_length(s.sources, 1) IS NULL THEN 'no_source'
      WHEN array_length(s.sources, 1) > 1 THEN 'multi_source'
      WHEN s.sources[1] = 'faa' THEN 'faa_only'
      WHEN s.sources[1] = 'wyvern' THEN 'wyvern_only'
      WHEN s.sources[1] = 'argus' THEN 'argus_only'
      ELSE 'other_single_source'
    END AS source_mix,
    CASE
      WHEN COALESCE(c.has_open_cert, FALSE) THEN 'has_open_cert'
      WHEN COALESCE(c.has_any_cert, FALSE) THEN 'has_closed_cert_only'
      ELSE 'no_cert_relationship'
    END AS cert_rel,
    COALESCE(c.open_parts_set,   ARRAY[]::text[]) AS open_parts_set,
    COALESCE(c.closed_parts_set, ARRAY[]::text[]) AS closed_parts_set,
    COALESCE(c.open_on_d085, FALSE) AS open_on_d085,
    COALESCE(c.open_parts_set,   ARRAY[]::text[]) @> ARRAY['135'] AS open_contains_135,
    COALESCE(c.open_parts_set,   ARRAY[]::text[]) @> ARRAY['121'] AS open_contains_121,
    COALESCE(c.open_parts_set,   ARRAY[]::text[]) @> ARRAY['91K'] AS open_contains_91K,
    COALESCE(c.closed_parts_set, ARRAY[]::text[]) @> ARRAY['135'] AS closed_contains_135,
    COALESCE(c.closed_parts_set, ARRAY[]::text[]) @> ARRAY['121'] AS closed_contains_121,
    COALESCE(c.closed_parts_set, ARRAY[]::text[]) @> ARRAY['91K'] AS closed_contains_91K,
    o.canonical_name ~* '\\mLLC\\M'        AS has_llc,
    o.canonical_name ~* '\\mINC\\M'        AS has_inc,
    o.canonical_name ~* '\\mGROUP\\M'      AS has_group,
    o.canonical_name ~* '\\mHOLDINGS\\M'   AS has_holdings,
    o.canonical_name ~* '\\mSERVICES\\M'   AS has_services,
    o.canonical_name ~* '\\mMANAGEMENT\\M' AS has_management,
    o.canonical_name ~* '\\mLEASING\\M'    AS has_leasing,
    o.canonical_name ~* '\\mCAPITAL\\M'    AS has_capital
  FROM null_typed_ops o
  LEFT JOIN op_sources s        ON s.id = o.id
  LEFT JOIN op_cert_features c  ON c.id = o.id
)
`;

const PART_CLASS_CASE = (prefix: "open" | "closed") => `
  CASE
    WHEN ${prefix}_contains_135 AND ${prefix}_contains_121 AND ${prefix}_contains_91K THEN 'contains_all_three'
    WHEN ${prefix}_contains_135 AND ${prefix}_contains_121 THEN 'contains_135_AND_121'
    WHEN ${prefix}_contains_135 AND ${prefix}_contains_91K THEN 'contains_135_AND_91K'
    WHEN ${prefix}_contains_121 AND ${prefix}_contains_91K THEN 'contains_121_AND_91K'
    WHEN ${prefix}_contains_135 THEN 'contains_135'
    WHEN ${prefix}_contains_121 THEN 'contains_121'
    WHEN ${prefix}_contains_91K THEN 'contains_91K'
    ELSE 'contains_other_only'
  END
`;

const SOURCE_MIX_ORDER = `
  CASE source_mix
    WHEN 'faa_only' THEN 1
    WHEN 'wyvern_only' THEN 2
    WHEN 'argus_only' THEN 3
    WHEN 'other_single_source' THEN 4
    WHEN 'multi_source' THEN 5
    WHEN 'no_source' THEN 6
    ELSE 7
  END
`;

const CERT_REL_ORDER = `
  CASE cert_rel
    WHEN 'has_open_cert' THEN 1
    WHEN 'has_closed_cert_only' THEN 2
    WHEN 'no_cert_relationship' THEN 3
    ELSE 4
  END
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

function fmtArr(a: string[] | null | undefined): string {
  if (!a || a.length === 0) return "—";
  return "{" + a.join(",") + "}";
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

  console.log("[triage] Mode: READ-ONLY ANALYSIS — no writes.");
  console.log(`[triage] Plan: /Users/phelipehonesto/.claude/plans/starting-session-a-8-path-enumerated-crayon.md`);
  console.log("");

  // ── Pre-flight Q1: total operators ─────────────────────────────────────

  const q1 = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM public.operators`);
  const totalOps = q1.rows[0]!.n;
  console.log(`[triage] Q1 total operators: ${totalOps}  (expected ${TOTAL_OPERATORS_EXPECTED})`);
  if (totalOps !== TOTAL_OPERATORS_EXPECTED) {
    console.log(`[triage]   ⚠ drift from expected total — investigate`);
  }
  console.log("");

  // ── Pre-flight Q2: operator_type breakdown ─────────────────────────────

  const q2 = await pool.query<OperatorTypeRow>(`
    SELECT operator_type, COUNT(*)::int AS n
    FROM public.operators
    GROUP BY operator_type
    ORDER BY operator_type NULLS FIRST
  `);
  console.log("[triage] Q2 operator_type breakdown:");
  console.log("    " + pad("operator_type", 24) + rpad("n", 8));
  console.log("    " + "─".repeat(32));
  let nullCount = -1;
  for (const r of q2.rows) {
    const label = r.operator_type === null ? "(NULL)" : r.operator_type;
    console.log("    " + pad(label, 24) + rpad(r.n, 8));
    if (r.operator_type === null) nullCount = r.n;
  }
  console.log("");

  // ── INVARIANT GATE: NULL-typed must equal 471 ──────────────────────────

  if (nullCount !== NULL_TYPED_INVARIANT) {
    console.log(
      `[triage] ✗ INVARIANT VIOLATION: NULL-typed = ${nullCount}, expected ${NULL_TYPED_INVARIANT}.`,
    );
    console.log(`[triage]   The 471 invariant is load-bearing for this analysis.`);
    console.log(`[triage]   Aborting before bucketing — investigate the baseline drift.`);
    await pool.end();
    process.exit(1);
  }
  console.log(`[triage] ✓ Invariant: NULL-typed = ${nullCount} (expected ${NULL_TYPED_INVARIANT}).`);
  console.log("");

  // ── Pre-flight Q3: NULL-typed source-mix (partitioned) ─────────────────

  const q3 = await pool.query<SourceMixRow>(`
    ${FEATURES_CTE}
    SELECT source_mix, COUNT(*)::int AS n
    FROM features
    GROUP BY source_mix
    ORDER BY ${SOURCE_MIX_ORDER}
  `);
  console.log("[triage] Q3 NULL-typed source-mix (partitioned bucket):");
  console.log(
    "    " +
      pad("source_mix", 24) +
      rpad("n", 8) +
      rpad("plan_ref", 10) +
      rpad("Δ_plan", 10) +
      rpad("postA7_ref", 12) +
      rpad("Δ_postA7", 12),
  );
  console.log("    " + "─".repeat(76));
  const sourceMixCounts: Record<string, number> = {};
  let q3Sum = 0;
  for (const r of q3.rows) {
    sourceMixCounts[r.source_mix] = r.n;
    q3Sum += r.n;
    const planRef = (PARENT_PLAN_REF as Record<string, number>)[r.source_mix] ?? 0;
    const a7Ref = (POST_A7_REF as Record<string, number>)[r.source_mix] ?? 0;
    console.log(
      "    " +
        pad(r.source_mix, 24) +
        rpad(r.n, 8) +
        rpad(planRef, 10) +
        rpad(delta(r.n, planRef), 10) +
        rpad(a7Ref, 12) +
        rpad(delta(r.n, a7Ref), 12),
    );
  }
  console.log("    " + "─".repeat(76));
  console.log("    " + pad("TOTAL", 24) + rpad(q3Sum, 8));
  console.log("");

  if (q3Sum !== NULL_TYPED_INVARIANT) {
    console.log(
      `[triage] ⚠ Q3 sum (${q3Sum}) ≠ NULL-typed invariant (${NULL_TYPED_INVARIANT}) — partition broken`,
    );
  }

  // ── Drift analysis vs post-A.7 reference ───────────────────────────────

  console.log("[triage] Drift analysis (post-A.7 reference vs live):");
  let driftWarn = false;
  for (const key of Object.keys(POST_A7_REF) as Array<keyof typeof POST_A7_REF>) {
    const live = sourceMixCounts[key] ?? 0;
    const ref = POST_A7_REF[key];
    const d = live - ref;
    const flag = Math.abs(d) > 2 ? " ⚠ drift > ±2" : "";
    if (Math.abs(d) > 2) driftWarn = true;
    console.log(`    ${pad(key, 24)} live=${rpad(live, 4)} ref=${rpad(ref, 4)} Δ=${rpad(delta(live, ref), 5)}${flag}`);
  }
  if (driftWarn) {
    console.log(
      "[triage]   ⚠ Drift > ±2 detected on at least one bucket. Continuing (this does not halt — only the NULL=471 invariant halts).",
    );
  } else {
    console.log("[triage]   ✓ All buckets within ±2 of post-A.7 reference.");
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // T1. source_mix × cert_rel cross-tab (cells partition the 471)
  // ════════════════════════════════════════════════════════════════════════

  const t1 = await pool.query<T1Row>(`
    ${FEATURES_CTE}
    SELECT source_mix, cert_rel, COUNT(*)::int AS n
    FROM features
    GROUP BY source_mix, cert_rel
    ORDER BY ${SOURCE_MIX_ORDER}, ${CERT_REL_ORDER}
  `);
  const t1Cells: Record<string, Record<string, number>> = {};
  let t1Sum = 0;
  for (const r of t1.rows) {
    if (!t1Cells[r.source_mix]) t1Cells[r.source_mix] = {};
    t1Cells[r.source_mix]![r.cert_rel] = r.n;
    t1Sum += r.n;
  }
  console.log("[triage] T1 source_mix × cert_rel matrix:");
  console.log(
    "    " +
      pad("source_mix \\ cert_rel", 24) +
      rpad("has_open_cert", 16) +
      rpad("has_closed_only", 18) +
      rpad("no_cert", 10) +
      rpad("ROW", 8),
  );
  console.log("    " + "─".repeat(76));
  const sourceMixOrder: SourceMix[] = [
    "faa_only",
    "wyvern_only",
    "argus_only",
    "other_single_source",
    "multi_source",
    "no_source",
  ];
  const certRels: CertRel[] = ["has_open_cert", "has_closed_cert_only", "no_cert_relationship"];
  const colSums: Record<string, number> = {
    has_open_cert: 0,
    has_closed_cert_only: 0,
    no_cert_relationship: 0,
  };
  for (const sm of sourceMixOrder) {
    if (!t1Cells[sm]) continue;
    const row = t1Cells[sm]!;
    let rowSum = 0;
    for (const cr of certRels) {
      const v = row[cr] ?? 0;
      rowSum += v;
      colSums[cr]! += v;
    }
    console.log(
      "    " +
        pad(sm, 24) +
        rpad(row.has_open_cert ?? 0, 16) +
        rpad(row.has_closed_cert_only ?? 0, 18) +
        rpad(row.no_cert_relationship ?? 0, 10) +
        rpad(rowSum, 8),
    );
  }
  console.log("    " + "─".repeat(76));
  console.log(
    "    " +
      pad("COL", 24) +
      rpad(colSums.has_open_cert!, 16) +
      rpad(colSums.has_closed_cert_only!, 18) +
      rpad(colSums.no_cert_relationship!, 10) +
      rpad(t1Sum, 8),
  );
  if (t1Sum !== NULL_TYPED_INVARIANT) {
    console.log(`[triage] ⚠ T1 cell sum (${t1Sum}) ≠ ${NULL_TYPED_INVARIANT} — partition broken`);
  } else {
    console.log(`[triage] ✓ T1 partition: ${t1Sum} = ${NULL_TYPED_INVARIANT}`);
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // T2. has_open_cert × {on_d085, not_on_d085} × part_class
  // ════════════════════════════════════════════════════════════════════════

  const t2 = await pool.query<T2Row>(`
    ${FEATURES_CTE}
    SELECT
      CASE WHEN open_on_d085 THEN 'on_d085' ELSE 'not_on_d085' END AS d085,
      ${PART_CLASS_CASE("open")} AS part_class,
      COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_open_cert'
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);
  console.log("[triage] T2 has_open_cert × {d085 presence} × part_class:");
  console.log("    " + pad("d085", 14) + pad("part_class", 24) + rpad("n", 8));
  console.log("    " + "─".repeat(46));
  let t2Sum = 0;
  for (const r of t2.rows) {
    t2Sum += r.n;
    const flag = r.d085 === "on_d085" && r.part_class === "contains_135" ? "  ← A.5 RECONCILE" : "";
    console.log("    " + pad(r.d085, 14) + pad(r.part_class, 24) + rpad(r.n, 8) + flag);
  }
  console.log("    " + "─".repeat(46));
  console.log("    " + pad("SUBTOTAL", 14) + pad("(has_open_cert)", 24) + rpad(t2Sum, 8));
  console.log("");

  // T2 sample rows per cell
  const t2Samples = await pool.query<{
    d085: string;
    part_class: PartClass;
    rn: number;
    id: string;
    canonical_name: string;
    sources: string[];
    open_parts_set: string[];
    open_on_d085: boolean;
  }>(`
    ${FEATURES_CTE}
    , ranked AS (
      SELECT
        CASE WHEN open_on_d085 THEN 'on_d085' ELSE 'not_on_d085' END AS d085,
        ${PART_CLASS_CASE("open")} AS part_class,
        id::text, canonical_name, sources, open_parts_set, open_on_d085,
        ROW_NUMBER() OVER (
          PARTITION BY
            CASE WHEN open_on_d085 THEN 'on_d085' ELSE 'not_on_d085' END,
            ${PART_CLASS_CASE("open")}
          ORDER BY canonical_name
        ) AS rn
      FROM features
      WHERE cert_rel = 'has_open_cert'
    )
    SELECT * FROM ranked
    WHERE rn <= ${SAMPLE_PER_BUCKET}
    ORDER BY d085, part_class, rn
  `);
  console.log("[triage] T2 samples (up to 5 per cell):");
  let prevCell = "";
  for (const r of t2Samples.rows) {
    const cell = `${r.d085} / ${r.part_class}`;
    if (cell !== prevCell) {
      const flag = r.d085 === "on_d085" && r.part_class === "contains_135" ? "  ← A.5 RECONCILE" : "";
      console.log(`    ${cell}${flag}`);
      prevCell = cell;
    }
    console.log(
      `        ${pad(trunc(r.canonical_name, 48), 48)}  sources=${fmtArr(r.sources)}  parts=${fmtArr(r.open_parts_set)}`,
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // T3. has_closed_cert_only × part_class
  // ════════════════════════════════════════════════════════════════════════

  const t3 = await pool.query<T3Row>(`
    ${FEATURES_CTE}
    SELECT
      ${PART_CLASS_CASE("closed")} AS part_class,
      COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_closed_cert_only'
    GROUP BY 1
    ORDER BY 1
  `);
  console.log("[triage] T3 has_closed_cert_only × part_class:");
  console.log("    " + pad("part_class", 24) + rpad("n", 8));
  console.log("    " + "─".repeat(32));
  let t3Sum = 0;
  for (const r of t3.rows) {
    t3Sum += r.n;
    console.log("    " + pad(r.part_class, 24) + rpad(r.n, 8));
  }
  console.log("    " + "─".repeat(32));
  console.log("    " + pad("SUBTOTAL", 24) + rpad(t3Sum, 8));
  console.log("");

  const t3Samples = await pool.query<{
    part_class: PartClass;
    rn: number;
    id: string;
    canonical_name: string;
    sources: string[];
    closed_parts_set: string[];
  }>(`
    ${FEATURES_CTE}
    , ranked AS (
      SELECT
        ${PART_CLASS_CASE("closed")} AS part_class,
        id::text, canonical_name, sources, closed_parts_set,
        ROW_NUMBER() OVER (
          PARTITION BY ${PART_CLASS_CASE("closed")}
          ORDER BY canonical_name
        ) AS rn
      FROM features
      WHERE cert_rel = 'has_closed_cert_only'
    )
    SELECT * FROM ranked
    WHERE rn <= ${SAMPLE_PER_BUCKET}
    ORDER BY part_class, rn
  `);
  console.log("[triage] T3 samples (up to 5 per cell):");
  prevCell = "";
  for (const r of t3Samples.rows) {
    if (r.part_class !== prevCell) {
      console.log(`    ${r.part_class}`);
      prevCell = r.part_class;
    }
    console.log(
      `        ${pad(trunc(r.canonical_name, 48), 48)}  sources=${fmtArr(r.sources)}  parts=${fmtArr(r.closed_parts_set)}`,
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // T4. no_cert_relationship × source_mix
  // ════════════════════════════════════════════════════════════════════════

  const t4 = await pool.query<T4Row>(`
    ${FEATURES_CTE}
    SELECT source_mix, COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'no_cert_relationship'
    GROUP BY source_mix
    ORDER BY ${SOURCE_MIX_ORDER}
  `);
  console.log("[triage] T4 no_cert_relationship × source_mix:");
  console.log("    " + pad("source_mix", 24) + rpad("n", 8));
  console.log("    " + "─".repeat(32));
  let t4Sum = 0;
  for (const r of t4.rows) {
    t4Sum += r.n;
    console.log("    " + pad(r.source_mix, 24) + rpad(r.n, 8));
  }
  console.log("    " + "─".repeat(32));
  console.log("    " + pad("SUBTOTAL", 24) + rpad(t4Sum, 8));
  console.log("");

  const t4Samples = await pool.query<{
    source_mix: SourceMix;
    rn: number;
    id: string;
    canonical_name: string;
    sources: string[];
  }>(`
    ${FEATURES_CTE}
    , ranked AS (
      SELECT
        source_mix, id::text, canonical_name, sources,
        ROW_NUMBER() OVER (PARTITION BY source_mix ORDER BY canonical_name) AS rn
      FROM features
      WHERE cert_rel = 'no_cert_relationship'
    )
    SELECT * FROM ranked
    WHERE rn <= ${SAMPLE_PER_BUCKET}
    ORDER BY ${SOURCE_MIX_ORDER}, rn
  `);
  console.log("[triage] T4 samples (up to 5 per cell):");
  prevCell = "";
  for (const r of t4Samples.rows) {
    if (r.source_mix !== prevCell) {
      console.log(`    ${r.source_mix}`);
      prevCell = r.source_mix;
    }
    console.log(
      `        ${pad(trunc(r.canonical_name, 48), 48)}  sources=${fmtArr(r.sources)}`,
    );
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // T5. Name pattern flag totals (broad signal — no tagging proposal)
  // ════════════════════════════════════════════════════════════════════════

  const t5 = await pool.query<T5Row>(`
    ${FEATURES_CTE}
    SELECT
      COUNT(*) FILTER (WHERE has_llc)::int        AS has_llc,
      COUNT(*) FILTER (WHERE has_inc)::int        AS has_inc,
      COUNT(*) FILTER (WHERE has_group)::int      AS has_group,
      COUNT(*) FILTER (WHERE has_holdings)::int   AS has_holdings,
      COUNT(*) FILTER (WHERE has_services)::int   AS has_services,
      COUNT(*) FILTER (WHERE has_management)::int AS has_management,
      COUNT(*) FILTER (WHERE has_leasing)::int    AS has_leasing,
      COUNT(*) FILTER (WHERE has_capital)::int    AS has_capital
    FROM features
  `);
  const t5Row = t5.rows[0]!;
  console.log("[triage] T5 name pattern flag totals (broad signal — no tagging from this alone):");
  const t5Flags: Array<[string, number]> = [
    ["has_LLC", t5Row.has_llc],
    ["has_INC", t5Row.has_inc],
    ["has_GROUP", t5Row.has_group],
    ["has_HOLDINGS", t5Row.has_holdings],
    ["has_SERVICES", t5Row.has_services],
    ["has_MANAGEMENT", t5Row.has_management],
    ["has_LEASING", t5Row.has_leasing],
    ["has_CAPITAL", t5Row.has_capital],
  ];
  console.log("    " + pad("flag", 16) + rpad("n", 8) + "  sample names");
  console.log("    " + "─".repeat(80));
  for (const [flag, n] of t5Flags) {
    const samples = await pool.query<{ canonical_name: string }>(
      `${FEATURES_CTE}
       SELECT canonical_name FROM features WHERE ${flag.toLowerCase()} = TRUE
       ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}`,
    );
    const sampleNames = samples.rows.map((r) => trunc(r.canonical_name, 36)).join(" | ");
    console.log("    " + pad(flag, 16) + rpad(n, 8) + "  " + sampleNames);
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Mechanically-tagable subset proposal
  // ════════════════════════════════════════════════════════════════════════

  console.log("[triage] ═══════ Mechanically-tagable subset proposal ═══════");
  console.log("[triage] Convention (A.5 Phase 3): 0.95 = authoritative single-source upgrade.");
  console.log("[triage] FAA cert evidence is authoritative for cert-based types.");
  console.log("");

  // M1: open cert exactly {'121'} → part_121
  const m1 = await pool.query<MechanicalSubsetRow>(`
    ${FEATURES_CTE}
    SELECT COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_open_cert'
      AND array_length(open_parts_set, 1) = 1
      AND open_parts_set[1] = '121'
  `);
  const m1n = m1.rows[0]!.n;
  console.log(`  M1. ${rpad(m1n, 4)} operators with open cert operating_part EXACTLY {'121'}`);
  console.log(`        → mechanically taggable as part_121, confidence 0.95`);
  if (m1n > 0) {
    const m1Samples = await pool.query<SampleRow>(`
      ${FEATURES_CTE}
      SELECT id::text, canonical_name, sources, open_parts_set, closed_parts_set, open_on_d085
      FROM features
      WHERE cert_rel = 'has_open_cert'
        AND array_length(open_parts_set, 1) = 1
        AND open_parts_set[1] = '121'
      ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}
    `);
    for (const r of m1Samples.rows) {
      console.log(
        `        sample: ${pad(trunc(r.canonical_name, 44), 44)}  sources=${fmtArr(r.sources)}  d085=${r.open_on_d085}`,
      );
    }
  }
  console.log("");

  // M2: open cert exactly {'91K'} → part_91k
  const m2 = await pool.query<MechanicalSubsetRow>(`
    ${FEATURES_CTE}
    SELECT COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_open_cert'
      AND array_length(open_parts_set, 1) = 1
      AND open_parts_set[1] = '91K'
  `);
  const m2n = m2.rows[0]!.n;
  console.log(`  M2. ${rpad(m2n, 4)} operators with open cert operating_part EXACTLY {'91K'}`);
  console.log(`        → mechanically taggable as part_91k, confidence 0.95`);
  if (m2n > 0) {
    const m2Samples = await pool.query<SampleRow>(`
      ${FEATURES_CTE}
      SELECT id::text, canonical_name, sources, open_parts_set, closed_parts_set, open_on_d085
      FROM features
      WHERE cert_rel = 'has_open_cert'
        AND array_length(open_parts_set, 1) = 1
        AND open_parts_set[1] = '91K'
      ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}
    `);
    for (const r of m2Samples.rows) {
      console.log(
        `        sample: ${pad(trunc(r.canonical_name, 44), 44)}  sources=${fmtArr(r.sources)}  d085=${r.open_on_d085}`,
      );
    }
  }
  console.log("");

  // M3: closed-only exactly {'135'} → defunct (subtype part_135)
  const m3 = await pool.query<MechanicalSubsetRow>(`
    ${FEATURES_CTE}
    SELECT COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_closed_cert_only'
      AND array_length(closed_parts_set, 1) = 1
      AND closed_parts_set[1] = '135'
  `);
  const m3n = m3.rows[0]!.n;
  console.log(`  M3. ${rpad(m3n, 4)} operators with closed-only cert operating_part EXACTLY {'135'}`);
  console.log(`        → mechanically taggable as defunct (former part_135), confidence 0.95`);
  if (m3n > 0) {
    const m3Samples = await pool.query<SampleRow>(`
      ${FEATURES_CTE}
      SELECT id::text, canonical_name, sources, open_parts_set, closed_parts_set, open_on_d085
      FROM features
      WHERE cert_rel = 'has_closed_cert_only'
        AND array_length(closed_parts_set, 1) = 1
        AND closed_parts_set[1] = '135'
      ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}
    `);
    for (const r of m3Samples.rows) {
      console.log(
        `        sample: ${pad(trunc(r.canonical_name, 44), 44)}  sources=${fmtArr(r.sources)}`,
      );
    }
  }
  console.log("");

  // M4: closed-only exactly {'121'} → defunct (subtype part_121)
  const m4 = await pool.query<MechanicalSubsetRow>(`
    ${FEATURES_CTE}
    SELECT COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_closed_cert_only'
      AND array_length(closed_parts_set, 1) = 1
      AND closed_parts_set[1] = '121'
  `);
  const m4n = m4.rows[0]!.n;
  console.log(`  M4. ${rpad(m4n, 4)} operators with closed-only cert operating_part EXACTLY {'121'}`);
  console.log(`        → mechanically taggable as defunct (former part_121), confidence 0.95`);
  if (m4n > 0) {
    const m4Samples = await pool.query<SampleRow>(`
      ${FEATURES_CTE}
      SELECT id::text, canonical_name, sources, open_parts_set, closed_parts_set, open_on_d085
      FROM features
      WHERE cert_rel = 'has_closed_cert_only'
        AND array_length(closed_parts_set, 1) = 1
        AND closed_parts_set[1] = '121'
      ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}
    `);
    for (const r of m4Samples.rows) {
      console.log(
        `        sample: ${pad(trunc(r.canonical_name, 44), 44)}  sources=${fmtArr(r.sources)}`,
      );
    }
  }
  console.log("");

  // M5: closed-only exactly {'91K'} → defunct (subtype part_91k)
  const m5 = await pool.query<MechanicalSubsetRow>(`
    ${FEATURES_CTE}
    SELECT COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_closed_cert_only'
      AND array_length(closed_parts_set, 1) = 1
      AND closed_parts_set[1] = '91K'
  `);
  const m5n = m5.rows[0]!.n;
  console.log(`  M5. ${rpad(m5n, 4)} operators with closed-only cert operating_part EXACTLY {'91K'}`);
  console.log(`        → mechanically taggable as defunct (former part_91k), confidence 0.95`);
  console.log("");

  // M6: A.5 reconciliation cell — DO NOT TAG
  const m6 = await pool.query<MechanicalSubsetRow>(`
    ${FEATURES_CTE}
    SELECT COUNT(*)::int AS n
    FROM features
    WHERE cert_rel = 'has_open_cert'
      AND open_on_d085 = TRUE
      AND open_contains_135 = TRUE
  `);
  const m6n = m6.rows[0]!.n;
  console.log(`  M6. ${rpad(m6n, 4)} operators in on_d085 ∩ open_contains_135 (A.5 RECONCILIATION CELL)`);
  console.log(`        → DO NOT mechanically tag. These should have been tagged by the A.5 Phase 3 run.`);
  console.log(`          Investigate why they were missed before Phase 4 covers them.`);
  if (m6n > 0) {
    const m6Samples = await pool.query<SampleRow>(`
      ${FEATURES_CTE}
      SELECT id::text, canonical_name, sources, open_parts_set, closed_parts_set, open_on_d085
      FROM features
      WHERE cert_rel = 'has_open_cert'
        AND open_on_d085 = TRUE
        AND open_contains_135 = TRUE
      ORDER BY canonical_name LIMIT ${SAMPLE_PER_BUCKET}
    `);
    for (const r of m6Samples.rows) {
      console.log(
        `        sample: ${pad(trunc(r.canonical_name, 44), 44)}  sources=${fmtArr(r.sources)}  parts=${fmtArr(r.open_parts_set)}`,
      );
    }
  }
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // Summary — the four confirmation answers (C1–C4) for the gate
  // ════════════════════════════════════════════════════════════════════════

  console.log("[triage] ═══════ Gate confirmation answers (C1–C4) ═══════");
  console.log("");
  console.log(`  C1. T1 cell sum = ${t1Sum}, expected ${NULL_TYPED_INVARIANT}.  ${t1Sum === NULL_TYPED_INVARIANT ? "✓ PARTITION OK" : "✗ BROKEN"}`);
  console.log("");
  console.log(`  C2. on_d085 ∩ open_contains_135 cell count: ${m6n}`);
  console.log(`        ${m6n === 0 ? "→ A.5 Phase 3 covered all on-D085 part_135 operators. No reconciliation gap." : "→ Investigate why A.5 missed these before Phase 4."}`);
  console.log("");
  console.log("  C3. Mechanically-tagable subsets:");
  console.log(`        M1 (open exactly {'121'} → part_121,  conf 0.95): n=${m1n}`);
  console.log(`        M2 (open exactly {'91K'} → part_91k, conf 0.95): n=${m2n}`);
  console.log(`        M3 (closed-only exactly {'135'} → defunct, conf 0.95): n=${m3n}`);
  console.log(`        M4 (closed-only exactly {'121'} → defunct, conf 0.95): n=${m4n}`);
  console.log(`        M5 (closed-only exactly {'91K'} → defunct, conf 0.95): n=${m5n}`);
  console.log(`        M6 (on_d085 ∩ open_contains_135): n=${m6n}  → DO NOT TAG, investigate`);
  console.log("");
  console.log(`  C4. Open-cert mechanical candidates (cleanest):`);
  console.log(`        has_open_cert with operating_part EXACTLY {'121'}: ${m1n}`);
  console.log(`        has_open_cert with operating_part EXACTLY {'91K'}: ${m2n}`);
  console.log("");
  console.log("[triage] STOP — no Phase 4 tagging from this script. Gate review next.");

  await pool.end();
}

main().catch((err) => {
  console.error("[triage] FATAL:", err);
  process.exit(1);
});
