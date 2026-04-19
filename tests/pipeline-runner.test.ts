import { describe, it, expect } from "vitest";
import type pg from "pg";
import { PipelineRunner, runPipelineJob } from "../src/ingestion/pipeline-runner.js";

function mockClient(): { client: pg.PoolClient; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let nextRunId = 42;
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (/INSERT INTO pipeline_runs/.test(sql)) {
        return { rows: [{ id: nextRunId++ }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as pg.PoolClient;
  return { client, queries };
}

describe("PipelineRunner.start", () => {
  it("INSERTs a 'running' row with job_name + started_at and returns the runId", async () => {
    const { client, queries } = mockClient();
    const runner = await PipelineRunner.start(client, "archive_adsb", "2026-04-19T12:00:00Z");
    expect(runner.runId).toBe(42);
    expect(runner.jobName).toBe("archive_adsb");
    expect(queries).toHaveLength(1);
    expect(queries[0]!.sql).toMatch(/INSERT INTO pipeline_runs/);
    expect(queries[0]!.sql).toContain("'running'");
    expect(queries[0]!.params).toEqual(["archive_adsb", "2026-04-19T12:00:00Z"]);
  });
});

describe("PipelineRunner.complete", () => {
  it("UPDATEs to status='completed' with ended_at + row_count_delta + metadata", async () => {
    const { client, queries } = mockClient();
    const runner = await PipelineRunner.start(client, "job-x");
    await runner.complete({ rowCountDelta: 1234, metadata: { batch: 3 } });
    const updateCall = queries[1]!;
    expect(updateCall.sql).toContain("'completed'");
    expect(updateCall.params[1]).toBe(1234);
    expect(JSON.parse(updateCall.params[2] as string)).toEqual({ batch: 3 });
  });

  it("defaults row_count_delta to 0 and metadata to {} when not provided", async () => {
    const { client, queries } = mockClient();
    const runner = await PipelineRunner.start(client, "job-x");
    await runner.complete();
    const updateCall = queries[1]!;
    expect(updateCall.params[1]).toBe(0);
    expect(JSON.parse(updateCall.params[2] as string)).toEqual({});
  });
});

describe("PipelineRunner.fail", () => {
  it("UPDATEs to status='failed' with error_message extracted from Error instance", async () => {
    const { client, queries } = mockClient();
    const runner = await PipelineRunner.start(client, "job-x");
    await runner.fail(new Error("boom"));
    const updateCall = queries[1]!;
    expect(updateCall.sql).toContain("'failed'");
    expect(updateCall.params[1]).toBe("boom");
  });

  it("stringifies non-Error throwables (defensive)", async () => {
    const { client, queries } = mockClient();
    const runner = await PipelineRunner.start(client, "job-x");
    await runner.fail("string thrown instead of Error");
    expect(queries[1]!.params[1]).toBe("string thrown instead of Error");
  });
});

describe("runPipelineJob — functional wrapper", () => {
  it("records complete() on success and returns fn's result", async () => {
    const { client, queries } = mockClient();
    const out = await runPipelineJob(client, "ok-job", async () => ({
      result: "hello",
      rowCountDelta: 50,
      metadata: { ok: true },
    }));
    expect(out).toBe("hello");
    expect(queries).toHaveLength(2); // INSERT + UPDATE
    expect(queries[1]!.sql).toContain("'completed'");
  });

  it("records fail() on exception AND re-throws", async () => {
    const { client, queries } = mockClient();
    await expect(
      runPipelineJob(client, "bad-job", async () => {
        throw new Error("kapow");
      }),
    ).rejects.toThrow("kapow");
    expect(queries).toHaveLength(2);
    expect(queries[1]!.sql).toContain("'failed'");
    expect(queries[1]!.params[1]).toBe("kapow");
  });
});
