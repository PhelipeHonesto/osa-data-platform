import { describe, it, expect } from "vitest";
import {
  parseArgs,
  countPopulatedFields,
  EXPECTED_FIELDS_PER_OPERATOR,
} from "../scripts/compute-operator-trust-scores.js";

describe("parseArgs", () => {
  it("defaults to dry run", () => {
    expect(parseArgs([])).toEqual({ commit: false });
  });
  it("flips on --commit", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true });
  });
});

describe("countPopulatedFields", () => {
  it("counts canonical_name when non-empty", () => {
    expect(countPopulatedFields({
      canonical_name: "NetJets",
      headquarters_icao: null,
      type_tags: [],
    })).toBe(1);
  });

  it("counts headquarters_icao when set", () => {
    expect(countPopulatedFields({
      canonical_name: "NetJets",
      headquarters_icao: "KCMH",
      type_tags: [],
    })).toBe(2);
  });

  it("counts type_tags when non-empty", () => {
    expect(countPopulatedFields({
      canonical_name: "NetJets",
      headquarters_icao: "KCMH",
      type_tags: ["fractional"],
    })).toBe(3);
  });

  it("ignores whitespace-only canonical_name", () => {
    expect(countPopulatedFields({
      canonical_name: "   ",
      headquarters_icao: null,
      type_tags: [],
    })).toBe(0);
  });

  it("matches EXPECTED_FIELDS_PER_OPERATOR constant when every field is populated", () => {
    const max = countPopulatedFields({
      canonical_name: "Op",
      headquarters_icao: "KTEB",
      type_tags: ["charter"],
    });
    expect(max).toBe(EXPECTED_FIELDS_PER_OPERATOR);
  });
});
