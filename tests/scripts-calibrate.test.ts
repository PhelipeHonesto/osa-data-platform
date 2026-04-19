import { describe, it, expect } from "vitest";
import {
  parseArgs,
  sampleUpTo,
  assignPairIds,
  DEFAULT_TARGETS,
  analyzeLabels,
  type CalibrationPair,
  type LabeledPair,
} from "../scripts/calibrate-match-thresholds.js";

describe("parseArgs", () => {
  it("recognises --sample", () => {
    expect(parseArgs(["--sample"])).toEqual({ sample: true, score: false });
  });
  it("recognises --score", () => {
    expect(parseArgs(["--score"])).toEqual({ sample: false, score: true });
  });
  it("returns both false when neither flag is passed", () => {
    expect(parseArgs([])).toEqual({ sample: false, score: false });
  });
});

describe("sampleUpTo", () => {
  it("returns all items when pool is smaller than n", () => {
    expect(sampleUpTo([1, 2, 3], 10).sort()).toEqual([1, 2, 3]);
  });

  it("returns exactly n items when pool is larger", () => {
    const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = sampleUpTo(pool, 3);
    expect(result).toHaveLength(3);
    for (const v of result) expect(pool).toContain(v);
  });

  it("returns empty array when n=0", () => {
    expect(sampleUpTo([1, 2, 3], 0)).toEqual([]);
  });

  it("does not mutate the input", () => {
    const pool = [1, 2, 3, 4, 5];
    const frozen = Object.freeze(pool);
    sampleUpTo(frozen, 2); // Should not throw
    expect(pool).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("assignPairIds", () => {
  const mk = (type: "auto_match" | "review_queue", name: string): Omit<CalibrationPair, "pair_id"> => ({
    type,
    scraped_name: name,
    source: "wyvern",
    score: 0.8,
    reason: null,
    top_candidate: { operator_id: "u1", canonical_name: "X", existing_sources: [] },
    other_candidates: [],
    label: null,
    comment: null,
  });

  it("sorts auto_match before review_queue then by scraped_name, assigns 1..N", () => {
    const pairs = [
      mk("review_queue", "Zeta Air"),
      mk("auto_match", "Beta Jets"),
      mk("auto_match", "Alpha Aviation"),
      mk("review_queue", "Yankee Jets"),
    ];
    const assigned = assignPairIds(pairs);
    expect(assigned.map((p) => p.scraped_name)).toEqual([
      "Alpha Aviation",
      "Beta Jets",
      "Yankee Jets",
      "Zeta Air",
    ]);
    expect(assigned.map((p) => p.pair_id)).toEqual([1, 2, 3, 4]);
  });

  it("produces stable ids across calls with the same input", () => {
    const pairs = [mk("auto_match", "Alpha"), mk("review_queue", "Bravo")];
    const a = assignPairIds(pairs);
    const b = assignPairIds(pairs);
    expect(a).toEqual(b);
  });

  it("preserves all original fields on each pair", () => {
    const input = mk("review_queue", "Op One");
    input.score = 0.123;
    input.reason = "medium_name_only";
    const [out] = assignPairIds([input]);
    expect(out?.score).toBe(0.123);
    expect(out?.reason).toBe("medium_name_only");
    expect(out?.label).toBeNull();
    expect(out?.comment).toBeNull();
  });
});

describe("analyzeLabels — per-stratum precision + recommended thresholds", () => {
  const labeled = (over: Partial<LabeledPair>): LabeledPair => ({
    pair_id: 1,
    type: "auto_match",
    scraped_name: "op",
    source: "wyvern",
    score: 0.95,
    reason: null,
    top_candidate: { operator_id: "u", canonical_name: "X", existing_sources: [] },
    other_candidates: [],
    label: "correct",
    comment: null,
    ...over,
  });

  it("computes auto_match precision across correct + false-positive mix", () => {
    const pairs: LabeledPair[] = [
      labeled({ pair_id: 1, score: 0.98, label: "correct" }),
      labeled({ pair_id: 2, score: 0.96, label: "correct" }),
      labeled({ pair_id: 3, score: 0.91, label: "new_operator" }),
    ];
    const a = analyzeLabels(pairs);
    expect(a.auto_match.count).toBe(3);
    expect(a.auto_match.correct).toBe(2);
    expect(a.auto_match.precision).toBeCloseTo(2 / 3);
    expect(a.false_positive_auto_matches).toHaveLength(1);
    expect(a.false_positive_auto_matches[0]?.pair_id).toBe(3);
  });

  it("recommends a high threshold just below the lowest correct auto_match score", () => {
    const pairs: LabeledPair[] = [
      labeled({ score: 0.99, label: "correct" }),
      labeled({ score: 0.93, label: "correct" }),
      labeled({ score: 0.91, label: "new_operator" }),
    ];
    const a = analyzeLabels(pairs);
    // Lowest correct = 0.93; recommended = 0.93 - 0.005 = 0.925 → rounded to 0.93 (2dp round).
    expect(a.recommendations.high).toBeGreaterThanOrEqual(0.9);
    expect(a.recommendations.high).toBeLessThan(0.93);
  });

  it("floors the high threshold at 0.90 even when correct range is lower", () => {
    const pairs: LabeledPair[] = [labeled({ score: 0.7, label: "correct" })];
    const a = analyzeLabels(pairs);
    expect(a.recommendations.high).toBe(0.9);
  });

  it("keeps medium and low unchanged (stratum precision not threshold-separable)", () => {
    const a = analyzeLabels([labeled({})]);
    expect(a.recommendations.medium).toBe(0.75);
    expect(a.recommendations.low).toBe(0.6);
  });

  it("splits review_queue pairs by reason", () => {
    const pairs: LabeledPair[] = [
      labeled({ type: "review_queue", reason: "medium_name_only", label: "correct", score: 0.82 }),
      labeled({ type: "review_queue", reason: "medium_name_only", label: "new_operator", score: 0.80 }),
      labeled({ type: "review_queue", reason: "low_tier", label: "new_operator", score: 0.65 }),
      labeled({ type: "review_queue", reason: "ambiguous_runner_up", label: "new_operator", score: 0.86 }),
    ];
    const a = analyzeLabels(pairs);
    expect(a.review_medium_name_only.count).toBe(2);
    expect(a.review_medium_name_only.correct).toBe(1);
    expect(a.review_low_tier.count).toBe(1);
    expect(a.review_ambiguous.count).toBe(1);
  });

  it("stamps calibrated_at as an ISO timestamp and records sample size", () => {
    const pairs: LabeledPair[] = [labeled({}), labeled({}), labeled({})];
    const a = analyzeLabels(pairs);
    expect(a.recommendations.calibrated_sample_size).toBe(3);
    expect(a.recommendations.calibrated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("DEFAULT_TARGETS", () => {
  it("sums to 50 target pairs", () => {
    const total =
      DEFAULT_TARGETS.auto_match_high +
      DEFAULT_TARGETS.review_medium_name_only +
      DEFAULT_TARGETS.review_low_tier +
      DEFAULT_TARGETS.review_ambiguous;
    expect(total).toBe(50);
  });

  it("gives largest budget to review_medium_name_only (most important stratum)", () => {
    expect(DEFAULT_TARGETS.review_medium_name_only).toBeGreaterThanOrEqual(DEFAULT_TARGETS.review_low_tier);
    expect(DEFAULT_TARGETS.review_medium_name_only).toBeGreaterThanOrEqual(DEFAULT_TARGETS.review_ambiguous);
  });
});
