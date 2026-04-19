/**
 * PipelineRunner — records every ingestion job run to pipeline_runs.
 *
 * Usage:
 *   const runner = await PipelineRunner.start(client, "archive_adsb");
 *   try {
 *     const { rowCountDelta, metadata } = await doTheWork();
 *     await runner.complete({ rowCountDelta, metadata });
 *   } catch (err) {
 *     await runner.fail(err);
 *     throw err;
 *   }
 *
 * Or the functional form:
 *   const result = await runPipelineJob(client, "archive_adsb", async () => {
 *     return { result: doTheWork(), rowCountDelta: 1234, metadata: { ... } };
 *   });
 *
 * Every ingestion script should wrap its main work this way. The morning
 * report (scripts/morning-report.ts) queries pipeline_runs + data_quality_runs
 * over the last 24 h and produces a status summary.
 */

import type pg from "pg";
import { childLogger } from "../utils/logger.js";

const log = childLogger("pipeline-runner");

export class PipelineRunner {
  private constructor(
    private readonly client: pg.PoolClient,
    public readonly runId: number,
    public readonly jobName: string,
  ) {}

  /**
   * Insert a `running` row and return a runner bound to its id.
   * started_at is set by the caller (ISO string) — lets tests inject a fixed clock.
   */
  static async start(
    client: pg.PoolClient,
    jobName: string,
    startedAt: string = new Date().toISOString(),
  ): Promise<PipelineRunner> {
    const res = await client.query<{ id: number }>(
      `INSERT INTO pipeline_runs (job_name, started_at, status)
       VALUES ($1, $2, 'running')
       RETURNING id`,
      [jobName, startedAt],
    );
    const runId = res.rows[0]!.id;
    log.info({ runId, jobName }, "pipeline run started");
    return new PipelineRunner(client, runId, jobName);
  }

  async complete(opts: {
    rowCountDelta?: number;
    metadata?: Record<string, unknown>;
    endedAt?: string;
  } = {}): Promise<void> {
    const endedAt = opts.endedAt ?? new Date().toISOString();
    await this.client.query(
      `UPDATE pipeline_runs
          SET status = 'completed',
              ended_at = $1,
              row_count_delta = $2,
              metadata = $3::jsonb
        WHERE id = $4`,
      [endedAt, opts.rowCountDelta ?? 0, JSON.stringify(opts.metadata ?? {}), this.runId],
    );
    log.info({ runId: this.runId, jobName: this.jobName, rowCountDelta: opts.rowCountDelta }, "pipeline run completed");
  }

  async fail(err: unknown, metadata: Record<string, unknown> = {}): Promise<void> {
    const endedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : String(err);
    await this.client.query(
      `UPDATE pipeline_runs
          SET status = 'failed',
              ended_at = $1,
              error_message = $2,
              metadata = $3::jsonb
        WHERE id = $4`,
      [endedAt, message, JSON.stringify(metadata), this.runId],
    );
    log.error({ runId: this.runId, jobName: this.jobName, err }, "pipeline run failed");
  }
}

/**
 * Functional form. Wraps `fn` with automatic start + complete/fail bookkeeping.
 * `fn` returns an object with the pipeline's result + optional row-count /
 * metadata context; the wrapper unpacks and records them, and returns `result`.
 */
export async function runPipelineJob<T>(
  client: pg.PoolClient,
  jobName: string,
  fn: () => Promise<{
    result: T;
    rowCountDelta?: number;
    metadata?: Record<string, unknown>;
  }>,
): Promise<T> {
  const runner = await PipelineRunner.start(client, jobName);
  try {
    const { result, rowCountDelta, metadata } = await fn();
    const completeOpts: Parameters<PipelineRunner["complete"]>[0] = {};
    if (rowCountDelta !== undefined) completeOpts.rowCountDelta = rowCountDelta;
    if (metadata !== undefined) completeOpts.metadata = metadata;
    await runner.complete(completeOpts);
    return result;
  } catch (err) {
    await runner.fail(err);
    throw err;
  }
}
