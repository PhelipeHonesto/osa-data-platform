import { describe, it, expect } from "vitest";
import { trigrams, trigramSimilarity } from "../src/entity-resolution/trigram.js";

describe("trigrams", () => {
  it("generates padded trigrams (leading/trailing spaces)", () => {
    const t = trigrams("ab");
    expect(t.size).toBeGreaterThan(0);
    // After padding "  ab  ", trigrams include "  a", " ab", "ab ", "b  "
    expect(t.has("  a")).toBe(true);
    expect(t.has(" ab")).toBe(true);
  });

  it("is case-insensitive", () => {
    const a = trigrams("NetJets");
    const b = trigrams("netjets");
    expect(a).toEqual(b);
  });
});

describe("trigramSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(trigramSimilarity("Flexjet", "Flexjet")).toBe(1);
  });

  it("returns 0 when either input is empty", () => {
    expect(trigramSimilarity("", "")).toBe(0);
    expect(trigramSimilarity("Flexjet", "")).toBe(0);
  });

  it("returns 0 for completely disjoint strings", () => {
    expect(trigramSimilarity("abc", "xyz")).toBe(0);
  });

  it("scores substrings meaningfully (case-insensitive)", () => {
    const s = trigramSimilarity("NetJets Aviation", "netjets aviation inc");
    expect(s).toBeGreaterThan(0.6);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("is symmetric: trigramSimilarity(a, b) === trigramSimilarity(b, a)", () => {
    const ab = trigramSimilarity("NetJets Aviation", "Flexjet LLC");
    const ba = trigramSimilarity("Flexjet LLC", "NetJets Aviation");
    expect(ab).toBe(ba);
  });
});
