import { describe, it, expect } from "vitest";
import {
  sourceReliability,
  freshnessScore,
  agreementScore,
  completenessScore,
  computeDataConfidenceScore,
  SOURCE_RELIABILITY,
  FRESHNESS_HALF_LIFE_DAYS,
} from "../src/memory/canonical/trust-score.js";

describe("sourceReliability", () => {
  it("returns 0 for no sources", () => {
    expect(sourceReliability([])).toBe(0);
  });

  it("takes the max — FAA beats everything", () => {
    expect(sourceReliability(["manual", "wyvern", "faa"])).toBe(SOURCE_RELIABILITY.faa);
  });

  it("respects source hierarchy (argus > wyvern > manual)", () => {
    expect(sourceReliability(["manual"])).toBe(SOURCE_RELIABILITY.manual);
    expect(sourceReliability(["wyvern"])).toBe(SOURCE_RELIABILITY.wyvern);
    expect(sourceReliability(["argus"])).toBe(SOURCE_RELIABILITY.argus);
  });
});

describe("freshnessScore", () => {
  const now = new Date("2026-04-18T00:00:00Z");

  it("returns 0 when no verification timestamp", () => {
    expect(freshnessScore(null, now)).toBe(0);
  });

  it("returns 1 when verification is in the future or this instant (clock skew tolerance)", () => {
    expect(freshnessScore(now, now)).toBe(1);
    expect(freshnessScore(new Date("2026-05-01T00:00:00Z"), now)).toBe(1);
  });

  it("decays to exactly 0.5 at the half-life", () => {
    const halfLifeAgo = new Date(now.getTime() - FRESHNESS_HALF_LIFE_DAYS * 24 * 3600 * 1000);
    expect(freshnessScore(halfLifeAgo, now)).toBeCloseTo(0.5, 5);
  });

  it("decays to 0.25 at two half-lives", () => {
    const twoHalfLivesAgo = new Date(now.getTime() - 2 * FRESHNESS_HALF_LIFE_DAYS * 24 * 3600 * 1000);
    expect(freshnessScore(twoHalfLivesAgo, now)).toBeCloseTo(0.25, 5);
  });
});

describe("agreementScore", () => {
  it("returns 0 for no sources", () => {
    expect(agreementScore([])).toBe(0);
  });

  it("counts distinct sources, not occurrences", () => {
    expect(agreementScore(["faa", "faa", "faa"])).toBeCloseTo(1 / 3);
  });

  it("caps at 1.0 when 3+ distinct sources confirm", () => {
    expect(agreementScore(["faa", "argus", "wyvern"])).toBe(1);
    expect(agreementScore(["faa", "argus", "wyvern", "adsb"])).toBe(1);
  });
});

describe("completenessScore", () => {
  it("returns populated/expected clamped to [0, 1]", () => {
    expect(completenessScore(0, 4)).toBe(0);
    expect(completenessScore(2, 4)).toBe(0.5);
    expect(completenessScore(4, 4)).toBe(1);
  });

  it("handles zero expected fields without dividing by zero", () => {
    expect(completenessScore(0, 0)).toBe(0);
  });
});

describe("computeDataConfidenceScore", () => {
  const now = new Date("2026-04-18T00:00:00Z");
  const freshVerified = new Date("2026-04-18T00:00:00Z");

  it("all-zero input → 0", () => {
    expect(computeDataConfidenceScore({
      sources: [],
      mostRecentVerifiedAt: null,
      now,
      populatedFields: 0,
      expectedFields: 4,
    })).toBe(0);
  });

  it("FAA-only, just-verified, all fields populated → near 1.0", () => {
    const s = computeDataConfidenceScore({
      sources: ["faa"],
      mostRecentVerifiedAt: freshVerified,
      now,
      populatedFields: 4,
      expectedFields: 4,
    });
    // 0.40*1.0 + 0.25*1.0 + 0.20*0.33 + 0.15*1.0 = 0.87
    expect(s).toBeCloseTo(0.87, 2);
  });

  it("all signals perfect (3+ sources, fresh, complete) → 1.0", () => {
    expect(computeDataConfidenceScore({
      sources: ["faa", "argus", "wyvern"],
      mostRecentVerifiedAt: freshVerified,
      now,
      populatedFields: 4,
      expectedFields: 4,
    })).toBe(1);
  });

  it("monotonicity: adding a second more-reliable source cannot decrease the score", () => {
    const before = computeDataConfidenceScore({
      sources: ["manual"],
      mostRecentVerifiedAt: freshVerified,
      now,
      populatedFields: 4,
      expectedFields: 4,
    });
    const after = computeDataConfidenceScore({
      sources: ["manual", "faa"],
      mostRecentVerifiedAt: freshVerified,
      now,
      populatedFields: 4,
      expectedFields: 4,
    });
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("rounds to 2 decimal places (matches NUMERIC(3,2) column)", () => {
    const s = computeDataConfidenceScore({
      sources: ["wyvern"],
      mostRecentVerifiedAt: freshVerified,
      now,
      populatedFields: 3,
      expectedFields: 4,
    });
    // Ensures the result is roundable to 2dp, never more precision than that.
    expect(Number((s).toFixed(2))).toBe(s);
  });

  it("never returns above 1.0 even with extreme inputs", () => {
    const s = computeDataConfidenceScore({
      sources: ["faa", "argus", "wyvern", "isbao", "adsb"],
      mostRecentVerifiedAt: new Date(now.getTime() + 1e10),
      now,
      populatedFields: 100,
      expectedFields: 4,
    });
    expect(s).toBeLessThanOrEqual(1);
  });
});
