/**
 * Phase 1 — Decompose the omr review queue.
 *
 * Path A — Stage 2 close-out per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Read-only analysis. Buckets all pending operator_match_review rows by
 * stored `_resolver_reason` from scraped_payload JSONB. For each bucket,
 * counts how many would auto-resolve if the resolver re-ran today against
 * current canonical state (post-A.6 dedup, post-A.6.5 normalize-match guard).
 *
 * Two mechanical auto-resolve classes:
 *
 *   Type A — dedup-unblocked.
 *     candidate_matches has 2+ entries with top and runner-up scores
 *     within AMBIGUITY_EPSILON (0.02), AND exactly one of the top two
 *     no longer exists in public.operators (was deduped in A.6). The
 *     resolver was uncertain at write time; today it would auto-match
 *     to the surviving candidate. Does NOT depend on
 *     scraped_payload._resolver_reason — that field is NULL for older
 *     omr rows from code paths that pre-date the writeReview reason
 *     field. Score-similarity + structure is the load-bearing signal.
 *
 *   Type B — normalize-match.
 *     ANY structure. scraped_name normalize-equals an existing
 *     operator's canonical_name under the LOWER + TRIM + REGEXP_REPLACE
 *     expression installed in 2026-05-05-001-operators-canonical-name-
 *     unique-idx.sql. This catches rows queued before A.6.5's
 *     normalize-match guard (commit fe9fc17) was added to the resolver.
 *
 * The two classes can overlap (an ambiguous_runner_up where the top is also
 * a normalize-match). The bucket breakdown counts each class separately;
 * sample rows annotate which class(es) apply.
 *
 * Expected per A.6 close-out:
 *   - 5 dedup-unblocked rows: omr ids 1955, 1982, 2001, 2017, 2195
 *   - 10 normalize-match rows (ids surfaced by this script)
 *
 * Outliers from the A.6 doc to reconcile:
 *   - 9 rows attributed to "gate_downgrade" reason in the A.6 narrative,
 *     but the resolver's reason enum has only 3 values
 *     (ambiguous_runner_up | low_tier | medium_name_only). This script
 *     groups by the actual stored value to see what's there.
 *
 * No writes. Default and only mode is read-only analysis.
 *
 * Usage:
 *   npx tsx scripts/decompose-omr-queue-2026-05-06.ts
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const EXPECTED_DEDUP_UNBLOCKED_IDS = [1955, 1982, 2001, 2017, 2195];
const SAMPLE_PER_BUCKET = 5;

// Mirrors AMBIGUITY_EPSILON in src/entity-resolution/match-thresholds.ts.
// A row is "ambiguous_runner_up in spirit" when top and runner-up scores
// are within this delta — regardless of whether the stored
// _resolver_reason field captured it (older code paths left it NULL).
const AMBIGUITY_EPSILON = 0.02;

// ── Types ─────────────────────────────────────────────────────────────────

interface BucketRow {
  reason: string;
  n: number;
  n_dedup_unblocked: number;
  n_normalize_match: number;
  n_either: number;
}

interface SampleRow {
  id: number;
  scraped_name: string;
  scraped_source: string;
  top_id: string | null;
  top_canonical_name: string | null;
  top_score: string | null;
  top_still_exists: boolean | null;
  runner_up_id: string | null;
  runner_up_canonical_name: string | null;
  runner_up_score: string | null;
  runner_up_still_exists: boolean | null;
  normalize_match_id: string | null;
  normalize_match_canonical_name: string | null;
  is_dedup_unblocked: boolean;
  is_normalize_match: boolean;
}

interface VerifyDedupRow {
  id: number;
  scraped_name: string;
  stored_reason: string | null;
  top_score: string | null;
  runner_up_score: string | null;
  top_still_exists: boolean;
  runner_up_still_exists: boolean;
  is_dedup_unblocked: boolean;
}

// ── SQL ───────────────────────────────────────────────────────────────────

const NORMALIZE_EXPR = `LOWER(TRIM(REGEXP_REPLACE($COL$, '\\s+', ' ', 'g')))`;

const BUCKET_SQL = `
WITH pending AS (
  SELECT
    omr.id,
    omr.scraped_name,
    omr.scraped_payload->>'_resolver_reason' AS stored_reason,
    jsonb_array_length(omr.candidate_matches)              AS n_candidates,
    NULLIF(omr.candidate_matches->0->>'operator_id', '')::uuid AS top_id,
    NULLIF(omr.candidate_matches->0->>'score', '')::numeric    AS top_score,
    NULLIF(omr.candidate_matches->1->>'operator_id', '')::uuid AS runner_up_id,
    NULLIF(omr.candidate_matches->1->>'score', '')::numeric    AS runner_up_score
  FROM operator_match_review omr
  WHERE omr.status = 'pending'
),
classified AS (
  SELECT
    p.id,
    COALESCE(p.stored_reason, 'NULL') AS reason,
    -- Type A: dedup-unblocked. 2+ candidates within AMBIGUITY_EPSILON,
    -- exactly one of the top two no longer exists. Catches the 5 expected
    -- rows even when stored_reason is NULL (older writeReview path).
    (p.n_candidates >= 2
     AND p.top_score IS NOT NULL
     AND p.runner_up_score IS NOT NULL
     AND (p.top_score - p.runner_up_score) < $1::numeric
     AND p.top_id IS NOT NULL
     AND p.runner_up_id IS NOT NULL
     AND (
       (    EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
        AND NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
       OR
       (NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
        AND EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
     )
    ) AS is_dedup_unblocked,
    -- Type B: scraped_name normalize-equals an existing operator
    EXISTS (
      SELECT 1 FROM operators o
       WHERE ${NORMALIZE_EXPR.replace("$COL$", "o.canonical_name")}
           = ${NORMALIZE_EXPR.replace("$COL$", "p.scraped_name")}
    ) AS is_normalize_match
  FROM pending p
)
SELECT
  reason,
  COUNT(*)::int AS n,
  COUNT(*) FILTER (WHERE is_dedup_unblocked)::int AS n_dedup_unblocked,
  COUNT(*) FILTER (WHERE is_normalize_match)::int AS n_normalize_match,
  COUNT(*) FILTER (WHERE is_dedup_unblocked OR is_normalize_match)::int AS n_either
FROM classified
GROUP BY reason
ORDER BY n DESC
`;

const SAMPLE_SQL = `
WITH pending AS (
  SELECT
    omr.id,
    omr.scraped_name,
    omr.scraped_source,
    omr.scraped_payload->>'_resolver_reason' AS stored_reason,
    jsonb_array_length(omr.candidate_matches)              AS n_candidates,
    NULLIF(omr.candidate_matches->0->>'operator_id', '')::uuid AS top_id,
    omr.candidate_matches->0->>'canonical_name' AS top_canonical_name,
    NULLIF(omr.candidate_matches->0->>'score', '')::numeric AS top_score_num,
    omr.candidate_matches->0->>'score' AS top_score,
    NULLIF(omr.candidate_matches->1->>'operator_id', '')::uuid AS runner_up_id,
    omr.candidate_matches->1->>'canonical_name' AS runner_up_canonical_name,
    NULLIF(omr.candidate_matches->1->>'score', '')::numeric AS runner_up_score_num,
    omr.candidate_matches->1->>'score' AS runner_up_score
  FROM operator_match_review omr
  WHERE omr.status = 'pending'
)
SELECT
  p.id,
  p.scraped_name,
  p.scraped_source,
  p.top_id::text       AS top_id,
  p.top_canonical_name,
  p.top_score,
  CASE
    WHEN p.top_id IS NULL THEN NULL
    ELSE EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
  END AS top_still_exists,
  p.runner_up_id::text AS runner_up_id,
  p.runner_up_canonical_name,
  p.runner_up_score,
  CASE
    WHEN p.runner_up_id IS NULL THEN NULL
    ELSE EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id)
  END AS runner_up_still_exists,
  (SELECT o.id::text FROM operators o
    WHERE ${NORMALIZE_EXPR.replace("$COL$", "o.canonical_name")}
        = ${NORMALIZE_EXPR.replace("$COL$", "p.scraped_name")}
    LIMIT 1) AS normalize_match_id,
  (SELECT o.canonical_name FROM operators o
    WHERE ${NORMALIZE_EXPR.replace("$COL$", "o.canonical_name")}
        = ${NORMALIZE_EXPR.replace("$COL$", "p.scraped_name")}
    LIMIT 1) AS normalize_match_canonical_name,
  (p.n_candidates >= 2
   AND p.top_score_num IS NOT NULL
   AND p.runner_up_score_num IS NOT NULL
   AND (p.top_score_num - p.runner_up_score_num) < $3::numeric
   AND p.top_id IS NOT NULL
   AND p.runner_up_id IS NOT NULL
   AND (
     (    EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
      AND NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
     OR
     (NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
      AND EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
   )
  ) AS is_dedup_unblocked,
  EXISTS (
    SELECT 1 FROM operators o
     WHERE ${NORMALIZE_EXPR.replace("$COL$", "o.canonical_name")}
         = ${NORMALIZE_EXPR.replace("$COL$", "p.scraped_name")}
  ) AS is_normalize_match
FROM pending p
WHERE COALESCE(p.stored_reason, 'NULL') = $1
ORDER BY p.id
LIMIT $2
`;

const VERIFY_DEDUP_SQL = `
WITH pending AS (
  SELECT
    omr.id,
    omr.scraped_name,
    omr.scraped_payload->>'_resolver_reason' AS stored_reason,
    jsonb_array_length(omr.candidate_matches)              AS n_candidates,
    NULLIF(omr.candidate_matches->0->>'operator_id', '')::uuid AS top_id,
    NULLIF(omr.candidate_matches->0->>'score', '')::numeric    AS top_score,
    NULLIF(omr.candidate_matches->1->>'operator_id', '')::uuid AS runner_up_id,
    NULLIF(omr.candidate_matches->1->>'score', '')::numeric    AS runner_up_score
  FROM operator_match_review omr
  WHERE omr.id = ANY($1::int[])
)
SELECT
  p.id,
  p.scraped_name,
  p.stored_reason,
  p.top_score::text     AS top_score,
  p.runner_up_score::text AS runner_up_score,
  COALESCE((SELECT TRUE FROM operators o WHERE o.id = p.top_id), FALSE)       AS top_still_exists,
  COALESCE((SELECT TRUE FROM operators o WHERE o.id = p.runner_up_id), FALSE) AS runner_up_still_exists,
  (p.n_candidates >= 2
   AND p.top_score IS NOT NULL
   AND p.runner_up_score IS NOT NULL
   AND (p.top_score - p.runner_up_score) < $2::numeric
   AND p.top_id IS NOT NULL
   AND p.runner_up_id IS NOT NULL
   AND (
     (    EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
      AND NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
     OR
     (NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
      AND EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
   )
  ) AS is_dedup_unblocked
FROM pending p
ORDER BY p.id
`;

const DEDUP_UNBLOCKED_LIST_SQL = `
WITH pending AS (
  SELECT
    omr.id,
    omr.scraped_name,
    omr.scraped_source,
    omr.scraped_payload->>'_resolver_reason' AS stored_reason,
    jsonb_array_length(omr.candidate_matches)              AS n_candidates,
    NULLIF(omr.candidate_matches->0->>'operator_id', '')::uuid AS top_id,
    omr.candidate_matches->0->>'canonical_name' AS top_canonical_name,
    NULLIF(omr.candidate_matches->0->>'score', '')::numeric    AS top_score,
    NULLIF(omr.candidate_matches->1->>'operator_id', '')::uuid AS runner_up_id,
    omr.candidate_matches->1->>'canonical_name' AS runner_up_canonical_name,
    NULLIF(omr.candidate_matches->1->>'score', '')::numeric    AS runner_up_score
  FROM operator_match_review omr
  WHERE omr.status = 'pending'
)
SELECT
  p.id,
  p.scraped_name,
  p.scraped_source,
  COALESCE(p.stored_reason, 'NULL') AS stored_reason,
  p.top_score::text     AS top_score,
  p.runner_up_score::text AS runner_up_score,
  EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)        AS top_exists,
  EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id) AS runner_up_exists,
  p.top_canonical_name,
  p.runner_up_canonical_name,
  -- The surviving operator_id (whichever side wasn't deduped)
  CASE
    WHEN EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id) THEN p.top_id::text
    WHEN EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id) THEN p.runner_up_id::text
    ELSE NULL
  END AS surviving_operator_id,
  -- Surviving canonical_name for display
  CASE
    WHEN EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id) THEN p.top_canonical_name
    WHEN EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id) THEN p.runner_up_canonical_name
    ELSE NULL
  END AS surviving_canonical_name
FROM pending p
WHERE p.n_candidates >= 2
  AND p.top_score IS NOT NULL
  AND p.runner_up_score IS NOT NULL
  AND (p.top_score - p.runner_up_score) < $1::numeric
  AND p.top_id IS NOT NULL
  AND p.runner_up_id IS NOT NULL
  AND (
    (    EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
     AND NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
    OR
    (NOT EXISTS (SELECT 1 FROM operators o WHERE o.id = p.top_id)
     AND EXISTS (SELECT 1 FROM operators o WHERE o.id = p.runner_up_id))
  )
ORDER BY p.id
`;

const NORMALIZE_LIST_SQL = `
WITH pending AS (
  SELECT
    omr.id,
    omr.scraped_name,
    omr.scraped_source,
    omr.scraped_payload->>'_resolver_reason' AS stored_reason
  FROM operator_match_review omr
  WHERE omr.status = 'pending'
)
SELECT
  p.id,
  p.scraped_name,
  p.scraped_source,
  COALESCE(p.stored_reason, 'NULL') AS stored_reason,
  o.id::text       AS normalize_match_id,
  o.canonical_name AS normalize_match_canonical_name
FROM pending p
JOIN operators o
  ON ${NORMALIZE_EXPR.replace("$COL$", "o.canonical_name")}
   = ${NORMALIZE_EXPR.replace("$COL$", "p.scraped_name")}
ORDER BY p.id
`;

const TOTAL_PENDING_SQL = `
SELECT COUNT(*)::int AS n FROM operator_match_review WHERE status = 'pending'
`;

// ── Output helpers ────────────────────────────────────────────────────────

function pad(s: string | null | number, n: number): string {
  const str = s === null ? "—" : String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function trunc(s: string | null, n: number): string {
  if (s === null) return "—";
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

  console.log("[decompose-omr] Mode: READ-ONLY ANALYSIS");
  console.log(`[decompose-omr] Expected dedup-unblocked omr ids: ${EXPECTED_DEDUP_UNBLOCKED_IDS.join(", ")}`);
  console.log("");

  // ── Total pending ───────────────────────────────────────────────────────

  const total = await pool.query<{ n: number }>(TOTAL_PENDING_SQL);
  const totalN = total.rows[0]!.n;
  console.log(`[decompose-omr] Total pending omr rows: ${totalN}`);
  console.log("");

  // ── Bucket breakdown ────────────────────────────────────────────────────

  const buckets = await pool.query<BucketRow>(BUCKET_SQL, [AMBIGUITY_EPSILON]);
  console.log("[decompose-omr] Bucket breakdown by stored _resolver_reason:");
  console.log(
    "    " +
      pad("reason", 26) +
      pad("n", 8) +
      pad("dedup_unblocked", 18) +
      pad("normalize_match", 18) +
      pad("either", 8),
  );
  console.log("    " + "─".repeat(78));
  let sumN = 0;
  let sumDedup = 0;
  let sumNorm = 0;
  let sumEither = 0;
  for (const r of buckets.rows) {
    sumN += r.n;
    sumDedup += r.n_dedup_unblocked;
    sumNorm += r.n_normalize_match;
    sumEither += r.n_either;
    console.log(
      "    " +
        pad(r.reason, 26) +
        pad(r.n, 8) +
        pad(r.n_dedup_unblocked, 18) +
        pad(r.n_normalize_match, 18) +
        pad(r.n_either, 8),
    );
  }
  console.log("    " + "─".repeat(78));
  console.log(
    "    " +
      pad("TOTAL", 26) +
      pad(sumN, 8) +
      pad(sumDedup, 18) +
      pad(sumNorm, 18) +
      pad(sumEither, 8),
  );
  console.log("");

  if (sumN !== totalN) {
    console.log(`[decompose-omr] ⚠ bucket sum (${sumN}) ≠ total pending (${totalN}) — investigate`);
    console.log("");
  }

  // ── Verify the 5 expected dedup-unblocked ids ───────────────────────────

  const verify = await pool.query<VerifyDedupRow>(VERIFY_DEDUP_SQL, [
    EXPECTED_DEDUP_UNBLOCKED_IDS,
    AMBIGUITY_EPSILON,
  ]);
  console.log("[decompose-omr] Verify 5 expected dedup-unblocked omr ids (1955/1982/2001/2017/2195):");
  console.log(
    "    " +
      pad("id", 8) +
      pad("scraped_name", 32) +
      pad("top_score", 12) +
      pad("ru_score", 12) +
      pad("top_exists", 12) +
      pad("ru_exists", 11) +
      pad("dedup_unblocked", 16),
  );
  console.log("    " + "─".repeat(103));
  for (const r of verify.rows) {
    console.log(
      "    " +
        pad(r.id, 8) +
        pad(trunc(r.scraped_name, 31), 32) +
        pad(r.top_score?.slice(0, 8) ?? "—", 12) +
        pad(r.runner_up_score?.slice(0, 8) ?? "—", 12) +
        pad(r.top_still_exists ? "yes" : "no", 12) +
        pad(r.runner_up_still_exists ? "yes" : "no", 11) +
        pad(r.is_dedup_unblocked ? "✓ YES" : "✗ NO", 16),
    );
  }
  const allFive = verify.rows.length === 5 && verify.rows.every((r) => r.is_dedup_unblocked);
  console.log(
    "    → " +
      (allFive
        ? "All 5 verified as dedup-unblocked."
        : `Only ${verify.rows.filter((r) => r.is_dedup_unblocked).length}/5 verified — investigate.`),
  );
  console.log("");

  // ── List all dedup-unblocked rows ───────────────────────────────────────

  const dedupList = await pool.query(DEDUP_UNBLOCKED_LIST_SQL, [AMBIGUITY_EPSILON]);
  const expectedSet = new Set(EXPECTED_DEDUP_UNBLOCKED_IDS);
  console.log(`[decompose-omr] All dedup-unblocked rows (n=${dedupList.rows.length}):`);
  console.log(
    "    " +
      pad("id", 8) +
      pad("scraped_name", 32) +
      pad("source", 14) +
      pad("reason", 22) +
      pad("score", 10) +
      pad("→ surviving canonical_name", 32) +
      pad("expected?", 10),
  );
  console.log("    " + "─".repeat(128));
  for (const r of dedupList.rows as Array<{
    id: number;
    scraped_name: string;
    scraped_source: string;
    stored_reason: string;
    top_score: string;
    surviving_canonical_name: string;
  }>) {
    console.log(
      "    " +
        pad(r.id, 8) +
        pad(trunc(r.scraped_name, 31), 32) +
        pad(r.scraped_source, 14) +
        pad(r.stored_reason, 22) +
        pad(r.top_score?.slice(0, 8) ?? "—", 10) +
        pad(trunc(r.surviving_canonical_name, 31), 32) +
        pad(expectedSet.has(r.id) ? "expected" : "+ extra", 10),
    );
  }
  console.log("");

  // ── List the normalize-match rows ───────────────────────────────────────

  const normList = await pool.query(NORMALIZE_LIST_SQL);
  console.log(`[decompose-omr] Normalize-match rows (n=${normList.rows.length}):`);
  console.log(
    "    " +
      pad("id", 8) +
      pad("scraped_name", 32) +
      pad("source", 14) +
      pad("stored_reason", 24) +
      pad("→ canonical_name", 32),
  );
  console.log("    " + "─".repeat(110));
  for (const r of normList.rows as Array<{
    id: number;
    scraped_name: string;
    scraped_source: string;
    stored_reason: string;
    normalize_match_id: string;
    normalize_match_canonical_name: string;
  }>) {
    console.log(
      "    " +
        pad(r.id, 8) +
        pad(trunc(r.scraped_name, 31), 32) +
        pad(r.scraped_source, 14) +
        pad(r.stored_reason, 24) +
        pad(trunc(r.normalize_match_canonical_name, 31), 32),
    );
  }
  console.log("");

  // ── Sample rows per bucket ──────────────────────────────────────────────

  for (const b of buckets.rows) {
    const sample = await pool.query<SampleRow>(SAMPLE_SQL, [
      b.reason,
      SAMPLE_PER_BUCKET,
      AMBIGUITY_EPSILON,
    ]);
    if (sample.rows.length === 0) continue;
    console.log(`[decompose-omr] SAMPLE reason='${b.reason}' (showing ${sample.rows.length} of ${b.n}):`);
    for (const r of sample.rows) {
      const flags: string[] = [];
      if (r.is_dedup_unblocked) flags.push("DEDUP-UNBLOCKED");
      if (r.is_normalize_match) flags.push("NORMALIZE-MATCH");
      const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
      console.log(
        `    omr#${r.id}  "${trunc(r.scraped_name, 40)}"  source=${r.scraped_source}${flagStr}`,
      );
      console.log(
        `        top:       ${trunc(r.top_canonical_name, 50)} (score=${r.top_score ?? "—"}, exists=${r.top_still_exists ?? "—"})`,
      );
      if (r.runner_up_id !== null) {
        console.log(
          `        runner-up: ${trunc(r.runner_up_canonical_name, 50)} (score=${r.runner_up_score ?? "—"}, exists=${r.runner_up_still_exists ?? "—"})`,
        );
      }
      if (r.normalize_match_id !== null) {
        console.log(`        normalize→ ${trunc(r.normalize_match_canonical_name, 50)}`);
      }
    }
    console.log("");
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log("[decompose-omr] Summary:");
  console.log(`    Pending omr rows:           ${totalN}`);
  console.log(`    Type A (dedup-unblocked):   ${sumDedup}  (expected 5)`);
  console.log(`    Type B (normalize-match):   ${sumNorm}  (expected 10)`);
  console.log(`    Either A or B (Phase 2):    ${sumEither}`);
  console.log("");
  console.log("[decompose-omr] Phase 2 mechanical reprocess scope per plan: the ");
  console.log("    ambiguous_runner_up dedup-unblocked rows + normalize-match rows.");
  console.log("    Anything beyond these goes to Phase 2.5 with explicit gate.");

  await pool.end();
}

main().catch((err) => {
  console.error("[decompose-omr] FATAL:", err);
  process.exit(1);
});
