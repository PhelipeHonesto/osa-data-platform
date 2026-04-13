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
import Database from "better-sqlite3";
import { runMigrations } from "../memory/migrations.js";

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
  const pipelineStart = new Date().toISOString();
  console.log(`\n╔${"═".repeat(58)}╗`);
  console.log(`║  OSA DUMONT — NIGHTLY BATCH PIPELINE                     ║`);
  console.log(`║  Started: ${pipelineStart}                ║`);
  console.log(`╚${"═".repeat(58)}╝`);

  // Ensure migrations are current (creates pipeline_runs if needed)
  const dbPath = process.env.DATABASE_PATH ?? process.env.DUMONT_DB_PATH ?? resolve("./data/dumont.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Insert pipeline_runs row (status = 'running')
  const runRow = db.prepare(`
    INSERT INTO pipeline_runs (started_at, status)
    VALUES (?, 'running')
  `).run(pipelineStart);
  const runId = runRow.lastInsertRowid;

  // Snapshot change counts before diff (so we can measure delta)
  const changesBefore = db.prepare(
    "SELECT COUNT(*) as cnt FROM faa_registry_changes",
  ).get() as { cnt: number };
  const countBefore = changesBefore.cnt;

  // Close DB before shelling out (scripts open their own connections)
  db.close();

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
      "node classify-aircraft.mjs",
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
      "node update-graph.mjs",
    );
    steps.push(step3);
    if (!step3.success) {
      failedStep = step3.name;
    } else {
      stepsCompleted++;
    }
  }

  // ── Step 4: Propagate Safety Ratings ───────────────────────────────────
  //    update-graph.mjs now self-heals safety scores, but we also run the
  //    full safety ingestion as belt-and-suspenders to catch any new ratings.
  if (!failedStep) {
    const step4 = runStep(
      "Propagate Safety Ratings",
      "npx tsx src/ingestion/safety-ratings.ts",
    );
    steps.push(step4);
    if (!step4.success) {
      // Safety propagation failure is non-fatal — graph is already rebuilt
      console.warn("  ⚠ Safety ratings propagation failed — graph is still valid");
    } else {
      stepsCompleted++;
    }
  }

  // ── Step 5: Collect stats and log pipeline run ──────────────────────────
  const pipelineEnd = new Date().toISOString();
  const db2 = new Database(dbPath);
  db2.pragma("journal_mode = WAL");

  // Query stats from the database
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
  const changesAfter = db2.prepare(
    "SELECT COUNT(*) as cnt FROM faa_registry_changes",
  ).get() as { cnt: number };
  const totalNewChanges = changesAfter.cnt - countBefore;

  if (totalNewChanges > 0) {
    // Count changes with detected_at >= pipeline start
    const preciseCounts = db2.prepare(`
      SELECT change_type, COUNT(*) as cnt
      FROM faa_registry_changes
      WHERE detected_at >= ?
      GROUP BY change_type
    `).all(pipelineStart) as { change_type: string; cnt: number }[];

    for (const row of preciseCounts) {
      switch (row.change_type) {
        case "new": stats.newAircraft = row.cnt; break;
        case "deregistered": stats.deregistered = row.cnt; break;
        case "ownership_change": stats.ownershipChanges = row.cnt; break;
        case "field_change": stats.fieldChanges = row.cnt; break;
      }
    }
  }

  // Classified aircraft: count non-null aircraft_class
  const classifiedRow = db2.prepare(
    "SELECT COUNT(*) as cnt FROM faa_aircraft WHERE aircraft_class IS NOT NULL",
  ).get() as { cnt: number };
  stats.aircraftClassified = classifiedRow.cnt;

  // Knowledge graph stats
  const graphExists = db2.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_graph'",
  ).get();

  if (graphExists) {
    const graphStats = db2.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(is_charter_class) as charter,
        SUM(is_ghost_candidate) as ghosts
      FROM knowledge_graph
    `).get() as { total: number; charter: number; ghosts: number };
    stats.totalInGraph = graphStats.total;
    stats.charterTracked = graphStats.charter;
    stats.ghostCandidates = graphStats.ghosts;
  }

  // Update pipeline_runs row
  const status = failedStep ? "failed" : "completed";
  db2.prepare(`
    UPDATE pipeline_runs SET
      ended_at = ?,
      status = ?,
      steps_completed = ?,
      failed_step = ?,
      new_aircraft = ?,
      deregistered = ?,
      ownership_changes = ?,
      field_changes = ?,
      aircraft_classified = ?,
      ghost_candidates = ?,
      total_in_graph = ?,
      charter_tracked = ?,
      error_message = ?
    WHERE id = ?
  `).run(
    pipelineEnd,
    status,
    stepsCompleted,
    failedStep,
    stats.newAircraft,
    stats.deregistered,
    stats.ownershipChanges,
    stats.fieldChanges,
    stats.aircraftClassified,
    stats.ghostCandidates,
    stats.totalInGraph,
    stats.charterTracked,
    failedStep ? steps.find((s) => !s.success)?.error ?? null : null,
    runId,
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
    const changes = db2.prepare(`
      SELECT tail_number, old_value, new_value
      FROM faa_registry_changes
      WHERE change_type = 'ownership_change' AND detected_at >= ?
      ORDER BY detected_at DESC
      LIMIT 20
    `).all(pipelineStart) as { tail_number: string; old_value: string; new_value: string }[];

    console.log("\n── Ownership Changes (Transaction Signals) ──");
    for (const r of changes) {
      console.log(`  ${r.tail_number}: ${r.old_value} → ${r.new_value}`);
    }
  }

  // Show ghost candidates
  if (stats.ghostCandidates > 0) {
    const ghosts = db2.prepare(`
      SELECT tail_number, aircraft_class, ghost_airport, operator_name, idle_hours
      FROM knowledge_graph
      WHERE is_ghost_candidate = 1
      ORDER BY idle_hours DESC
      LIMIT 20
    `).all() as { tail_number: string; aircraft_class: string; ghost_airport: string; operator_name: string; idle_hours: number }[];

    console.log("\n── Ghost Candidates (Idle Charter Aircraft at Network Airports) ──");
    for (const g of ghosts) {
      console.log(`  ${g.tail_number} (${g.aircraft_class}) at ${g.ghost_airport} — ${g.operator_name}`);
    }
  }

  db2.close();

  // Show the pipeline_runs row
  const db3 = new Database(dbPath);
  const row = db3.prepare("SELECT * FROM pipeline_runs WHERE id = ?").get(runId) as Record<string, unknown>;
  console.log("\n── pipeline_runs row ──");
  console.log(JSON.stringify(row, null, 2));
  db3.close();

  if (failedStep) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[pipeline] Fatal:", err);
  process.exit(1);
});
