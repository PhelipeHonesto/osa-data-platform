/**
 * Data-confidence score ("how confident are we in THIS RECORD?").
 *
 *   data_confidence_score = 0.40 * source_reliability
 *                         + 0.25 * data_freshness
 *                         + 0.20 * cross_source_agreement
 *                         + 0.15 * completeness
 *
 * All four components are 0.0–1.0. Output is clamped to [0, 1] and rounded
 * to 2 decimal places (matches the NUMERIC(3, 2) column in operators).
 *
 * Monotonicity invariant: adding a *more-reliable* source identity cannot
 * decrease the score. The tests cover this explicitly.
 *
 * Separate from operator_trust_score (see operator-trust-score.ts), which
 * answers the substantive question "How trustworthy is this operator as
 * an entity?" — safety ratings, accident history, source count, identity
 * stability. The two scores are orthogonal: an operator can have high
 * data_confidence (FAA + ARGUS both say the same thing, recently) and
 * low operator_trust (recent accidents, no safety rating) or vice versa.
 *
 * Pure functions, no DB, no time calls beyond what the caller passes.
 */

import type { Source } from "./operator-field-priority.js";

export const SOURCE_RELIABILITY: Readonly<Record<Source, number>> = {
  faa: 1.0,
  argus: 0.90,
  wyvern: 0.85,
  isbao: 0.85,
  adsb: 0.75,
  manual: 0.50,
};

export const WEIGHTS = {
  sourceReliability: 0.40,
  dataFreshness: 0.25,
  crossSourceAgreement: 0.20,
  completeness: 0.15,
} as const;

export const FRESHNESS_HALF_LIFE_DAYS = 180;

export interface TrustScoreInputs {
  /** All linked identity sources (may repeat — duplicates don't count extra for agreement). */
  sources: Source[];
  /** Max(last_verified_at) across linked identities, or null if none. */
  mostRecentVerifiedAt: Date | null;
  /** Caller-supplied "now" so the function stays pure. */
  now: Date;
  /** Count of canonical-row fields populated (non-null, non-empty). */
  populatedFields: number;
  /** Total expected fields on the canonical row. */
  expectedFields: number;
}

export function sourceReliability(sources: Source[]): number {
  if (sources.length === 0) return 0;
  return Math.max(...sources.map((s) => SOURCE_RELIABILITY[s]));
}

export function freshnessScore(
  mostRecentVerifiedAt: Date | null,
  now: Date,
  halfLifeDays = FRESHNESS_HALF_LIFE_DAYS,
): number {
  if (!mostRecentVerifiedAt) return 0;
  const ageMs = now.getTime() - mostRecentVerifiedAt.getTime();
  if (ageMs <= 0) return 1;
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

export function agreementScore(sources: Source[]): number {
  const distinct = new Set(sources).size;
  return Math.min(1, distinct / 3);
}

export function completenessScore(populated: number, expected: number): number {
  if (expected <= 0) return 0;
  return Math.max(0, Math.min(1, populated / expected));
}

export function computeDataConfidenceScore(input: TrustScoreInputs): number {
  const sr = sourceReliability(input.sources);
  const fr = freshnessScore(input.mostRecentVerifiedAt, input.now);
  const ag = agreementScore(input.sources);
  const co = completenessScore(input.populatedFields, input.expectedFields);
  const raw =
    WEIGHTS.sourceReliability * sr +
    WEIGHTS.dataFreshness * fr +
    WEIGHTS.crossSourceAgreement * ag +
    WEIGHTS.completeness * co;
  return Math.max(0, Math.min(1, Math.round(raw * 100) / 100));
}
