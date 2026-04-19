import { describe, it, expect } from "vitest";
import {
  parseArgs,
  sampleUpTo,
  assignPairIds,
  DEFAULT_TARGETS,
  type CalibrationPair,
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
