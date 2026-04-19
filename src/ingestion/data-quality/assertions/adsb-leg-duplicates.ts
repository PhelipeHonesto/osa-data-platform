/**
 * Assertion: no duplicate (icao_hex, departure_time, arrival_time) tuples
 * in the last 7 days of adsb_completed_legs.
 *
 * Why scoped to 7 days instead of the whole table:
 *   - Total leg count in production is 9M+ and growing (Phase 7 rebuild
 *     is still running). An unscoped GROUP BY hits Supabase's statement
 *     timeout and the assertion fails on timeout rather than on data.
 *   - 7 days is the window where a duplicate points to an active-feed
 *     bug (live-ingest collision, re-processing race). Duplicates older
 *     than that are already historical — they'd have been caught earlier
 *     and won't auto-resolve.
 *
 * Phase-1 caveat: the Phase 7 rebuild may re-process a day if a prior
 * run partially completed, which can produce transient duplicates on
 * the day being rebuilt. That day is rarely in the last-7-days window
 * (rebuild is years behind live), but when Phase 7 catches up, this
 * assertion might flag on the in-flight day — confirm against
 * backfill_progress.status='processing' before panicking.
 *
 * Scale upgrade: an index on (icao_hex, departure_time) would let the
 * unscoped version run in seconds. Not added here — Rule 5 additive
 * first, index creation belongs in its own migration with a clear ROI.
 */

import type { Assertion } from "./types.js";

export const adsbLegDuplicates: Assertion = {
  name: "adsb_leg_duplicates",
  description: "Zero duplicate (icao_hex, departure_time, arrival_time) in last 7 days of adsb_completed_legs",
  async run(client) {
    // departure_time is TEXT (ISO string); string comparison against an
    // ISO threshold works because ISO sorts lexicographically.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM (
         SELECT icao_hex, departure_time, arrival_time
           FROM adsb_completed_legs
          WHERE departure_time >= $1
          GROUP BY icao_hex, departure_time, arrival_time
          HAVING COUNT(*) > 1
       ) dup`,
      [cutoff],
    );
    const duplicates = Number(res.rows[0]?.cnt ?? 0);
    return {
      status: duplicates === 0 ? "pass" : "fail",
      threshold: "= 0 (scoped to last 7 days)",
      actual_value: String(duplicates),
      context: { duplicate_tuple_count: duplicates, window_start: cutoff },
    };
  },
};
