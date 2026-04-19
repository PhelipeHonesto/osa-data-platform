import { describe, it, expect } from "vitest";
import { computeNameSim, scoreMatch } from "../src/memory/canonical/match-scoring.js";
import { tierOf, THRESHOLDS } from "../src/memory/canonical/match-thresholds.js";

describe("computeNameSim", () => {
  it("returns 1 for identical names", () => {
    expect(computeNameSim("NetJets Aviation", "NetJets Aviation")).toBe(1);
  });

  it("returns 0 when either name is empty", () => {
    expect(computeNameSim("", "NetJets")).toBe(0);
    expect(computeNameSim("NetJets", "")).toBe(0);
  });

  it("takes the max of Jaro-Winkler and trigram (forgiving by design)", () => {
    // Word reordering trips up JW but trigram handles it
    const s = computeNameSim("Aviation Partners LLC", "LLC Aviation Partners");
    expect(s).toBeGreaterThan(0.7);
  });
});

describe("scoreMatch — weighted signal combination", () => {
  it("name-only score equals nameSim (no other signals, mean-imputation kicks in)", () => {
    expect(scoreMatch({ nameSim: 0.85 })).toBe(0.85);
  });

  it("perfect name + all signals true → 1.0", () => {
    expect(scoreMatch({
      nameSim: 1,
      icaoMatch: true,
      stateMatch: true,
      cityMatch: true,
    })).toBe(1);
  });

  it("missing signals don't penalize; name + icao only averages just those two", () => {
    const base = scoreMatch({ nameSim: 0.8 });
    const withIcao = scoreMatch({ nameSim: 0.8, icaoMatch: true });
    expect(withIcao).toBeGreaterThan(base);
  });

  it("clamps to [0, 1]", () => {
    expect(scoreMatch({ nameSim: -0.5 })).toBeGreaterThanOrEqual(0);
    expect(scoreMatch({ nameSim: 1.5 })).toBeLessThanOrEqual(1);
  });
});

describe("tierOf — threshold bucket placement", () => {
  it("high tier is exact-boundary inclusive", () => {
    expect(tierOf(THRESHOLDS.high)).toBe("high");
  });

  it("medium tier kicks in just below high", () => {
    expect(tierOf(THRESHOLDS.high - 0.01)).toBe("medium");
  });

  it("low tier is the manual-review band", () => {
    expect(tierOf(THRESHOLDS.medium - 0.01)).toBe("low");
    expect(tierOf(THRESHOLDS.low)).toBe("low");
  });

  it("below low threshold → new_operator", () => {
    expect(tierOf(THRESHOLDS.low - 0.01)).toBe("new_operator");
    expect(tierOf(0)).toBe("new_operator");
  });
});
