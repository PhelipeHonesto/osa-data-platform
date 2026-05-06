/**
 * Session B Phase 1 — Read-only validation of the LLM ER queue.
 *
 * Path A — per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md
 * + design doc docs/plans/llm-er-pass-design.md.
 *
 * Validates that public.operator_llm_er_checkpoint contains the
 * expected 668-case queue per the Session B design:
 *
 *   Cohort A — step2c medium-tier residual:
 *     - input_step='step2c'                       (existing, ~342 rows)
 *     - input_step='step2c.5_phase1_collision'    (existing, ~9 rows)
 *     Total ~351 cases per migration 2026-04-25-002.
 *
 *   Cohort B — A.8 NULL-typed deferrals:
 *     - input_step='a8_null_typed_deferral'  (NEW, expect 317 rows)
 *     Sub-cohorts via reason slug (stored in firecrawl_pages or
 *     llm_evidence JSONB at init time per design doc):
 *       - p1_d085_seed_no_may1_attestation        166
 *       - p2_apr19_burst_synthetic                147
 *       - p2_apr19_burst_multi                     14
 *       - p3_realfleet_merge_no_canonical_cert      2
 *
 * If the A.8 deferrals are not yet routed, this script reports the
 * gap and recommends the routing as a separate write step before
 * Phase 2 (the actual LLM ER run).
 *
 * No writes. No CLI flags. Read-only by construction.
 *
 * Usage:
 *   npx tsx scripts/validate-llm-er-queue-2026-05-06.ts
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const SAMPLE_PER_BUCKET = 5;
const EXPECTED_COHORT_A_TOTAL = 351;
const EXPECTED_COHORT_B_TOTAL = 317;
const EXPECTED_TOTAL = 668;

const COHORT_A_STEPS = ["step2c", "step2c.5_phase1_collision"] as const;
const COHORT_B_STEP = "a8_null_typed_deferral" as const;

const EXPECTED_REASON_COUNTS = {
  p1_d085_seed_no_may1_attestation: 166,
  p2_apr19_burst_synthetic: 147,
  p2_apr19_burst_multi: 14,
  p3_realfleet_merge_no_canonical_cert: 2,
} as const;

// NULL-typed invariant from A.8 close-out (post-Phase-4a tagging of 154):
const NULL_TYPED_INVARIANT_POST_A8 = 317;

// ── Types ─────────────────────────────────────────────────────────────────

interface InputStepRow {
  input_step: string;
  status: string;
  n: number;
}

interface ReasonRow {
  reason: string | null;
  n: number;
}

interface SampleRow {
  id: string;
  input_review_id: number;
  input_step: string;
  status: string;
  attempt_count: number;
  scraped_name: string | null;
  scraped_source: string | null;
  reason: string | null;
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

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  console.log("[validate-queue] Mode: READ-ONLY ANALYSIS — no writes.");
  console.log("[validate-queue] Design doc: docs/plans/llm-er-pass-design.md");
  console.log("");

  // ── Pre-flight invariants ─────────────────────────────────────────────

  const operatorCounts = await pool.query<{
    total: number;
    null_typed: number;
    part_135: number;
  }>(`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE operator_type IS NULL)::int     AS null_typed,
      COUNT(*) FILTER (WHERE operator_type = 'part_135')::int AS part_135
    FROM public.operators
  `);
  const op = operatorCounts.rows[0]!;
  console.log("[validate-queue] Operator state (post-A.8 invariants):");
  console.log(`  • total: ${op.total}  (expected 1937)`);
  console.log(`  • part_135: ${op.part_135}  (expected 1615 post-Phase-4a)`);
  console.log(`  • NULL-typed: ${op.null_typed}  (expected ${NULL_TYPED_INVARIANT_POST_A8} post-Phase-4a)`);
  if (op.null_typed !== NULL_TYPED_INVARIANT_POST_A8) {
    console.log(`    ⚠ NULL-typed drift — investigate before routing A.8 deferrals`);
  }
  console.log("");

  // ── Q1: Total checkpoint rows ─────────────────────────────────────────

  const totalCkpt = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.operator_llm_er_checkpoint`,
  );
  const totalN = totalCkpt.rows[0]!.n;
  console.log(`[validate-queue] Q1 total checkpoint rows: ${totalN}  (expected ${EXPECTED_TOTAL})`);
  console.log("");

  // ── Q2: Breakdown by input_step × status ──────────────────────────────

  const stepStatus = await pool.query<InputStepRow>(`
    SELECT input_step, status, COUNT(*)::int AS n
    FROM public.operator_llm_er_checkpoint
    GROUP BY input_step, status
    ORDER BY input_step, status
  `);
  console.log("[validate-queue] Q2 breakdown by input_step × status:");
  console.log(
    "    " +
      pad("input_step", 36) +
      pad("status", 20) +
      rpad("n", 8),
  );
  console.log("    " + "─".repeat(64));
  let q2Sum = 0;
  const stepTotals: Record<string, number> = {};
  for (const r of stepStatus.rows) {
    q2Sum += r.n;
    stepTotals[r.input_step] = (stepTotals[r.input_step] ?? 0) + r.n;
    console.log(
      "    " + pad(r.input_step, 36) + pad(r.status, 20) + rpad(r.n, 8),
    );
  }
  console.log("    " + "─".repeat(64));
  console.log("    " + pad("TOTAL", 36) + pad("", 20) + rpad(q2Sum, 8));
  console.log("");

  // ── Q3: Cohort accounting ─────────────────────────────────────────────

  const cohortA = (stepTotals["step2c"] ?? 0) + (stepTotals["step2c.5_phase1_collision"] ?? 0);
  const cohortB = stepTotals[COHORT_B_STEP] ?? 0;
  const otherSteps = Object.entries(stepTotals)
    .filter(([s]) => !COHORT_A_STEPS.includes(s as typeof COHORT_A_STEPS[number]) && s !== COHORT_B_STEP)
    .map(([s, n]) => `${s}=${n}`);

  console.log("[validate-queue] Q3 cohort accounting:");
  console.log(`  Cohort A (step2c + step2c.5_phase1_collision): ${cohortA}  (expected ${EXPECTED_COHORT_A_TOTAL})`);
  console.log(`  Cohort B (a8_null_typed_deferral):              ${cohortB}  (expected ${EXPECTED_COHORT_B_TOTAL})`);
  if (otherSteps.length > 0) {
    console.log(`  Other unexpected input_step values:             ${otherSteps.join(", ")}`);
  }
  console.log(`  Total queue size:                               ${cohortA + cohortB}  (expected ${EXPECTED_TOTAL})`);
  console.log("");

  // ── Cohort gap detection ──────────────────────────────────────────────

  const cohortAGap = EXPECTED_COHORT_A_TOTAL - cohortA;
  const cohortBGap = EXPECTED_COHORT_B_TOTAL - cohortB;

  if (cohortAGap === 0) {
    console.log(`  ✓ Cohort A matches expected (${cohortA} = ${EXPECTED_COHORT_A_TOTAL})`);
  } else if (cohortAGap > 0) {
    console.log(`  ⚠ Cohort A short by ${cohortAGap} rows (expected ${EXPECTED_COHORT_A_TOTAL}, have ${cohortA})`);
  } else {
    console.log(`  ⚠ Cohort A has ${-cohortAGap} extra rows (expected ${EXPECTED_COHORT_A_TOTAL}, have ${cohortA})`);
  }

  if (cohortB === 0) {
    console.log(`  ✗ Cohort B not loaded — 0 rows with input_step='${COHORT_B_STEP}'`);
    console.log(`    The 317 A.8 NULL-typed deferrals need routing before Phase 2.`);
    console.log(`    Per design doc: scripts/route-a8-deferrals-to-llm-er-2026-XX-XX.ts`);
  } else if (cohortBGap === 0) {
    console.log(`  ✓ Cohort B matches expected (${cohortB} = ${EXPECTED_COHORT_B_TOTAL})`);
  } else if (cohortBGap > 0) {
    console.log(`  ⚠ Cohort B short by ${cohortBGap} rows (expected ${EXPECTED_COHORT_B_TOTAL}, have ${cohortB})`);
  } else {
    console.log(`  ⚠ Cohort B has ${-cohortBGap} extra rows (expected ${EXPECTED_COHORT_B_TOTAL}, have ${cohortB})`);
  }
  console.log("");

  // ── Q4: Cohort B reason breakdown (if loaded) ─────────────────────────

  if (cohortB > 0) {
    // Reason is expected to live in firecrawl_pages or llm_evidence JSONB
    // at init time per design doc. Try multiple candidate paths.
    const reasonBreakdown = await pool.query<ReasonRow>(`
      SELECT
        COALESCE(
          firecrawl_pages->>'a8_deferral_reason',
          llm_evidence->>'a8_deferral_reason',
          'unknown_or_missing'
        ) AS reason,
        COUNT(*)::int AS n
      FROM public.operator_llm_er_checkpoint
      WHERE input_step = $1
      GROUP BY 1
      ORDER BY n DESC
    `, [COHORT_B_STEP]);
    console.log("[validate-queue] Q4 Cohort B reason slug breakdown:");
    console.log("    " + pad("reason", 44) + rpad("n", 8) + rpad("expected", 12));
    console.log("    " + "─".repeat(64));
    let q4Sum = 0;
    for (const r of reasonBreakdown.rows) {
      q4Sum += r.n;
      const expected = (EXPECTED_REASON_COUNTS as Record<string, number>)[r.reason ?? "unknown"];
      const expectedStr = expected !== undefined ? String(expected) : "—";
      console.log("    " + pad(r.reason ?? "(NULL)", 44) + rpad(r.n, 8) + rpad(expectedStr, 12));
    }
    console.log("    " + "─".repeat(64));
    console.log("    " + pad("TOTAL", 44) + rpad(q4Sum, 8));
    console.log("");
  } else {
    console.log("[validate-queue] Q4 Cohort B reason breakdown: SKIPPED (cohort not loaded)");
    console.log("");
  }

  // ── Q5: Cohort A samples per input_step ───────────────────────────────

  for (const step of COHORT_A_STEPS) {
    const stepCount = stepTotals[step] ?? 0;
    if (stepCount === 0) continue;
    const samples = await pool.query<SampleRow>(`
      SELECT
        ckpt.id::text                  AS id,
        ckpt.input_review_id           AS input_review_id,
        ckpt.input_step                AS input_step,
        ckpt.status                    AS status,
        ckpt.attempt_count             AS attempt_count,
        omr.scraped_name               AS scraped_name,
        omr.scraped_source             AS scraped_source,
        NULL::text                     AS reason
      FROM public.operator_llm_er_checkpoint ckpt
      LEFT JOIN public.operator_match_review omr
        ON omr.id = ckpt.input_review_id
      WHERE ckpt.input_step = $1
      ORDER BY ckpt.input_review_id
      LIMIT ${SAMPLE_PER_BUCKET}
    `, [step]);
    console.log(`[validate-queue] Q5 samples for input_step='${step}' (showing ${samples.rows.length} of ${stepCount}):`);
    for (const r of samples.rows) {
      console.log(
        `    omr#${pad(r.input_review_id, 6)}  status=${pad(r.status, 18)}  attempts=${r.attempt_count}  src=${pad(r.scraped_source ?? "—", 8)}  name="${trunc(r.scraped_name, 36)}"`,
      );
    }
    console.log("");
  }

  // ── Q6: Cohort B samples per reason (if loaded) ───────────────────────

  if (cohortB > 0) {
    const cohortBSamples = await pool.query<SampleRow>(`
      WITH ranked AS (
        SELECT
          ckpt.id::text                  AS id,
          ckpt.input_review_id           AS input_review_id,
          ckpt.input_step                AS input_step,
          ckpt.status                    AS status,
          ckpt.attempt_count             AS attempt_count,
          o.canonical_name               AS scraped_name,
          NULL::text                     AS scraped_source,
          COALESCE(
            ckpt.firecrawl_pages->>'a8_deferral_reason',
            ckpt.llm_evidence->>'a8_deferral_reason'
          ) AS reason,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(
              ckpt.firecrawl_pages->>'a8_deferral_reason',
              ckpt.llm_evidence->>'a8_deferral_reason'
            )
            ORDER BY ckpt.input_review_id
          ) AS rn
        FROM public.operator_llm_er_checkpoint ckpt
        LEFT JOIN public.operators o
          ON o.id::text = (ckpt.firecrawl_pages->>'operator_id')
        WHERE ckpt.input_step = $1
      )
      SELECT * FROM ranked
      WHERE rn <= ${SAMPLE_PER_BUCKET}
      ORDER BY reason, rn
    `, [COHORT_B_STEP]);

    let prevReason = "";
    console.log(`[validate-queue] Q6 Cohort B samples per reason:`);
    for (const r of cohortBSamples.rows) {
      if (r.reason !== prevReason) {
        console.log(`  reason='${r.reason ?? "(NULL)"}':`);
        prevReason = r.reason ?? "(NULL)";
      }
      console.log(
        `    ckpt id=${r.id.slice(0, 8)}…  status=${pad(r.status, 16)}  name="${trunc(r.scraped_name, 36)}"`,
      );
    }
    console.log("");
  }

  // ── Q7: Lifecycle health check ────────────────────────────────────────

  const lifecycleStats = await pool.query<{
    status: string;
    n: number;
    avg_attempts: number;
    max_attempts: number;
  }>(`
    SELECT
      status,
      COUNT(*)::int AS n,
      ROUND(AVG(attempt_count)::numeric, 2)::float AS avg_attempts,
      MAX(attempt_count)::int AS max_attempts
    FROM public.operator_llm_er_checkpoint
    GROUP BY status
    ORDER BY status
  `);
  console.log("[validate-queue] Q7 lifecycle status health check:");
  console.log(
    "    " +
      pad("status", 22) +
      rpad("n", 8) +
      rpad("avg_attempts", 16) +
      rpad("max_attempts", 16),
  );
  console.log("    " + "─".repeat(62));
  for (const r of lifecycleStats.rows) {
    console.log(
      "    " +
        pad(r.status, 22) +
        rpad(r.n, 8) +
        rpad(r.avg_attempts, 16) +
        rpad(r.max_attempts, 16),
    );
  }
  console.log("");

  // ── Summary + Phase 2 readiness ───────────────────────────────────────

  console.log("[validate-queue] ═══════ Phase 2 readiness ═══════");
  console.log("");
  const ready =
    cohortA === EXPECTED_COHORT_A_TOTAL &&
    cohortB === EXPECTED_COHORT_B_TOTAL &&
    op.null_typed === NULL_TYPED_INVARIANT_POST_A8;
  if (ready) {
    console.log(`  ✓ Queue is fully loaded: ${cohortA + cohortB} = ${EXPECTED_TOTAL} cases`);
    console.log(`  ✓ NULL-typed invariant matches: ${op.null_typed} = ${NULL_TYPED_INVARIANT_POST_A8}`);
    console.log(`  → Phase 2 (LLM ER pass execution) can proceed.`);
  } else {
    console.log(`  ⚠ Queue NOT fully loaded.`);
    if (cohortA !== EXPECTED_COHORT_A_TOTAL) {
      console.log(`    Cohort A: have ${cohortA}, expected ${EXPECTED_COHORT_A_TOTAL}.`);
    }
    if (cohortB !== EXPECTED_COHORT_B_TOTAL) {
      console.log(`    Cohort B: have ${cohortB}, expected ${EXPECTED_COHORT_B_TOTAL}.`);
      if (cohortB === 0) {
        console.log(`    → Need to write + run the routing script before Phase 2:`);
        console.log(`      scripts/route-a8-deferrals-to-llm-er-2026-XX-XX.ts`);
        console.log(`      Per design doc: inserts 317 rows with input_step='a8_null_typed_deferral'`);
        console.log(`      and reason slug in evidence JSONB. Also adds the new step to`);
        console.log(`      ELIGIBLE_INPUT_STEPS in scripts/llm-er-pass-firecrawl.ts.`);
      }
    }
    if (op.null_typed !== NULL_TYPED_INVARIANT_POST_A8) {
      console.log(`    NULL-typed invariant: have ${op.null_typed}, expected ${NULL_TYPED_INVARIANT_POST_A8}.`);
      console.log(`    → Investigate operator state drift before routing.`);
    }
  }
  console.log("");
  console.log("[validate-queue] STOP — Phase 1 read-only complete. Gate review next.");

  await pool.end();
}

main().catch((err) => {
  console.error("[validate-queue] FATAL:", err);
  process.exit(1);
});
