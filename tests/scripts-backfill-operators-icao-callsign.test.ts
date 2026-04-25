import { describe, it, expect } from "vitest";
import {
  parseArgs,
  isIcaoCallsign,
  decideCallsign,
} from "../scripts/backfill-operators-icao-callsign.js";

describe("parseArgs", () => {
  it("defaults to dry-run", () => {
    expect(parseArgs([])).toEqual({ commit: false });
  });
  it("reads --commit", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true });
  });
  it("ignores unrelated flags", () => {
    expect(parseArgs(["--verbose", "--write"])).toEqual({ commit: false });
  });
});

describe("isIcaoCallsign", () => {
  it("accepts exactly 3 uppercase letters", () => {
    expect(isIcaoCallsign("EJA")).toBe(true);
    expect(isIcaoCallsign("LXJ")).toBe(true);
    expect(isIcaoCallsign("WUP")).toBe(true);
  });
  it("rejects lowercase or mixed case", () => {
    expect(isIcaoCallsign("eja")).toBe(false);
    expect(isIcaoCallsign("Eja")).toBe(false);
    expect(isIcaoCallsign("eJa")).toBe(false);
  });
  it("rejects non-3-letter strings", () => {
    expect(isIcaoCallsign("EJ")).toBe(false);
    expect(isIcaoCallsign("EJAX")).toBe(false);
    expect(isIcaoCallsign("EJ1")).toBe(false);
    expect(isIcaoCallsign("E J")).toBe(false);
    expect(isIcaoCallsign("")).toBe(false);
    expect(isIcaoCallsign("NetJets")).toBe(false);
  });
  it("rejects null and undefined", () => {
    expect(isIcaoCallsign(null)).toBe(false);
    expect(isIcaoCallsign(undefined)).toBe(false);
  });
});

describe("decideCallsign", () => {
  it("returns the callsign when dba_name matches", () => {
    expect(decideCallsign({ dba_name: "EJA" })).toEqual({ callsign: "EJA" });
    expect(decideCallsign({ dba_name: "LXJ" })).toEqual({ callsign: "LXJ" });
  });
  it("returns null when dba_name is not a 3-letter callsign", () => {
    expect(decideCallsign({ dba_name: "NetJets Aviation" })).toBeNull();
    expect(decideCallsign({ dba_name: "Jet Linx" })).toBeNull();
    expect(decideCallsign({ dba_name: "eja" })).toBeNull();
  });
  it("returns null when dba_name is null", () => {
    expect(decideCallsign({ dba_name: null })).toBeNull();
  });
});
