/**
 * Operator entity resolver (DB-layer glue).
 *
 * Takes one scraped operator record, resolves it against the Gold canonical
 * operators table, and writes exactly one of these outcomes:
 *
 *   exact   — (source, source_id) already linked to an operator.
 *             UPDATE operator_identities.last_verified_at. No new row.
 *   matched — Strong match (high/medium tier, passes ambiguity guard).
 *             INSERT one operator_identities row.
 *   review  — Weak / ambiguous match (low tier OR runner-up within
 *             AMBIGUITY_EPSILON). INSERT one operator_match_review row;
 *             no identity written. Commit 9 CLI writes the identity after
 *             a human picks.
 *   new     — No candidate scored above the low threshold.
 *             INSERT operators + INSERT operator_identities (confidence='exact').
 *
 * Two write paths are mutually exclusive per scraped record — never both
 * operator_identities and operator_match_review for the same input.
 *
 * Pre-filter is deliberately naive: ILIKE on the first significant word of
 * the scraped name, capped at 50 candidates. O(n·m) across 3,898 FAA ops
 * and ~313 scraped records = ~1.2M pair-scorings for the backfill. Fine for
 * one-shot. Commit 10 (if needed) can swap to pg_trgm GIN or vector kNN.
 *
 * Transaction model: caller-owned. Pass a pg.PoolClient that's already
 * inside a BEGIN; when undefined, the resolver acquires one from the pool
 * and wraps its own transaction. Backfill scripts pass a client so a
 * whole batch lives under one transaction.
 *
 * match_evidence is schema-less JSONB (Record<string, unknown>). Convention:
 *   { nameSim, icaoMatch?, stateMatch?, cityMatch?, topScore,
 *     secondBestScore?, secondBestCandidateId?, method }
 */

import pg from "pg";
import { randomUUID } from "node:crypto";
import { getPool } from "../db/pg-database.js";
import { computeNameSim, scoreMatch, type MatchSignals } from "./match-scoring.js";
import {
  AMBIGUITY_EPSILON,
  tierOf,
  REQUIRE_SIGNAL_AT_TIERS,
  hasCorroboratingSignal,
} from "./match-thresholds.js";
import type { Source } from "./operator-field-priority.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ScrapedRecord {
  name: string;
  source: Source;
  sourceId: string;
  /** Home base / hq ICAO if the source provides one. */
  icao?: string;
  /** State / region if provided. */
  state?: string;
  /** City if provided. */
  city?: string;
  /** Original scraped payload, persisted to operator_match_review.scraped_payload when review is needed. */
  payload?: Record<string, unknown>;
}

export type ResolverActionKind = "exact" | "matched" | "review" | "new";

export interface ResolverResult {
  action: ResolverActionKind;
  operatorId: string | null;
  identityId: number | null;
  reviewId: number | null;
  matchConfidence: "exact" | "high" | "medium" | "low" | "manual" | null;
  topScore: number | null;
  reason?: "ambiguous_runner_up" | "low_tier" | "medium_name_only" | null;
}

interface OperatorCandidate {
  operator_id: string;
  canonical_name: string;
  headquarters_icao: string | null;
  state: string | null;
  city: string | null;
}

interface ScoredCandidate {
  operator_id: string;
  canonical_name: string;
  score: number;
  signals: MatchSignals;
}

// ── Pre-filter ───────────────────────────────────────────────────────────

const CANDIDATE_LIMIT = 50;

/**
 * First significant word of a name for ILIKE pre-filtering. Requires 3+ chars
 * AND at least one letter — pure numeric tokens ("247") make poor filters
 * because they'd match too many unrelated operators.
 */
export function firstSignificantWord(name: string): string {
  for (const w of name.split(/\s+/)) {
    const clean = w.replace(/[^A-Za-z0-9]/g, "");
    if (clean.length >= 3 && /[A-Za-z]/.test(clean)) return clean;
  }
  return name.trim();
}

async function fetchCandidates(
  client: pg.PoolClient,
  scraped: ScrapedRecord,
): Promise<OperatorCandidate[]> {
  const word = firstSignificantWord(scraped.name);
  const pattern = `%${word}%`;
  // Join identities → operators via FAA-side state/city hints where we have them.
  // (State/city come from faa_operators via identities; for new ARGUS/Wyvern
  // operators with no FAA cert yet, those hints will be null — that's fine.)
  const res = await client.query<OperatorCandidate>(
    `SELECT
       o.id AS operator_id,
       o.canonical_name,
       o.headquarters_icao,
       fo.state,
       fo.city
     FROM operators o
     LEFT JOIN operator_identities oi ON oi.operator_id = o.id AND oi.source = 'faa'
     LEFT JOIN faa_operators fo ON fo.certificate_number = oi.source_id
     WHERE o.canonical_name ILIKE $1
     LIMIT $2`,
    [pattern, CANDIDATE_LIMIT],
  );
  return res.rows;
}

// ── Scoring ──────────────────────────────────────────────────────────────

function scoreCandidates(
  scraped: ScrapedRecord,
  candidates: OperatorCandidate[],
): ScoredCandidate[] {
  const scored: ScoredCandidate[] = candidates.map((c) => {
    const signals: MatchSignals = {
      nameSim: computeNameSim(scraped.name, c.canonical_name),
    };
    if (scraped.icao !== undefined && c.headquarters_icao !== null) {
      signals.icaoMatch = scraped.icao.toUpperCase() === c.headquarters_icao.toUpperCase();
    }
    if (scraped.state !== undefined && c.state !== null) {
      signals.stateMatch = scraped.state.toUpperCase() === c.state.toUpperCase();
    }
    if (scraped.city !== undefined && c.city !== null) {
      signals.cityMatch = scraped.city.toLowerCase().trim() === c.city.toLowerCase().trim();
    }
    return {
      operator_id: c.operator_id,
      canonical_name: c.canonical_name,
      score: scoreMatch(signals),
      signals,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ── Action decision ──────────────────────────────────────────────────────

interface Decision {
  action: Exclude<ResolverActionKind, "exact">;
  confidence: "high" | "medium" | "low";
  reason?: "ambiguous_runner_up" | "low_tier" | "medium_name_only";
}

function decide(scored: ScoredCandidate[]): Decision {
  if (scored.length === 0) {
    return { action: "new", confidence: "high" };
  }
  const top = scored[0]!;
  const secondScore = scored[1]?.score ?? 0;
  const tier = tierOf(top.score);

  if (tier === "new_operator") {
    return { action: "new", confidence: "high" };
  }
  if (tier === "low") {
    return { action: "review", confidence: "low", reason: "low_tier" };
  }
  // Ambiguity guard: downgrade high/medium to review when runner-up is close.
  if (scored.length >= 2 && top.score - secondScore < AMBIGUITY_EPSILON) {
    return { action: "review", confidence: tier, reason: "ambiguous_runner_up" };
  }
  // Signal-required tier: if the tier gate demands a corroborating signal
  // beyond name similarity and none is present, downgrade to review.
  if (REQUIRE_SIGNAL_AT_TIERS.includes(tier) && !hasCorroboratingSignal(top.signals)) {
    return { action: "review", confidence: tier, reason: "medium_name_only" };
  }
  return { action: "matched", confidence: tier };
}

// ── Write paths ──────────────────────────────────────────────────────────

async function writeExact(
  client: pg.PoolClient,
  scraped: ScrapedRecord,
): Promise<{ operatorId: string; identityId: number } | null> {
  const res = await client.query<{ id: number; operator_id: string }>(
    `UPDATE operator_identities
       SET last_verified_at = NOW()
     WHERE source = $1 AND source_id = $2
     RETURNING id, operator_id`,
    [scraped.source, scraped.sourceId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { operatorId: row.operator_id, identityId: row.id };
}

async function writeMatched(
  client: pg.PoolClient,
  scraped: ScrapedRecord,
  operatorId: string,
  confidence: "high" | "medium",
  topScored: ScoredCandidate,
  runnerUp: ScoredCandidate | null,
): Promise<{ identityId: number }> {
  const evidence: Record<string, unknown> = {
    nameSim: topScored.signals.nameSim,
    topScore: topScored.score,
    method: "name_fuzzy",
  };
  if (topScored.signals.icaoMatch !== undefined) evidence.icaoMatch = topScored.signals.icaoMatch;
  if (topScored.signals.stateMatch !== undefined) evidence.stateMatch = topScored.signals.stateMatch;
  if (topScored.signals.cityMatch !== undefined) evidence.cityMatch = topScored.signals.cityMatch;
  if (runnerUp) {
    evidence.secondBestScore = runnerUp.score;
    evidence.secondBestCandidateId = runnerUp.operator_id;
  }

  const res = await client.query<{ id: number }>(
    `INSERT INTO operator_identities
       (operator_id, source, source_id, name_as_provided,
        match_confidence, match_method, match_evidence)
     VALUES ($1, $2, $3, $4, $5, 'name_fuzzy', $6::jsonb)
     RETURNING id`,
    [
      operatorId,
      scraped.source,
      scraped.sourceId,
      scraped.name,
      confidence,
      JSON.stringify(evidence),
    ],
  );
  return { identityId: res.rows[0]!.id };
}

async function writeReview(
  client: pg.PoolClient,
  scraped: ScrapedRecord,
  scored: ScoredCandidate[],
  reason: "ambiguous_runner_up" | "low_tier" | "medium_name_only",
): Promise<{ reviewId: number }> {
  const top3 = scored.slice(0, 3).map((c) => ({
    operator_id: c.operator_id,
    canonical_name: c.canonical_name,
    score: c.score,
    signals: c.signals,
  }));
  const payload = { ...(scraped.payload ?? {}), _resolver_reason: reason };
  const res = await client.query<{ id: number }>(
    `INSERT INTO operator_match_review
       (scraped_name, scraped_source, scraped_source_id, scraped_payload, candidate_matches)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
     RETURNING id`,
    [
      scraped.name,
      scraped.source,
      scraped.sourceId,
      JSON.stringify(payload),
      JSON.stringify(top3),
    ],
  );
  return { reviewId: res.rows[0]!.id };
}

async function writeNew(
  client: pg.PoolClient,
  scraped: ScrapedRecord,
): Promise<{ operatorId: string; identityId: number }> {
  const operatorId = randomUUID();
  await client.query(
    `INSERT INTO operators (id, canonical_name) VALUES ($1, $2)`,
    [operatorId, scraped.name],
  );
  const evidence: Record<string, unknown> = { method: "self_creation" };
  const res = await client.query<{ id: number }>(
    `INSERT INTO operator_identities
       (operator_id, source, source_id, name_as_provided,
        match_confidence, match_method, match_evidence)
     VALUES ($1, $2, $3, $4, 'exact', 'self_creation', $5::jsonb)
     RETURNING id`,
    [operatorId, scraped.source, scraped.sourceId, scraped.name, JSON.stringify(evidence)],
  );
  return { operatorId, identityId: res.rows[0]!.id };
}

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Resolve one scraped record to a canonical operator.
 *
 * @param scraped  The scraped record.
 * @param client   Optional pg client. When provided, caller owns the
 *                 transaction. When omitted, the resolver acquires one and
 *                 wraps BEGIN/COMMIT internally.
 */
export async function resolveOperator(
  scraped: ScrapedRecord,
  client?: pg.PoolClient,
): Promise<ResolverResult> {
  const ownsClient = client === undefined;
  const c = client ?? (await getPool().connect());
  if (ownsClient) await c.query("BEGIN");
  try {
    const result = await runResolve(c, scraped);
    if (ownsClient) await c.query("COMMIT");
    return result;
  } catch (err) {
    if (ownsClient) {
      try {
        await c.query("ROLLBACK");
      } catch {
        // swallow rollback-of-failed-transaction errors
      }
    }
    throw err;
  } finally {
    if (ownsClient) c.release();
  }
}

async function runResolve(
  client: pg.PoolClient,
  scraped: ScrapedRecord,
): Promise<ResolverResult> {
  // 1. Exact short-circuit on existing (source, source_id).
  const existing = await writeExact(client, scraped);
  if (existing) {
    return {
      action: "exact",
      operatorId: existing.operatorId,
      identityId: existing.identityId,
      reviewId: null,
      matchConfidence: "exact",
      topScore: null,
      reason: null,
    };
  }

  // 2. Candidate fetch + score.
  const candidates = await fetchCandidates(client, scraped);
  const scored = scoreCandidates(scraped, candidates);

  // 3. Decide action.
  const decision = decide(scored);
  const topScore = scored[0]?.score ?? null;

  // 4. Execute the one write path.
  if (decision.action === "new") {
    const { operatorId, identityId } = await writeNew(client, scraped);
    return {
      action: "new",
      operatorId,
      identityId,
      reviewId: null,
      matchConfidence: "exact",
      topScore,
      reason: null,
    };
  }
  if (decision.action === "review") {
    const { reviewId } = await writeReview(client, scraped, scored, decision.reason!);
    return {
      action: "review",
      operatorId: null,
      identityId: null,
      reviewId,
      matchConfidence: null,
      topScore,
      reason: decision.reason ?? null,
    };
  }
  // matched
  const top = scored[0]!;
  const runnerUp = scored[1] ?? null;
  const { identityId } = await writeMatched(
    client,
    scraped,
    top.operator_id,
    decision.confidence as "high" | "medium",
    top,
    runnerUp,
  );
  return {
    action: "matched",
    operatorId: top.operator_id,
    identityId,
    reviewId: null,
    matchConfidence: decision.confidence,
    topScore,
    reason: null,
  };
}
