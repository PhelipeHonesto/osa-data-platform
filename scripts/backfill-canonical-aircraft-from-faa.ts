/**
 * Checkpoint 1 — FAA bulk backfill into canonical.aircraft + aircraft_identities.
 *
 * For every row in `public.faa_aircraft`, create one `canonical.aircraft`
 * row and one `canonical.aircraft_identities` row tagged `source='faa',
 * source_id=tail_number, match_confidence='exact'`. FAA is authoritative
 * for US aircraft identity — no resolver, no ambiguity, no new-operator
 * side effects.
 *
 * Idempotency: skips faa rows whose tail_number already has an identity
 * row tagged `source='faa'`. Re-running after a partial run continues from
 * where it stopped.
 *
 * icao_hex duplicates: at least 10 hex values appear twice in faa_aircraft
 * today (likely cancelled-and-reassigned hex). The partial UNIQUE index
 * `ux_aircraft_icao_hex` would reject the second insert. Resolution: per
 * hex, the most-recently-updated row is the "winner" and keeps the hex on
 * its canonical.aircraft row; loser rows land with `icao_hex = NULL`
 * (their tail + serial + attributes still land; just no hex anchor).
 * Stage 2c aircraft resolver can reconcile later if needed.
 *
 * Usage:
 *   tsx scripts/backfill-canonical-aircraft-from-faa.ts                    # dry-run (default)
 *   tsx scripts/backfill-canonical-aircraft-from-faa.ts --write            # actually mutate
 *   tsx scripts/backfill-canonical-aircraft-from-faa.ts --write --batch-size=5000
 *   tsx scripts/backfill-canonical-aircraft-from-faa.ts --write --max-batches=1   # single-batch smoke
 *
 * Rollback: schema/rollback/2026-04-24-checkpoint-1-rollback.sql
 *   Deletes aircraft_identities + orphan canonical.aircraft tagged with
 *   this run's backfill_run_id (stored in match_evidence JSONB).
 */

import "dotenv/config";
import pg from "pg";

const DEFAULT_BATCH_SIZE = 5000;
const PROGRESS_LOG_EVERY = 10_000;

interface Args {
  write: boolean;
  batchSize: number;
  maxBatches: number | null;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const batchFlag = args.find((a) => a.startsWith("--batch-size="));
  const maxFlag = args.find((a) => a.startsWith("--max-batches="));
  return {
    write,
    batchSize: batchFlag ? Number.parseInt(batchFlag.split("=")[1]!, 10) : DEFAULT_BATCH_SIZE,
    maxBatches: maxFlag ? Number.parseInt(maxFlag.split("=")[1]!, 10) : null,
  };
}

function formatRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

async function countRemaining(client: pg.PoolClient): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(*)::bigint AS n
     FROM faa_aircraft fa
     WHERE fa.tail_number IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM canonical.aircraft_identities ai
          WHERE ai.source = 'faa' AND ai.source_id = fa.tail_number
       )`,
  );
  return Number.parseInt(r.rows[0]!.n, 10);
}

async function runBatch(
  client: pg.PoolClient,
  runId: string,
  batchSize: number,
  write: boolean,
): Promise<number> {
  // One CTE chain:
  //   1. hex_winners picks the global winner row per icao_hex (for duplicates).
  //   2. candidate selects up to batchSize faa rows whose tail_number isn't
  //      already in canonical.aircraft_identities.
  //   3. inserted_aircraft writes canonical.aircraft with effective_hex
  //      (hex-winner rows keep hex; losers get NULL).
  //   4. Final INSERT writes the matching aircraft_identities.
  //
  // The whole chain runs inside the caller's transaction. Dry-run mode
  // still runs step 1+2 (read-only) to prove the plan is sound, but rolls
  // back before step 3.
  const sql = `
    WITH hex_winners AS (
      SELECT icao_hex, tail_number AS winner_tail
      FROM (
        SELECT
          icao_hex,
          tail_number,
          ROW_NUMBER() OVER (
            PARTITION BY icao_hex
            ORDER BY updated_at DESC NULLS LAST, tail_number
          ) AS rn
        FROM faa_aircraft
        WHERE icao_hex IS NOT NULL AND tail_number IS NOT NULL
      ) x
      WHERE rn = 1
    ),
    candidate AS (
      SELECT
        fa.tail_number,
        fa.icao_hex,
        fa.serial_number,
        fa.manufacturer,
        fa.model,
        fa.common_name,
        fa.aircraft_class,
        fa.year_manufactured,
        CASE
          WHEN fa.icao_hex IS NULL THEN NULL
          WHEN hw.winner_tail = fa.tail_number THEN fa.icao_hex
          ELSE NULL
        END AS effective_hex
      FROM faa_aircraft fa
      LEFT JOIN hex_winners hw ON hw.icao_hex = fa.icao_hex
      WHERE fa.tail_number IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM canonical.aircraft_identities ai
           WHERE ai.source = 'faa' AND ai.source_id = fa.tail_number
        )
      ORDER BY fa.tail_number
      LIMIT $1
    ),
    inserted_aircraft AS (
      INSERT INTO canonical.aircraft
        (icao_hex, serial_number, current_tail_number,
         manufacturer, model, common_name, aircraft_class, year_manufactured)
      SELECT
        effective_hex, serial_number, tail_number,
        manufacturer, model, common_name, aircraft_class, year_manufactured
      FROM candidate
      RETURNING aircraft_id, current_tail_number
    )
    INSERT INTO canonical.aircraft_identities
      (aircraft_id, source, source_id, match_confidence, match_method, match_evidence)
    SELECT
      ia.aircraft_id,
      'faa',
      ia.current_tail_number,
      'exact',
      'faa_registry_tail',
      jsonb_build_object(
        'backfill_run_id', $2::text,
        'snapshot_date',   NOW()::date,
        'checkpoint',      'stage2b_checkpoint1_faa'
      )
    FROM inserted_aircraft ia
    RETURNING id
  `;

  if (!write) {
    // Dry-run: execute the read-only part inside a rolled-back savepoint
    // so we prove the plan is valid without mutating prod.
    await client.query("SAVEPOINT dryrun");
    try {
      const res = await client.query<{ id: number }>(sql, [batchSize, runId]);
      return res.rowCount ?? 0;
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT dryrun");
      await client.query("RELEASE SAVEPOINT dryrun");
    }
  }

  const res = await client.query<{ id: number }>(sql, [batchSize, runId]);
  return res.rowCount ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = formatRunId();
  const connectionString = process.env["SUPABASE_DATABASE_URL"];
  if (!connectionString) {
    console.error("SUPABASE_DATABASE_URL not set. Add it to .env.");
    process.exit(1);
  }
  const pool = new pg.Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  console.log(`[backfill-checkpoint1] run_id=${runId}`);
  console.log(`[backfill-checkpoint1] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[backfill-checkpoint1] batch_size=${args.batchSize}${args.maxBatches ? ` max_batches=${args.maxBatches}` : ""}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '180s'`);
    await client.query("BEGIN");

    const startRemaining = await countRemaining(client);
    console.log(`[backfill-checkpoint1] faa_aircraft rows remaining to backfill: ${startRemaining.toLocaleString()}`);
    if (startRemaining === 0) {
      console.log(`[backfill-checkpoint1] nothing to do.`);
      await client.query("ROLLBACK");
      return;
    }

    const startMs = Date.now();
    let totalInserted = 0;
    let lastLogAt = 0;
    let batchNum = 0;

    for (;;) {
      batchNum++;
      const batchStart = Date.now();
      const n = await runBatch(client, runId, args.batchSize, args.write);
      const elapsedMs = Date.now() - batchStart;
      totalInserted += n;

      if (args.write && totalInserted - lastLogAt >= PROGRESS_LOG_EVERY) {
        const pct = ((totalInserted / startRemaining) * 100).toFixed(1);
        console.log(
          `[backfill-checkpoint1] batch ${batchNum}: ${n} rows in ${elapsedMs}ms — ` +
            `cumulative ${totalInserted.toLocaleString()} / ${startRemaining.toLocaleString()} (${pct}%)`,
        );
        lastLogAt = totalInserted;
      }

      if (n < args.batchSize) break; // drained
      if (args.maxBatches !== null && batchNum >= args.maxBatches) {
        console.log(`[backfill-checkpoint1] hit --max-batches=${args.maxBatches}, stopping early.`);
        break;
      }
    }

    const wallMs = Date.now() - startMs;
    const wallSec = (wallMs / 1000).toFixed(1);
    console.log(`\n[backfill-checkpoint1] batches=${batchNum} rows_inserted=${totalInserted.toLocaleString()} wall=${wallSec}s`);

    if (args.write) {
      await client.query("COMMIT");
      console.log(`[backfill-checkpoint1] COMMIT. run_id=${runId}`);

      // Post-write verification. Serial, not Promise.all — one client is
      // inside one transaction, so concurrent client.query() calls are
      // deprecated in pg@8.x and removed in pg@9.
      const acCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft`,
      );
      const idCount = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_identities WHERE source='faa'`,
      );
      const nullHex = await client.query<{ n: string }>(
        `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft WHERE icao_hex IS NULL`,
      );
      console.log(`[backfill-checkpoint1] verify: canonical.aircraft=${acCount.rows[0]!.n}, aircraft_identities[faa]=${idCount.rows[0]!.n}, aircraft with NULL icao_hex=${nullHex.rows[0]!.n}`);
    } else {
      await client.query("ROLLBACK");
      console.log(`[backfill-checkpoint1] DRY-RUN: rolled back. Re-run with --write to apply.`);
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[backfill-checkpoint1] FATAL:", err instanceof Error ? err.message : err);
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
