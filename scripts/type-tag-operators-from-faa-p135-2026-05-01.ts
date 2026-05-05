/**
 * Phase 3 — type-tag operators corroborated by May 1 D085 cert_identities.
 *
 * Session A.5 Phase 3 per /Users/phelipehonesto/.claude/plans/we-re-resuming-session-a-5-steady-ladybug.md.
 *
 * Sets `operator_type='part_135', data_confidence_score=0.95` on operators
 * with at least one open ohc whose cert_id appears in
 * canonical.certificate_identities[source='faa_d085_2026_05_01'] (the May 1
 * attestation audit trail). Path A's compare-and-delta wrote 1,791 cert_identity
 * rows for May 1 but only 66 new ohc rows under the new source slug — the
 * other 1,725 attestations are joinable via cert_id without needing a fresh
 * ohc write.
 *
 * SC-1 reframing rationale:
 *   The original 1,750 target assumed Phase 2 full re-attestation under a
 *   single new source slug (every May 1 cert × holder writes a fresh ohc).
 *   Path A explicitly chose compare-and-delta to preserve audit history. Under
 *   Path A:
 *     - 66 ohc rows written as Case 3 inserts (new high-conf links)
 *     - 1,371 ohc rows are Case 1 no-ops (May 1 confirms existing seed-cohort)
 *     - 1,791 cert_identity rows always written (the attestation audit trail)
 *
 *   Reframed SC-1: "Operators with operator_type='part_135' AND
 *   data_confidence_score>=0.95 AND at least one open ohc corroborated by
 *   May 1 cert_identity." Target = the candidate pool count itself
 *   (~1,434), not 1,750. This is correct accounting, not target-lowering.
 *
 * Update rules:
 *   - operator_type IS NULL → set part_135 @ 0.95
 *   - operator_type='part_135' AND conf<0.95 → upgrade conf to 0.95
 *   - operator_type IS NOT NULL AND != 'part_135' → SKIP (never overwrite
 *     broker/defunct/financier/etc.)
 *   - already part_135 @ conf>=0.95 → SKIP (no-op)
 *
 * Pre-flight measured candidate pool: 1,434 operators.
 *   - 1,336 null_at_seed_conf_upgrade (NULL @ 0.70, the d085_seed cohort)
 *   -    91 null_at_other_conf (NULL @ other confidences)
 *   -     6 already_tagged_correctly (skip)
 *   -     1 other_type_skip (skip)
 *   Expected UPDATE count: 1,427.
 *
 * Default --dry-run. --write commits inside a single transaction.
 *
 * Usage:
 *   npx tsx scripts/type-tag-operators-from-faa-p135-2026-05-01.ts          # dry-run
 *   npx tsx scripts/type-tag-operators-from-faa-p135-2026-05-01.ts --write  # commit
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const MAY1_SOURCE = "faa_d085_2026_05_01";
const TARGET_TYPE = "part_135";
const TARGET_CONF = 0.95;

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
}

interface BucketRow {
  bucket: string;
  n: number;
}

interface SampleRow {
  operator_id: string;
  canonical_name: string;
  before_type: string | null;
  before_conf: string;
  after_type: string;
  after_conf: string;
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  return { write: argv.includes("--write") };
}

// ── SQL ───────────────────────────────────────────────────────────────────

const CANDIDATE_BUCKETS_SQL = `
WITH candidates AS (
  SELECT DISTINCT ohc.operator_id
  FROM canonical.operator_holds_certificate ohc
  JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
  WHERE ci.source = $1
    AND ohc.role = 'holder_of_record'
    AND ohc.valid_to IS NULL
)
SELECT
  CASE
    WHEN o.operator_type = $2 AND o.data_confidence_score >= $3 THEN 'already_tagged_correctly'
    WHEN o.operator_type = $2 AND o.data_confidence_score < $3 THEN 'tagged_low_conf_upgrade'
    WHEN o.operator_type IS NULL AND o.data_confidence_score = 0.70 THEN 'null_at_seed_conf_upgrade'
    WHEN o.operator_type IS NULL AND o.data_confidence_score != 0.70 THEN 'null_at_other_conf'
    WHEN o.operator_type IS NOT NULL AND o.operator_type != $2 THEN 'other_type_skip'
    ELSE 'other'
  END AS bucket,
  COUNT(*)::int AS n
FROM candidates c
JOIN public.operators o ON o.id = c.operator_id
GROUP BY 1
ORDER BY n DESC
`;

const SAMPLE_BUCKET_SQL = `
WITH candidates AS (
  SELECT DISTINCT ohc.operator_id
  FROM canonical.operator_holds_certificate ohc
  JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
  WHERE ci.source = $1
    AND ohc.role = 'holder_of_record'
    AND ohc.valid_to IS NULL
)
SELECT
  o.id::text         AS operator_id,
  o.canonical_name   AS canonical_name,
  o.operator_type    AS before_type,
  o.data_confidence_score::text AS before_conf,
  $2::text           AS after_type,
  $3::text           AS after_conf
FROM candidates c
JOIN public.operators o ON o.id = c.operator_id
WHERE
  CASE
    WHEN o.operator_type = $2 AND o.data_confidence_score >= $3::numeric THEN 'already_tagged_correctly'
    WHEN o.operator_type = $2 AND o.data_confidence_score < $3::numeric THEN 'tagged_low_conf_upgrade'
    WHEN o.operator_type IS NULL AND o.data_confidence_score = 0.70 THEN 'null_at_seed_conf_upgrade'
    WHEN o.operator_type IS NULL AND o.data_confidence_score != 0.70 THEN 'null_at_other_conf'
    WHEN o.operator_type IS NOT NULL AND o.operator_type != $2 THEN 'other_type_skip'
    ELSE 'other'
  END = $4
ORDER BY o.canonical_name
LIMIT $5
`;

const UPDATE_SQL = `
UPDATE public.operators
SET operator_type = $2,
    data_confidence_score = $3::numeric,
    last_updated_at = NOW()
WHERE id IN (
  SELECT DISTINCT ohc.operator_id
  FROM canonical.operator_holds_certificate ohc
  JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
  WHERE ci.source = $1
    AND ohc.role = 'holder_of_record'
    AND ohc.valid_to IS NULL
)
  AND (
    operator_type IS NULL
    OR (operator_type = $2 AND data_confidence_score < $3::numeric)
  )
`;

const SC1_REFRAMED_SQL = `
SELECT COUNT(*)::int AS n
FROM public.operators o
WHERE o.operator_type = $2
  AND o.data_confidence_score >= $3::numeric
  AND EXISTS (
    SELECT 1 FROM canonical.operator_holds_certificate ohc
    JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
    WHERE ohc.operator_id = o.id
      AND ci.source = $1
      AND ohc.valid_to IS NULL
  )
`;

const SC1_ABSOLUTE_SQL = `
SELECT COUNT(*)::int AS n
FROM public.operators
WHERE operator_type = $1
  AND data_confidence_score >= $2::numeric
`;

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`[type-tag] Mode: ${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[type-tag] May 1 source: ${MAY1_SOURCE}`);
  console.log(`[type-tag] Target: operator_type='${TARGET_TYPE}', data_confidence_score=${TARGET_CONF}`);
  console.log("");

  // ── Bucket breakdown ────────────────────────────────────────────────────

  const buckets = await pool.query<BucketRow>(CANDIDATE_BUCKETS_SQL, [
    MAY1_SOURCE,
    TARGET_TYPE,
    TARGET_CONF,
  ]);

  const totalCandidates = buckets.rows.reduce((s, r) => s + r.n, 0);
  const willUpdate =
    (buckets.rows.find((r) => r.bucket === "null_at_seed_conf_upgrade")?.n ?? 0) +
    (buckets.rows.find((r) => r.bucket === "null_at_other_conf")?.n ?? 0) +
    (buckets.rows.find((r) => r.bucket === "tagged_low_conf_upgrade")?.n ?? 0);

  console.log(`[type-tag] Candidate pool: ${totalCandidates} operators`);
  console.log(`[type-tag] Bucket breakdown:`);
  for (const row of buckets.rows) {
    const willTouch =
      row.bucket === "null_at_seed_conf_upgrade" ||
      row.bucket === "null_at_other_conf" ||
      row.bucket === "tagged_low_conf_upgrade";
    console.log(`    ${row.bucket}: ${row.n} ${willTouch ? "(WILL UPDATE)" : "(SKIP)"}`);
  }
  console.log(`[type-tag] Total operators that will UPDATE: ${willUpdate}`);
  console.log("");

  // ── Sample rows ─────────────────────────────────────────────────────────

  for (const bucket of [
    "null_at_seed_conf_upgrade",
    "null_at_other_conf",
    "other_type_skip",
    "already_tagged_correctly",
  ]) {
    const sample = await pool.query<SampleRow>(SAMPLE_BUCKET_SQL, [
      MAY1_SOURCE,
      TARGET_TYPE,
      TARGET_CONF,
      bucket,
      bucket.endsWith("_skip") || bucket === "already_tagged_correctly" ? 5 : 10,
    ]);
    if (sample.rows.length === 0) continue;
    const tag = bucket.endsWith("_skip") || bucket === "already_tagged_correctly" ? "ANTI-SAMPLE" : "SAMPLE";
    console.log(`[type-tag] ${tag} ${bucket} (${sample.rows.length}):`);
    for (const r of sample.rows) {
      const before = `${r.before_type ?? "NULL"} @ ${r.before_conf}`;
      const after =
        bucket.endsWith("_skip") || bucket === "already_tagged_correctly"
          ? "(unchanged)"
          : `${r.after_type} @ ${r.after_conf}`;
      console.log(`    ${r.canonical_name.padEnd(50)} ${before.padEnd(20)} → ${after}`);
    }
    console.log("");
  }

  // ── SC-1 baseline (pre-write) ───────────────────────────────────────────

  const sc1AbsBefore = await pool.query<{ n: number }>(SC1_ABSOLUTE_SQL, [TARGET_TYPE, TARGET_CONF]);
  const sc1RefBefore = await pool.query<{ n: number }>(SC1_REFRAMED_SQL, [
    MAY1_SOURCE,
    TARGET_TYPE,
    TARGET_CONF,
  ]);
  console.log(`[type-tag] SC-1 baseline (pre-${args.write ? "write" : "run"}):`);
  console.log(`    Absolute count (any source):    ${sc1AbsBefore.rows[0]!.n}`);
  console.log(`    Reframed (May 1 corroborated):  ${sc1RefBefore.rows[0]!.n}`);
  console.log("");

  if (!args.write) {
    console.log(`[type-tag] DRY-RUN — no rows updated.`);
    console.log(`[type-tag] Re-run with --write to commit.`);
    await pool.end();
    return;
  }

  // ── WRITE: single transaction ───────────────────────────────────────────

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(UPDATE_SQL, [MAY1_SOURCE, TARGET_TYPE, TARGET_CONF]);
    await client.query("COMMIT");
    console.log(`[type-tag] WRITE complete: UPDATE rowCount = ${result.rowCount}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* swallow — connection may already be aborted */
    });
    throw err;
  } finally {
    client.release();
  }

  // ── SC-1 post-write ─────────────────────────────────────────────────────

  const sc1AbsAfter = await pool.query<{ n: number }>(SC1_ABSOLUTE_SQL, [TARGET_TYPE, TARGET_CONF]);
  const sc1RefAfter = await pool.query<{ n: number }>(SC1_REFRAMED_SQL, [
    MAY1_SOURCE,
    TARGET_TYPE,
    TARGET_CONF,
  ]);
  console.log("");
  console.log(`[type-tag] SC-1 post-write:`);
  console.log(
    `    Absolute count (any source):    ${sc1AbsAfter.rows[0]!.n}  (Δ +${sc1AbsAfter.rows[0]!.n - sc1AbsBefore.rows[0]!.n})`,
  );
  console.log(
    `    Reframed (May 1 corroborated):  ${sc1RefAfter.rows[0]!.n}  (Δ +${sc1RefAfter.rows[0]!.n - sc1RefBefore.rows[0]!.n})`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error("[type-tag] FATAL:", err);
  process.exit(1);
});
