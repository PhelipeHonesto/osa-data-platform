import { describe, it, expect } from "vitest";
import {
  parseArgs,
  parseCertNumbersList,
  isIcaoCallsign,
  normalizeAlias,
  decideAliasAction,
  buildOperatorPayload,
  buildIdentityEvidence,
  type RealFleetRow,
} from "../scripts/backfill-operators-canonical-faa-realfleet.js";

describe("parseArgs", () => {
  it("defaults to dry run with threshold=20 and empty cert list", () => {
    expect(parseArgs([])).toEqual({ commit: false, threshold: 20, certNumbers: [] });
  });

  it("reads --commit", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true, threshold: 20, certNumbers: [] });
  });

  it("reads --threshold=N", () => {
    expect(parseArgs(["--threshold=10"])).toEqual({
      commit: false,
      threshold: 10,
      certNumbers: [],
    });
    expect(parseArgs(["--threshold=5", "--commit"])).toEqual({
      commit: true,
      threshold: 5,
      certNumbers: [],
    });
  });

  it("rejects non-numeric and zero/negative thresholds", () => {
    expect(() => parseArgs(["--threshold=abc"])).toThrow();
    expect(() => parseArgs(["--threshold=0"])).toThrow();
    expect(() => parseArgs(["--threshold=-1"])).toThrow();
  });

  it("reads --cert-numbers=CSV (uppercased, deduped, trimmed)", () => {
    expect(parseArgs(["--cert-numbers=SLH,KFS,LJY"])).toEqual({
      commit: false,
      threshold: 20,
      certNumbers: ["SLH", "KFS", "LJY"],
    });
    expect(parseArgs(["--cert-numbers=slh, kfs ,LJY"])).toEqual({
      commit: false,
      threshold: 20,
      certNumbers: ["SLH", "KFS", "LJY"],
    });
    expect(parseArgs(["--cert-numbers=SLH,SLH,KFS"])).toEqual({
      commit: false,
      threshold: 20,
      certNumbers: ["SLH", "KFS"],
    });
  });

  it("rejects empty --cert-numbers values", () => {
    expect(() => parseArgs(["--cert-numbers="])).toThrow();
    expect(() => parseArgs(["--cert-numbers=  ,  "])).toThrow();
  });

  it("combines --cert-numbers with --commit", () => {
    expect(parseArgs(["--cert-numbers=SLH,KFS", "--commit"])).toEqual({
      commit: true,
      threshold: 20,
      certNumbers: ["SLH", "KFS"],
    });
  });

  it("ignores unrelated flags", () => {
    expect(parseArgs(["--verbose", "--foo=bar"])).toEqual({
      commit: false,
      threshold: 20,
      certNumbers: [],
    });
  });
});

describe("parseCertNumbersList", () => {
  it("splits CSV, uppercases, trims, dedupes", () => {
    expect(parseCertNumbersList("slh, kfs ,LJY,slh")).toEqual(["SLH", "KFS", "LJY"]);
  });

  it("throws on empty / whitespace-only input", () => {
    expect(() => parseCertNumbersList("")).toThrow();
    expect(() => parseCertNumbersList("  ,  ,  ")).toThrow();
  });
});

describe("isIcaoCallsign", () => {
  it("accepts exactly 3 uppercase letters", () => {
    expect(isIcaoCallsign("EJA")).toBe(true);
    expect(isIcaoCallsign("LXJ")).toBe(true);
    expect(isIcaoCallsign("WUP")).toBe(true);
    expect(isIcaoCallsign("PCH")).toBe(true);
  });

  it("rejects lowercase or mixed case", () => {
    expect(isIcaoCallsign("eja")).toBe(false);
    expect(isIcaoCallsign("Eja")).toBe(false);
  });

  it("rejects anything not exactly 3 letters", () => {
    expect(isIcaoCallsign("EJ")).toBe(false);
    expect(isIcaoCallsign("EJAX")).toBe(false);
    expect(isIcaoCallsign("EJ1")).toBe(false);
    expect(isIcaoCallsign("")).toBe(false);
    expect(isIcaoCallsign("EJA ")).toBe(false);
  });
});

describe("normalizeAlias", () => {
  it("trims, lowercases, collapses whitespace", () => {
    expect(normalizeAlias("  NetJets   Aviation  ")).toBe("netjets aviation");
    expect(normalizeAlias("Flexjet")).toBe("flexjet");
  });
});

describe("decideAliasAction", () => {
  it("skips when dba_name is null", () => {
    expect(decideAliasAction(null, "NetJets Aviation")).toEqual({ kind: "skip_null" });
  });

  it("skips when dba_name is empty or whitespace", () => {
    expect(decideAliasAction("", "Something")).toEqual({ kind: "skip_null" });
    expect(decideAliasAction("   ", "Something")).toEqual({ kind: "skip_null" });
  });

  it("skips when dba_name equals name (after trim)", () => {
    expect(decideAliasAction("  Same Name  ", "Same Name")).toEqual({ kind: "skip_same_as_name" });
  });

  it("skips ICAO callsigns and surfaces the callsign for logging", () => {
    expect(decideAliasAction("EJA", "NetJets Aviation")).toEqual({
      kind: "skip_icao_callsign",
      callsign: "EJA",
    });
    expect(decideAliasAction("LXJ", "Flexjet")).toEqual({
      kind: "skip_icao_callsign",
      callsign: "LXJ",
    });
  });

  it("inserts real DBAs with normalized alias", () => {
    expect(decideAliasAction("Jet Linx", "Jet Linx Aviation LLC")).toEqual({
      kind: "insert",
      alias: "Jet Linx",
      aliasNormalized: "jet linx",
    });
  });

  it("trims dba_name before inserting", () => {
    expect(decideAliasAction("  Marquis  Jet  ", "Marquis Jet Partners")).toEqual({
      kind: "insert",
      alias: "Marquis  Jet",
      aliasNormalized: "marquis jet",
    });
  });
});

describe("buildOperatorPayload", () => {
  const base: RealFleetRow = {
    certificate_number: "EJA",
    name: "NetJets Aviation",
    dba_name: "EJA",
    aircraft_count: 304,
    state: "OH",
    city: "COLUMBUS",
    created_at: "2025-07-14T12:00:00Z",
  };

  it("trims canonical name and pins operator_type='part_135' + confidence=1.0", () => {
    const p = buildOperatorPayload({ ...base, name: "  NetJets Aviation  " });
    expect(p.canonicalName).toBe("NetJets Aviation");
    expect(p.typeTags).toEqual([]);
    expect(p.operatorType).toBe("part_135");
    expect(p.dataConfidenceScore).toBe(1.0);
  });

  it("preserves created_at as first_seen_at", () => {
    const p = buildOperatorPayload(base);
    expect(p.firstSeenAt).toEqual(new Date("2025-07-14T12:00:00Z"));
  });

  it("falls back to now() when created_at is null", () => {
    const t0 = Date.now();
    const p = buildOperatorPayload({ ...base, created_at: null });
    expect(p.firstSeenAt.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(p.firstSeenAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("buildIdentityEvidence", () => {
  const baseRow: RealFleetRow = {
    certificate_number: "LXJ",
    name: "Flexjet",
    dba_name: "LXJ",
    aircraft_count: 148,
    state: "OH",
    city: "CLEVELAND",
    created_at: null,
  };

  it("threshold mode: includes run_id, threshold, aircraft_count, checkpoint", () => {
    const e = buildIdentityEvidence(baseRow, "run-uuid-123", {
      mode: "threshold",
      threshold: 20,
    });
    expect(e).toEqual({
      backfill_run_id: "run-uuid-123",
      checkpoint: "stage-2b-followup",
      threshold: 20,
      aircraft_count: 148,
    });
  });

  it("cert_list mode (insert_new): no threshold, no merged_into_existing, curated checkpoint", () => {
    const e = buildIdentityEvidence(baseRow, "run-uuid-456", {
      mode: "cert_list",
      mergedIntoExisting: false,
    });
    expect(e).toEqual({
      backfill_run_id: "run-uuid-456",
      checkpoint: "stage-2b-followup-curated",
      aircraft_count: 148,
    });
    expect(e).not.toHaveProperty("threshold");
    expect(e).not.toHaveProperty("merged_into_existing");
  });

  it("cert_list mode (merge_existing): adds merged_into_existing=true", () => {
    const e = buildIdentityEvidence(baseRow, "run-uuid-789", {
      mode: "cert_list",
      mergedIntoExisting: true,
    });
    expect(e).toEqual({
      backfill_run_id: "run-uuid-789",
      checkpoint: "stage-2b-followup-curated",
      aircraft_count: 148,
      merged_into_existing: true,
    });
    expect(e).not.toHaveProperty("threshold");
  });
});
