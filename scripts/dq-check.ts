/**
 * Data-quality CLI. Runs all DQ assertions, persists per-check rows to
 * data_quality_runs, and exits non-zero if any fail. Designed to be
 * called after every ingestion job (archive, pipeline, backfill).
 *
 * Alerting: log.error calls from the runner bridge to Sentry via the
 * existing logger pipeline. No separate webhook/email path.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *   2 — unexpected error (connection, SQL parse, etc.)
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run dq:check
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getPool, closePg } from "../src/memory/pg-database.js";
import { childLogger } from "../src/utils/logger.js";
import { runAssertions, ALL_ASSERTIONS } from "../src/ingestion/data-quality/index.js";

const log = childLogger("dq-check");

function loadEnv(): void {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* .env not found */
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("dq:check requires DATABASE_TYPE=postgres");
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    const start = Date.now();
    console.log(`[dq-check] Running ${ALL_ASSERTIONS.length} assertions...`);
    const result = await runAssertions(client, ALL_ASSERTIONS);
    const ms = Date.now() - start;

    console.log(`\n[dq-check] Run ${result.run_id}:`);
    for (const { assertion, result: r } of result.results) {
      const icon = r.status === "pass" ? "✓" : "✗";
      console.log(`  ${icon} ${assertion.name.padEnd(32)} ${r.threshold.padEnd(16)} actual=${r.actual_value}`);
    }
    console.log(`\n[dq-check] Summary: ${result.passed}/${result.results.length} passed, ${result.failed} failed  (${ms}ms)`);
    console.log(`[dq-check] Overall: ${result.overall_status.toUpperCase()}`);

    process.exit(result.failed === 0 ? 0 : 1);
  } finally {
    client.release();
    await closePg();
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "dq-check fatal error");
    process.exit(2);
  });
}
