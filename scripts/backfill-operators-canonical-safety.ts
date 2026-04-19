/**
 * Backfill operators canonical layer from safety_ratings.
 *
 * Phase 1 commit 7: for each safety_ratings row, resolve the scraped
 * ARGUS / Wyvern operator name against the canonical operators table
 * (populated in commit 6) via resolveOperator(). Writes one of:
 *
 *   exact   — existing (source='argus'|'wyvern', source_id=safety_ratings.id)
 *             already linked; bump last_verified_at
 *   matched — strong match against a Gold canonical row; INSERT identity
 *   review  — weak / ambiguous match; INSERT operator_match_review
 *   new     — no canonical match; INSERT operators + identity
 *
 * A safety_ratings row with BOTH argus_rating and wyvern_status triggers
 * two resolver calls, one per source, creating two identity rows that
 * either link to the same canonical operator (ideal) or to two different
 * operators (flag; review CLI in commit 9 can merge).
 *
 * safety_ratings.id is used as source_id because neither ARGUS nor Wyvern
 * exposes a stable external ID that maps cleanly — the scrape rows are
 * OSA-internal. This stays consistent across re-runs of the script (same
 * id, same source → exact short-circuit).
 *
 * SIGNAL NOTE (2026-04-18):
 *   The current safety_ratings dataset has zero rows with
 *   argus_home_base_icao populated. Matching is therefore name-only
 *   (no ICAO/state/city signal). Commit 4's computeNameSim (max of
 *   Jaro-Winkler and trigram) is the entire match score.
 *
 * Dry-run wraps the whole run in BEGIN + ROLLBACK, so intra-run
 * "new operator" creations affect later candidate sets (accurate
 * simulation of live behaviour). Live mode uses one transaction per
 * safety_ratings row.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:backfill-safety            # dry run
 *   DATABASE_TYPE=postgres npm run operators:backfill-safety -- --commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/memory/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";
import { resolveOperator, type ScrapedRecord, type ResolverResult } from "../src/memory/canonical/operator-resolver.js";

const log = childLogger("safety-backfill");

// ── Types ────────────────────────────────────────────────────────────────

export interface SafetyRatingRow {
  id: number;
  operator_name: string;
  argus_rating: string | null;
  wyvern_status: string | null;
  argus_home_base_icao: string | null;
}

export interface ResolutionPlan {
  /** safety_ratings row. */
  row: SafetyRatingRow;
  /** One or two ScrapedRecord instances to send through resolveOperator(). */
  scraped: ScrapedRecord[];
}

export interface OutcomeTally {
  exact: number;
  matched_high: number;
  matched_medium: number;
  review_low_tier: number;
  review_ambiguous: number;
  new_: number;
  skipped: number;
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { commit: boolean } {
  return { commit: argv.includes("--commit") };
}

/**
 * Build zero, one, or two ScrapedRecord objects per safety_ratings row.
 * Zero when the row has no rating on either source (skipped).
 * Two when both argus_rating and wyvern_status are present — each source
 * gets its own identity row, both pointing to the same canonical operator
 * in the happy path.
 */
export function planResolutions(row: SafetyRatingRow): ResolutionPlan {
  const scraped: ScrapedRecord[] = [];
  const idStr = String(row.id);
  if (row.argus_rating !== null) {
    scraped.push({
      name: row.operator_name,
      source: "argus",
      sourceId: idStr,
      ...(row.argus_home_base_icao ? { icao: row.argus_home_base_icao } : {}),
      payload: {
        safety_ratings_id: row.id,
        argus_rating: row.argus_rating,
      },
    });
  }
  if (row.wyvern_status !== null) {
    scraped.push({
      name: row.operator_name,
      source: "wyvern",
      sourceId: idStr,
      payload: {
        safety_ratings_id: row.id,
        wyvern_status: row.wyvern_status,
      },
    });
  }
  return { row, scraped };
}

export function emptyTally(): OutcomeTally {
  return {
    exact: 0,
    matched_high: 0,
    matched_medium: 0,
    review_low_tier: 0,
    review_ambiguous: 0,
    new_: 0,
    skipped: 0,
  };
}

export function tallyResult(tally: OutcomeTally, r: ResolverResult): void {
  switch (r.action) {
    case "exact":
      tally.exact++;
      break;
    case "matched":
      if (r.matchConfidence === "medium") tally.matched_medium++;
      else tally.matched_high++;
      break;
    case "review":
      if (r.reason === "ambiguous_runner_up") tally.review_ambiguous++;
      else tally.review_low_tier++;
      break;
    case "new":
      tally.new_++;
      break;
  }
}

// ── DB I/O ───────────────────────────────────────────────────────────────

async function loadSafetyRatings(client: pg.PoolClient): Promise<SafetyRatingRow[]> {
  const res = await client.query<SafetyRatingRow>(
    `SELECT id, operator_name, argus_rating, wyvern_status, argus_home_base_icao
     FROM safety_ratings
     ORDER BY id`,
  );
  return res.rows;
}

// ── Env load ─────────────────────────────────────────────────────────────

function loadEnv(): void {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env not found — fine
  }
}

// ── Processing ───────────────────────────────────────────────────────────

interface ResolutionTrace {
  scraped: ScrapedRecord;
  result: ResolverResult;
  candidateCanonicalName?: string;
}

async function processAll(
  client: pg.PoolClient,
  rows: SafetyRatingRow[],
): Promise<{ tally: OutcomeTally; traces: ResolutionTrace[] }> {
  const tally = emptyTally();
  const traces: ResolutionTrace[] = [];
  let processed = 0;
  for (const row of rows) {
    const plan = planResolutions(row);
    if (plan.scraped.length === 0) {
      tally.skipped++;
      continue;
    }
    for (const s of plan.scraped) {
      const result = await resolveOperator(s, client);
      tallyResult(tally, result);
      traces.push({ scraped: s, result });
    }
    processed++;
    if (processed % 50 === 0) {
      console.log(`[safety-backfill] Progress: ${processed}/${rows.length} rows processed`);
    }
  }
  return { tally, traces };
}

async function lookupCanonicalNames(
  client: pg.PoolClient,
  traces: ResolutionTrace[],
): Promise<void> {
  const ids = [...new Set(traces.map((t) => t.result.operatorId).filter((x): x is string => x !== null))];
  if (ids.length === 0) return;
  const res = await client.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM operators WHERE id = ANY($1::UUID[])`,
    [ids],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r.canonical_name]));
  for (const t of traces) {
    if (t.result.operatorId) t.candidateCanonicalName = byId.get(t.result.operatorId);
  }
}

function printReport(title: string, tally: OutcomeTally, total: number): void {
  const matched = tally.matched_high + tally.matched_medium;
  const review = tally.review_low_tier + tally.review_ambiguous;
  console.log(`\n[safety-backfill] ${title}`);
  console.log(`  Exact (already linked):  ${tally.exact}`);
  console.log(`  Matched:                 ${matched} (${tally.matched_high} high, ${tally.matched_medium} medium)`);
  console.log(`  Review queue:            ${review} (${tally.review_ambiguous} ambiguous, ${tally.review_low_tier} low tier)`);
  console.log(`  New operators created:   ${tally.new_}`);
  console.log(`  Skipped (no rating):     ${tally.skipped}`);
  console.log(`  Total resolver calls:    ${tally.exact + matched + review + tally.new_}`);
  console.log(`  Total safety_ratings rows: ${total}`);
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:backfill-safety requires DATABASE_TYPE=postgres");
  }
  initSentry();
  installProcessHandlers("safety-backfill");

  const { commit } = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const pool = getPool();
  const client = await pool.connect();

  try {
    console.log("[safety-backfill] Reading safety_ratings...");
    const rows = await loadSafetyRatings(client);
    const withArgus = rows.filter((r) => r.argus_rating !== null).length;
    const withWyvern = rows.filter((r) => r.wyvern_status !== null).length;
    const withBoth = rows.filter((r) => r.argus_rating !== null && r.wyvern_status !== null).length;
    const neither = rows.filter((r) => r.argus_rating === null && r.wyvern_status === null).length;
    const totalResolverCalls = withArgus + withWyvern;

    console.log(`[safety-backfill] Found ${rows.length} rows`);
    console.log(
      `[safety-backfill] ${withArgus} have argus_rating, ${withWyvern} have wyvern_status, ${withBoth} have both, ${neither} have neither`,
    );
    console.log(`[safety-backfill] Will attempt ${totalResolverCalls} resolutions`);

    if (!commit) {
      // Dry-run: run the whole thing in a transaction we'll ROLLBACK.
      console.log(`[safety-backfill] Dry run — simulating against current canonical operators...`);
      await client.query("BEGIN");
      try {
        const { tally, traces } = await processAll(client, rows);
        await lookupCanonicalNames(client, traces);
        printReport("Projected outcomes (pre-rollback):", tally, rows.length);

        // Sample of up to 10 matched results (top actions first).
        const matchedTraces = traces
          .filter((t) => t.result.action === "matched" || t.result.action === "exact")
          .slice(0, 10);
        if (matchedTraces.length > 0) {
          console.log(`\n[safety-backfill] Sample projected matches:`);
          matchedTraces.forEach((t, i) => {
            const conf = t.result.matchConfidence;
            console.log(
              `  ${i + 1}. '${t.scraped.name}' → '${t.candidateCanonicalName ?? "???"}' (${t.scraped.source}, ${conf}, score=${t.result.topScore?.toFixed(3) ?? "n/a"})`,
            );
          });
        }

        // Sample of review-queue entries.
        const reviewTraces = traces.filter((t) => t.result.action === "review").slice(0, 10);
        if (reviewTraces.length > 0) {
          console.log(`\n[safety-backfill] Sample review-queue entries:`);
          reviewTraces.forEach((t, i) => {
            console.log(
              `  ${i + 1}. '${t.scraped.name}' (${t.scraped.source}, reason=${t.result.reason}, topScore=${t.result.topScore?.toFixed(3) ?? "n/a"})`,
            );
          });
        }

        await client.query("ROLLBACK");
        console.log(`\n[safety-backfill] Dry run rolled back. Use --commit to write.`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      await closePg();
      await flushSentry();
      return;
    }

    // Live: per-safety_ratings-row transaction.
    console.log(`[safety-backfill] Writing with per-row transactions...`);
    const tally = emptyTally();
    let processed = 0;
    for (const row of rows) {
      const plan = planResolutions(row);
      if (plan.scraped.length === 0) {
        tally.skipped++;
        continue;
      }
      await client.query("BEGIN");
      try {
        for (const s of plan.scraped) {
          const result = await resolveOperator(s, client);
          tallyResult(tally, result);
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
      processed++;
      if (processed % 50 === 0) {
        console.log(`[safety-backfill] Progress: ${processed}/${rows.length} rows processed`);
      }
    }
    const dtSec = ((Date.now() - t0) / 1000).toFixed(1);
    printReport("Live backfill complete:", tally, rows.length);
    console.log(`[safety-backfill] Runtime: ${dtSec}s`);

    // Verify counts
    const ops = await client.query<{ cnt: string }>(`SELECT COUNT(*)::TEXT AS cnt FROM operators`);
    const ids = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM operator_identities WHERE source IN ('argus','wyvern')`,
    );
    const review = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM operator_match_review WHERE status = 'pending'`,
    );
    console.log(
      `[safety-backfill] DB state: ${ops.rows[0]?.cnt} operators total, ${ids.rows[0]?.cnt} argus+wyvern identities, ${review.rows[0]?.cnt} review pending`,
    );
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "safety-backfill fatal error");
    process.exit(1);
  });
}
