/**
 * Track 6 Step 2c.5 Phase 1 — expand public.operators from the D085 pending
 * sidecar.
 *
 * Reads canonical.operator_holds_certificate_pending (resolved_at IS NULL,
 * source='faa_d085'). Groups by holder_name_normalized. For each unique
 * normalized name, classifies into one of three buckets:
 *
 *   B (collision: normalized exact match) — name matches an existing
 *     public.operators row by case-insensitive collapsed-whitespace UPPER
 *     equality. Step 2c's matcher would normally have caught this at score
 *     1.0; if it didn't, the firstSignificantWord pre-filter likely excluded
 *     the candidate. Route to public.operator_match_review for Phase 2 web
 *     verification — never auto-link a name 2c missed.
 *
 *   C (collision: resolver high-tier on rerun) — fresh resolver run produces
 *     a high-tier match (score >=0.91). Phase 1's pool has no signals
 *     (state/city/icao columns are NULL on candidates), so high-tier
 *     here is name-only — same Two-Source Rule logic applies. Route to
 *     review queue.
 *
 *   D (seed: no match) — the dominant bucket (~78% of input by 2c's pending
 *     rate). Create one public.operators row + one public.operator_identities
 *     row + one canonical.operator_holds_certificate row per pending window.
 *     UPDATE pending: resolved_at=NOW(), resolved_to_operator_id.
 *
 * No S3 reads, no D085 parser. Pending rows already carry the cert window.
 *
 * ── Source slugs ──────────────────────────────────────────────────────────
 *   public.operator_identities.source = 'faa' (CHECK enforced)
 *   public.operator_identities.match_method = 'self_creation_d085_seed'
 *   public.operator_identities.match_confidence = 'exact'
 *   canonical.operator_holds_certificate.source = 'faa_d085_seed'
 *   canonical.operator_holds_certificate.match_method = 'd085_self_seed'
 *   public.operator_match_review.scraped_payload.step = 'step2c.5_phase1_collision'
 *
 * ── Confidence ────────────────────────────────────────────────────────────
 *   public.operators.data_confidence_score = 0.70 (single-source D085-derived)
 *   canonical.operator_holds_certificate.confidence = 0.85 (link is high-trust
 *     because D085 directly states the cert→holder fact, even when the
 *     operator entity is single-sourced)
 *
 * ── Idempotency ───────────────────────────────────────────────────────────
 * Refused-if-populated. Three guard checks:
 *   - canonical.operator_holds_certificate WHERE source='faa_d085_seed'
 *   - public.operator_identities WHERE match_method='self_creation_d085_seed'
 *   - public.operator_match_review WHERE scraped_payload->>'step'='step2c.5_phase1_collision'
 * If any non-zero, exit cleanly. Manual rollback required for re-runs.
 *
 * ── Usage ─────────────────────────────────────────────────────────────────
 *   tsx scripts/expand-public-operators-from-d085-pending.ts                    # dry-run
 *   tsx scripts/expand-public-operators-from-d085-pending.ts --write            # commit
 *   tsx scripts/expand-public-operators-from-d085-pending.ts --max-entries=10   # smoke
 */

import "dotenv/config";
import pg from "pg";
import {
  type OperatorCandidate,
  type ScoredCandidate,
  scoreCandidates,
  firstSignificantWord,
} from "../src/entity-resolution/operator-resolver.js";
import {
  hasCorroboratingSignal,
  tierOf,
} from "../src/entity-resolution/match-thresholds.js";
import type { Source } from "../src/entity-resolution/operator-field-priority.js";

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE_LINK = "faa_d085_seed";
const MATCH_METHOD_LINK = "d085_self_seed";
const CONFIDENCE_LINK = 0.85;
const ROLE = "holder_of_record";

const SOURCE_IDENTITY: Source = "faa";
const MATCH_METHOD_IDENTITY = "self_creation_d085_seed";
const MATCH_CONFIDENCE_IDENTITY = "exact";

const DATA_CONFIDENCE_OPERATOR = 0.7;

const STEP_TAG_COLLISION = "step2c.5_phase1_collision";
const CHECKPOINT = "track6_step2c5_phase1";
const PENDING_SOURCE_FILTER = "faa_d085";

// ── Types ─────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  maxEntries: number | null;
}

interface PendingRow {
  id: string;
  cert_id: string;
  holder_name_as_provided: string;
  holder_name_normalized: string;
  valid_from: string;
  valid_to: string | null;
  evidence: Record<string, unknown> | null;
  cert_designator: string;
}

type Bucket = "B" | "C" | "D";

interface WorkRow {
  holder_name_normalized: string;
  preferred_canonical_name: string;
  pending_rows: PendingRow[];
  collision_operator_id: string | null;
  collision_operator_name: string | null;
  resolver_top: ScoredCandidate | null;
  resolver_top_tier: "high" | "medium" | "low" | "new_operator" | null;
  resolver_runner_up_score: number | null;
  candidate_matches_top3: Array<{
    operator_id: string;
    canonical_name: string;
    score: number;
  }>;
  bucket: Bucket;
  reason: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const maxFlag = args.find((a) => a.startsWith("--max-entries="));
  return {
    write,
    maxEntries: maxFlag ? Number.parseInt(maxFlag.split("=")[1]!, 10) : null,
  };
}

function formatRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Same normalization Step 2c stamps onto holder_name_normalized.
 * UPPER + collapse internal whitespace + trim. No suffix stripping.
 */
function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toUpperCase();
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = formatRunId();
  const cs = process.env["SUPABASE_DATABASE_URL"];
  if (!cs) {
    console.error("SUPABASE_DATABASE_URL not set. Add it to .env.");
    process.exit(1);
  }

  const pool = new pg.Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`[2c5-phase1] run_id=${runId}`);
  console.log(`[2c5-phase1] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  if (args.maxEntries !== null) {
    console.log(`[2c5-phase1] --max-entries=${args.maxEntries} (smoke mode)`);
  }

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    // ── Step 1: refused-if-populated guardrail ─────────────────────────────
    {
      const ohcSeed = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate WHERE source = $1`,
        [SOURCE_LINK],
      );
      const oiSeed = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM public.operator_identities WHERE match_method = $1`,
        [MATCH_METHOD_IDENTITY],
      );
      const omrSeed = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM public.operator_match_review
          WHERE scraped_source = 'faa' AND scraped_payload->>'step' = $1`,
        [STEP_TAG_COLLISION],
      );
      const ohcN = Number.parseInt(ohcSeed.rows[0]!.n, 10);
      const oiN = Number.parseInt(oiSeed.rows[0]!.n, 10);
      const omrN = Number.parseInt(omrSeed.rows[0]!.n, 10);
      if (ohcN > 0 || oiN > 0 || omrN > 0) {
        console.log(
          `[2c5-phase1] destination tables already populated ` +
            `(ohc[${SOURCE_LINK}]=${ohcN}, oi[${MATCH_METHOD_IDENTITY}]=${oiN}, ` +
            `omr[${STEP_TAG_COLLISION}]=${omrN}). Refusing to re-run. ` +
            `Manual rollback required.`,
        );
        return;
      }
    }

    // ── Step 2: load pending rows + cert designators ───────────────────────
    console.log(`\n[2c5-phase1] phase 1 of 4: load pending rows`);
    const pendingRes = await client.query<PendingRow>(
      `SELECT
         p.id::text AS id,
         p.cert_id::text AS cert_id,
         p.holder_name_as_provided,
         p.holder_name_normalized,
         p.valid_from::text AS valid_from,
         (p.valid_to::text) AS valid_to,
         p.evidence,
         c.faa_cert_number AS cert_designator
       FROM canonical.operator_holds_certificate_pending p
       JOIN canonical.certificates c ON c.cert_id = p.cert_id
       WHERE p.resolved_at IS NULL
         AND p.source = $1
       ORDER BY p.holder_name_normalized, p.valid_from`,
      [PENDING_SOURCE_FILTER],
    );
    console.log(`[2c5-phase1]   ${pendingRes.rowCount} unresolved pending rows`);

    // Group by holder_name_normalized (preserves valid_from sort order within group)
    const groups = new Map<string, PendingRow[]>();
    for (const row of pendingRes.rows) {
      let bucket = groups.get(row.holder_name_normalized);
      if (!bucket) {
        bucket = [];
        groups.set(row.holder_name_normalized, bucket);
      }
      bucket.push(row);
    }
    console.log(
      `[2c5-phase1]   ${groups.size} unique holder_name_normalized groups`,
    );

    let groupKeys = Array.from(groups.keys());
    if (args.maxEntries !== null) {
      groupKeys = groupKeys.slice(0, args.maxEntries);
      console.log(
        `[2c5-phase1]   capped to first ${args.maxEntries} groups via --max-entries`,
      );
    }

    // ── Step 3: load existing public.operators + build collision index ─────
    console.log(`\n[2c5-phase1] phase 2 of 4: load candidate pool`);
    const opsRes = await client.query<{
      operator_id: string;
      canonical_name: string;
      headquarters_icao: string | null;
    }>(
      `SELECT id::text AS operator_id, canonical_name, headquarters_icao
         FROM public.operators`,
    );
    console.log(
      `[2c5-phase1]   ${opsRes.rowCount} canonical operators in pool`,
    );

    const candidatePool: OperatorCandidate[] = opsRes.rows.map((r) => ({
      operator_id: r.operator_id,
      canonical_name: r.canonical_name,
      headquarters_icao: r.headquarters_icao,
      state: null,
      city: null,
    }));

    const collisionMap = new Map<
      string,
      { operator_id: string; canonical_name: string }
    >();
    for (const r of opsRes.rows) {
      collisionMap.set(normalize(r.canonical_name), {
        operator_id: r.operator_id,
        canonical_name: r.canonical_name,
      });
    }
    console.log(
      `[2c5-phase1]   ${collisionMap.size} unique normalized canonical names ` +
        `(collision lookup ready)`,
    );

    // ── Step 4: classify each group into Buckets B/C/D ─────────────────────
    console.log(`\n[2c5-phase1] phase 3 of 4: classification`);
    const workRows: WorkRow[] = [];
    let bucketB = 0;
    let bucketC = 0;
    let bucketD = 0;

    for (const key of groupKeys) {
      const pending = groups.get(key)!;
      // Earliest by valid_from (sorted in driver query). Tiebreak: first seen.
      const preferred = pending[0]!.holder_name_as_provided;

      // Collision check (Bucket B)
      const collision = collisionMap.get(key) ?? null;

      // Resolver re-run (Bucket C detection)
      const word = firstSignificantWord(preferred).toLowerCase();
      const filtered = word
        ? candidatePool.filter((c) =>
            c.canonical_name.toLowerCase().includes(word),
          )
        : [];
      const scored = scoreCandidates(
        {
          name: preferred,
          source: "faa" as Source,
          sourceId: "_step2c5_phase1_lookup",
        },
        filtered,
      );
      const top = scored[0] ?? null;
      const runner = scored[1] ?? null;
      const topTier = top ? tierOf(top.score) : null;
      const top3 = scored.slice(0, 3).map((c) => ({
        operator_id: c.operator_id,
        canonical_name: c.canonical_name,
        score: c.score,
      }));

      let bucket: Bucket;
      let reason: string;
      if (collision) {
        bucket = "B";
        reason = "normalized_exact_match_existing_operator";
        bucketB++;
      } else if (top && topTier === "high") {
        // High-tier name match the resolver missed in 2c. Phase 1's candidate
        // pool here has no state/city/icao signals (always NULL), so this is
        // name-only similarity — Two-Source Rule says route to review.
        bucket = "C";
        reason = hasCorroboratingSignal(top.signals)
          ? "resolver_high_tier_with_signal"
          : "resolver_high_tier_name_only";
        bucketC++;
      } else {
        bucket = "D";
        reason = "no_match_seed_new";
        bucketD++;
      }

      workRows.push({
        holder_name_normalized: key,
        preferred_canonical_name: preferred,
        pending_rows: pending,
        collision_operator_id: collision?.operator_id ?? null,
        collision_operator_name: collision?.canonical_name ?? null,
        resolver_top: top,
        resolver_top_tier: topTier,
        resolver_runner_up_score: runner?.score ?? null,
        candidate_matches_top3: top3,
        bucket,
        reason,
      });
    }

    console.log(`[2c5-phase1]   bucket distribution:`);
    console.log(
      `[2c5-phase1]     B (collision: normalized exact match): ${bucketB}`,
    );
    console.log(
      `[2c5-phase1]     C (collision: resolver high-tier):     ${bucketC}`,
    );
    console.log(
      `[2c5-phase1]     D (seed: no match):                    ${bucketD}`,
    );
    console.log(`[2c5-phase1]   total groups processed: ${workRows.length}`);

    const totalPendingCovered = workRows.reduce(
      (s, w) => s + w.pending_rows.length,
      0,
    );
    console.log(
      `[2c5-phase1]   total pending rows covered: ${totalPendingCovered}`,
    );

    // Sample output (top 10 of each bucket)
    const sampleBucket = (label: string, pred: (w: WorkRow) => boolean) => {
      const sample = workRows.filter(pred).slice(0, 10);
      if (sample.length === 0) {
        console.log(`[2c5-phase1]   sample ${label}: (none)`);
        return;
      }
      console.log(`[2c5-phase1]   sample ${label}:`);
      for (const w of sample) {
        const t = w.resolver_top;
        const certs = Array.from(
          new Set(w.pending_rows.map((p) => p.cert_designator)),
        ).slice(0, 3);
        const certStr =
          certs.length === w.pending_rows.length
            ? certs.join(",")
            : `${certs.join(",")}...`;
        console.log(
          `[2c5-phase1]     "${w.holder_name_normalized}" (${w.pending_rows.length} pending, certs=${certStr})` +
            (t ? `, top=${t.canonical_name} ${t.score.toFixed(3)}` : "") +
            (w.collision_operator_id
              ? `, collision=${w.collision_operator_name}`
              : ""),
        );
      }
    };
    sampleBucket("Bucket B", (w) => w.bucket === "B");
    sampleBucket("Bucket C", (w) => w.bucket === "C");
    sampleBucket("Bucket D", (w) => w.bucket === "D");

    // Write-phase counts for the summary
    const seedOperators = workRows.filter((w) => w.bucket === "D").length;
    const seedIdentities = seedOperators;
    const seedOhcRows = workRows
      .filter((w) => w.bucket === "D")
      .reduce((s, w) => s + w.pending_rows.length, 0);
    const omrRows = workRows.filter(
      (w) => w.bucket === "B" || w.bucket === "C",
    ).length;
    const pendingResolveRows = seedOhcRows;

    console.log(`\n[2c5-phase1]   inserts to perform:`);
    console.log(
      `[2c5-phase1]     public.operators:                           ${seedOperators}`,
    );
    console.log(
      `[2c5-phase1]     public.operator_identities:                 ${seedIdentities}`,
    );
    console.log(
      `[2c5-phase1]     canonical.operator_holds_certificate:       ${seedOhcRows}`,
    );
    console.log(
      `[2c5-phase1]     public.operator_match_review:               ${omrRows}`,
    );
    console.log(`[2c5-phase1]   updates to perform:`);
    console.log(
      `[2c5-phase1]     canonical.operator_holds_certificate_pending: ${pendingResolveRows} (resolve)`,
    );

    // ── Step 5: write transaction ──────────────────────────────────────────
    console.log(`\n[2c5-phase1] phase 4 of 4: write transaction`);
    await client.query("BEGIN");
    const startWrite = Date.now();

    let opsInserted = 0;
    let idInserted = 0;
    let ohcInserted = 0;
    let omrInserted = 0;
    let pendingResolved = 0;

    for (const w of workRows) {
      if (w.bucket === "D") {
        // 1. INSERT public.operators
        const opRes = await client.query<{ id: string }>(
          `INSERT INTO public.operators
             (canonical_name, type_tags, operator_type, data_confidence_score)
           VALUES ($1, '{}', NULL, $2)
           RETURNING id::text AS id`,
          [w.preferred_canonical_name, DATA_CONFIDENCE_OPERATOR],
        );
        const newOperatorId = opRes.rows[0]!.id;
        opsInserted++;

        // 2. INSERT public.operator_identities (one per operator)
        const certDesignators = Array.from(
          new Set(w.pending_rows.map((p) => p.cert_designator)),
        );
        const holderVariants = Array.from(
          new Set(w.pending_rows.map((p) => p.holder_name_as_provided)),
        );
        const matchEvidence = {
          step: "2c.5_phase1",
          source_detail: "faa_d085",
          cert_designators: certDesignators,
          holder_name_normalized: w.holder_name_normalized,
          holder_name_as_provided_variants: holderVariants,
          pending_count: w.pending_rows.length,
          ingest_run_id: runId,
          two_source_rule_status: "awaiting_corroboration",
          checkpoint: CHECKPOINT,
        };
        // source_id encodes (first cert + normalized name); JSONB carries the
        // full cert list. UNIQUE(source, source_id) is satisfied — each work
        // row produces exactly one identity row.
        const firstCert = certDesignators[0]!;
        const sourceId = `d085_seed:${firstCert}:${w.holder_name_normalized}`;
        await client.query(
          `INSERT INTO public.operator_identities
             (operator_id, source, source_id, name_as_provided,
              match_confidence, match_method, match_evidence)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            newOperatorId,
            SOURCE_IDENTITY,
            sourceId,
            w.preferred_canonical_name,
            MATCH_CONFIDENCE_IDENTITY,
            MATCH_METHOD_IDENTITY,
            JSON.stringify(matchEvidence),
          ],
        );
        idInserted++;

        // 3. INSERT canonical.operator_holds_certificate (one per pending row)
        for (const p of w.pending_rows) {
          const evidence = {
            step: "2c.5_phase1",
            cert_designator: p.cert_designator,
            holder_name_as_provided: p.holder_name_as_provided,
            holder_name_normalized: p.holder_name_normalized,
            preceded_by_pending_id: p.id,
            preceded_by_pending_evidence: p.evidence,
            ingest_run_id: runId,
            checkpoint: CHECKPOINT,
          };
          await client.query(
            `INSERT INTO canonical.operator_holds_certificate
               (operator_id, cert_id, role, valid_from, valid_to,
                source, source_url, source_timestamp, confidence,
                match_method, evidence)
             VALUES ($1, $2, $3, $4::date, $5::date, $6, NULL, NULL,
                     $7, $8, $9::jsonb)`,
            [
              newOperatorId,
              p.cert_id,
              ROLE,
              p.valid_from,
              p.valid_to,
              SOURCE_LINK,
              CONFIDENCE_LINK,
              MATCH_METHOD_LINK,
              JSON.stringify(evidence),
            ],
          );
          ohcInserted++;
        }

        // 4. UPDATE pending: resolve
        const pendingIds = w.pending_rows.map((p) => p.id);
        const updateRes = await client.query(
          `UPDATE canonical.operator_holds_certificate_pending
              SET resolved_at = NOW(),
                  resolved_to_operator_id = $1::uuid,
                  last_updated_at = NOW()
            WHERE id = ANY($2::uuid[])`,
          [newOperatorId, pendingIds],
        );
        pendingResolved += updateRes.rowCount ?? 0;
      } else {
        // Bucket B or C: write to operator_match_review. Pending rows stay
        // unresolved — Phase 2 closes them via web verification.
        const certDesignators = Array.from(
          new Set(w.pending_rows.map((p) => p.cert_designator)),
        );
        const firstCert = certDesignators[0]!;
        const payload = {
          step: STEP_TAG_COLLISION,
          bucket: w.bucket,
          reason: w.reason,
          holder_name_as_provided: w.preferred_canonical_name,
          holder_name_normalized: w.holder_name_normalized,
          collision_operator_id: w.collision_operator_id,
          collision_operator_name: w.collision_operator_name,
          resolver_top_canonical_name: w.resolver_top?.canonical_name ?? null,
          resolver_top_score: w.resolver_top?.score ?? null,
          resolver_top_tier: w.resolver_top_tier,
          resolver_runner_up_score: w.resolver_runner_up_score,
          pending_ids: w.pending_rows.map((p) => p.id),
          cert_designators: certDesignators,
          windows: w.pending_rows.map((p) => ({
            pending_id: p.id,
            cert_id: p.cert_id,
            cert_designator: p.cert_designator,
            valid_from: p.valid_from,
            valid_to: p.valid_to,
          })),
          ingest_run_id: runId,
          checkpoint: CHECKPOINT,
        };
        // For Bucket B, prepend the collision candidate at score 1.0 so
        // reviewers see it first; for Bucket C, just emit the resolver top-3.
        const candidateMatches: Array<Record<string, unknown>> =
          w.bucket === "B" && w.collision_operator_id
            ? [
                {
                  operator_id: w.collision_operator_id,
                  canonical_name: w.collision_operator_name,
                  score: 1.0,
                  signals: { nameSim: 1.0 },
                  origin: "normalized_exact_match",
                },
                ...w.candidate_matches_top3.map((c) => ({
                  ...c,
                  origin: "resolver_rerun",
                })),
              ]
            : w.candidate_matches_top3.map((c) => ({
                ...c,
                origin: "resolver_rerun",
              }));
        await client.query(
          `INSERT INTO public.operator_match_review
             (scraped_name, scraped_source, scraped_source_id,
              scraped_payload, candidate_matches)
           VALUES ($1, 'faa', $2, $3::jsonb, $4::jsonb)`,
          [
            w.preferred_canonical_name,
            `${SOURCE_LINK}:${firstCert}:${w.holder_name_normalized}`,
            JSON.stringify(payload),
            JSON.stringify(candidateMatches),
          ],
        );
        omrInserted++;
      }
    }

    const writeMs = Date.now() - startWrite;
    console.log(
      `\n[2c5-phase1]   inserts: ops=${opsInserted}, identities=${idInserted}, ` +
        `ohc=${ohcInserted}, omr=${omrInserted}, pending_resolved=${pendingResolved}, ` +
        `wall=${(writeMs / 1000).toFixed(1)}s`,
    );

    // ── Step 6: in-transaction verification ────────────────────────────────
    const verifyOps = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM public.operators`,
    );
    const verifyIdentities = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM public.operator_identities WHERE match_method = $1`,
      [MATCH_METHOD_IDENTITY],
    );
    const verifyOhc = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate WHERE source = $1`,
      [SOURCE_LINK],
    );
    const verifyOmr = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM public.operator_match_review
        WHERE scraped_payload->>'step' = $1`,
      [STEP_TAG_COLLISION],
    );
    const verifyPendingUnresolved = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.operator_holds_certificate_pending
        WHERE resolved_at IS NULL AND source = $1`,
      [PENDING_SOURCE_FILTER],
    );
    const verifyOhcWindows = await client.query<{
      open: string;
      closed: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE valid_to IS NULL)::bigint AS open,
         COUNT(*) FILTER (WHERE valid_to IS NOT NULL)::bigint AS closed
       FROM canonical.operator_holds_certificate WHERE source = $1`,
      [SOURCE_LINK],
    );

    console.log(`[2c5-phase1]   in-tx verification:`);
    console.log(
      `[2c5-phase1]     public.operators total:                              ${verifyOps.rows[0]!.n}`,
    );
    console.log(
      `[2c5-phase1]     operator_identities[${MATCH_METHOD_IDENTITY}]:        ${verifyIdentities.rows[0]!.n}`,
    );
    console.log(
      `[2c5-phase1]     operator_holds_certificate[${SOURCE_LINK}]:           ${verifyOhc.rows[0]!.n}`,
    );
    console.log(
      `[2c5-phase1]       open  (valid_to IS NULL):                          ${verifyOhcWindows.rows[0]!.open}`,
    );
    console.log(
      `[2c5-phase1]       closed (valid_to IS NOT NULL):                     ${verifyOhcWindows.rows[0]!.closed}`,
    );
    console.log(
      `[2c5-phase1]     operator_match_review[${STEP_TAG_COLLISION}]:        ${verifyOmr.rows[0]!.n}`,
    );
    console.log(
      `[2c5-phase1]     operator_holds_certificate_pending[unresolved]:       ${verifyPendingUnresolved.rows[0]!.n}`,
    );

    if (args.write) {
      await client.query("COMMIT");
      console.log(`\n[2c5-phase1] COMMIT. run_id=${runId}`);
      // Post-commit summary (re-query outside the transaction for confidence)
      const post = await client.query<{
        ops: string;
        identities: string;
        ohc: string;
        omr: string;
        pending_unresolved: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::bigint FROM public.operators) AS ops,
           (SELECT COUNT(*)::bigint FROM public.operator_identities
              WHERE match_method = $1) AS identities,
           (SELECT COUNT(*)::bigint FROM canonical.operator_holds_certificate
              WHERE source = $2) AS ohc,
           (SELECT COUNT(*)::bigint FROM public.operator_match_review
              WHERE scraped_payload->>'step' = $3) AS omr,
           (SELECT COUNT(*)::bigint FROM canonical.operator_holds_certificate_pending
              WHERE resolved_at IS NULL AND source = $4) AS pending_unresolved`,
        [
          MATCH_METHOD_IDENTITY,
          SOURCE_LINK,
          STEP_TAG_COLLISION,
          PENDING_SOURCE_FILTER,
        ],
      );
      const r = post.rows[0]!;
      console.log(
        `[2c5-phase1] verify post-commit: ops=${r.ops}, identities=${r.identities}, ` +
          `ohc=${r.ohc}, omr=${r.omr}, pending_unresolved=${r.pending_unresolved}`,
      );
    } else {
      await client.query("ROLLBACK");
      console.log(
        `\n[2c5-phase1] DRY-RUN: rolled back. Re-run with --write to apply.`,
      );
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error(
      "[2c5-phase1] FATAL:",
      err instanceof Error ? err.message : err,
    );
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
