/**
 * Unit tests for scripts/phase7-verify.ts check logic.
 *
 * Mocks the minimal QueryClient interface so checks run against synthetic
 * fixtures instead of real Postgres. No Sentry or DB side-effects.
 */
import { describe, it, expect, vi } from "vitest";
import {
  CHECKS,
  runAllChecks,
  persistResults,
  reportFailures,
  type CheckResult,
  type QueryClient,
} from "../scripts/phase7-verify.js";

// ── Synthetic fixtures ─────────────────────────────────────────────────────

// Fixture keys are matched in insertion order; put more-specific substrings
// first so check 1 (the bare COUNT) falls through last.
function passingFixtures(): Record<string, unknown[]> {
  return {
    "WHERE flight_time_min > 1440": [{ n: 42 }],
    "WHERE EXTRACT(HOUR FROM departure_time": [{ cluster: 20, total: 21_000_000 }],
    "SELECT EXTRACT(HOUR FROM departure_time::timestamptz)::int AS hr":
      Array.from({ length: 24 }, (_, i) => ({ hr: i, c: 200_000 + (i % 3) * 50_000 })),
    "AVG(flight_time_min)": [{ avg: "120.5", max: 600 }],
    "COUNT(DISTINCT SUBSTRING": [{ n: 850 }],
    "FROM backfill_progress GROUP BY status": [
      { status: "complete", c: 850 },
    ],
    "FROM adsb_completed_legs": [{ n: 21_000_000 }],
  };
}

function routeFixture(sql: string, fixtures: Record<string, unknown[]>): unknown[] {
  for (const [needle, rows] of Object.entries(fixtures)) {
    if (sql.includes(needle)) return rows;
  }
  throw new Error(`no fixture matched query:\n${sql}`);
}

function mockClient(fixtures: Record<string, unknown[]>): QueryClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string) {
      calls.push(sql);
      return { rows: routeFixture(sql, fixtures) as never };
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("phase7-verify — check logic", () => {
  it("defines exactly 7 checks", () => {
    expect(CHECKS).toHaveLength(7);
  });

  it("all checks pass with passing fixtures", async () => {
    const client = mockClient(passingFixtures());
    const results = await runAllChecks(client);
    expect(results).toHaveLength(7);
    for (const r of results) {
      expect(r.status, `${r.name} should pass but actual=${r.actualValue}`).toBe("pass");
    }
  });

  it("leg count below 15M triggers phase7_leg_count fail (and only that check)", async () => {
    const fx = passingFixtures();
    fx["FROM adsb_completed_legs"] = [{ n: 1_000_000 }];
    const results = await runAllChecks(mockClient(fx));
    const failed = results.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.name)).toEqual(["phase7_leg_count"]);
  });

  it("midnight cluster ratio >= 0.0005 triggers phase7_no_midnight_cluster fail", async () => {
    const fx = passingFixtures();
    // cluster=5000 / total=8M → ratio 0.000625 > threshold 0.0005
    fx["WHERE EXTRACT(HOUR FROM departure_time"] = [{ cluster: 5000, total: 8_000_000 }];
    const results = await runAllChecks(mockClient(fx));
    const failed = results.filter((r) => r.status === "fail");
    expect(failed.map((r) => r.name)).toContain("phase7_no_midnight_cluster");
    expect(failed.find((r) => r.name === "phase7_no_midnight_cluster")!.actualValue).toBe("5000/8000000 = 0.0625%");
  });

  it("skewed hour distribution (one hour > 3x median) triggers spread fail", async () => {
    const fx = passingFixtures();
    // 23 hours at 100k, one hour at 1M — max/median = 10x
    const hours = Array.from({ length: 24 }, (_, i) => ({
      hr: i,
      c: i === 12 ? 1_000_000 : 100_000,
    }));
    fx["SELECT EXTRACT(HOUR FROM departure_time::timestamptz)::int AS hr"] = hours;
    const results = await runAllChecks(mockClient(fx));
    const check = results.find((r) => r.name === "phase7_hour_distribution_spread")!;
    expect(check.status).toBe("fail");
  });

  it("extreme max flight time triggers distribution fail", async () => {
    const fx = passingFixtures();
    fx["AVG(flight_time_min)"] = [{ avg: "120", max: 2000 }]; // outside [600, 1440]
    const results = await runAllChecks(mockClient(fx));
    const check = results.find((r) => r.name === "phase7_flight_time_distribution")!;
    expect(check.status).toBe("fail");
  });

  it("backfill_progress failed count above KNOWN_FAILED_MAX triggers completion fail", async () => {
    const fx = passingFixtures();
    fx["FROM backfill_progress GROUP BY status"] = [
      { status: "complete", c: 800 },
      { status: "failed", c: 15 }, // exceeds KNOWN_FAILED_MAX=10
    ];
    const results = await runAllChecks(mockClient(fx));
    const check = results.find((r) => r.name === "phase7_backfill_progress_complete")!;
    expect(check.status).toBe("fail");
  });

  it("query error in a check is caught and reported as fail", async () => {
    const client: QueryClient = {
      async query(sql: string) {
        if (sql.includes("adsb_completed_legs")) throw new Error("connection refused");
        return { rows: [] as never };
      },
    };
    const results = await runAllChecks(client);
    // Every check that queries adsb_completed_legs should fail — none crash the runner.
    const failed = results.filter((r) => r.status === "fail");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.actualValue).toBe("error");
  });
});

describe("phase7-verify — persistResults", () => {
  it("inserts one row per check with run_id and status", async () => {
    const inserts: unknown[][] = [];
    const client: QueryClient = {
      async query(sql: string, params?: unknown[]) {
        if (sql.startsWith("INSERT INTO data_quality_runs")) inserts.push(params ?? []);
        return { rows: [] as never };
      },
    };
    const results: CheckResult[] = [
      {
        name: "check_a",
        threshold: "n < 100",
        status: "pass",
        actualValue: "42",
        context: { n: 42 },
      },
      {
        name: "check_b",
        threshold: "n >= 10",
        status: "fail",
        actualValue: "3",
        context: { n: 3 },
      },
    ];
    await persistResults(client, "00000000-0000-0000-0000-000000000001", results);
    expect(inserts).toHaveLength(2);
    const [row1, row2] = inserts;
    expect(row1![0]).toBe("green"); // overall_status for pass
    expect(row1![2]).toBe("00000000-0000-0000-0000-000000000001");
    expect(row1![3]).toBe("check_a");
    expect(row1![4]).toBe("pass");
    expect(row2![0]).toBe("red"); // overall_status for fail
    expect(row2![4]).toBe("fail");
  });
});

describe("phase7-verify — reportFailures", () => {
  it("calls log.error once per fail, never for pass", () => {
    const logError = vi.fn();
    const results: CheckResult[] = [
      { name: "ok", threshold: "x", status: "pass", actualValue: "1", context: {} },
      { name: "bad_a", threshold: "y", status: "fail", actualValue: "2", context: { q: 1 } },
      { name: "bad_b", threshold: "z", status: "fail", actualValue: "3", context: {} },
    ];
    reportFailures(results, { error: logError });
    expect(logError).toHaveBeenCalledTimes(2);
    const firstCall = logError.mock.calls[0]!;
    expect((firstCall[0] as { check_name: string }).check_name).toBe("bad_a");
    expect(firstCall[1]).toContain("bad_a");
  });
});
