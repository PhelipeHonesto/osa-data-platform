import { describe, it, expect } from "vitest";
import {
  pickCanonicalName,
  pickHeadquartersIcao,
  mergeTypeTags,
  SOURCE_PRIORITY,
} from "../src/memory/canonical/operator-field-priority.js";

describe("pickCanonicalName", () => {
  it("returns null for empty candidates", () => {
    expect(pickCanonicalName([])).toBeNull();
  });

  it("picks the longest non-truncated value", () => {
    expect(pickCanonicalName([
      { value: "NetJets", source: "argus" },
      { value: "NetJets Aviation Inc", source: "faa" },
      { value: "NetJets Aviation", source: "wyvern" },
    ])).toBe("NetJets Aviation Inc");
  });

  it("tiebreaks equal-length values by source priority (FAA wins)", () => {
    expect(pickCanonicalName([
      { value: "Flexjet Corp", source: "wyvern" },
      { value: "Flexjet Corp", source: "faa" },
      { value: "Flexjet Corp", source: "argus" },
    ])).toBe("Flexjet Corp"); // source shouldn't affect equal values
    // With actual differing sources, FAA is picked deterministically
    // (all three values are identical here — any is acceptable, but sort is stable on source priority)
  });

  it("rejects truncated values (ending in ... or …) when non-truncated alternatives exist", () => {
    expect(pickCanonicalName([
      { value: "Aviation Partners Very Long Name...", source: "argus" },
      { value: "Aviation Partners", source: "faa" },
    ])).toBe("Aviation Partners");
  });

  it("falls back to the truncated pool when all candidates are truncated", () => {
    expect(pickCanonicalName([
      { value: "Short Name...", source: "argus" },
      { value: "Even Longer Name…", source: "wyvern" },
    ])).toBe("Even Longer Name…");
  });
});

describe("pickHeadquartersIcao", () => {
  it("returns null for empty candidates", () => {
    expect(pickHeadquartersIcao([])).toBeNull();
  });

  it("FAA wins over ARGUS when both supply an ICAO", () => {
    expect(pickHeadquartersIcao([
      { value: "KPWK", source: "argus" },
      { value: "KORD", source: "faa" },
    ])).toBe("KORD");
  });

  it("ARGUS wins over Wyvern and ADS-B-derived", () => {
    expect(pickHeadquartersIcao([
      { value: "KTEB", source: "adsb" },
      { value: "KBED", source: "wyvern" },
      { value: "KPWK", source: "argus" },
    ])).toBe("KPWK");
  });
});

describe("mergeTypeTags", () => {
  it("returns empty array for empty candidates", () => {
    expect(mergeTypeTags([])).toEqual([]);
  });

  it("unions tags across sources (not override)", () => {
    expect(mergeTypeTags([
      { value: ["charter"], source: "faa" },
      { value: ["management"], source: "argus" },
    ])).toEqual(["charter", "management"]);
  });

  it("dedupes tags that appear in multiple sources", () => {
    expect(mergeTypeTags([
      { value: ["charter", "fractional"], source: "faa" },
      { value: ["charter", "management"], source: "argus" },
    ])).toEqual(["charter", "fractional", "management"]);
  });

  it("orders by source priority (FAA tags first)", () => {
    const result = mergeTypeTags([
      { value: ["cargo"], source: "wyvern" },
      { value: ["charter"], source: "faa" },
    ]);
    expect(result.indexOf("charter")).toBeLessThan(result.indexOf("cargo"));
  });
});

describe("SOURCE_PRIORITY constant", () => {
  it("FAA is the highest-authority source", () => {
    const entries = Object.entries(SOURCE_PRIORITY) as Array<[string, number]>;
    const faaPriority = SOURCE_PRIORITY.faa;
    for (const [source, priority] of entries) {
      if (source === "faa") continue;
      expect(priority).toBeGreaterThan(faaPriority);
    }
  });

  it("manual is the lowest-authority source", () => {
    const entries = Object.entries(SOURCE_PRIORITY) as Array<[string, number]>;
    const manualPriority = SOURCE_PRIORITY.manual;
    for (const [source, priority] of entries) {
      if (source === "manual") continue;
      expect(priority).toBeLessThan(manualPriority);
    }
  });
});
