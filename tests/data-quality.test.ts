import { describe, it, expect } from "vitest";
import type pg from "pg";
import { faaRegistryCount } from "../src/ingestion/data-quality/assertions/faa-registry-count.js";
import { adsbLegsPresence } from "../src/ingestion/data-quality/assertions/adsb-legs-presence.js";
import { operatorIdentityOrphans } from "../src/ingestion/data-quality/assertions/operator-identity-orphans.js";
import { routeVectorEmbeddings } from "../src/ingestion/data-quality/assertions/route-vector-embeddings.js";
import { adsbLegDuplicates } from "../src/ingestion/data-quality/assertions/adsb-leg-duplicates.js";
import { runAssertions } from "../src/ingestion/data-quality/runner.js";
import { ALL_ASSERTIONS } from "../src/ingestion/data-quality/index.js";
import type { Assertion, AssertionResult } from "../src/ingestion/data-quality/index.js";

function mockClient(fixtures: Array<{ sql: RegExp | string; rows: unknown[] }>): {
  client: pg.PoolClient;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let idx = 0;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const expect = fixtures[idx++];
      if (!expect) throw new Error(`no fixture for call ${idx}: ${sql.slice(0, 80)}`);
      const ok = typeof expect.sql === "string" ? sql.includes(expect.sql) : expect.sql.test(sql);
      if (!ok) throw new Error(`sql mismatch at call ${idx}: got ${sql.slice(0, 120)}`);
      return { rows: expect.rows };
    },
  } as unknown as pg.PoolClient;
  return { client, calls };
}

// ── Individual assertions ────────────────────────────────────────────────

describe("faaRegistryCount", () => {
  it("passes when count is above the catastrophic-loss floor", async () => {
    const { client } = mockClient([{ sql: "FROM faa_aircraft", rows: [{ cnt: "320000" }] }]);
    const result = await faaRegistryCount.run(client);
    expect(result.status).toBe("pass");
    expect(result.actual_value).toBe("320000");
  });
  it("fails when count falls below 100,000", async () => {
    const { client } = mockClient([{ sql: "FROM faa_aircraft", rows: [{ cnt: "50000" }] }]);
    const result = await faaRegistryCount.run(client);
    expect(result.status).toBe("fail");
  });
});

describe("adsbLegsPresence", () => {
  it("passes when any legs exist", async () => {
    const { client } = mockClient([{ sql: "FROM adsb_completed_legs", rows: [{ cnt: "1" }] }]);
    expect((await adsbLegsPresence.run(client)).status).toBe("pass");
  });
  it("fails on zero legs (ingestion path broken)", async () => {
    const { client } = mockClient([{ sql: "FROM adsb_completed_legs", rows: [{ cnt: "0" }] }]);
    expect((await adsbLegsPresence.run(client)).status).toBe("fail");
  });
});

describe("operatorIdentityOrphans", () => {
  it("passes when no orphans", async () => {
    const { client } = mockClient([{ sql: "FROM operator_identities", rows: [{ cnt: "0" }] }]);
    expect((await operatorIdentityOrphans.run(client)).status).toBe("pass");
  });
  it("fails when any identity points to a missing operator", async () => {
    const { client } = mockClient([{ sql: "FROM operator_identities", rows: [{ cnt: "3" }] }]);
    const r = await operatorIdentityOrphans.run(client);
    expect(r.status).toBe("fail");
    expect(r.context?.orphan_count).toBe(3);
  });
});

describe("routeVectorEmbeddings", () => {
  it("passes when no null embeddings", async () => {
    const { client } = mockClient([{ sql: "FROM route_vectors", rows: [{ cnt: "0" }] }]);
    expect((await routeVectorEmbeddings.run(client)).status).toBe("pass");
  });
  it("fails on any null embedding", async () => {
    const { client } = mockClient([{ sql: "FROM route_vectors", rows: [{ cnt: "5" }] }]);
    expect((await routeVectorEmbeddings.run(client)).status).toBe("fail");
  });
});

describe("adsbLegDuplicates", () => {
  it("passes when no duplicate tuples", async () => {
    const { client } = mockClient([{ sql: /FROM \(/, rows: [{ cnt: "0" }] }]);
    expect((await adsbLegDuplicates.run(client)).status).toBe("pass");
  });
  it("fails when duplicates exist", async () => {
    const { client } = mockClient([{ sql: /FROM \(/, rows: [{ cnt: "12" }] }]);
    const r = await adsbLegDuplicates.run(client);
    expect(r.status).toBe("fail");
    expect(r.context?.duplicate_tuple_count).toBe(12);
  });
});

// ── Runner orchestration ─────────────────────────────────────────────────

function fakeAssertion(name: string, status: "pass" | "fail"): Assertion {
  return {
    name,
    description: `synthetic ${name}`,
    async run(): Promise<AssertionResult> {
      return { status, threshold: "stub", actual_value: "stub" };
    },
  };
}

describe("runAssertions", () => {
  it("generates a UUID run_id for every invocation and passes it to every INSERT", async () => {
    const captured: unknown[][] = [];
    const client = {
      async query(_sql: string, params: unknown[] = []) {
        captured.push(params);
        return { rows: [] };
      },
    } as unknown as pg.PoolClient;

    const result = await runAssertions(client, [
      fakeAssertion("a", "pass"),
      fakeAssertion("b", "pass"),
    ]);

    expect(result.run_id).toMatch(/^[0-9a-f-]{36}$/);
    for (const params of captured) {
      expect(params[1]).toBe(result.run_id); // same run_id threaded through every row
    }
  });

  it("overall_status is 'green' when all pass", async () => {
    const client = { async query() { return { rows: [] }; } } as unknown as pg.PoolClient;
    const result = await runAssertions(client, [fakeAssertion("a", "pass"), fakeAssertion("b", "pass")]);
    expect(result.overall_status).toBe("green");
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  it("overall_status is 'red' on any failure", async () => {
    const client = { async query() { return { rows: [] }; } } as unknown as pg.PoolClient;
    const result = await runAssertions(client, [fakeAssertion("a", "pass"), fakeAssertion("b", "fail")]);
    expect(result.overall_status).toBe("red");
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("treats a thrown assertion as a failure (defensive — doesn't abort the run)", async () => {
    const client = { async query() { return { rows: [] }; } } as unknown as pg.PoolClient;
    const throwing: Assertion = {
      name: "broken",
      description: "always throws",
      async run() {
        throw new Error("boom");
      },
    };
    const result = await runAssertions(client, [throwing, fakeAssertion("b", "pass")]);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
    const throwingResult = result.results.find((r) => r.assertion.name === "broken")!;
    expect(throwingResult.result.status).toBe("fail");
    expect(throwingResult.result.actual_value).toContain("boom");
  });
});

// ── Module surface ───────────────────────────────────────────────────────

describe("ALL_ASSERTIONS — public surface", () => {
  it("exports the five Phase 1 initial assertions", () => {
    const names = ALL_ASSERTIONS.map((a) => a.name).sort();
    expect(names).toEqual([
      "adsb_leg_duplicates",
      "adsb_legs_presence",
      "faa_registry_count",
      "operator_identity_orphans",
      "route_vector_embeddings",
    ]);
  });
});
