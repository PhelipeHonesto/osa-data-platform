/**
 * Safety Ratings Refresh — scrape ARGUS + Wyvern, upsert to safety_ratings,
 * sync matched rows into faa_operators columns.
 *
 * INTERNAL USE ONLY. Data is used internally by Dumont's Sourcing agent for
 * operator ranking. NEVER display publicly, NEVER expose via public API,
 * NEVER redistribute.
 *
 * Cadence: monthly max. A 25-day guard against last_scraped_at prevents
 * accidental over-refresh. Pass --force to bypass (used by CI cron where
 * the schedule itself is the cadence control).
 *
 * Partial failure tolerant: if one source errors, the others continue.
 * log.error on a source failure hits Sentry via the log bridge.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run safety:refresh
 *   DATABASE_TYPE=postgres npm run safety:refresh -- --force
 *   DATABASE_TYPE=postgres npm run safety:refresh -- --dry-run
 *
 * Exit codes:
 *   0 — success OR skipped by 25-day guard
 *   1 — all three sources failed, or unexpected fatal error
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { getDatabase, setPgBridge } from "../src/memory/database.js";
import { getPgBridge, closePg } from "../src/memory/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";
import { normalize, fuzzyMatch } from "../src/ingestion/safety-ratings-fuzzy.js";
import {
  scrapeArgusOperators,
  scrapeWyvernWingman,
  scrapeWyvernRegistered,
  URLS,
  type ArgusRow,
  type WyvernRow,
} from "../src/ingestion/safety-ratings-scrape.js";

const log = childLogger("safety-refresh");

const GUARD_DAYS = 25;
const RATE_LIMIT_MS = 2500;

// ── Pure logic (unit-testable without DB) ─────────────────────────────────

export function shouldSkipRefresh(
  lastScrapedAt: Date | null,
  now: Date,
  force: boolean,
): boolean {
  if (force) return false;
  if (!lastScrapedAt) return false;
  const ageMs = now.getTime() - lastScrapedAt.getTime();
  return ageMs < GUARD_DAYS * 24 * 3600 * 1000;
}

export interface MergedRow {
  operator_name: string;
  operator_name_normalized: string;
  argus_rating: "gold" | "gold_plus" | "platinum" | "platinum_elite" | null;
  argus_last_seen_at: string | null;
  wyvern_status: "registered" | "wingman" | null;
  wyvern_country: string | null;
  wyvern_last_seen_at: string | null;
  certificate_number: string | null;
  source_urls: Record<string, string>;
}

/**
 * Merge scraped rows by normalized operator name. One row per operator across
 * all three sources — ARGUS-only and Wyvern-only rows combine into a single
 * record with the appropriate per-source last_seen_at timestamps.
 */
export function mergeScrapedRows(
  argus: ArgusRow[],
  wingman: WyvernRow[],
  registered: WyvernRow[],
  nowIso: string,
): MergedRow[] {
  const byNorm = new Map<string, MergedRow>();

  const ensure = (displayName: string): MergedRow => {
    const norm = normalize(displayName);
    let row = byNorm.get(norm);
    if (!row) {
      row = {
        operator_name: displayName,
        operator_name_normalized: norm,
        argus_rating: null,
        argus_last_seen_at: null,
        wyvern_status: null,
        wyvern_country: null,
        wyvern_last_seen_at: null,
        certificate_number: null,
        source_urls: {},
      };
      byNorm.set(norm, row);
    }
    return row;
  };

  for (const r of argus) {
    const row = ensure(r.operator_name);
    row.argus_rating = r.argus_rating;
    row.argus_last_seen_at = nowIso;
    row.source_urls["argus"] = r.source_url;
  }
  // Wingman first, then registered — if an operator somehow appears on both,
  // wingman wins (higher tier).
  for (const r of wingman) {
    const row = ensure(r.operator_name);
    row.wyvern_status = "wingman";
    row.wyvern_country = r.wyvern_country ?? row.wyvern_country;
    row.wyvern_last_seen_at = nowIso;
    row.certificate_number = row.certificate_number ?? r.certificate_number;
    row.source_urls["wyvern_wingman"] = r.source_url;
  }
  for (const r of registered) {
    const row = ensure(r.operator_name);
    if (row.wyvern_status !== "wingman") {
      row.wyvern_status = "registered";
    }
    row.wyvern_country = r.wyvern_country ?? row.wyvern_country;
    row.wyvern_last_seen_at = nowIso;
    row.certificate_number = row.certificate_number ?? r.certificate_number;
    row.source_urls["wyvern_registered"] = r.source_url;
  }
  return [...byNorm.values()];
}

export interface SeedDiff {
  seedOnly: string[];
  scrapeOnly: string[];
  matched: string[];
}

/**
 * Diff scraped operator names against the unverified JSON seed. Output is
 * log-only: seed entries missing from the scrape (probably stale) and
 * scrape entries missing from the seed (new finds). Matches are a
 * confidence signal, not a requirement.
 */
export function computeSeedDiff(
  seed: Array<{ operator_name: string }>,
  scraped: MergedRow[],
): SeedDiff {
  const scrapedNorms = new Set(scraped.map((r) => r.operator_name_normalized));
  const seedOnly: string[] = [];
  const matched: string[] = [];
  for (const s of seed) {
    const norm = normalize(s.operator_name);
    if (scrapedNorms.has(norm)) matched.push(s.operator_name);
    else seedOnly.push(s.operator_name);
  }
  const seedNorms = new Set(seed.map((s) => normalize(s.operator_name)));
  const scrapeOnly = scraped
    .filter((r) => !seedNorms.has(r.operator_name_normalized))
    .map((r) => r.operator_name);
  return { seedOnly, scrapeOnly, matched };
}

/**
 * Find the most likely faa_operators.certificate_number for a scraped operator
 * name using the shared fuzzy matcher. Returns null when zero or multiple
 * matches — ambiguous matches are skipped so we don't silently mislabel.
 */
export function attemptCertMatch(
  operatorName: string,
  faaOperators: Array<{ certificate_number: string; name: string }>,
): string | null {
  const matches = faaOperators.filter((op) => fuzzyMatch(operatorName, op.name));
  if (matches.length !== 1) return null;
  return matches[0]?.certificate_number ?? null;
}

// ── DB-touching code (not directly unit-tested; runs against Supabase) ────

type DbPrepareFn = (sql: string) => {
  get: (...args: unknown[]) => Promise<unknown>;
  all: (...args: unknown[]) => Promise<unknown[]>;
  run: (...args: unknown[]) => Promise<unknown>;
};

async function getLastScrapedAt(
  db: { prepare: DbPrepareFn },
): Promise<Date | null> {
  const row = (await db.prepare(
    `SELECT MAX(last_scraped_at) AS last FROM safety_ratings`,
  ).get()) as { last: string | null } | undefined;
  if (!row?.last) return null;
  return new Date(row.last);
}

async function upsertMergedRows(
  db: { prepare: DbPrepareFn },
  rows: MergedRow[],
): Promise<{ inserted: number; updated: number }> {
  const stmt = db.prepare(
    `INSERT INTO safety_ratings (
       certificate_number, operator_name, operator_name_normalized,
       argus_rating, argus_last_seen_at,
       wyvern_status, wyvern_country, wyvern_last_seen_at,
       source_urls, last_scraped_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
     ON CONFLICT (operator_name_normalized) DO UPDATE SET
       certificate_number = COALESCE(safety_ratings.certificate_number, EXCLUDED.certificate_number),
       argus_rating       = COALESCE(EXCLUDED.argus_rating, safety_ratings.argus_rating),
       argus_last_seen_at = COALESCE(EXCLUDED.argus_last_seen_at, safety_ratings.argus_last_seen_at),
       wyvern_status      = COALESCE(EXCLUDED.wyvern_status, safety_ratings.wyvern_status),
       wyvern_country     = COALESCE(EXCLUDED.wyvern_country, safety_ratings.wyvern_country),
       wyvern_last_seen_at= COALESCE(EXCLUDED.wyvern_last_seen_at, safety_ratings.wyvern_last_seen_at),
       source_urls        = safety_ratings.source_urls || EXCLUDED.source_urls,
       last_scraped_at    = NOW()
     RETURNING (xmax = 0) AS inserted`,
  );
  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const res = (await stmt.all(
      r.certificate_number,
      r.operator_name,
      r.operator_name_normalized,
      r.argus_rating,
      r.argus_last_seen_at,
      r.wyvern_status,
      r.wyvern_country,
      r.wyvern_last_seen_at,
      JSON.stringify(r.source_urls),
    )) as Array<{ inserted: boolean }>;
    if (res[0]?.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

async function syncToFaaOperators(
  db: { prepare: DbPrepareFn },
): Promise<{ synced: number; fuzzyMatched: number }> {
  // Step 1: direct update via certificate_number already on the row.
  const directUpdate = db.prepare(
    `UPDATE faa_operators o SET
       argus_rating = s.argus_rating,
       wyvern_rating = CASE WHEN s.wyvern_status = 'wingman' THEN 'wingman' ELSE o.wyvern_rating END,
       safety_verified_at = NOW()::text
     FROM safety_ratings s
     WHERE s.certificate_number = o.certificate_number
       AND s.certificate_number IS NOT NULL`,
  );
  const direct = (await directUpdate.run()) as { changes?: number };
  const synced = direct.changes ?? 0;

  // Step 2: fuzzy-match remaining safety_ratings rows to faa_operators by name.
  const unmatched = (await db.prepare(
    `SELECT id, operator_name, argus_rating, wyvern_status
     FROM safety_ratings
     WHERE certificate_number IS NULL`,
  ).all()) as Array<{
    id: number;
    operator_name: string;
    argus_rating: string | null;
    wyvern_status: string | null;
  }>;

  const allOps = (await db.prepare(
    `SELECT certificate_number, name FROM faa_operators`,
  ).all()) as Array<{ certificate_number: string; name: string }>;

  let fuzzyMatched = 0;
  const setCert = db.prepare(
    `UPDATE safety_ratings SET certificate_number = $1 WHERE id = $2`,
  );
  const fuzzySync = db.prepare(
    `UPDATE faa_operators SET
       argus_rating = COALESCE($1, argus_rating),
       wyvern_rating = CASE WHEN $2 = 'wingman' THEN 'wingman' ELSE wyvern_rating END,
       safety_verified_at = NOW()::text
     WHERE certificate_number = $3`,
  );
  for (const row of unmatched) {
    const cert = attemptCertMatch(row.operator_name, allOps);
    if (!cert) continue;
    await setCert.run(cert, row.id);
    await fuzzySync.run(row.argus_rating, row.wyvern_status, cert);
    fuzzyMatched++;
  }

  return { synced: synced + fuzzyMatched, fuzzyMatched };
}

// ── Scraper runner with partial-failure tolerance ─────────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function runScrapers(): Promise<{
  argus: ArgusRow[];
  wingman: WyvernRow[];
  registered: WyvernRow[];
  failures: string[];
}> {
  const failures: string[] = [];
  let argus: ArgusRow[] = [];
  let wingman: WyvernRow[] = [];
  let registered: WyvernRow[] = [];

  try {
    argus = await scrapeArgusOperators();
  } catch (err) {
    failures.push("argus");
    log.error({ err, source: "argus" }, "ARGUS scrape failed — continuing");
  }
  await sleep(RATE_LIMIT_MS);

  try {
    wingman = await scrapeWyvernWingman();
  } catch (err) {
    failures.push("wyvern_wingman");
    log.error({ err, source: "wyvern_wingman" }, "Wyvern Wingman scrape failed — continuing");
  }
  await sleep(RATE_LIMIT_MS);

  try {
    registered = await scrapeWyvernRegistered();
  } catch (err) {
    failures.push("wyvern_registered");
    log.error({ err, source: "wyvern_registered" }, "Wyvern Registered scrape failed — continuing");
  }

  return { argus, wingman, registered, failures };
}

// ── Main ──────────────────────────────────────────────────────────────────

function parseArgs(): { force: boolean; dryRun: boolean } {
  const args = process.argv.slice(2);
  return {
    force: args.includes("--force"),
    dryRun: args.includes("--dry-run"),
  };
}

function loadSeed(): Array<{ operator_name: string }> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const path = resolve(__dirname, "..", "data", "seeds", "safety-ratings.json");
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Array<{ operator_name: string }>;
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("safety:refresh requires DATABASE_TYPE=postgres");
  }

  initSentry();
  installProcessHandlers("safety-refresh");
  setPgBridge(getPgBridge());
  const db = getDatabase() as unknown as { prepare: DbPrepareFn };

  const { force, dryRun } = parseArgs();

  const last = await getLastScrapedAt(db);
  if (shouldSkipRefresh(last, new Date(), force)) {
    log.warn(
      { last: last?.toISOString(), guard_days: GUARD_DAYS },
      "last scrape was <25 days ago; skipping (pass --force to bypass)",
    );
    await closePg();
    await flushSentry();
    return;
  }

  log.info({ last: last?.toISOString() ?? "never", force, dryRun }, "starting refresh");

  const { argus, wingman, registered, failures } = await runScrapers();
  const totalRows = argus.length + wingman.length + registered.length;
  log.info(
    { argus: argus.length, wingman: wingman.length, registered: registered.length, failures },
    "scrape complete",
  );

  if (failures.length === 3) {
    log.error({ failures }, "all three sources failed — aborting without DB writes");
    await closePg();
    await flushSentry();
    process.exit(1);
  }
  if (totalRows === 0) {
    log.error({ failures }, "zero rows scraped across all sources — aborting");
    await closePg();
    await flushSentry();
    process.exit(1);
  }

  const nowIso = new Date().toISOString();
  const merged = mergeScrapedRows(argus, wingman, registered, nowIso);
  log.info({ merged: merged.length }, "merged across sources");

  // Validation harness: diff against the unverified JSON seed. Log-only.
  const seed = loadSeed();
  if (seed.length > 0) {
    const diff = computeSeedDiff(seed, merged);
    log.info(
      {
        seed_total: seed.length,
        scrape_total: merged.length,
        matched: diff.matched.length,
        seed_only: diff.seedOnly.length,
        scrape_only: diff.scrapeOnly.length,
      },
      "seed-diff summary",
    );
    if (diff.seedOnly.length > 0) {
      log.info({ operators: diff.seedOnly.slice(0, 20) }, "seed-only (probably stale)");
    }
    if (diff.scrapeOnly.length > 0) {
      log.info({ sample: diff.scrapeOnly.slice(0, 20) }, "scrape-only (new finds) — sample of up to 20");
    }
  }

  if (dryRun) {
    log.info({ merged: merged.length }, "dry-run: skipping DB writes");
    await closePg();
    await flushSentry();
    return;
  }

  const { inserted, updated } = await upsertMergedRows(db, merged);
  log.info({ inserted, updated }, "safety_ratings upsert complete");

  const { synced, fuzzyMatched } = await syncToFaaOperators(db);
  log.info({ synced, fuzzy_matched: fuzzyMatched }, "faa_operators sync complete");

  console.log(`\n═══ Safety Ratings Refresh ═══`);
  console.log(`  Sources:     argus=${argus.length}  wingman=${wingman.length}  registered=${registered.length}`);
  console.log(`  Failures:    ${failures.length === 0 ? "none" : failures.join(", ")}`);
  console.log(`  Merged:      ${merged.length}`);
  console.log(`  Inserted:    ${inserted}`);
  console.log(`  Updated:     ${updated}`);
  console.log(`  Synced→FAA:  ${synced} (of which ${fuzzyMatched} via fuzzy name match)`);

  await closePg();
  await flushSentry();
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "safety-refresh fatal error");
    process.exit(1);
  });
}

export { URLS };
