/**
 * Calibrate entity-resolution match thresholds.
 *
 * Phase 1 commit 8a — `--sample` mode: draws a stratified sample of ~50
 * labeled-able pairs from the current Gold state (operator_identities
 * auto-matches + operator_match_review pending rows) and writes them to
 * data/calibration/matches-sample.json for human labeling.
 *
 * Phase 1 commit 8b — `--score` mode (not in this commit): reads the
 * labeled file, computes per-tier precision / recall, recommends
 * threshold adjustments, and updates match-thresholds.ts with the
 * calibrated values + timestamp. Also persists each review-queue pair's
 * comment into operator_match_review.reviewer_notes for commit 9's CLI
 * to pre-seed the review context.
 *
 * Sample stratification for --sample (target totals; actual counts
 * adjust if a stratum is smaller than target):
 *   auto_match  (confidence=high)    up to 15
 *   review_queue medium_name_only    up to 20
 *   review_queue low_tier            up to 10
 *   review_queue ambiguous_runner_up up to 5
 *   total target 50
 *
 * Output shape (per entry):
 *   {
 *     pair_id: 1..N,                     // stable within this sample
 *     type: 'auto_match' | 'review_queue',
 *     scraped_name,
 *     source: 'argus' | 'wyvern',
 *     score,                              // top_candidate's score
 *     reason,                             // review only; null for auto_match
 *     top_candidate: { operator_id, canonical_name, existing_sources },
 *     other_candidates: [same shape + score],  // review only; [] for auto_match
 *     label: null,                        // human fills: correct|incorrect|use_other|new_operator
 *     comment: null,                      // human fills: free text
 *   }
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:calibrate -- --sample
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("calibrate-thresholds");

const OUTPUT_PATH = resolve(process.cwd(), "data", "calibration", "matches-sample.json");

// ── Types ────────────────────────────────────────────────────────────────

export type PairType = "auto_match" | "review_queue";
export type ReviewReason = "medium_name_only" | "low_tier" | "ambiguous_runner_up";

export interface CandidateInfo {
  operator_id: string;
  canonical_name: string;
  existing_sources: string[];
  score?: number; // only set for other_candidates (top_candidate score lives on the pair)
}

export interface CalibrationPair {
  pair_id: number;
  type: PairType;
  scraped_name: string;
  source: string;
  score: number;
  reason: ReviewReason | null;
  top_candidate: CandidateInfo;
  other_candidates: CandidateInfo[];
  label: null;
  comment: null;
}

export interface SampleTargets {
  auto_match_high: number;
  review_medium_name_only: number;
  review_low_tier: number;
  review_ambiguous: number;
}

export const DEFAULT_TARGETS: SampleTargets = {
  auto_match_high: 15,
  review_medium_name_only: 20,
  review_low_tier: 10,
  review_ambiguous: 5,
};

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): { sample: boolean; score: boolean } {
  return {
    sample: argv.includes("--sample"),
    score: argv.includes("--score"),
  };
}

/**
 * Random sample of up to `n` items. Returns a new array; does not mutate input.
 * Uses Math.random for reproducibility-indifferent selection (calibration
 * is a one-shot activity — we don't need a seed).
 */
export function sampleUpTo<T>(items: ReadonlyArray<T>, n: number): T[] {
  if (items.length <= n) return [...items];
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

/**
 * Assign stable pair_ids to a sample by sorting (type, scraped_name) then
 * indexing 1..N. Returns a new array.
 */
export function assignPairIds(pairs: ReadonlyArray<Omit<CalibrationPair, "pair_id">>): CalibrationPair[] {
  const sorted = [...pairs].sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.scraped_name.localeCompare(b.scraped_name);
  });
  return sorted.map((p, i) => ({ ...p, pair_id: i + 1 }));
}

// ── DB queries ───────────────────────────────────────────────────────────

interface AutoMatchRow {
  identity_id: number;
  scraped_name: string;
  source: string;
  score: number | null;
  operator_id: string;
  canonical_name: string;
  match_confidence: string;
}

async function loadAutoMatches(client: pg.PoolClient): Promise<AutoMatchRow[]> {
  const res = await client.query<AutoMatchRow>(
    `SELECT oi.id AS identity_id,
            oi.name_as_provided AS scraped_name,
            oi.source,
            (oi.match_evidence->>'topScore')::NUMERIC AS score,
            o.id AS operator_id,
            o.canonical_name,
            oi.match_confidence
       FROM operator_identities oi
       JOIN operators o ON o.id = oi.operator_id
      WHERE oi.source IN ('argus','wyvern')
        AND oi.match_confidence IN ('high','medium')`,
  );
  return res.rows;
}

interface ReviewRow {
  id: number;
  scraped_name: string;
  scraped_source: string;
  reason: string | null;
  candidate_matches: Array<{
    operator_id: string;
    canonical_name: string;
    score: number;
  }>;
}

async function loadReviewRows(client: pg.PoolClient): Promise<ReviewRow[]> {
  const res = await client.query<ReviewRow>(
    `SELECT id,
            scraped_name,
            scraped_source,
            scraped_payload->>'_resolver_reason' AS reason,
            candidate_matches
       FROM operator_match_review
      WHERE status = 'pending'`,
  );
  return res.rows;
}

/** Batch-load existing_sources for every operator_id referenced. */
async function loadExistingSources(
  client: pg.PoolClient,
  operatorIds: ReadonlyArray<string>,
): Promise<Map<string, string[]>> {
  const unique = [...new Set(operatorIds)];
  if (unique.length === 0) return new Map();
  const res = await client.query<{ operator_id: string; sources: string[] }>(
    `SELECT operator_id, ARRAY_AGG(DISTINCT source ORDER BY source) AS sources
       FROM operator_identities
      WHERE operator_id = ANY($1::UUID[])
      GROUP BY operator_id`,
    [unique],
  );
  return new Map(res.rows.map((r) => [r.operator_id, r.sources]));
}

// ── Stratified sampling ──────────────────────────────────────────────────

interface Strata {
  autoHigh: AutoMatchRow[];
  reviewMediumNameOnly: ReviewRow[];
  reviewLowTier: ReviewRow[];
  reviewAmbiguous: ReviewRow[];
}

function stratify(auto: AutoMatchRow[], review: ReviewRow[]): Strata {
  return {
    autoHigh: auto.filter((a) => a.match_confidence === "high"),
    reviewMediumNameOnly: review.filter((r) => r.reason === "medium_name_only"),
    reviewLowTier: review.filter((r) => r.reason === "low_tier"),
    reviewAmbiguous: review.filter((r) => r.reason === "ambiguous_runner_up"),
  };
}

// ── Build pairs ──────────────────────────────────────────────────────────

function buildAutoMatchPair(
  row: AutoMatchRow,
  existingSources: Map<string, string[]>,
): Omit<CalibrationPair, "pair_id"> {
  return {
    type: "auto_match",
    scraped_name: row.scraped_name,
    source: row.source,
    score: Number(row.score ?? 0),
    reason: null,
    top_candidate: {
      operator_id: row.operator_id,
      canonical_name: row.canonical_name,
      existing_sources: existingSources.get(row.operator_id) ?? [],
    },
    other_candidates: [],
    label: null,
    comment: null,
  };
}

function buildReviewPair(
  row: ReviewRow,
  canonicalNames: Map<string, string>,
  existingSources: Map<string, string[]>,
): Omit<CalibrationPair, "pair_id"> {
  const matches = Array.isArray(row.candidate_matches) ? row.candidate_matches : [];
  const top = matches[0];
  if (!top) {
    throw new Error(`review row ${row.id} has empty candidate_matches`);
  }
  const rest = matches.slice(1, 3).map((c) => ({
    operator_id: c.operator_id,
    canonical_name: canonicalNames.get(c.operator_id) ?? c.canonical_name,
    existing_sources: existingSources.get(c.operator_id) ?? [],
    score: Number(c.score),
  }));
  return {
    type: "review_queue",
    scraped_name: row.scraped_name,
    source: row.scraped_source,
    score: Number(top.score),
    reason: (row.reason as ReviewReason | null) ?? null,
    top_candidate: {
      operator_id: top.operator_id,
      canonical_name: canonicalNames.get(top.operator_id) ?? top.canonical_name,
      existing_sources: existingSources.get(top.operator_id) ?? [],
    },
    other_candidates: rest,
    label: null,
    comment: null,
  };
}

// ── Score mode ───────────────────────────────────────────────────────────

export type Label = "correct" | "incorrect" | "use_other" | "new_operator";

export interface LabeledPair extends CalibrationPair {
  label: Label | null;
  comment: string | null;
}

export interface StratumAnalysis {
  count: number;
  correct: number;
  precision: number;
  correct_score_min: number | null;
  correct_score_max: number | null;
  wrong_score_min: number | null;
  wrong_score_max: number | null;
}

export interface Analysis {
  auto_match: StratumAnalysis;
  review_ambiguous: StratumAnalysis;
  review_medium_name_only: StratumAnalysis;
  review_low_tier: StratumAnalysis;
  false_positive_auto_matches: Array<{
    pair_id: number;
    scraped_name: string;
    top_candidate: string;
    score: number;
    comment: string | null;
  }>;
  recommendations: {
    high: number;
    medium: number;
    low: number;
    calibrated_at: string;
    calibrated_sample_size: number;
  };
}

export function loadLabeledSample(path: string): LabeledPair[] {
  const raw = readFileSync(path, "utf-8");
  const pairs = JSON.parse(raw) as LabeledPair[];
  const unlabeled = pairs.filter((p) => p.label === null);
  if (unlabeled.length > 0) {
    throw new Error(
      `${unlabeled.length} of ${pairs.length} pairs are unlabeled — fill every 'label' field before --score`,
    );
  }
  return pairs;
}

function analyzeStratum(pairs: LabeledPair[]): StratumAnalysis {
  const correctScores = pairs.filter((p) => p.label === "correct").map((p) => p.score);
  const wrongScores = pairs
    .filter((p) => p.label === "new_operator" || p.label === "incorrect")
    .map((p) => p.score);
  return {
    count: pairs.length,
    correct: correctScores.length,
    precision: pairs.length > 0 ? correctScores.length / pairs.length : 0,
    correct_score_min: correctScores.length > 0 ? Math.min(...correctScores) : null,
    correct_score_max: correctScores.length > 0 ? Math.max(...correctScores) : null,
    wrong_score_min: wrongScores.length > 0 ? Math.min(...wrongScores) : null,
    wrong_score_max: wrongScores.length > 0 ? Math.max(...wrongScores) : null,
  };
}

/**
 * Calibration logic (auditable — all math is explicit):
 *
 *   high = max(0.90, lowest_correct_auto_match - 0.005)
 *     (keep all known-correct above the line; don't go lower than 0.90)
 *     Floor ensures we never relax the default. A sample with no wrong
 *     auto-matches leaves high at the default 0.90.
 *
 *   medium = 0.75 (unchanged — stratum precision is already governed by
 *     REQUIRE_SIGNAL_AT_TIERS, not absolute score).
 *
 *   low = 0.60 (unchanged — review stratum serves the low band; raising
 *     would reject true matches below 0.70 without catching more FPs).
 */
export function analyzeLabels(pairs: LabeledPair[]): Analysis {
  const auto = pairs.filter((p) => p.type === "auto_match");
  const review = pairs.filter((p) => p.type === "review_queue");

  const analyses = {
    auto_match: analyzeStratum(auto),
    review_ambiguous: analyzeStratum(review.filter((p) => p.reason === "ambiguous_runner_up")),
    review_medium_name_only: analyzeStratum(review.filter((p) => p.reason === "medium_name_only")),
    review_low_tier: analyzeStratum(review.filter((p) => p.reason === "low_tier")),
  };

  const falsePositives = auto
    .filter((p) => p.label === "new_operator" || p.label === "incorrect")
    .map((p) => ({
      pair_id: p.pair_id,
      scraped_name: p.scraped_name,
      top_candidate: p.top_candidate.canonical_name,
      score: p.score,
      comment: p.comment,
    }));

  // high threshold: strictly below the lowest correct auto_match, rounded
  // down to 2 decimal places. Floor at the default 0.90 so calibration
  // never relaxes the matcher. FP guard: 0.93 * 100 = 93.00000000000001
  // in JS, so detect "essentially on a cent boundary" via epsilon.
  const lowestCorrectAutoMatch = analyses.auto_match.correct_score_min ?? 0.9;
  const tightenedHigh = (() => {
    const cents = lowestCorrectAutoMatch * 100;
    const floorCents = Math.floor(cents + 1e-9);
    const atBoundary = Math.abs(cents - floorCents) < 1e-6;
    const recCents = atBoundary ? floorCents - 1 : floorCents;
    return Math.max(0.9, recCents / 100);
  })();

  return {
    ...analyses,
    false_positive_auto_matches: falsePositives,
    recommendations: {
      high: tightenedHigh,
      medium: 0.75,
      low: 0.6,
      calibrated_at: new Date().toISOString(),
      calibrated_sample_size: pairs.length,
    },
  };
}

function printAnalysisReport(a: Analysis): void {
  const fmt = (s: StratumAnalysis, label: string) => {
    const p = (s.precision * 100).toFixed(0);
    const cr = s.correct_score_min !== null
      ? `[${s.correct_score_min.toFixed(3)}-${s.correct_score_max!.toFixed(3)}]`
      : "n/a";
    const wr = s.wrong_score_min !== null
      ? `[${s.wrong_score_min.toFixed(3)}-${s.wrong_score_max!.toFixed(3)}]`
      : "n/a";
    console.log(`  ${label.padEnd(24)} ${s.correct}/${s.count} correct (${p}%)  correct ${cr}  wrong ${wr}`);
  };
  console.log(`\n[calibrate] Per-stratum precision:`);
  fmt(a.auto_match, "auto_match (high):");
  fmt(a.review_ambiguous, "ambiguous_runner_up:");
  fmt(a.review_medium_name_only, "medium_name_only:");
  fmt(a.review_low_tier, "low_tier:");

  if (a.false_positive_auto_matches.length > 0) {
    console.log(`\n[calibrate] Auto-match false positives (should NOT have auto-matched):`);
    for (const fp of a.false_positive_auto_matches) {
      console.log(`  pair ${fp.pair_id}: '${fp.scraped_name}' → '${fp.top_candidate}' (score=${fp.score.toFixed(3)})`);
      if (fp.comment) console.log(`    ${fp.comment}`);
    }
  }

  console.log(`\n[calibrate] Recommended thresholds:`);
  console.log(`  high:   ${a.recommendations.high.toFixed(2)}  (was 0.90)`);
  console.log(`  medium: ${a.recommendations.medium.toFixed(2)}  (unchanged — signal gate is load-bearing)`);
  console.log(`  low:    ${a.recommendations.low.toFixed(2)}  (unchanged — review catches low-tier)`);
}

/**
 * Persist every review_queue pair's comment into
 * operator_match_review.reviewer_notes, keyed by (scraped_source, scraped_source_id).
 * Comments on auto_match pairs are not persisted — those rows are in
 * operator_identities, not review queue.
 */
async function persistReviewComments(
  client: pg.PoolClient,
  pairs: LabeledPair[],
): Promise<number> {
  const reviewWithComment = pairs.filter(
    (p) => p.type === "review_queue" && p.comment !== null && p.comment !== "",
  );
  let persisted = 0;
  for (const p of reviewWithComment) {
    const sourceId = p.top_candidate.operator_id; // Not the right key — scraped_source_id is what we need.
    // Pull the scraped_source_id from the review row using scraped_name + scraped_source
    // (operator_match_review doesn't expose scraped_source_id in the sample JSON — we
    // use scraped_name as the join key).
    const res = await client.query(
      `UPDATE operator_match_review
          SET reviewer_notes = $1
        WHERE scraped_source = $2
          AND scraped_name = $3
          AND status = 'pending'`,
      [p.comment, p.source, p.scraped_name],
    );
    void sourceId;
    persisted += res.rowCount ?? 0;
  }
  return persisted;
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

// ── Main (sample mode) ───────────────────────────────────────────────────

async function runSample(client: pg.PoolClient, targets: SampleTargets): Promise<CalibrationPair[]> {
  console.log("[calibrate] Loading auto_match + review_queue pools...");
  const [autoRows, reviewRows] = await Promise.all([
    loadAutoMatches(client),
    loadReviewRows(client),
  ]);
  console.log(`[calibrate] Pool: ${autoRows.length} auto_match, ${reviewRows.length} review_queue`);

  const strata = stratify(autoRows, reviewRows);
  console.log(
    `[calibrate] Strata: auto_high=${strata.autoHigh.length}, medium_name_only=${strata.reviewMediumNameOnly.length}, low_tier=${strata.reviewLowTier.length}, ambiguous=${strata.reviewAmbiguous.length}`,
  );

  // Reallocate: if ambiguous has fewer than target, shift slots to medium_name_only.
  const ambigTake = Math.min(targets.review_ambiguous, strata.reviewAmbiguous.length);
  const mediumTake = Math.min(
    strata.reviewMediumNameOnly.length,
    targets.review_medium_name_only + (targets.review_ambiguous - ambigTake),
  );
  const lowTake = Math.min(targets.review_low_tier, strata.reviewLowTier.length);
  const autoTake = Math.min(targets.auto_match_high, strata.autoHigh.length);

  const sampledAuto = sampleUpTo(strata.autoHigh, autoTake);
  const sampledMedium = sampleUpTo(strata.reviewMediumNameOnly, mediumTake);
  const sampledLow = sampleUpTo(strata.reviewLowTier, lowTake);
  const sampledAmbig = sampleUpTo(strata.reviewAmbiguous, ambigTake);
  console.log(
    `[calibrate] Sampled: auto=${sampledAuto.length}, medium=${sampledMedium.length}, low=${sampledLow.length}, ambiguous=${sampledAmbig.length}, total=${sampledAuto.length + sampledMedium.length + sampledLow.length + sampledAmbig.length}`,
  );

  // Collect every operator_id referenced (top + others) and batch-fetch existing_sources + names.
  const opIds = new Set<string>();
  for (const a of sampledAuto) opIds.add(a.operator_id);
  for (const r of [...sampledMedium, ...sampledLow, ...sampledAmbig]) {
    const matches = Array.isArray(r.candidate_matches) ? r.candidate_matches : [];
    for (const c of matches.slice(0, 3)) opIds.add(c.operator_id);
  }
  console.log(`[calibrate] Fetching existing_sources + names for ${opIds.size} distinct operators...`);
  const existingSources = await loadExistingSources(client, [...opIds]);
  // Also fetch current canonical_name (the stored candidate_matches might be stale after the
  // upstream `operators` row was renamed — rare, but safer to re-read).
  const nameRes = await client.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM operators WHERE id = ANY($1::UUID[])`,
    [[...opIds]],
  );
  const canonicalNames = new Map(nameRes.rows.map((r) => [r.id, r.canonical_name]));

  const autoPairs = sampledAuto.map((r) => buildAutoMatchPair(r, existingSources));
  const reviewPairs = [...sampledMedium, ...sampledLow, ...sampledAmbig].map((r) =>
    buildReviewPair(r, canonicalNames, existingSources),
  );

  return assignPairIds([...autoPairs, ...reviewPairs]);
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:calibrate requires DATABASE_TYPE=postgres");
  }
  const { sample, score } = parseArgs(process.argv.slice(2));
  if (sample === score) {
    throw new Error("usage: npm run operators:calibrate -- --sample | --score");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    if (sample) {
      const pairs = await runSample(client, DEFAULT_TARGETS);

      mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
      writeFileSync(OUTPUT_PATH, JSON.stringify(pairs, null, 2) + "\n", "utf-8");

      const byType = pairs.reduce<Record<string, number>>((acc, p) => {
        acc[p.type] = (acc[p.type] ?? 0) + 1;
        return acc;
      }, {});
      const byReason = pairs.reduce<Record<string, number>>((acc, p) => {
        const key = p.reason ?? "auto_match";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});

      console.log(`\n[calibrate] Wrote ${pairs.length} pairs → ${OUTPUT_PATH}`);
      console.log(`[calibrate] By type:`, byType);
      console.log(`[calibrate] By reason:`, byReason);
      console.log(`\n[calibrate] Label values:`);
      console.log(`  "correct"      top_candidate is right`);
      console.log(`  "incorrect"    top_candidate is wrong, no other_candidate is right → new_operator`);
      console.log(`  "use_other"    an other_candidates entry is right — say which in comment`);
      console.log(`  "new_operator" none of the candidates fit; this is a new operator`);
      console.log(`  (auto_match type: only correct | incorrect)`);
    } else {
      // --score mode
      const pairs = loadLabeledSample(OUTPUT_PATH);
      const analysis = analyzeLabels(pairs);
      printAnalysisReport(analysis);

      const persisted = await persistReviewComments(client, pairs);
      console.log(`\n[calibrate] Persisted ${persisted} comments into operator_match_review.reviewer_notes`);
      console.log(`\n[calibrate] To apply the calibration, update src/memory/canonical/match-thresholds.ts:`);
      const recs = analysis.recommendations;
      console.log(`  high: ${recs.high.toFixed(2)}`);
      console.log(`  medium: ${recs.medium.toFixed(2)}`);
      console.log(`  low: ${recs.low.toFixed(2)}`);
      console.log(`  calibrated_at: "${recs.calibrated_at}"`);
      console.log(`  calibrated_sample_size: ${recs.calibrated_sample_size}`);
    }
  } finally {
    client.release();
    await closePg();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "calibrate fatal error");
    process.exit(1);
  });
}
