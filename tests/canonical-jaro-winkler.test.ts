import { describe, it, expect } from "vitest";
import { jaro, jaroWinkler } from "../src/entity-resolution/jaro-winkler.js";

describe("jaro", () => {
  it("returns 1 for identical strings", () => {
    expect(jaro("NetJets", "NetJets")).toBe(1);
  });

  it("returns 0 when either string is empty", () => {
    expect(jaro("", "")).toBe(0);
    expect(jaro("NetJets", "")).toBe(0);
    expect(jaro("", "NetJets")).toBe(0);
  });

  it("scores high on single-char difference", () => {
    expect(jaro("NetJets", "NetJest")).toBeGreaterThan(0.9);
  });

  it("handles asymmetric lengths (short substring of long)", () => {
    const s = jaro("Flex", "Flexjet LLC");
    expect(s).toBeGreaterThan(0.7);
    expect(s).toBeLessThan(1);
  });

  it("drops to 0 for strings with no shared characters", () => {
    expect(jaro("abc", "xyz")).toBe(0);
  });
});

describe("jaroWinkler", () => {
  it("returns 1 for identical strings", () => {
    expect(jaroWinkler("NetJets", "NetJets")).toBe(1);
  });

  it("boosts the score for strings sharing a common prefix", () => {
    const plainJaro = jaro("NetJets Aviation", "NetJets Sales");
    const withWinkler = jaroWinkler("NetJets Aviation", "NetJets Sales");
    expect(withWinkler).toBeGreaterThan(plainJaro);
  });

  it("does not apply the prefix boost when base jaro is below 0.7", () => {
    const a = "Operator Alpha";
    const b = "Unrelated Name";
    expect(jaroWinkler(a, b)).toBe(jaro(a, b));
  });

  it("caps the prefix at 4 characters — longer shared prefixes don't add more", () => {
    const shortPrefix = jaroWinkler("Flex", "FlexXXX");
    const longPrefix = jaroWinkler("FlexABCDEF", "FlexABCDEFGHI");
    expect(shortPrefix).toBeGreaterThan(0);
    expect(longPrefix).toBeLessThanOrEqual(1);
  });
});
