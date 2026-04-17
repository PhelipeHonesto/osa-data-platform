/**
 * Nightly Batch Pipeline Orchestrator
 *
 * Runs the full data pipeline in order:
 *   1. FAA Registry Diff       — detect new/changed/deregistered aircraft
 *   2. Classify Aircraft        — tag unclassified aircraft with charter classes
 *   3. Rebuild Knowledge Graph  — join FAA + ADS-B, flag ghost candidates, propagate safety scores
 *   4. Propagate Safety Ratings — full safety ingestion (belt-and-suspenders)
 *   5. Log pipeline run         — persist stats to pipeline_runs table
 *
 * Each step shells out to the existing standalone script so they remain
 * independently runnable. The orchestrator captures output, extracts stats
 * from the database, and logs a unified report.
 *
 * Usage:
 *   npm run pipeline                          # download FAA registry
 *   npm run pipeline -- data/faa_raw/MASTER.txt  # use local MASTER.txt
 *   npm run pipeline -- --zip ~/Downloads/ReleasableAircraft.zip
 *
 * Run via: npm run pipeline
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { createStandaloneClient } from "../memory/pg-database.js";
import { childLogger } from "../utils/logger.js";
import { initSentry } from "../utils/sentry.js";

initSentry();
const log = childLogger("pipeline");

// ── Types ──────────────────────────────────────────────────────────────────

interface PipelineStats {
  newAircraft: number;
  deregistered: number;
  ownershipChanges: number;
  fieldChanges: number;
  aircraftClassified: number;
  ghostCandidates: number;
  totalInGraph: number;
  charterTracked: number;
}

interface StepResult {
  name: string;
  success: boolean;
  output: string;
  durationMs: number;
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function runStep(name: string, command: string): StepResult {
  const start = Date.now();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  STEP: ${name}`);
  console.log(`  CMD:  ${command}`);
  console.log(`${"═".repeat(60)}\n`);

  try {
    const output = execSync(command, {
      cwd: resolve("."),
      encoding: "utf-8",
      timeout: 300_000, // 5 minute timeout per step
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    const durationMs = Date.now() - start;
    console.log(output);
    console.log(`  ✓ ${name} completed in ${(durationMs / 1000).toFixed(1)}s`);
    return { name, success: true, output, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const error = err as { stderr?: string; stdout?: string; message?: string };
    const output = (error.stdout || "") + (error.stderr || "");
    const message = error.message || "Unknown error";
    console.error(output);
    console.error(`  ✗ ${name} FAILED after ${(durationMs / 1000).toFixed(1)}s: ${message}`);
    return { name, success: false, output, durationMs, error: message };
  }
}

function buildFaaDiffArgs(): string {
  // Forward CLI args to faa-daily-diff
  const args = process.argv.slice(2);
  if (args.length > 0) {
    return args.join(" ");
  }
  return "";
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "pipeline requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }

  const pipelineStart = new Date().toISOString();
  console.log(`\n╔${"═".repeat(58)}╗`);
  console.log(`║  OSA DUMONT — NIGHTLY BATCH PIPELINE                     ║`);
  console.log(`║  Started: ${pipelineStart}                ║`);
  console.log(`╚${"═".repeat(58)}╝`);

  const pgClient = createStandaloneClient();
  await pgClient.connect();

  // Insert pipeline_runs row (status = 'running'), capture id via RETURNING
  const insertRun = await pgClient.query(
    `INSERT INTO pipeline_runs (started_at, status) VALUES ($1, 'running') RETURNING id`,
    [pipelineStart],
  );
  const runId = insertRun.rows[0]!.id as number;

  // Snapshot change counts before diff (so we can measure delta)
  const changesBefore = await pgClient.query(
    "SELECT COUNT(*)::int as cnt FROM faa_registry_changes",
  );
  const countBefore = (changesBefore.rows[0] as { cnt: number }).cnt;

  const steps: StepResult[] = [];
  let stepsCompleted = 0;
  let failedStep: string | null = null;

  // ── Step 1: FAA Registry Diff ───────────────────────────────────────────
  const diffArgs = buildFaaDiffArgs();
  const step1 = runStep(
    "FAA Registry Diff",
    `npx tsx src/ingestion/faa-daily-diff.ts ${diffArgs}`,
  );
  steps.push(step1);
  if (!step1.success) {
    failedStep = step1.name;
  } else {
    stepsCompleted++;
  }

  // ── Step 2: Classify Aircraft ───────────────────────────────────────────
  if (!failedStep) {
    const step2 = runStep(
      "Classify Aircraft",
      "npx tsx src/ingestion/classify-aircraft.ts",
    );
    steps.push(step2);
    if (!step2.success) {
      failedStep = step2.name;
    } else {
      stepsCompleted++;
    }
  }

  // ── Step 3: Rebuild Knowledge Graph ─────────────────────────────────────
  if (!failedStep) {
    const step3 = runStep(
      "Rebuild Knowledge Graph",
      "npx tsx src/ingestion/update-graph.ts",
    );
    steps.push(step3);
    if (!step3.success) {
      failedStep = step3.name;
    } else {
      stepsCompleted++;
    }
  }

  // ── Step 4: Propagate Safety Ratings ───────────────────────────────────
  //    update-graph self-heals safety scores, but we also run the full
  //    safety ingestion as belt-and-suspenders to catch any new ratings.
  if (!failedStep) {
    const step4 = runStep(
      "Propagate Safety Ratings",
      "npx tsx src/ingestion/safety-ratings.ts",
    );
    steps.push(step4);
    if (!step4.success) {
      // Safety propagation failure is non-fatal — graph is already rebuilt
      log.warn({}, "safety ratings propagation failed — graph is still valid");
    } else {
      stepsCompleted++;
    }
  }

  // ── Step 5: Collect stats and log pipeline run ──────────────────────────
  const pipelineEnd = new Date().toISOString();

  const stats: PipelineStats = {
    newAircraft: 0,
    deregistered: 0,
    ownershipChanges: 0,
    fieldChanges: 0,
    aircraftClassified: 0,
    ghostCandidates: 0,
    totalInGraph: 0,
    charterTracked: 0,
  };

  // Count changes detected in this run (delta from before)
  const changesAfter = await pgClient.query(
    "SELECT COUNT(*)::int as cnt FROM faa_registry_changes",
  );
  const totalNewChanges = (changesAfter.rows[0] as { cnt: number }).cnt - countBefore;

  if (totalNewChanges > 0) {
    const preciseCounts = await pgClient.query(
      `SELECT change_type, COUNT(*)::int as cnt
       FROM faa_registry_changes
       WHERE detected_at >= $1
       GROUP BY change_type`,
      [pipelineStart],
    );
    for (const row of preciseCounts.rows as Array<{ change_type: string; cnt: number }>) {
      switch (row.change_type) {
        case "new": stats.newAircraft = row.cnt; break;
        case "deregistered": stats.deregistered = row.cnt; break;
        case "ownership_change": stats.ownershipChanges = row.cnt; break;
        case "field_change": stats.fieldChanges = row.cnt; break;
      }
    }
  }

  // Classified aircraft: count non-null aircraft_class
  const classifiedRow = await pgClient.query(
    "SELECT COUNT(*)::int as cnt FROM faa_aircraft WHERE aircraft_class IS NOT NULL",
  );
  stats.aircraftClassified = (classifiedRow.rows[0] as { cnt: number }).cnt;

  // Knowledge graph stats — populated by update-graph (Step 3 above).
  try {
    const graphStats = await pgClient.query(`
      SELECT
        COUNT(*)::int as total,
        SUM(CASE WHEN is_charter_class THEN 1 ELSE 0 END)::int as charter,
        SUM(CASE WHEN is_ghost_candidate THEN 1 ELSE 0 END)::int as ghosts
      FROM knowledge_graph
    `);
    const g = graphStats.rows[0] as { total: number; charter: number; ghosts: number };
    stats.totalInGraph = g.total;
    stats.charterTracked = g.charter ?? 0;
    stats.ghostCandidates = g.ghosts ?? 0;
  } catch {
    // knowledge_graph missing or schema mismatch — not fatal for the run
  }

  // Update pipeline_runs row
  const status = failedStep ? "failed" : "completed";
  await pgClient.query(
    `UPDATE pipeline_runs SET
       ended_at = $1, status = $2, steps_completed = $3, failed_step = $4,
       new_aircraft = $5, deregistered = $6, ownership_changes = $7, field_changes = $8,
       aircraft_classified = $9, ghost_candidates = $10, total_in_graph = $11,
       charter_tracked = $12, error_message = $13
     WHERE id = $14`,
    [
      pipelineEnd, status, stepsCompleted, failedStep,
      stats.newAircraft, stats.deregistered, stats.ownershipChanges, stats.fieldChanges,
      stats.aircraftClassified, stats.ghostCandidates, stats.totalInGraph,
      stats.charterTracked,
      failedStep ? steps.find((s) => !s.success)?.error ?? null : null,
      runId,
    ],
  );

  // ── Final Report ────────────────────────────────────────────────────────
  const totalDuration = steps.reduce((sum, s) => sum + s.durationMs, 0);

  console.log(`\n╔${"═".repeat(58)}╗`);
  console.log(`║  PIPELINE ${status.toUpperCase().padEnd(47)}║`);
  console.log(`╠${"═".repeat(58)}╣`);
  console.log(`║  Steps completed: ${String(stepsCompleted).padEnd(39)}║`);
  if (failedStep) {
    console.log(`║  Failed at:       ${failedStep.padEnd(39)}║`);
  }
  console.log(`║  Duration:        ${(totalDuration / 1000).toFixed(1).padEnd(39)}s║`);
  console.log(`╠${"═".repeat(58)}╣`);
  console.log(`║  FAA Registry:                                           ║`);
  console.log(`║    New registrations:   ${String(stats.newAircraft).padEnd(34)}║`);
  console.log(`║    Deregistered:        ${String(stats.deregistered).padEnd(34)}║`);
  console.log(`║    Ownership changes:   ${String(stats.ownershipChanges).padEnd(34)}║`);
  console.log(`║    Field changes:       ${String(stats.fieldChanges).padEnd(34)}║`);
  console.log(`╠${"═".repeat(58)}╣`);
  console.log(`║  Fleet Intelligence:                                     ║`);
  console.log(`║    Aircraft classified: ${String(stats.aircraftClassified).padEnd(34)}║`);
  console.log(`║    Knowledge graph:     ${String(stats.totalInGraph).padEnd(34)}║`);
  console.log(`║    Charter tracked:     ${String(stats.charterTracked).padEnd(34)}║`);
  console.log(`║    Ghost candidates:    ${String(stats.ghostCandidates).padEnd(34)}║`);
  console.log(`╚${"═".repeat(58)}╝`);

  // Show ownership changes if any
  if (stats.ownershipChanges > 0) {
    const changes = await pgClient.query(
      `SELECT tail_number, old_value, new_value
       FROM faa_registry_changes
       WHERE change_type = 'ownership_change' AND detected_at >= $1
       ORDER BY detected_at DESC
       LIMIT 20`,
      [pipelineStart],
    );

    console.log("\n── Ownership Changes (Transaction Signals) ──");
    for (const r of changes.rows as Array<{ tail_number: string; old_value: string; new_value: string }>) {
      console.log(`  ${r.tail_number}: ${r.old_value} → ${r.new_value}`);
    }
  }

  // Show ghost candidates
  if (stats.ghostCandidates > 0) {
    try {
      const ghosts = await pgClient.query(
        `SELECT tail_number, aircraft_class, ghost_airport, operator_name, idle_hours
         FROM knowledge_graph
         WHERE is_ghost_candidate = true
         ORDER BY idle_hours DESC
         LIMIT 20`,
      );
      console.log("\n── Ghost Candidates (Idle Charter Aircraft at Network Airports) ──");
      for (const g of ghosts.rows as Array<{ tail_number: string; aircraft_class: string; ghost_airport: string; operator_name: string; idle_hours: number }>) {
        console.log(`  ${g.tail_number} (${g.aircraft_class}) at ${g.ghost_airport} — ${g.operator_name}`);
      }
    } catch {
      /* knowledge_graph missing columns — skip */
    }
  }

  // Show the pipeline_runs row
  const row = await pgClient.query("SELECT * FROM pipeline_runs WHERE id = $1", [runId]);
  console.log("\n── pipeline_runs row ──");
  console.log(JSON.stringify(row.rows[0], null, 2));

  await pgClient.end();

  if (failedStep) {
    process.exit(1);
  }
}

main().catch((err) => {
  log.fatal({ err }, "pipeline fatal error");
  process.exit(1);
});
