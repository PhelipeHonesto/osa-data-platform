/**
 * Assertion: faa_aircraft row count is sensible.
 *
 * v0 threshold: >= 100,000. The US registry has ~300K entries; if we
 * drop below 100K something catastrophic happened (bulk delete, bad
 * ingestion overwrite).
 *
 * Future upgrade: ±5% of 7-day rolling average. Blocked on a
 * `faa_registry_snapshots` table that records daily totals.
 * Tracked in docs/phase1-followups.md if needed.
 */

import type { Assertion } from "./types.js";

const MIN_FAA_AIRCRAFT = 100_000;

export const faaRegistryCount: Assertion = {
  name: "faa_registry_count",
  description: "faa_aircraft row count >= 100,000 (catastrophic-loss floor)",
  async run(client) {
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt FROM faa_aircraft`,
    );
    const count = Number(res.rows[0]?.cnt ?? 0);
    return {
      status: count >= MIN_FAA_AIRCRAFT ? "pass" : "fail",
      threshold: `>= ${MIN_FAA_AIRCRAFT}`,
      actual_value: String(count),
      context: { count, min: MIN_FAA_AIRCRAFT },
    };
  },
};
