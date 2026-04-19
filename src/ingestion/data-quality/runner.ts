/**
 * DQ runner — executes each assertion, writes per-check results to
 * data_quality_runs, and fires log.error on any failure (which bridges
 * to Sentry via the standard log pipeline).
 *
 * One `run_id` (UUID) ties all checks from a single DQ session together.
 * The data_quality_runs table carries both the legacy holistic columns
 * (written by src/analytics/data-quality.ts) and the per-check columns
 * used here (run_id / check_name / status / threshold / actual_value /
 * context). Legacy rows have run_id=NULL, per-check rows have run_id
 * populated — see schema/transactional/eval.sql + migration 2026-04-18-001.
 */

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { childLogger } from "../../utils/logger.js";
import type { Assertion, AssertionResult } from "./assertions/types.js";

const log = childLogger("data-quality");

export interface DqRunResult {
  run_id: string;
  overall_status: "green" | "red";
  results: Array<{ assertion: Assertion; result: AssertionResult }>;
  passed: number;
  failed: number;
}

export async function runAssertions(
  client: pg.PoolClient,
  assertions: ReadonlyArray<Assertion>,
): Promise<DqRunResult> {
  const run_id = randomUUID();
  const results: Array<{ assertion: Assertion; result: AssertionResult }> = [];
  let passed = 0;
  let failed = 0;

  for (const assertion of assertions) {
    let result: AssertionResult;
    try {
      result = await assertion.run(client);
    } catch (err) {
      // Treat an exception as a failure — the assertion itself is broken.
      result = {
        status: "fail",
        threshold: "no-throw",
        actual_value: err instanceof Error ? err.message : String(err),
        context: { error: err instanceof Error ? err.message : String(err) },
      };
    }
    results.push({ assertion, result });
    if (result.status === "pass") passed++;
    else failed++;

    // Persist per-check row. overall_status on per-check rows is the row's
    // OWN status (green=pass, red=fail), not the aggregate. Aggregate
    // goes on the legacy holistic row written by analytics/data-quality.
    await client.query(
      `INSERT INTO data_quality_runs
         (run_at, overall_status, run_id, check_name, status, threshold, actual_value, context)
       VALUES (NOW(), $1, $2::UUID, $3, $4, $5, $6, $7::jsonb)`,
      [
        result.status === "pass" ? "green" : "red",
        run_id,
        assertion.name,
        result.status,
        result.threshold,
        result.actual_value,
        JSON.stringify(result.context ?? {}),
      ],
    );

    if (result.status === "fail") {
      // Bridged to Sentry via the log pipeline — minimal alerting per plan.
      log.error(
        {
          run_id,
          check: assertion.name,
          threshold: result.threshold,
          actual: result.actual_value,
          context: result.context,
        },
        `DQ assertion failed: ${assertion.name}`,
      );
    }
  }

  return {
    run_id,
    overall_status: failed === 0 ? "green" : "red",
    results,
    passed,
    failed,
  };
}
