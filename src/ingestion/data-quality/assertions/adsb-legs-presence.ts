/**
 * Assertion: adsb_completed_legs has at least one leg.
 *
 * v0 threshold: total count > 0. The live feed + Phase 7 rebuild writes
 * here continuously; a zero count means the whole ingestion path broke.
 *
 * User spec mentioned "days with known active aircraft" — a per-day
 * check that correlates with the live-active-aircraft list. Deferred:
 * during Phase 7 rebuild, leg-write dates span the 2023-2026 range,
 * not just "yesterday," so a naive yesterday-only check produces noise.
 * Revisit post-rebuild (tracked via rebuild completion, not here).
 */

import type { Assertion } from "./types.js";

export const adsbLegsPresence: Assertion = {
  name: "adsb_legs_presence",
  description: "adsb_completed_legs has > 0 rows (ingestion path alive)",
  async run(client) {
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM adsb_completed_legs`,
    );
    const count = Number(res.rows[0]?.cnt ?? 0);
    return {
      status: count > 0 ? "pass" : "fail",
      threshold: "> 0",
      actual_value: String(count),
      context: { count },
    };
  },
};
