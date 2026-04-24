import { describe, it, expect } from "vitest";
import { preFilter } from "../src/entity-resolution/pre-filters.js";

describe("preFilter — null and placeholder short-circuits", () => {
  it("null certificate_holder → skipped_null", () => {
    expect(preFilter({ certificateHolder: null, registrantType: "7" })).toBe("skipped_null");
  });
  it("empty string → skipped_placeholder", () => {
    expect(preFilter({ certificateHolder: "   ", registrantType: "7" })).toBe("skipped_placeholder");
  });
  for (const p of ["-", "REGISTRATION PENDING", "SALE REPORTED"]) {
    it(`"${p}" → skipped_placeholder`, () => {
      expect(preFilter({ certificateHolder: p, registrantType: "7" })).toBe("skipped_placeholder");
    });
  }
});

describe("preFilter — individual registrant (registrant_type=1)", () => {
  it("registrant_type=1 with an LLC-looking name still skips as individual", () => {
    // Deliberate: once the FAA flags a registration as individual, we trust that
    // over the name tokens. No resolver call.
    expect(preFilter({ certificateHolder: "AWAD RONALD E", registrantType: "1" })).toBe("skipped_individual");
  });
  it("registrant_type=1 with null ch short-circuits to null first", () => {
    // null check runs before registrant_type — placeholder/null is the more
    // specific bucket.
    expect(preFilter({ certificateHolder: null, registrantType: "1" })).toBe("skipped_null");
  });
  it("registrant_type=7 (LLC) does not trigger individual skip", () => {
    expect(preFilter({ certificateHolder: "AWAD AVIATION LLC", registrantType: "7" })).toBeNull();
  });
});

describe("preFilter — trustee suffix", () => {
  for (const name of [
    "BANK OF UTAH TRUSTEE",
    "TVPX AIRCRAFT SOLUTIONS INC TRUSTEE",
    "WILMINGTON TRUST CO TRUSTEE",
    "UMB BANK NA TRUSTEE",
    "AIRCRAFT GUARANTY CORP TRUSTEE",
  ]) {
    it(`"${name}" → skipped_trustee`, () => {
      expect(preFilter({ certificateHolder: name, registrantType: "3" })).toBe("skipped_trustee");
    });
  }

  it("BOARD OF TRUSTEES OF <university> passes through (not a trustee)", () => {
    expect(
      preFilter({
        certificateHolder: "BOARD OF TRUSTEES OF WESTERN MICHIGAN UNIVERSITY",
        registrantType: "5",
      }),
    ).toBeNull();
  });
});

describe("preFilter — explicit trustee names without TRUSTEE suffix", () => {
  it("BANK OF UTAH without TRUSTEE suffix still skips", () => {
    expect(preFilter({ certificateHolder: "BANK OF UTAH", registrantType: "3" })).toBe("skipped_trustee");
  });
  it("TVPX ARS INC TRUSTEE — matches both suffix and explicit name", () => {
    expect(preFilter({ certificateHolder: "TVPX ARS INC TRUSTEE", registrantType: "3" })).toBe("skipped_trustee");
  });
  it("REGIONS BANK TRUSTEE (added per Phelipe) → skipped_trustee", () => {
    expect(preFilter({ certificateHolder: "REGIONS BANK TRUSTEE", registrantType: "3" })).toBe("skipped_trustee");
  });
  it("DEUTSCHE BANK TRUST COMPANY (added per Phelipe) → skipped_trustee", () => {
    expect(preFilter({ certificateHolder: "DEUTSCHE BANK TRUST COMPANY", registrantType: "3" })).toBe(
      "skipped_trustee",
    );
  });
});

describe("preFilter — manufacturer-as-holder", () => {
  for (const name of ["CIRRUS DESIGN CORP", "TEXTRON AVIATION INC", "BOEING COMPANY"]) {
    it(`"${name}" → skipped_manufacturer`, () => {
      expect(preFilter({ certificateHolder: name, registrantType: "3" })).toBe("skipped_manufacturer");
    });
  }
  it("manufacturer must be exact match — GULFSTREAM-SUBSIDIARY passes through", () => {
    // Subsidiary / authorized-service-center entries aren't manufacturer holds.
    expect(
      preFilter({ certificateHolder: "GULFSTREAM PACIFIC AVIATION LLC", registrantType: "7" }),
    ).toBeNull();
  });
});

describe("preFilter — pass-through (resolver should run)", () => {
  for (const name of [
    "NETJETS AVIATION INC",
    "VISTAJET US INC",
    "XYZ AIRCRAFT LLC",
    "FEDERAL EXPRESS CORP",
    "AIR METHODS LLC",
  ]) {
    it(`"${name}" passes through`, () => {
      expect(preFilter({ certificateHolder: name, registrantType: "3" })).toBeNull();
    });
  }
});

describe("preFilter — priority ordering", () => {
  it("placeholder beats individual: 'REGISTRATION PENDING' with reg_type=1 → skipped_placeholder", () => {
    expect(preFilter({ certificateHolder: "REGISTRATION PENDING", registrantType: "1" })).toBe(
      "skipped_placeholder",
    );
  });
  it("individual beats trustee: an individual-owned 'SMITH TRUSTEE' → skipped_individual", () => {
    // Unlikely edge case but worth being explicit: registrant_type=1 is the
    // most authoritative signal once the placeholder check has passed.
    expect(preFilter({ certificateHolder: "SMITH TRUSTEE", registrantType: "1" })).toBe(
      "skipped_individual",
    );
  });
});
