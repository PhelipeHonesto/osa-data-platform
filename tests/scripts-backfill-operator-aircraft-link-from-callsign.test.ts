import { describe, it, expect } from "vitest";
import {
  parseArgs,
  normalizeHex,
  extractIcao,
  confidenceForPositionCount,
  buildEvidence,
} from "../scripts/backfill-operator-aircraft-link-from-callsign.js";

describe("parseArgs", () => {
  it("defaults to dry-run, min_positions=1", () => {
    expect(parseArgs([])).toEqual({ commit: false, minPositions: 1 });
  });
  it("reads --commit", () => {
    expect(parseArgs(["--commit"])).toEqual({ commit: true, minPositions: 1 });
  });
  it("reads --min-positions=N", () => {
    expect(parseArgs(["--min-positions=3"])).toEqual({ commit: false, minPositions: 3 });
    expect(parseArgs(["--commit", "--min-positions=10"])).toEqual({ commit: true, minPositions: 10 });
  });
  it("rejects invalid min-positions", () => {
    expect(() => parseArgs(["--min-positions=0"])).toThrow();
    expect(() => parseArgs(["--min-positions=abc"])).toThrow();
    expect(() => parseArgs(["--min-positions=-5"])).toThrow();
  });
});

describe("normalizeHex", () => {
  it("strips leading tilde and lowercases", () => {
    expect(normalizeHex("~26A137")).toBe("26a137");
    expect(normalizeHex("~26a137")).toBe("26a137");
  });
  it("passes bare hex through, lowercased", () => {
    expect(normalizeHex("a087d3")).toBe("a087d3");
    expect(normalizeHex("A087D3")).toBe("a087d3");
  });
  it("returns null for null/undefined/empty/just-tilde", () => {
    expect(normalizeHex(null)).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
    expect(normalizeHex("")).toBeNull();
    expect(normalizeHex("~")).toBeNull();
  });
});

describe("extractIcao", () => {
  it("extracts the 3-letter prefix from a callsign", () => {
    expect(extractIcao("EJA790")).toBe("EJA");
    expect(extractIcao("LXJ484")).toBe("LXJ");
    expect(extractIcao("VJA119")).toBe("VJA");
    expect(extractIcao("AAL1234")).toBe("AAL");
  });
  it("accepts a bare 3-letter callsign", () => {
    expect(extractIcao("EJA")).toBe("EJA");
  });
  it("returns null for tail numbers (digit in pos 2)", () => {
    expect(extractIcao("N123AB")).toBeNull();
  });
  it("returns null for empty / null / undefined / lowercase", () => {
    expect(extractIcao("")).toBeNull();
    expect(extractIcao(null)).toBeNull();
    expect(extractIcao(undefined)).toBeNull();
    expect(extractIcao("eja123")).toBeNull();
  });
});

describe("confidenceForPositionCount", () => {
  it("ladders: >=50 → 0.95, >=10 → 0.85, >=3 → 0.75, 1-2 → 0.60", () => {
    expect(confidenceForPositionCount(100)).toBe(0.95);
    expect(confidenceForPositionCount(50)).toBe(0.95);
    expect(confidenceForPositionCount(49)).toBe(0.85);
    expect(confidenceForPositionCount(10)).toBe(0.85);
    expect(confidenceForPositionCount(9)).toBe(0.75);
    expect(confidenceForPositionCount(3)).toBe(0.75);
    expect(confidenceForPositionCount(2)).toBe(0.6);
    expect(confidenceForPositionCount(1)).toBe(0.6);
  });
});

describe("buildEvidence", () => {
  it("packs all fields including ISO timestamps", () => {
    const first = new Date("2026-04-16T23:54:35Z");
    const last = new Date("2026-04-16T23:55:37Z");
    const e = buildEvidence(["EJA790"], 2, "EJA", "run-uuid-1", first, last);
    expect(e).toEqual({
      callsign_observed: ["EJA790"],
      position_count: 2,
      icao_designator: "EJA",
      backfill_run_id: "run-uuid-1",
      first_seen: "2026-04-16T23:54:35.000Z",
      last_seen: "2026-04-16T23:55:37.000Z",
    });
  });
  it("preserves multiple distinct callsigns", () => {
    const t = new Date("2026-04-16T23:54:35Z");
    const e = buildEvidence(["EJA790", "EJA791"], 5, "EJA", "r2", t, t);
    expect(e.callsign_observed).toEqual(["EJA790", "EJA791"]);
    expect(e.position_count).toBe(5);
  });
});
