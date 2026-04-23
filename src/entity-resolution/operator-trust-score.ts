/**
 * INTERNAL DECISION-SUPPORT SCORE.
 *
 * This value is computed, stored, and used for:
 *   - Ranking options when multiple operators serve the same mission.
 *   - Adding contextual caveats to Dumont's recommendations.
 *   - Internal risk modeling and deal-quality tracking.
 *   - Flagging edge-case bookings for human review.
 *
 * This value is NOT used for:
 *   - Filtering operators out of recommendations.
 *   - Preventing customer access to any legally-operating carrier.
 *   - Customer-facing display as a raw number.
 *
 * OSA is a charter brokerage. We route business to all viable operators,
 * including consolidating holdings (Vista Global, Wheels Up, Flexjet,
 * NetJets) that score lower under this formula. Trust scores inform HOW
 * we describe and recommend options — not WHETHER those options are
 * available. Any future caller that wires a hard gate on this score is
 * using it wrong.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Operator trust score ("how trustworthy is THIS OPERATOR as an entity?").
 *
 *   operator_trust_score = 0.40 * safety_rating_score
 *                        + 0.25 * accident_history_score
 *                        + 0.20 * source_count_score
 *                        + 0.15 * identity_stability_score
 *
 * All four components are 0.0–1.0. Output is clamped and rounded to 2dp.
 *
 * Substantive (about the operator), not meta (about our confidence in the
 * record). For the "confident in the record" score, see trust-score.ts →
 * computeDataConfidenceScore. The two are orthogonal and both land on the
 * operators row in separate columns.
 *
 * Pure functions. The DB-touching batch job that feeds these lives in
 * scripts/compute-operator-trust-scores.ts.
 */

import type { Source } from "./operator-field-priority.js";

/**
 * Source reliability scoped to SAFETY-RATING sources only. FAA / ADS-B /
 * manual don't carry a safety signal; they're recorded elsewhere.
 */
export const SAFETY_SOURCE_RELIABILITY: Readonly<Partial<Record<Source, number>>> = {
  argus: 0.90,
  wyvern: 0.85,
  isbao: 0.85,
};

export const OPERATOR_TRUST_WEIGHTS = {
  safetyRating: 0.40,
  accidentHistory: 0.25,
  sourceCount: 0.20,
  identityStability: 0.15,
} as const;

/**
 * Max safety-source reliability across an operator's identities. Returns 0
 * when no safety source is linked. FAA / ADS-B / manual identities do not
 * contribute — they're about presence on the registry, not safety posture.
 */
export function computeSafetyRatingScore(sources: ReadonlyArray<Source>): number {
  const scores: number[] = [];
  for (const s of sources) {
    const r = SAFETY_SOURCE_RELIABILITY[s];
    if (r !== undefined) scores.push(r);
  }
  if (scores.length === 0) return 0;
  return Math.max(...scores);
}

/**
 * 0 accidents → 1.0, 1 → 0.85, 2 → 0.70, ..., 7+ → 0.0.
 * Scope is accidents in the last 10 years; callers pre-filter.
 */
export function computeAccidentHistoryScore(accidentsInWindow: number): number {
  if (accidentsInWindow <= 0) return 1.0;
  return Math.max(0, 1.0 - accidentsInWindow * 0.15);
}

/** 1 source → 0.33, 2 → 0.67, 3+ → 1.0. */
export function computeSourceCountScore(distinctSourceCount: number): number {
  if (distinctSourceCount <= 0) return 0;
  return Math.min(1, distinctSourceCount / 3);
}

/**
 * v0 proxy: tiered by source count AND age of first-known timestamp.
 * Refinement deferred until aircraft_operator_history + operator_events
 * land (Phase 2+).
 *
 *   1.0 if sourceCount ≥ 2 AND firstSeen ≥ 365 days ago
 *   0.7 if sourceCount ≥ 2 (newer records)
 *   0.5 otherwise
 */
export function computeIdentityStabilityScore(
  distinctSourceCount: number,
  firstSeenAt: Date,
  now: Date,
): number {
  const ageDays = (now.getTime() - firstSeenAt.getTime()) / (1000 * 60 * 60 * 24);
  if (distinctSourceCount >= 2 && ageDays >= 365) return 1.0;
  if (distinctSourceCount >= 2) return 0.7;
  return 0.5;
}

export interface OperatorTrustInputs {
  sources: ReadonlyArray<Source>;
  accidentsInLast10y: number;
  firstSeenAt: Date;
  now: Date;
}

export interface OperatorTrustBreakdown {
  safetyRating: number;
  accidentHistory: number;
  sourceCount: number;
  identityStability: number;
}

export function computeOperatorTrustScore(input: OperatorTrustInputs): number {
  const b = operatorTrustBreakdown(input);
  const raw =
    OPERATOR_TRUST_WEIGHTS.safetyRating * b.safetyRating +
    OPERATOR_TRUST_WEIGHTS.accidentHistory * b.accidentHistory +
    OPERATOR_TRUST_WEIGHTS.sourceCount * b.sourceCount +
    OPERATOR_TRUST_WEIGHTS.identityStability * b.identityStability;
  return Math.max(0, Math.min(1, Math.round(raw * 100) / 100));
}

/** Per-component breakdown — useful for explainability + tests. */
export function operatorTrustBreakdown(input: OperatorTrustInputs): OperatorTrustBreakdown {
  const distinct = new Set(input.sources).size;
  return {
    safetyRating: computeSafetyRatingScore(input.sources),
    accidentHistory: computeAccidentHistoryScore(input.accidentsInLast10y),
    sourceCount: computeSourceCountScore(distinct),
    identityStability: computeIdentityStabilityScore(distinct, input.firstSeenAt, input.now),
  };
}
