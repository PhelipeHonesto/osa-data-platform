/**
 * Assertion: every operator_identities row points to an existing operators row.
 *
 * The FK constraint enforces this at write time, but the check runs
 * anyway — defense in depth. If this ever fails, we have a data-corruption
 * incident (FK dropped, race between migrations, manual DELETE CASCADE gap).
 */

import type { Assertion } from "./types.js";

export const operatorIdentityOrphans: Assertion = {
  name: "operator_identity_orphans",
  description: "Zero operator_identities rows with an operator_id that doesn't exist in operators",
  async run(client) {
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::TEXT AS cnt
         FROM operator_identities oi
         LEFT JOIN operators o ON o.id = oi.operator_id
         WHERE o.id IS NULL`,
    );
    const orphans = Number(res.rows[0]?.cnt ?? 0);
    return {
      status: orphans === 0 ? "pass" : "fail",
      threshold: "= 0",
      actual_value: String(orphans),
      context: { orphan_count: orphans },
    };
  },
};
