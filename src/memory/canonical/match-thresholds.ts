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

export interface MatchThresholds {
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly calibrated_at: string | null;
  readonly calibrated_sample_size: number | null;
}

export const THRESHOLDS: MatchThresholds = {
  high: 0.90,
  medium: 0.75,
  low: 0.60,
  calibrated_at: null,
  calibrated_sample_size: null,
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
