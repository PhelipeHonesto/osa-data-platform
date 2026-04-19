/**
 * Data-quality assertion contract. Each assertion is a pure check against
 * the live DB: given a pg client, return pass/fail with an explanatory
 * threshold + actual value. The runner writes results to data_quality_runs.
 */

import type pg from "pg";

export type AssertionStatus = "pass" | "fail";

export interface AssertionResult {
  status: AssertionStatus;
  /** Human-readable threshold description, e.g. ">= 100000" or "duplicate count = 0". */
  threshold: string;
  /** The actual measured value, as a string (matches data_quality_runs.actual_value TEXT). */
  actual_value: string;
  /** Optional extra detail for debugging, stored as JSONB. */
  context?: Record<string, unknown>;
}

export interface Assertion {
  /** Stable identifier, stored in data_quality_runs.check_name. */
  name: string;
  description: string;
  run(client: pg.PoolClient): Promise<AssertionResult>;
}
