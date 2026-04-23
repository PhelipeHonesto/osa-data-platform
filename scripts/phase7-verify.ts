/**
 * Phase 7 rebuild verification — 7 data quality checks against adsb_completed_legs.
 *
 * Thresholds calibrated for global ADS-B dataset (21M+ legs, 812+ days).
 * Each check has an explicit pass/fail threshold. Every result is persisted to
 * data_quality_runs (one row per check, grouped by run_id). Failures also fire
 * a log.error so the Sentry bridge alerts automatically.
 *
 * Usage:
 *   npx tsx scripts/phase7-verify.ts
 *   npx tsx scripts/phase7-verify.ts --silent
 *
 * Exit code: 0 if all checks pass, 1 if any fail.
 */
import pg from "pg";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { initSentry, flushSentry } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

export interface QueryClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type CheckStatus = "pass" | "fail";

export interface CheckResult {
  name: string;
  threshold: string;
  status: CheckStatus;
  actualValue: string;
  context: Record<string, unknown>;
}

interface CheckDef {
  name: string;
  threshold: string;
  run(client: QueryClient): Promise<Omit<CheckResult, "name" | "threshold">>;
}

// Known permanent gaps in S3 (adsb.lol did not publish these dates).
// See docs/known-issues.md for full list.
const PERMANENT_S3_GAPS = 17;

// Known failed days with root causes documented in known-issues.md.
// Expected to be resolved after Phase 3 split + ingestion bug fixes.
const KNOWN_FAILED_MAX = 10;

export const CHECKS: CheckDef[] = [
  {
    name: "phase7_leg_count",
    threshold: "15_000_000 <= count <= 50_000_000",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        "SELECT COUNT(*)::bigint AS n FROM adsb_completed_legs",
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n >= 15_000_000 && n <= 50_000_000 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { count: n },
      };
    },
  },
  {
    name: "phase7_no_impossibly_long_flights",
    threshold: "count(flight_time_min > 1440) < 1000",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        "SELECT COUNT(*)::bigint AS n FROM adsb_completed_legs WHERE flight_time_min > 1440",
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n < 1000 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { count_over_1440_min: n },
      };
    },
  },
  {
    name: "phase7_no_midnight_cluster",
    threshold: "ratio(midnight cluster / total legs) < 0.0005",
    async run(client) {
      const r = await client.query<{ cluster: number | string; total: number | string }>(
        `SELECT 
           (SELECT COUNT(*)::bigint FROM adsb_completed_legs
            WHERE EXTRACT(HOUR FROM departure_time::timestamptz) = 0
              AND EXTRACT(MINUTE FROM departure_time::timestamptz) = 0
              AND EXTRACT(SECOND FROM departure_time::timestamptz) < 10) AS cluster,
           (SELECT COUNT(*)::bigint FROM adsb_completed_legs) AS total`,
      );
      const cluster = Number(r.rows[0]!.cluster);
      const total = Number(r.rows[0]!.total);
      const ratio = total === 0 ? 0 : cluster / total;
      return {
        status: ratio < 0.0005 ? "pass" : "fail",
        actualValue: `${cluster}/${total} = ${(ratio * 100).toFixed(4)}%`,
        context: { midnight_cluster: cluster, total, ratio },
      };
    },
  },
  {
    name: "phase7_hour_distribution_spread",
    threshold: "no single hour > 3x the median of 24 hour counts",
    async run(client) {
      const r = await client.query<{ hr: number | string; c: number | string }>(
        `SELECT EXTRACT(HOUR FROM departure_time::timestamptz)::int AS hr,
                COUNT(*)::bigint AS c
         FROM adsb_completed_legs GROUP BY hr ORDER BY hr`,
      );
      const counts = r.rows.map((row) => Number(row.c)).filter((n) => Number.isFinite(n));
      if (counts.length === 0) {
        return { status: "fail", actualValue: "0 hours", context: { note: "no rows" } };
      }
      const sorted = [...counts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
      const max = Math.max(...counts);
      const ratio = median === 0 ? Infinity : max / median;
      const perHour = r.rows.map((row) => ({
        hr: Number(row.hr),
        c: Number(row.c),
      }));
      return {
        status: ratio <= 3 ? "pass" : "fail",
        actualValue: `max=${max}, median=${median}, ratio=${ratio.toFixed(2)}`,
        context: { per_hour: perHour, median, max, ratio },
      };
    },
  },
  {
    name: "phase7_flight_time_distribution",
    threshold: "avg flight_time_min in [60,180]; max in [600,1440]",
    async run(client) {
      const r = await client.query<{ avg: number | string; max: number | string }>(
        `SELECT AVG(flight_time_min)::numeric(10,2) AS avg,
                MAX(flight_time_min)::int AS max
         FROM adsb_completed_legs`,
      );
      const avg = Number(r.rows[0]!.avg);
      const max = Number(r.rows[0]!.max);
      const avgOk = avg >= 60 && avg <= 180;
      const maxOk = max >= 600 && max <= 1440;
      return {
        status: avgOk && maxOk ? "pass" : "fail",
        actualValue: `avg=${avg.toFixed(1)}, max=${max}`,
        context: { avg, max, avg_ok: avgOk, max_ok: maxOk },
      };
    },
  },
  {
    name: "phase7_days_covered",
    threshold: "distinct departure dates >= 800",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        `SELECT COUNT(DISTINCT SUBSTRING(departure_time, 1, 10))::bigint AS n
         FROM adsb_completed_legs`,
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n >= 800 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { distinct_days: n },
      };
    },
  },
  {
    name: "phase7_backfill_progress_complete",
    threshold: `complete >= 800, pending <= ${PERMANENT_S3_GAPS} (permanent S3 gaps), failed <= ${KNOWN_FAILED_MAX} (documented bugs)`,
    async run(client) {
      const r = await client.query<{ status: string; c: number | string }>(
        "SELECT status, COUNT(*)::bigint AS c FROM backfill_progress GROUP BY status",
      );
      const counts: Record<string, number> = {};
      for (const row of r.rows) counts[row.status] = Number(row.c);
      const complete = counts["complete"] ?? 0;
      const pending = counts["pending"] ?? 0;
      const failed = counts["failed"] ?? 0;
      const ok = complete >= 800 && pending <= PERMANENT_S3_GAPS && failed <= KNOWN_FAILED_MAX;
      return {
        status: ok ? "pass" : "fail",
        actualValue: `complete=${complete}, pending=${pending}, failed=${failed}`,
        context: {
          counts, complete, pending, failed,
          permanent_s3_gaps_allowed: PERMANENT_S3_GAPS,
          known_failed_max: KNOWN_FAILED_MAX,
        },
      };
    },
  },
];

export async function runAllChecks(client: QueryClient): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    try {
      const r = await check.run(client);
      results.push({ name: check.name, threshold: check.threshold, ...r });
    } catch (err) {
      results.push({
        name: check.name,
        threshold: check.threshold,
        status: "fail",
        actualValue: "error",
        context: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  return results;
}

export async function persistResults(
  client: QueryClient,
  runId: string,
  results: CheckResult[],
): Promise<void> {
  for (const r of results) {
    const overall = r.status === "pass" ? "green" : "red";
    await client.query(
      `INSERT INTO data_quality_runs
        (overall_status, details, schema_version, run_id, check_name, status, threshold, actual_value, context)
       VALUES ($1, $2, 2, $3, $4, $5, $6, $7, $8)`,
      [
        overall,
        JSON.stringify({ phase: "phase7_verify", ...r.context }),
        runId,
        r.name,
        r.status,
        r.threshold,
        r.actualValue,
        JSON.stringify(r.context),
      ],
    );
  }
}

export function reportFailures(
  results: CheckResult[],
  log: { error: (obj: Record<string, unknown>, msg: string) => void },
): void {
  for (const r of results) {
    if (r.status === "fail") {
      log.error(
        {
          err: new Error(`quality check ${r.name} failed`),
          check_name: r.name,
          threshold: r.threshold,
          actual: r.actualValue,
          context: r.context,
        },
        `phase 7 verify: ${r.name} FAILED`,
      );
    }
  }
}

async function main(): Promise<void> {
  initSentry();
  const log = childLogger("phase7-verify");

  const silent = process.argv.includes("--silent");
  const print = (s: string) => {
    if (!silent) console.log(s);
  };

  const pgUrl = process.env["SUPABASE_DATABASE_URL"];
  if (!pgUrl) {
    console.error("SUPABASE_DATABASE_URL not set");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: pgUrl,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const runId = randomUUID();
    print(`\n=== Phase 7 rebuild verification ===`);
    print(`Run ID: ${runId}`);
    print(``);

    const results = await runAllChecks(client);

    for (const r of results) {
      const marker = r.status === "pass" ? "✓" : "✗";
      print(`${marker} ${r.name}`);
      print(`    threshold: ${r.threshold}`);
      print(`    actual:    ${r.actualValue}`);
    }

    await persistResults(client, runId, results);
    reportFailures(results, log);

    const passed = results.filter((r) => r.status === "pass").length;
    const total = results.length;
    const allPassed = passed === total;

    print(``);
    if (allPassed) {
      print(`REBUILD PASSES: ${passed}/${total} checks`);
    } else {
      print(`REBUILD NEEDS REVIEW: ${total - passed}/${total} checks failed`);
      print(`Details in data_quality_runs (run_id=${runId}) and Sentry (if SENTRY_DSN set)`);
    }

    await flushSentry();
    await client.end();
    process.exit(allPassed ? 0 : 1);
  } catch (err) {
    log.fatal({ err }, "phase 7 verify crashed");
    await flushSentry();
    await client.end().catch(() => {});
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
