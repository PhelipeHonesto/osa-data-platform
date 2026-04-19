import { describe, it, expect } from "vitest";
import {
  SAFETY_SOURCE_RELIABILITY,
  OPERATOR_TRUST_WEIGHTS,
  computeSafetyRatingScore,
  computeAccidentHistoryScore,
  computeSourceCountScore,
  computeIdentityStabilityScore,
  computeOperatorTrustScore,
  operatorTrustBreakdown,
} from "../src/memory/canonical/operator-trust-score.js";

describe("weights sum to 1", () => {
  it("matches the commit 10 design (0.40 + 0.25 + 0.20 + 0.15)", () => {
    const total =
      OPERATOR_TRUST_WEIGHTS.safetyRating +
      OPERATOR_TRUST_WEIGHTS.accidentHistory +
      OPERATOR_TRUST_WEIGHTS.sourceCount +
      OPERATOR_TRUST_WEIGHTS.identityStability;
    expect(total).toBeCloseTo(1.0, 10);
  });
});

describe("computeSafetyRatingScore", () => {
  it("returns 0 when no sources are linked", () => {
    expect(computeSafetyRatingScore([])).toBe(0);
  });

  it("returns 0 when only non-safety sources are present", () => {
    expect(computeSafetyRatingScore(["faa", "adsb", "manual"])).toBe(0);
  });

  it("takes the max across safety sources (argus 0.90 > wyvern 0.85)", () => {
    expect(computeSafetyRatingScore(["wyvern", "argus"])).toBe(SAFETY_SOURCE_RELIABILITY.argus);
  });

  it("ignores FAA presence when scoring safety (spec — safety-specific only)", () => {
    const withFaa = computeSafetyRatingScore(["faa", "wyvern"]);
    const withoutFaa = computeSafetyRatingScore(["wyvern"]);
    expect(withFaa).toBe(withoutFaa);
  });
});

describe("computeAccidentHistoryScore", () => {
  it("returns 1.0 for zero accidents in the window", () => {
    expect(computeAccidentHistoryScore(0)).toBe(1.0);
  });

  it("returns 0.85 for one accident (1.0 - 0.15)", () => {
    expect(computeAccidentHistoryScore(1)).toBeCloseTo(0.85, 10);
  });

  it("returns 0.70 for two accidents", () => {
    expect(computeAccidentHistoryScore(2)).toBeCloseTo(0.70, 10);
  });

  it("floors at 0 — 7+ accidents saturate", () => {
    expect(computeAccidentHistoryScore(7)).toBe(0);
    expect(computeAccidentHistoryScore(100)).toBe(0);
  });

  it("treats negative input as zero accidents (defensive)", () => {
    expect(computeAccidentHistoryScore(-1)).toBe(1.0);
  });
});

describe("computeSourceCountScore", () => {
  it("returns 0 for zero sources", () => {
    expect(computeSourceCountScore(0)).toBe(0);
  });

  it("scales linearly up to 3 distinct sources", () => {
    expect(computeSourceCountScore(1)).toBeCloseTo(1 / 3);
    expect(computeSourceCountScore(2)).toBeCloseTo(2 / 3);
    expect(computeSourceCountScore(3)).toBe(1);
  });

  it("caps at 1.0 beyond 3 sources", () => {
    expect(computeSourceCountScore(4)).toBe(1);
    expect(computeSourceCountScore(10)).toBe(1);
  });
});

describe("computeIdentityStabilityScore", () => {
  const now = new Date("2026-04-19T00:00:00Z");
  const oneYearAgo = new Date("2025-04-19T00:00:00Z");
  const elevenMonthsAgo = new Date("2025-05-19T00:00:00Z");

  it("returns 1.0 for 2+ sources AND known ≥ 365 days", () => {
    expect(computeIdentityStabilityScore(2, oneYearAgo, now)).toBe(1.0);
    expect(computeIdentityStabilityScore(5, oneYearAgo, now)).toBe(1.0);
  });

  it("returns 0.7 for 2+ sources but newer than 365 days", () => {
    expect(computeIdentityStabilityScore(2, elevenMonthsAgo, now)).toBe(0.7);
  });

  it("returns 0.5 for single source (regardless of age)", () => {
    expect(computeIdentityStabilityScore(1, oneYearAgo, now)).toBe(0.5);
    expect(computeIdentityStabilityScore(1, elevenMonthsAgo, now)).toBe(0.5);
  });

  it("returns 0.5 for zero sources", () => {
    expect(computeIdentityStabilityScore(0, oneYearAgo, now)).toBe(0.5);
  });
});

describe("computeOperatorTrustScore — full formula", () => {
  const now = new Date("2026-04-19T00:00:00Z");

  it("returns 0 for an operator with no signals", () => {
    expect(computeOperatorTrustScore({
      sources: [],
      accidentsInLast10y: 0,
      firstSeenAt: new Date("2026-04-10T00:00:00Z"),
      now,
    })).toBeCloseTo(
      // 0.40*0 + 0.25*1 + 0.20*0 + 0.15*0.5 = 0.325 → 0.33 (2dp)
      0.33,
      2,
    );
  });

  it("FAA-only new operator with no accidents hits 0.33 (no safety, 1 source, freshly-seen)", () => {
    const s = computeOperatorTrustScore({
      sources: ["faa"],
      accidentsInLast10y: 0,
      firstSeenAt: new Date("2026-04-10T00:00:00Z"),
      now,
    });
    // breakdown: safety=0, accidents=1.0, sourceCount=1/3, stability=0.5
    // 0 + 0.25 + 0.0667 + 0.075 = 0.39 → 0.39
    expect(s).toBeCloseTo(0.39, 2);
  });

  it("ARGUS platinum, multi-source, year-old, no accidents hits near-1.0", () => {
    const s = computeOperatorTrustScore({
      sources: ["faa", "argus", "wyvern"],
      accidentsInLast10y: 0,
      firstSeenAt: new Date("2024-04-10T00:00:00Z"),
      now,
    });
    // breakdown: safety=0.9, accidents=1.0, sourceCount=1.0, stability=1.0
    // 0.36 + 0.25 + 0.20 + 0.15 = 0.96
    expect(s).toBeCloseTo(0.96, 2);
  });

  it("accidents drag the score down — 3 accidents with rest perfect", () => {
    const s = computeOperatorTrustScore({
      sources: ["argus", "wyvern"],
      accidentsInLast10y: 3,
      firstSeenAt: new Date("2024-04-10T00:00:00Z"),
      now,
    });
    // safety=0.9, accidents=1-0.45=0.55, sourceCount=0.67, stability=1.0
    // 0.36 + 0.1375 + 0.1333 + 0.15 = 0.78
    expect(s).toBeCloseTo(0.78, 2);
  });

  it("clamps to [0, 1]", () => {
    const s = computeOperatorTrustScore({
      sources: ["argus", "wyvern", "isbao", "faa"],
      accidentsInLast10y: 0,
      firstSeenAt: new Date("2020-04-10T00:00:00Z"),
      now,
    });
    expect(s).toBeLessThanOrEqual(1);
    expect(s).toBeGreaterThanOrEqual(0);
  });

  it("rounds to 2 decimal places (matches NUMERIC(3,2) column)", () => {
    const s = computeOperatorTrustScore({
      sources: ["wyvern"],
      accidentsInLast10y: 1,
      firstSeenAt: new Date("2024-01-01T00:00:00Z"),
      now,
    });
    expect(Number(s.toFixed(2))).toBe(s);
  });
});

describe("operatorTrustBreakdown — per-component explainability", () => {
  const now = new Date("2026-04-19T00:00:00Z");

  it("returns all four components so callers can surface 'why'", () => {
    const b = operatorTrustBreakdown({
      sources: ["argus", "wyvern"],
      accidentsInLast10y: 1,
      firstSeenAt: new Date("2026-01-01T00:00:00Z"),
      now,
    });
    expect(b.safetyRating).toBe(0.90);
    expect(b.accidentHistory).toBeCloseTo(0.85);
    expect(b.sourceCount).toBeCloseTo(2 / 3);
    expect(b.identityStability).toBe(0.7);
  });
});
