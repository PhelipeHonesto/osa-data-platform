import { describe, it, expect } from "vitest";
import {
  parseArgs,
  classifyFaaOperator,
  splitNewVsExisting,
  isRealOperatorCert,
  type FaaOperatorRow,
} from "../scripts/backfill-operators-canonical-faa.js";

describe("parseArgs", () => {
  it("defaults to dry run (commit=false) when no flag", () => {
    expect(parseArgs([])).toEqual({ commit: false });
    expect(parseArgs(["--force"])).toEqual({ commit: false });
  });
  it("sets commit=true when --commit is present", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true });
    expect(parseArgs(["--verbose", "--commit", "--foo"])).toEqual({ commit: true });
  });
});

describe("classifyFaaOperator", () => {
  const base: FaaOperatorRow = {
    certificate_number: "1OCA082A",
    name: "NETJETS AVIATION INC",
    dba_name: null,
    city: "COLUMBUS",
    state: "OH",
    created_at: "2025-07-14T12:00:00Z",
  };

  it("maps certificate_number, name, and created_at straight through", () => {
    const p = classifyFaaOperator(base);
    expect(p.certificateNumber).toBe("1OCA082A");
    expect(p.canonicalName).toBe("NETJETS AVIATION INC");
    expect(p.firstSeenAt).toEqual(new Date("2025-07-14T12:00:00Z"));
  });

  it("defaults type_tags to empty array in Phase 1 (no reliable source column yet)", () => {
    expect(classifyFaaOperator(base).typeTags).toEqual([]);
  });

  it("falls back to now() when created_at is null", () => {
    const t0 = Date.now();
    const p = classifyFaaOperator({ ...base, created_at: null });
    expect(p.firstSeenAt.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(p.firstSeenAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("trims whitespace from canonical_name", () => {
    const p = classifyFaaOperator({ ...base, name: "  Priester Aviation LLC  " });
    expect(p.canonicalName).toBe("Priester Aviation LLC");
  });
});

describe("isRealOperatorCert — filters aircraft owners, keeps real operators", () => {
  it("accepts synthetic 4-letter-3-digit codes (faa-operators-full.ts style)", () => {
    expect(isRealOperatorCert("NETJ001", "NetJets Aviation")).toBe(true);
    expect(isRealOperatorCert("FLEX001", "Flexjet")).toBe(true);
    expect(isRealOperatorCert("WHEE001", "Wheels Up")).toBe(true);
  });

  it("accepts real FAA Part 135 cert format (digit-3letters-3digits-letter)", () => {
    expect(isRealOperatorCert("1OCA082A", "Priester Aviation")).toBe(true);
    expect(isRealOperatorCert("7OCA297N", "Jet Linx Aviation")).toBe(true);
  });

  it("rejects rows where certificate_number equals name (aircraft-owner pollution)", () => {
    expect(isRealOperatorCert("YATES AVIATION LLC", "YATES AVIATION LLC")).toBe(false);
    expect(isRealOperatorCert("CHERRY ROAD LEASING LLC", "CHERRY ROAD LEASING LLC")).toBe(false);
  });

  it("rejects malformed cert-like values that don't match either pattern", () => {
    expect(isRealOperatorCert("AEROTITLE", "AEROTITLE")).toBe(false);
    expect(isRealOperatorCert("NETJETS", "NetJets Aviation")).toBe(false);  // missing digits
    expect(isRealOperatorCert("12345", "Something")).toBe(false);           // all digits
    expect(isRealOperatorCert("netj001", "NetJets Aviation")).toBe(false);  // lowercase
  });
});

describe("splitNewVsExisting", () => {
  const rows: FaaOperatorRow[] = [
    { certificate_number: "A1", name: "Op A", dba_name: null, city: null, state: null, created_at: null },
    { certificate_number: "B2", name: "Op B", dba_name: null, city: null, state: null, created_at: null },
    { certificate_number: "C3", name: "Op C", dba_name: null, city: null, state: null, created_at: null },
  ];

  it("returns all new when the existing set is empty", () => {
    const { newRows, updateCerts } = splitNewVsExisting(rows, new Set());
    expect(newRows).toHaveLength(3);
    expect(updateCerts).toHaveLength(0);
  });

  it("returns all existing when every cert is already linked", () => {
    const { newRows, updateCerts } = splitNewVsExisting(rows, new Set(["A1", "B2", "C3"]));
    expect(newRows).toHaveLength(0);
    expect(updateCerts).toEqual(["A1", "B2", "C3"]);
  });

  it("partitions by cert — mixed case", () => {
    const { newRows, updateCerts } = splitNewVsExisting(rows, new Set(["B2"]));
    expect(newRows.map((r) => r.certificate_number)).toEqual(["A1", "C3"]);
    expect(updateCerts).toEqual(["B2"]);
  });
});
