/**
 * Checkpoint 2 — merge ADS-B-observed identities onto canonical.aircraft.
 *
 * For every distinct icao_hex in `public.adsb_completed_legs`, write an
 * `aircraft_identities` row tagged `source='adsb'`, `source_id=icao_hex`,
 * `match_confidence='exact'`. No new canonical row is needed when the hex
 * already exists (Case A); orphan hex (no FAA match, Case B) creates a
 * fresh canonical.aircraft row with icao_hex only and then the identity.
 *
 * Case C (hex in faa_aircraft but the duplicate-hex "loser" row in
 * canonical has hex=NULL while the "winner" row holds the hex) resolves
 * naturally: we join adsb hex against canonical.aircraft.icao_hex, which
 * only matches the winner. No ambiguity.
 *
 * Idempotency: skips hex whose (source='adsb', source_id=hex) identity
 * already exists.
 *
 * Usage:
 *   tsx scripts/backfill-canonical-aircraft-from-adsb.ts                # dry-run
 *   tsx scripts/backfill-canonical-aircraft-from-adsb.ts --write
 *   tsx scripts/backfill-canonical-aircraft-from-adsb.ts --write --batch-size=10000
 *
 * Rollback: schema/rollback/2026-04-24-checkpoint-2-rollback.sql
 */

import "dotenv/config";
import pg from "pg";

const DEFAULT_BATCH_SIZE = 10_000;
const PROGRESS_LOG_EVERY = 20_000;

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

async function countRemaining(client: pg.PoolClient): Promise<{ total: number; caseA: number; caseB: number }> {
  // Remaining: distinct adsb hex whose identity isn't yet written.
  const total = await client.query<{ n: string }>(
    `SELECT COUNT(DISTINCT l.icao_hex)::bigint AS n
       FROM adsb_completed_legs l
      WHERE l.icao_hex IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM canonical.aircraft_identities ai
           WHERE ai.source = 'adsb' AND ai.source_id = l.icao_hex
        )`,
  );
  // Case A: hex already has a canonical.aircraft row (via the hex-winner from CP1).
  const caseA = await client.query<{ n: string }>(
    `SELECT COUNT(DISTINCT l.icao_hex)::bigint AS n
       FROM adsb_completed_legs l
      WHERE l.icao_hex IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM canonical.aircraft a WHERE a.icao_hex = l.icao_hex
        )
        AND NOT EXISTS (
          SELECT 1 FROM canonical.aircraft_identities ai
           WHERE ai.source = 'adsb' AND ai.source_id = l.icao_hex
        )`,
  );
  // Case B: orphan hex (no canonical row has this hex).
  const caseB = await client.query<{ n: string }>(
    `SELECT COUNT(DISTINCT l.icao_hex)::bigint AS n
       FROM adsb_completed_legs l
      WHERE l.icao_hex IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM canonical.aircraft a WHERE a.icao_hex = l.icao_hex
        )
        AND NOT EXISTS (
          SELECT 1 FROM canonical.aircraft_identities ai
           WHERE ai.source = 'adsb' AND ai.source_id = l.icao_hex
        )`,
  );
  return {
    total: Number.parseInt(total.rows[0]!.n, 10),
    caseA: Number.parseInt(caseA.rows[0]!.n, 10),
    caseB: Number.parseInt(caseB.rows[0]!.n, 10),
  };
}

/**
 * Case A batch — hex already has a canonical row. Just write the identity.
 * Returns number of identity rows inserted.
 */
async function runCaseABatch(
  client: pg.PoolClient,
  runId: string,
  batchSize: number,
): Promise<number> {
  const sql = `
    WITH candidate AS (
      SELECT DISTINCT l.icao_hex
        FROM adsb_completed_legs l
        JOIN canonical.aircraft a ON a.icao_hex = l.icao_hex
       WHERE l.icao_hex IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM canonical.aircraft_identities ai
            WHERE ai.source = 'adsb' AND ai.source_id = l.icao_hex
         )
       ORDER BY l.icao_hex
       LIMIT $1
    )
    INSERT INTO canonical.aircraft_identities
      (aircraft_id, source, source_id, match_confidence, match_method, match_evidence)
    SELECT
      a.aircraft_id,
      'adsb',
      c.icao_hex,
      'exact',
      'adsb_hex_exact',
      jsonb_build_object(
        'backfill_run_id', $2::text,
        'checkpoint',      'stage2b_checkpoint2_adsb',
        'case',            'A_hex_matched_faa'
      )
    FROM candidate c
    JOIN canonical.aircraft a ON a.icao_hex = c.icao_hex
    RETURNING id
  `;
  const res = await client.query<{ id: number }>(sql, [batchSize, runId]);
  return res.rowCount ?? 0;
}

/**
 * Case B — orphan hex (no FAA row). Create canonical.aircraft row first,
 * then identity. Small enough (1 row today) to process without batching,
 * but keep the batching shape for safety if the orphan count grows.
 */
async function runCaseBBatch(
  client: pg.PoolClient,
  runId: string,
  batchSize: number,
): Promise<number> {
  const sql = `
    WITH candidate AS (
      SELECT DISTINCT l.icao_hex
        FROM adsb_completed_legs l
       WHERE l.icao_hex IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM canonical.aircraft a WHERE a.icao_hex = l.icao_hex
         )
         AND NOT EXISTS (
           SELECT 1 FROM canonical.aircraft_identities ai
            WHERE ai.source = 'adsb' AND ai.source_id = l.icao_hex
         )
       ORDER BY l.icao_hex
       LIMIT $1
    ),
    new_aircraft AS (
      INSERT INTO canonical.aircraft (icao_hex)
      SELECT icao_hex FROM candidate
      RETURNING aircraft_id, icao_hex
    )
    INSERT INTO canonical.aircraft_identities
      (aircraft_id, source, source_id, match_confidence, match_method, match_evidence)
    SELECT
      na.aircraft_id,
      'adsb',
      na.icao_hex,
      'exact',
      'adsb_hex_orphan',
      jsonb_build_object(
        'backfill_run_id', $2::text,
        'checkpoint',      'stage2b_checkpoint2_adsb',
        'case',            'B_orphan_no_faa_row'
      )
    FROM new_aircraft na
    RETURNING id
  `;
  const res = await client.query<{ id: number }>(sql, [batchSize, runId]);
  return res.rowCount ?? 0;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const runId = formatRunId();
  const connectionString = process.env["SUPABASE_DATABASE_URL"];
  if (!connectionString) {
    console.error("SUPABASE_DATABASE_URL not set.");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  console.log(`[backfill-checkpoint2] run_id=${runId}`);
  console.log(`[backfill-checkpoint2] mode=${args.write ? "WRITE" : "DRY-RUN"}`);
  console.log(`[backfill-checkpoint2] batch_size=${args.batchSize}${args.maxBatches ? ` max_batches=${args.maxBatches}` : ""}`);

  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '180s'`);
    await client.query("BEGIN");

    const { total, caseA, caseB } = await countRemaining(client);
    console.log(`[backfill-checkpoint2] adsb hex remaining: total=${total.toLocaleString()} caseA(hex→existing)=${caseA.toLocaleString()} caseB(orphan)=${caseB.toLocaleString()}`);

    if (total === 0) {
      console.log(`[backfill-checkpoint2] nothing to do.`);
      await client.query("ROLLBACK");
      return;
    }

    if (!args.write) {
      console.log(`[backfill-checkpoint2] DRY-RUN: plan shows ${total.toLocaleString()} identity rows to insert (${caseA.toLocaleString()} Case A, ${caseB.toLocaleString()} Case B). Re-run with --write.`);
      await client.query("ROLLBACK");
      return;
    }

    const startMs = Date.now();
    let totalInserted = 0;
    let lastLogAt = 0;
    let batchNum = 0;

    // Case A first — bulk, fast path.
    console.log(`[backfill-checkpoint2] phase A: hex already in canonical.aircraft`);
    for (;;) {
      batchNum++;
      const batchStart = Date.now();
      const n = await runCaseABatch(client, runId, args.batchSize);
      const elapsedMs = Date.now() - batchStart;
      totalInserted += n;
      if (totalInserted - lastLogAt >= PROGRESS_LOG_EVERY) {
        const pct = ((totalInserted / total) * 100).toFixed(1);
        console.log(
          `[backfill-checkpoint2] batch ${batchNum}: ${n} rows in ${elapsedMs}ms — ` +
            `cumulative ${totalInserted.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`,
        );
        lastLogAt = totalInserted;
      }
      if (n < args.batchSize) break;
      if (args.maxBatches !== null && batchNum >= args.maxBatches) break;
    }

    // Case B — orphan.
    console.log(`[backfill-checkpoint2] phase B: orphan hex`);
    for (;;) {
      batchNum++;
      const batchStart = Date.now();
      const n = await runCaseBBatch(client, runId, args.batchSize);
      const elapsedMs = Date.now() - batchStart;
      totalInserted += n;
      if (n > 0) {
        console.log(
          `[backfill-checkpoint2] caseB batch ${batchNum}: ${n} orphan rows in ${elapsedMs}ms`,
        );
      }
      if (n < args.batchSize) break;
    }

    const wallMs = Date.now() - startMs;
    console.log(`\n[backfill-checkpoint2] rows_inserted=${totalInserted.toLocaleString()} wall=${(wallMs / 1000).toFixed(1)}s`);

    await client.query("COMMIT");
    console.log(`[backfill-checkpoint2] COMMIT. run_id=${runId}`);

    // Post-write verification (serial, not Promise.all).
    const acCount = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft`,
    );
    const faaCount = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_identities WHERE source='faa'`,
    );
    const adsbCount = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_identities WHERE source='adsb'`,
    );
    const orphanCount = await client.query<{ n: string }>(
      `SELECT COUNT(*)::bigint AS n FROM canonical.aircraft_identities
        WHERE source='adsb' AND match_method='adsb_hex_orphan'`,
    );
    console.log(
      `[backfill-checkpoint2] verify: canonical.aircraft=${acCount.rows[0]!.n} ` +
        `identities[faa]=${faaCount.rows[0]!.n} identities[adsb]=${adsbCount.rows[0]!.n} ` +
        `orphan_cases=${orphanCount.rows[0]!.n}`,
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    console.error("[backfill-checkpoint2] FATAL:", err instanceof Error ? err.message : err);
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
