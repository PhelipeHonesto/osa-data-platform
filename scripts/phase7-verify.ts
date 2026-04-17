/**
 * Phase 7 rebuild verification — 7 data quality checks against adsb_completed_legs.
 *
 * Each check has an explicit pass/fail threshold. Every result is persisted to
 * data_quality_runs (one row per check, grouped by run_id). Failures also fire
 * a log.error so the Sentry bridge (Phase 15 Step 2) alerts automatically.
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

// ── Minimal client shape so tests can inject a mock ─────────────────────────

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

// ── Check definitions ───────────────────────────────────────────────────────

export const CHECKS: CheckDef[] = [
  {
    name: "phase7_leg_count",
    threshold: "5_000_000 <= count <= 10_000_000",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        "SELECT COUNT(*)::bigint AS n FROM adsb_completed_legs",
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n >= 5_000_000 && n <= 10_000_000 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { count: n },
      };
    },
  },
  {
    name: "phase7_no_impossibly_long_flights",
    threshold: "count(flight_time_min > 720) < 100",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        "SELECT COUNT(*)::bigint AS n FROM adsb_completed_legs WHERE flight_time_min > 720",
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n < 100 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { count_over_720_min: n },
      };
    },
  },
  {
    name: "phase7_no_midnight_cluster",
    threshold: "count(departure at 00:00:00-00:00:10 UTC) < 1000",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        `SELECT COUNT(*)::bigint AS n FROM adsb_completed_legs
         WHERE EXTRACT(HOUR FROM departure_time::timestamptz) = 0
           AND EXTRACT(MINUTE FROM departure_time::timestamptz) = 0
           AND EXTRACT(SECOND FROM departure_time::timestamptz) < 10`,
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n < 1000 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { midnight_cluster: n },
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
    threshold: "avg flight_time_min in [60,180]; max in [400,900]",
    async run(client) {
      const r = await client.query<{ avg: number | string; max: number | string }>(
        `SELECT AVG(flight_time_min)::numeric(10,2) AS avg,
                MAX(flight_time_min)::int AS max
         FROM adsb_completed_legs`,
      );
      const avg = Number(r.rows[0]!.avg);
      const max = Number(r.rows[0]!.max);
      const avgOk = avg >= 60 && avg <= 180;
      const maxOk = max >= 400 && max <= 900;
      return {
        status: avgOk && maxOk ? "pass" : "fail",
        actualValue: `avg=${avg.toFixed(1)}, max=${max}`,
        context: { avg, max, avg_ok: avgOk, max_ok: maxOk },
      };
    },
  },
  {
    name: "phase7_days_covered",
    threshold: "distinct departure dates >= 700",
    async run(client) {
      const r = await client.query<{ n: number | string }>(
        `SELECT COUNT(DISTINCT (departure_time::timestamptz)::date)::bigint AS n
         FROM adsb_completed_legs`,
      );
      const n = Number(r.rows[0]!.n);
      return {
        status: n >= 700 ? "pass" : "fail",
        actualValue: n.toString(),
        context: { distinct_days: n },
      };
    },
  },
  {
    name: "phase7_backfill_progress_complete",
    threshold: "status=complete >= 700, pending == 0, failed == 0",
    async run(client) {
      const r = await client.query<{ status: string; c: number | string }>(
        "SELECT status, COUNT(*)::bigint AS c FROM backfill_progress GROUP BY status",
      );
      const counts: Record<string, number> = {};
      for (const row of r.rows) counts[row.status] = Number(row.c);
      const complete = counts["complete"] ?? 0;
      const pending = counts["pending"] ?? 0;
      const failed = counts["failed"] ?? 0;
      const ok = complete >= 700 && pending === 0 && failed === 0;
      return {
        status: ok ? "pass" : "fail",
        actualValue: `complete=${complete}, pending=${pending}, failed=${failed}`,
        context: { counts, complete, pending, failed },
      };
    },
  },
];

// ── Run checks (library; testable) ──────────────────────────────────────────

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

// ── CLI entry point ────────────────────────────────────────────────────────

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
