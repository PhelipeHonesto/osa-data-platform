/**
 * Weighted match scoring. Combines name similarity with optional signals
 * (home base ICAO, state, city) into a single 0.0–1.0 score that the
 * resolver uses to tier a candidate (high / medium / low / new_operator).
 *
 * Pure functions, no side effects, testable without a DB.
 *
 * Signals left undefined are treated as "unknown" — they neither contribute
 * nor penalize. Name similarity is always provided; other fields drop in as
 * the source supplies them. This matters because ARGUS gives us a name plus
 * maybe a home-base ICAO, Wyvern gives us a name plus a country, FAA gives
 * us a name plus address+state+city — different sources, different signal
 * sets, same scoring function.
 */

import { jaroWinkler } from "./jaro-winkler.js";
import { trigramSimilarity } from "./trigram.js";

export interface MatchSignals {
  /** Name similarity 0–1 (typically computeNameSim result). Required. */
  nameSim: number;
  /** Home base ICAO matches between candidate and record. */
  icaoMatch?: boolean;
  /** State / region code matches. */
  stateMatch?: boolean;
  /** City matches (after normalization). */
  cityMatch?: boolean;
  /** Phone number matches (after normalization). */
  phoneMatch?: boolean;
}

const WEIGHTS = {
  nameSim: 0.70,
  icaoMatch: 0.15,
  stateMatch: 0.10,
  cityMatch: 0.05,
} as const;

/**
 * Max of Jaro-Winkler and trigram similarity on two names. The two metrics
 * catch different errors: JW rewards shared prefixes, trigram is robust to
 * word reordering. Taking max is intentionally forgiving — false negatives
 * hurt more than false positives because the manual review queue (Tier 3)
 * catches the latter but not the former.
 */
export function computeNameSim(a: string, b: string): number {
  if (!a || !b) return 0;
  return Math.max(jaroWinkler(a, b), trigramSimilarity(a, b));
}

/**
 * Weighted score. Missing signals are mean-imputed — the weighted average
 * is computed only over the weights of the signals that were provided.
 * Edge case: empty-signal input produces 0.
 */
export function scoreMatch(signals: MatchSignals): number {
  const parts: Array<[number, number]> = [[signals.nameSim, WEIGHTS.nameSim]];
  if (signals.icaoMatch !== undefined) {
    parts.push([signals.icaoMatch ? 1 : 0, WEIGHTS.icaoMatch]);
  }
  if (signals.stateMatch !== undefined) {
    parts.push([signals.stateMatch ? 1 : 0, WEIGHTS.stateMatch]);
  }
  if (signals.cityMatch !== undefined) {
    parts.push([signals.cityMatch ? 1 : 0, WEIGHTS.cityMatch]);
  }
  let totalWeight = 0;
  let weightedSum = 0;
  for (const [value, weight] of parts) {
    totalWeight += weight;
    weightedSum += value * weight;
  }
  if (totalWeight === 0) return 0;
  return Math.max(0, Math.min(1, weightedSum / totalWeight));
}
