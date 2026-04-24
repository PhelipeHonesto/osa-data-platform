/**
 * Entity-resolution match confidence thresholds.
 *
 * PLACEHOLDER VALUES. The 0.90 / 0.75 / 0.60 cuts are initial guesses; they
 * get calibrated against a labeled sample in Phase 1 commit 8 (calibration
 * script), then locked here with the calibrated_at timestamp + sample size.
 *
 * Commit 9 (manual review CLI) refuses to run while calibrated_at is null —
 * that gate prevents reviewers from spending time on a queue built with
 * uncalibrated thresholds.
 *
 * Re-run calibration (rewriting this file) only if the matcher's inputs
 * change materially (new signal added, source-reliability weights shift).
 */

import type { MatchSignals } from "./match-scoring.js";

export interface MatchThresholds {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly calibrated_at: string | null;
  readonly calibrated_sample_size: number | null;
}

export const THRESHOLDS: MatchThresholds = {
  // Calibrated 2026-04-19 against a 50-pair labeled sample. high raised from
  // 0.90 → 0.91 to catch the "Pacific Jet Charter" class of false positive
  // (score 0.908, different entities sharing a prefix). medium + low
  // unchanged — stratum precision is governed by REQUIRE_SIGNAL_AT_TIERS
  // and the review queue, not absolute score cutoffs.
  high: 0.91,
  medium: 0.75,
  low: 0.60,
  calibrated_at: "2026-04-19T20:20:40.132Z",
  calibrated_sample_size: 50,
};

/**
 * Ambiguity guard: when the top candidate beats the runner-up by less than
 * this epsilon, the match is considered ambiguous and gets downgraded to
 * the review queue regardless of absolute tier. Calibrated in commit 8.
 *
 * Rationale: "top score 0.87, second score 0.85" is the case where the
 * matcher is functionally guessing — both candidates are plausibly the
 * same real-world operator, and letting the slightly-higher score win
 * auto-silently is exactly the risk MDM is supposed to prevent.
 */
export const AMBIGUITY_EPSILON = 0.02;

/**
 * Tiers that require at least one corroborating signal beyond name_sim
 * to auto-match. If name is the only available signal, these tiers
 * downgrade to the review queue.
 *
 * Rationale: in sparse-signal environments (e.g. Wyvern data with zero
 * ICAO), "medium" confidence on name alone means "names look similar
 * but nothing else confirms." That's a review candidate, not an
 * auto-match.
 *
 * Calibrated in commit 8 — may become empty, may include 'low' (redundant
 * since low already goes to review), may get more complex (require 2
 * signals, require ICAO specifically).
 */
export const REQUIRE_SIGNAL_AT_TIERS: ReadonlyArray<"high" | "medium" | "low"> = ["medium"];

/**
 * True when the signal set has at least one corroborating match beyond
 * name similarity. A signal only counts when it explicitly equals true —
 * `undefined` (unknown) and `false` (known mismatch) both fail the check.
 */
export function hasCorroboratingSignal(signals: MatchSignals): boolean {
  return (
    signals.icaoMatch === true ||
    signals.stateMatch === true ||
    signals.cityMatch === true ||
    signals.phoneMatch === true
  );
}

/**
 * Confidence tier a weighted-match score falls into. "exact" is reserved
 * for deterministic (shared-ID) matches and is assigned by the resolver,
 * not by this function.
 */
export type ScoreTier = "high" | "medium" | "low" | "new_operator";

export function tierOf(score: number): ScoreTier {
  if (score >= THRESHOLDS.high) return "high";
  if (score >= THRESHOLDS.medium) return "medium";
  if (score >= THRESHOLDS.low) return "low";
  return "new_operator";
}

export function isCalibrated(): boolean {
  return THRESHOLDS.calibrated_at !== null;
}

/**
 * Review-queue gating.
 *
 * After Stage 2b Checkpoint 3 revealed that the cert_holder-as-operator-proxy
 * walk rate is structurally capped at ~0.05% (trustees hide operator identity
 * for all major charter fleets by design), the small number of resolver-run
 * rows produced a review queue dominated by false positives — "AIR METHODS
 * LLC" ↔ "ACCENT AIRWAYS LLC" style name-shape overlaps with no real-world
 * relationship.
 *
 * The new review gate: a row may only enter operator_match_review when its
 * top candidate has BOTH (a) a non-low tier and (b) at least one
 * corroborating signal (state, city, ICAO, or phone). Without that, the
 * match is recorded as no_match in the resolution_log — no reviewer burn.
 *
 * This rule lives here (not in decide()) so resolveOperatorMatchOnly and
 * any future match-only-style caller can consult the same policy.
 *
 * `resolveOperator` (the write path used by Phase 1 backfill — ARGUS /
 * Wyvern ingest) intentionally does NOT apply this gate. Phase 1 uses the
 * resolver to onboard known real-world operators, and a low-tier name
 * match there is a reviewer task, not a false positive to discard.
 */
export interface ReviewGatePolicy {
  /** Minimum tier a match must reach to be eligible for review. */
  readonly minTier: "medium" | "low";
  /** If true, require at least one corroborating signal (state/city/icao/phone). */
  readonly requireSignal: boolean;
}

export const REVIEW_GATE: ReviewGatePolicy = {
  minTier: "medium",
  requireSignal: true,
};

/**
 * True when a candidate match is eligible for the review queue under
 * `REVIEW_GATE`. Low-tier, new-operator-tier, and (when requireSignal is
 * true) medium/high matches with no corroborating signal all fail the
 * gate and should be recorded as no_match instead of review.
 */
export function canEnterReview(tier: ScoreTier, signals: MatchSignals): boolean {
  if (tier === "new_operator") return false;
  if (tier === "low" && REVIEW_GATE.minTier !== "low") return false;
  if (REVIEW_GATE.requireSignal && !hasCorroboratingSignal(signals)) return false;
  return true;
}
