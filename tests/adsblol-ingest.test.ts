/**
 * Tests for trace parsing + leg detection.
 *
 * Most important case: an aircraft mid-flight at UTC midnight. adsb.lol's
 * daily globe-history tar for that day starts with the aircraft already
 * airborne (offset_s ≈ 0). The pre-fix code treated this first airborne
 * point as a fake takeoff, producing departure_time = midnight + ms and
 * wildly wrong flight_time_min values. Post-fix, those half-legs are
 * discarded and only confirmed ground→airborne transitions emit a leg.
 */

import { describe, it, expect } from "vitest";
import {
  downsampleTrace,
  detectLegs,
  type TraceFile,
  type ParsedTrace,
} from "../src/ingestion/adsblol-ingest.js";

function makeTrace(entries: (number | string | null)[][]): TraceFile {
  // 2026-01-07 UTC midnight
  return {
    icao: "a91ad0",
    r: "N788QS",
    t: "CL35",
    timestamp: 1767744000,
    trace: entries as unknown as (number | null | object | string)[][],
  };
}

describe("detectLegs — midnight crossover bug (Phase 7 fix)", () => {
  it("does NOT emit a fake leg when the trace starts airborne and ends on the ground", () => {
    // Aircraft is mid-flight at UTC midnight (first entry offset ≈ 0.4 s,
    // already airborne) and lands later in the day.
    const trace = makeTrace([
      // [offset_s, lat, lon, alt, gs, track, flags, alt_geom, ...]
      [0.4, 40.0, -75.0, 35000, 450, 90, 0, 35000, null, "adsb_icao", 0, null, null, null],
      [60.0, 40.1, -74.9, 35000, 450, 90, 0, 35000, null, "adsb_icao", 0, null, null, null],
      [7200.0, 40.5, -74.5, 5000, 250, 120, 0, 5000, null, "adsb_icao", -1500, null, null, null],
      [7500.0, 40.6, -74.4, 300, 40, 120, 1, null, null, "tisb_icao", null, null, null, null],
      [7560.0, 40.61, -74.39, "ground", 15, null, 1, null, null, "tisb_icao", null, null, null, null],
    ]);
    const parsed: ParsedTrace = {
      data: trace,
      aircraftClass: "super_mid",
      points: downsampleTrace(trace),
    };
    const legs = detectLegs(parsed, []);
    // Zero legs: we saw airborne→ground (a landing), but never a confirmed
    // ground→airborne transition, so no legitimate takeoff to pair it with.
    expect(legs).toEqual([]);
  });

  it("emits a real leg for a proper ground→airborne→ground sequence", () => {
    const trace = makeTrace([
      // Starts on ground (parked), takes off, cruises, lands
      [3600.0, 40.0, -75.0, "ground", 0, null, 1, null, null, "tisb_icao", null, null, null, null],
      [3660.0, 40.0, -75.0, 300, 50, 90, 1, null, null, "adsb_icao", 1000, null, null, null],
      [3720.0, 40.05, -74.95, 5000, 300, 90, 0, 5000, null, "adsb_icao", 1500, null, null, null],
      [7200.0, 40.5, -74.5, 35000, 450, 90, 0, 35000, null, "adsb_icao", 0, null, null, null],
      [9000.0, 40.8, -74.2, 5000, 250, 90, 0, 5000, null, "adsb_icao", -1500, null, null, null],
      [9300.0, 40.85, -74.15, 400, 40, 90, 1, null, null, "tisb_icao", null, null, null, null],
      [9360.0, 40.86, -74.14, "ground", 10, null, 1, null, null, "tisb_icao", null, null, null, null],
    ]);
    const parsed: ParsedTrace = {
      data: trace,
      aircraftClass: "super_mid",
      points: downsampleTrace(trace),
    };
    const legs = detectLegs(parsed, []);
    expect(legs).toHaveLength(1);
    const leg = legs[0]!;

    // Takeoff is the first airborne point after a confirmed ground state.
    // Which exact point gets picked depends on downsampler state detection
    // (alt <= 500 + gs < 60 = onGround), so we assert the departure falls
    // within the ground→airborne transition window: [offset 3660, 3720].
    const depEpoch = new Date(leg.departureTime).getTime() / 1000 - 1767744000;
    expect(depEpoch).toBeGreaterThanOrEqual(3660);
    expect(depEpoch).toBeLessThanOrEqual(3720);

    // Landing is the first onGround point after airborne: offset 9300 or 9360.
    const arrEpoch = new Date(leg.arrivalTime).getTime() / 1000 - 1767744000;
    expect(arrEpoch).toBeGreaterThanOrEqual(9300);
    expect(arrEpoch).toBeLessThanOrEqual(9360);

    // Roughly 94–95 minutes total.
    expect(leg.flightTimeMin).toBeGreaterThanOrEqual(93);
    expect(leg.flightTimeMin).toBeLessThanOrEqual(96);
  });

  it("emits zero legs when trace is entirely airborne (no takeoff, no landing)", () => {
    const trace = makeTrace([
      [0.5, 40.0, -75.0, 35000, 450, 90, 0, 35000, null, "adsb_icao", 0, null, null, null],
      [3600.0, 40.3, -74.7, 35000, 450, 90, 0, 35000, null, "adsb_icao", 0, null, null, null],
      [7200.0, 40.6, -74.4, 35000, 450, 90, 0, 35000, null, "adsb_icao", 0, null, null, null],
    ]);
    const parsed: ParsedTrace = {
      data: trace,
      aircraftClass: "heavy",
      points: downsampleTrace(trace),
    };
    expect(detectLegs(parsed, [])).toEqual([]);
  });

  it("emits two legs for takeoff→land→takeoff→land within one trace", () => {
    const trace = makeTrace([
      // Ground
      [100.0, 40.0, -75.0, "ground", 0, null, 1, null, null, "tisb_icao", null, null, null, null],
      // Takeoff #1
      [200.0, 40.0, -75.0, 300, 50, 90, 1, null, null, "adsb_icao", 1000, null, null, null],
      [500.0, 40.1, -74.9, 5000, 300, 90, 0, 5000, null, "adsb_icao", 1500, null, null, null],
      // Landing #1
      [2000.0, 40.5, -74.5, 400, 40, 90, 1, null, null, "tisb_icao", null, null, null, null],
      [2100.0, 40.51, -74.49, "ground", 10, null, 1, null, null, "tisb_icao", null, null, null, null],
      // Takeoff #2
      [4000.0, 40.51, -74.49, 400, 50, 90, 1, null, null, "adsb_icao", 1000, null, null, null],
      [4300.0, 40.6, -74.4, 5000, 300, 90, 0, 5000, null, "adsb_icao", 1500, null, null, null],
      // Landing #2
      [6000.0, 41.0, -74.0, 400, 40, 90, 1, null, null, "tisb_icao", null, null, null, null],
      [6100.0, 41.01, -73.99, "ground", 10, null, 1, null, null, "tisb_icao", null, null, null, null],
    ]);
    const parsed: ParsedTrace = {
      data: trace,
      aircraftClass: "midsize",
      points: downsampleTrace(trace),
    };
    const legs = detectLegs(parsed, []);
    expect(legs).toHaveLength(2);

    // Leg 1: takeoff around offset 200-500, landing around 2000-2100 → roughly 25-35 min.
    // The downsampler may keep or drop points near transitions depending on state-change
    // logic; we only assert the duration is in the reasonable range and nowhere near
    // the bug's symptom (100s to 1000s of minutes).
    expect(legs[0]!.flightTimeMin).toBeGreaterThanOrEqual(20);
    expect(legs[0]!.flightTimeMin).toBeLessThanOrEqual(40);

    // Leg 2: takeoff around offset 4000-4300, landing around 6000-6100 → roughly 30-35 min.
    expect(legs[1]!.flightTimeMin).toBeGreaterThanOrEqual(25);
    expect(legs[1]!.flightTimeMin).toBeLessThanOrEqual(40);
  });
});

describe("downsampleTrace — altitude string handling", () => {
  it("treats alt='ground' as onGround=true regardless of speed", () => {
    const trace = makeTrace([
      // A taxiing aircraft: altitude reported as "ground", speed > 60
      [100.0, 40.0, -75.0, "ground", 75, 90, 1, null, null, "tisb_icao", null, null, null, null],
    ]);
    const points = downsampleTrace(trace);
    expect(points).toHaveLength(1);
    expect(points[0]!.onGround).toBe(true);
  });

  it("sets altFt to null (not NaN) when alt is the 'ground' string", () => {
    const trace = makeTrace([
      [100.0, 40.0, -75.0, "ground", 10, null, 1, null, null, "tisb_icao", null, null, null, null],
    ]);
    const points = downsampleTrace(trace);
    expect(points[0]!.altFt).toBeNull();
  });
});
