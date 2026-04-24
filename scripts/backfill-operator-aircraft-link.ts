/**
 * Checkpoint 3 — backfill canonical.operator_aircraft_link from
 * faa_aircraft.certificate_holder.
 *
 * For every canonical.aircraft row with a faa identity:
 *   1. Pre-filter (src/entity-resolution/pre-filters.ts). If the input is a
 *      trustee, placeholder, manufacturer-as-holder, null, or an individual
 *      registration (registrant_type='1'), short-circuit to the appropriate
 *      skip bucket and audit-log to operator_aircraft_resolution_log.
 *   2. Otherwise call resolveOperatorMatchOnly — read-only, never opens a
 *      new operators row.
 *   3. For matched / exact, check operator_type. If it falls in the
 *      blocklist (broker, billing_agent, financier, holding_co, defunct,
 *      trust_holder), log as 'matched_blocked_operator_type' and do NOT
 *      write to operator_aircraft_link. NULL operator_type passes through.
 *   4. Allowed matches land in canonical.operator_aircraft_link with
 *      role='operator', valid_from = faa.created_at::date, valid_to = NULL.
 *   5. Review-tier rows land in public.operator_match_review.
 *   6. Every decision — match, review, no_match, skip — gets one row in
 *      canonical.operator_aircraft_resolution_log with the scoring signals.
 *
 * Idempotency: rows with an existing resolution_log entry (any run) are
 * skipped. Re-running is safe and picks up where it stopped.
 *
 * Usage:
 *   tsx scripts/backfill-operator-aircraft-link.ts                   # dry-run (default)
 *   tsx scripts/backfill-operator-aircraft-link.ts --write           # full run
 *   tsx scripts/backfill-operator-aircraft-link.ts --write --max-batches=10  # smoke / timing
 *   tsx scripts/backfill-operator-aircraft-link.ts --write --batch-size=5000
 *
 * Rollback: schema/rollback/2026-04-24-checkpoint-3-rollback.sql
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { preFilter, type PreFilterBucket } from "../src/entity-resolution/pre-filters.js";
import {
  resolveOperatorMatchOnly,
  type MatchOnlyAction,
  type MatchOnlyResult,
} from "../src/entity-resolution/operator-resolver.js";

const DEFAULT_BATCH_SIZE = 5000;
const OPERATOR_TYPE_BLOCKLIST = new Set([
  "broker",
  "billing_agent",
  "financier",
  "holding_co",
  "defunct",
  "trust_holder",
]);

type ResolverAction =
  | MatchOnlyAction
  | "matched_blocked_operator_type"
  | PreFilterBucket;

interface Args {
  write: boolean;
  batchSize: number;
  maxBatches: number | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const batchFlag = args.find((a) => a.startsWith("--batch-size="));
  const maxFlag = args.find((a) => a.startsWith("--max-batches="));
  return {
    write: args.includes("--write"),
    batchSize: batchFlag ? Number.parseInt(batchFlag.split("=")[1]!, 10) : DEFAULT_BATCH_SIZE,
    maxBatches: maxFlag ? Number.parseInt(maxFlag.split("=")[1]!, 10) : null,
  };
}

function formatRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

interface RowToProcess {
  aircraft_id: string;
  tail_number: string;
  certificate_holder: string | null;
  registrant_type: string | null;
  owner_state: string | null;
  faa_created_at: Date;
}

async function countRemaining(client: pg.PoolClient): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n
       FROM canonical.aircraft_identities ai
       JOIN faa_aircraft fa ON fa.tail_number = ai.source_id
      WHERE ai.source = 'faa'
        AND NOT EXISTS (
          SELECT 1 FROM canonical.operator_aircraft_resolution_log r
           WHERE r.aircraft_id = ai.aircraft_id
        )`,
  );
  return Number.parseInt(r.rows[0]!.n, 10);
}

async function fetchBatch(client: pg.PoolClient, batchSize: number): Promise<RowToProcess[]> {
  const res = await client.query<RowToProcess>(
    `SELECT
       ai.aircraft_id,
       ai.source_id AS tail_number,
       fa.certificate_holder,
       fa.registrant_type,
       fa.owner_state,
       fa.created_at AS faa_created_at
       FROM canonical.aircraft_identities ai
       JOIN faa_aircraft fa ON fa.tail_number = ai.source_id
      WHERE ai.source = 'faa'
        AND NOT EXISTS (
          SELECT 1 FROM canonical.operator_aircraft_resolution_log r
           WHERE r.aircraft_id = ai.aircraft_id
        )
      ORDER BY ai.aircraft_id
      LIMIT $1`,
    [batchSize],
  );
  return res.rows;
}

async function fetchOperatorType(
  client: pg.PoolClient,
  operatorId: string,
): Promise<string | null> {
  const r = await client.query<{ operator_type: string | null }>(
    `SELECT operator_type FROM operators WHERE id = $1`,
    [operatorId],
  );
  return r.rows[0]?.operator_type ?? null;
}

interface LogRow {
  aircraft_id: string;
  certificate_holder: string | null;
  registrant_type: string | null;
  resolver_action: ResolverAction;
  operator_id: string | null;
  operator_type: string | null;
  tier: string | null;
  score: number | null;
  second_best_score: number | null;
  signals: unknown | null;
  reason: string | null;
  link_id: string | null;
  review_id: number | null;
}

async function writeLogRow(
  client: pg.PoolClient,
  runId: string,
  log: LogRow,
): Promise<void> {
  await client.query(
    `INSERT INTO canonical.operator_aircraft_resolution_log
       (aircraft_id, certificate_holder, registrant_type, resolver_action,
        operator_id, operator_type, tier, score, second_best_score, signals,
        reason, link_id, review_id, backfill_run_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14)
     ON CONFLICT (aircraft_id, backfill_run_id) DO NOTHING`,
    [
      log.aircraft_id,
      log.certificate_holder,
      log.registrant_type,
      log.resolver_action,
      log.operator_id,
      log.operator_type,
      log.tier,
      log.score,
      log.second_best_score,
      log.signals ? JSON.stringify(log.signals) : null,
      log.reason,
      log.link_id,
      log.review_id,
      runId,
    ],
  );
}

async function writeOperatorAircraftLink(
  client: pg.PoolClient,
  row: RowToProcess,
  result: MatchOnlyResult,
  runId: string,
): Promise<string> {
  const linkId = randomUUID();
  const confidence = result.matchConfidence === "exact" ? 1.0
    : result.matchConfidence === "high" ? 0.9
    : result.matchConfidence === "medium" ? 0.7
    : 0.5;
  const evidence = {
    source: "faa_registry",
    checkpoint: "stage2b_checkpoint3",
    backfill_run_id: runId,
    resolver_tier: result.tier,
    resolver_action: result.action,
    nameSim: result.signals?.nameSim ?? null,
    topScore: result.topScore,
    secondBestScore: result.secondBestScore,
    stateMatch: result.signals?.stateMatch ?? null,
    cityMatch: result.signals?.cityMatch ?? null,
    icaoMatch: result.signals?.icaoMatch ?? null,
    tail_number: row.tail_number,
  };
  await client.query(
    `INSERT INTO canonical.operator_aircraft_link
       (id, operator_id, aircraft_id, role, valid_from, valid_to,
        source, source_url, source_timestamp, confidence,
        match_method, evidence)
     VALUES ($1, $2, $3, 'operator', $4::date, NULL,
             'faa_registry', NULL, $5::timestamptz, $6,
             'faa_cert_holder_fuzzy', $7::jsonb)`,
    [
      linkId,
      result.operatorId,
      row.aircraft_id,
      row.faa_created_at,
      row.faa_created_at,
      confidence,
      JSON.stringify(evidence),
    ],
  );
  return linkId;
}

async function writeReviewRow(
  client: pg.PoolClient,
  row: RowToProcess,
  result: MatchOnlyResult,
  runId: string,
): Promise<number> {
  const payload = {
    source: "stage2b_checkpoint3",
    tail_number: row.tail_number,
    aircraft_id: row.aircraft_id,
    faa_certificate_holder: row.certificate_holder,
    backfill_run_id: runId,
    resolver_reason: result.reason,
  };
  const candidates = result.operatorId
    ? [{ operator_id: result.operatorId, canonical_name: result.canonicalName, score: result.topScore, signals: result.signals }]
    : [];
  const res = await client.query<{ id: number }>(
    `INSERT INTO operator_match_review
       (scraped_name, scraped_source, scraped_source_id, scraped_payload, candidate_matches)
     VALUES ($1, 'faa', $2, $3::jsonb, $4::jsonb)
     RETURNING id`,
    [
      row.certificate_holder ?? "",
      row.tail_number,
      JSON.stringify(payload),
      JSON.stringify(candidates),
    ],
  );
  return res.rows[0]!.id;
}

interface BatchStats {
  processed: number;
  matched: number;
  matchedBlocked: number;
  review: number;
  noMatch: number;
  skippedNull: number;
  skippedPlaceholder: number;
  skippedIndividual: number;
  skippedTrustee: number;
  skippedManufacturer: number;
  linksWritten: number;
  reviewsWritten: number;
}

function zeroStats(): BatchStats {
  return {
    processed: 0,
    matched: 0,
    matchedBlocked: 0,
    review: 0,
    noMatch: 0,
    skippedNull: 0,
    skippedPlaceholder: 0,
    skippedIndividual: 0,
    skippedTrustee: 0,
    skippedManufacturer: 0,
    linksWritten: 0,
    reviewsWritten: 0,
  };
}

async function processRow(
  client: pg.PoolClient,
  runId: string,
  row: RowToProcess,
  write: boolean,
  stats: BatchStats,
): Promise<void> {
  stats.processed++;

  // 1. Pre-filter.
  const bucket = preFilter({
    certificateHolder: row.certificate_holder,
    registrantType: row.registrant_type,
  });
  if (bucket !== null) {
    if (bucket === "skipped_null") stats.skippedNull++;
    else if (bucket === "skipped_placeholder") stats.skippedPlaceholder++;
    else if (bucket === "skipped_individual") stats.skippedIndividual++;
    else if (bucket === "skipped_trustee") stats.skippedTrustee++;
    else if (bucket === "skipped_manufacturer") stats.skippedManufacturer++;
    if (write) {
      await writeLogRow(client, runId, {
        aircraft_id: row.aircraft_id,
        certificate_holder: row.certificate_holder,
        registrant_type: row.registrant_type,
        resolver_action: bucket,
        operator_id: null,
        operator_type: null,
        tier: null,
        score: null,
        second_best_score: null,
        signals: null,
        reason: null,
        link_id: null,
        review_id: null,
      });
    }
    return;
  }

  // 2. Resolver (read-only).
  const result = await resolveOperatorMatchOnly(
    {
      name: row.certificate_holder!,
      source: "faa",
      sourceId: row.tail_number,
      ...(row.owner_state ? { state: row.owner_state } : {}),
    },
    client,
  );

  let finalAction: ResolverAction = result.action;
  let linkId: string | null = null;
  let reviewId: number | null = null;
  let operatorType: string | null = null;

  if (result.action === "matched" || result.action === "exact") {
    // 3. operator_type blocklist (NULL passes through).
    if (result.operatorId) {
      operatorType = await fetchOperatorType(client, result.operatorId);
      if (operatorType !== null && OPERATOR_TYPE_BLOCKLIST.has(operatorType)) {
        finalAction = "matched_blocked_operator_type";
        stats.matchedBlocked++;
      } else if (write) {
        linkId = await writeOperatorAircraftLink(client, row, result, runId);
        stats.linksWritten++;
        stats.matched++;
      } else {
        stats.matched++;
      }
    }
  } else if (result.action === "review") {
    stats.review++;
    if (write) {
      reviewId = await writeReviewRow(client, row, result, runId);
      stats.reviewsWritten++;
    }
  } else if (result.action === "no_match") {
    stats.noMatch++;
  }

  if (write) {
    await writeLogRow(client, runId, {
      aircraft_id: row.aircraft_id,
      certificate_holder: row.certificate_holder,
      registrant_type: row.registrant_type,
      resolver_action: finalAction,
      operator_id: result.operatorId,
      operator_type: operatorType,
      tier: result.tier,
      score: result.topScore,
      second_best_score: result.secondBestScore,
      signals: result.signals,
      reason: result.reason,
      link_id: linkId,
      review_id: reviewId,
    });
  }
}

function logBatchStats(batchNum: number, elapsedMs: number, stats: BatchStats): void {
  console.log(
    `[cp3] batch ${batchNum}: ${stats.processed} rows in ${(elapsedMs / 1000).toFixed(1)}s — ` +
      `match=${stats.matched} blocked=${stats.matchedBlocked} review=${stats.review} no_match=${stats.noMatch} ` +
      `skipped(null=${stats.skippedNull}, ph=${stats.skippedPlaceholder}, ind=${stats.skippedIndividual}, ` +
      `trustee=${stats.skippedTrustee}, mfr=${stats.skippedManufacturer})`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = formatRunId();
  const connectionString = process.env["SUPABASE_DATABASE_URL"];
  if (!connectionString) {
    console.error("SUPABASE_DATABASE_URL not set.");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 5 });

  console.log(`[cp3] run_id=${runId}`);
  console.log(`[cp3] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[cp3] batch_size=${args.batchSize}${args.maxBatches !== null ? ` max_batches=${args.maxBatches}` : ""}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    const startRemaining = await countRemaining(client);
    console.log(`[cp3] rows remaining: ${startRemaining.toLocaleString()}`);
    if (startRemaining === 0) {
      console.log(`[cp3] nothing to do.`);
      return;
    }

    const startMs = Date.now();
    const cumulative = zeroStats();
    let batchNum = 0;

    for (;;) {
      batchNum++;
      await client.query("BEGIN");
      try {
        const rows = await fetchBatch(client, args.batchSize);
        if (rows.length === 0) {
          await client.query("ROLLBACK");
          break;
        }
        const batchStats = zeroStats();
        const batchStart = Date.now();
        for (const row of rows) {
          await processRow(client, runId, row, args.write, batchStats);
        }
        const batchMs = Date.now() - batchStart;

        if (args.write) {
          await client.query("COMMIT");
        } else {
          await client.query("ROLLBACK");
        }

        // Fold batch stats into cumulative.
        for (const k of Object.keys(batchStats) as Array<keyof BatchStats>) {
          cumulative[k] += batchStats[k];
        }
        logBatchStats(batchNum, batchMs, batchStats);

        if (rows.length < args.batchSize) break;
        if (args.maxBatches !== null && batchNum >= args.maxBatches) {
          console.log(`[cp3] hit --max-batches=${args.maxBatches}, stopping early.`);
          break;
        }
        if (!args.write) {
          // Dry-run always stops after one batch — prevents N batches of
          // read-only work. Use --max-batches to override if needed.
          console.log(`[cp3] DRY-RUN: stopped after 1 batch. Re-run with --write to execute.`);
          break;
        }
      } catch (err) {
        await client.query("ROLLBACK").catch(() => void 0);
        throw err;
      }
    }

    const wallMs = Date.now() - startMs;
    console.log(`\n[cp3] run_id=${runId} wall=${(wallMs / 1000).toFixed(1)}s batches=${batchNum}`);
    console.log(`[cp3] cumulative: processed=${cumulative.processed} ` +
      `matched=${cumulative.matched} matched_blocked=${cumulative.matchedBlocked} ` +
      `review=${cumulative.review} no_match=${cumulative.noMatch} ` +
      `skipped_null=${cumulative.skippedNull} skipped_placeholder=${cumulative.skippedPlaceholder} ` +
      `skipped_individual=${cumulative.skippedIndividual} skipped_trustee=${cumulative.skippedTrustee} ` +
      `skipped_manufacturer=${cumulative.skippedManufacturer}`);
    console.log(`[cp3] writes: links=${cumulative.linksWritten} reviews=${cumulative.reviewsWritten}`);

    if (args.maxBatches !== null && args.write) {
      const rowsLeft = await countRemaining(client);
      const completed = cumulative.processed;
      const fractionDone = completed / (completed + rowsLeft);
      const extrapMs = wallMs / Math.max(fractionDone, 0.0001);
      console.log(
        `\n[cp3] --max-batches extrapolation: completed=${completed.toLocaleString()} ` +
          `remaining=${rowsLeft.toLocaleString()} ` +
          `full_run_estimate=${(extrapMs / 1000 / 60).toFixed(1)}min`,
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
