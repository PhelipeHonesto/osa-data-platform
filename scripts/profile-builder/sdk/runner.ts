/**
 * SDK-direct runner for autonomous profile-builder bulk execution.
 *
 * Replaces the Claude Code Agent harness with a Node-driven loop.
 * State, halt conditions, cost tracking, error logging — all
 * preserved from the bash orchestrator (bulk-orchestrate.sh) so this
 * is a drop-in replacement that runs without needing an interactive
 * Claude Code session.
 *
 * CLI:
 *   tsx runner.ts                                 (defaults: --concurrency=10 --cost-cap=150 --resume)
 *   tsx runner.ts --max=5 --concurrency=2         (calibration)
 *   tsx runner.ts --concurrency=10 --cost-cap=150 --resume
 *   tsx runner.ts --cert=B8MA                     (one-shot, useful for testing)
 *
 * Halt conditions (auto-checked between certs):
 *   - cost > cost-cap                             → halt cleanly
 *   - 5 consecutive validation_failed             → halt
 *   - 10 consecutive parse failures               → halt
 *   - SIGTERM / SIGINT                            → graceful shutdown
 *
 * State:  .work/profile-builder/sdk-bulk-state.json
 * Status: .work/profile-builder/sdk-status.log     (append-only)
 * Errors: .work/profile-builder/sdk-errors.jsonl   (append-only)
 *
 * Resume: --resume flag is implicit — every iteration's cohort query
 * excludes already-profiled certs, so a fresh process picks up where
 * the previous one stopped.
 */

import "dotenv/config";
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  getPool,
  fetchCertContext,
  upsertProfile,
} from "../operator-profile.js";
import { runAgentForCert } from "./agent.js";
import { connectWithRetry, attachPoolErrorHandler, isRateLimitError, isPoolTimeoutError } from "./db.js";

const WORK_ROOT = ".work/profile-builder";
const STATE_FILE = resolve(WORK_ROOT, "sdk-bulk-state.json");
const STATUS_LOG = resolve(WORK_ROOT, "sdk-status.log");
const ERRORS_LOG = resolve(WORK_ROOT, "sdk-errors.jsonl");

interface Args {
  max: number | null;        // --max=N   process N certs then exit (calibration)
  concurrency: number;       // --concurrency=N   how many certs in flight at once
  costCap: number;           // --cost-cap=$N     halt when total spend >= cap
  resume: boolean;           // (default true)    skip already-profiled
  specificCert: string | null;     // --cert=X        one-shot mode (single cert)
  specificCerts: string[] | null;  // --certs=A,B,C   calibration mode (re-run named certs even if profiled)
}

interface BulkState {
  started_at: string;
  cost_cap_usd: number;
  cost_warn_usd: number;     // 100 — first time crossed, log MILESTONE
  n_total_cohort: number;
  n_pre_done: number;
  n_completed_this_run: number;
  n_failed_this_run: number;
  consecutive_validation_failures: number;
  consecutive_parse_failures: number;
  consecutive_rate_limits: number;          // V1.2.1: triggers 5-min backoff at 5
  consecutive_pool_timeouts: number;        // V1.2.1: triggers halt at 5
  total_spent_usd: number;
  cost_warn_announced: boolean;
  last_cert: string | null;
  halted: boolean;
  halted_reason: string | null;
}

function nowIso(): string { return new Date().toISOString(); }

function log(msg: string): void {
  const line = `[${nowIso()}] ${msg}`;
  console.error(line);
  appendFileSync(STATUS_LOG, line + "\n");
}

function logError(payload: Record<string, unknown>): void {
  appendFileSync(ERRORS_LOG, JSON.stringify({ ts: nowIso(), ...payload }) + "\n");
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const out: Args = {
    max: null,
    concurrency: 3,  // V1.2.1: dropped from 10 — 10-way exceeded Anthropic's
                     // per-org rate limit at our prompt complexity, causing
                     // 429-storm waste. 3-way is conservative but stable.
    costCap: 150,
    resume: true,
    specificCert: null,
    specificCerts: null,
  };
  for (const a of argv) {
    if (a.startsWith("--max="))         out.max = parseInt(a.slice(6), 10);
    else if (a.startsWith("--concurrency=")) out.concurrency = parseInt(a.slice(14), 10);
    else if (a.startsWith("--cost-cap=")) out.costCap = parseFloat(a.slice(11));
    else if (a === "--no-resume")       out.resume = false;
    else if (a === "--resume")          out.resume = true;
    else if (a.startsWith("--certs="))  out.specificCerts = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a.startsWith("--cert="))   out.specificCert = a.slice(7);
    else if (a === "--help" || a === "-h") usage();
    else { console.error(`unknown arg: ${a}`); usage(); }
  }
  return out;
}

function usage(): never {
  console.error(`Usage:
  tsx runner.ts [--concurrency=10] [--cost-cap=150] [--max=N] [--cert=X]

Defaults: concurrency=10, cost-cap=$150, resumable (skips already-profiled).

Required env: ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, FIRECRAWL_API_KEY,
              SUPABASE_DATABASE_URL.
`);
  process.exit(1);
}

function loadOrInitState(args: Args): BulkState {
  mkdirSync(WORK_ROOT, { recursive: true });
  if (existsSync(STATE_FILE)) {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as BulkState;
    if (s.halted) {
      log(`STATE halted=${s.halted_reason} — clearing halt + resuming this run`);
      s.halted = false;
      s.halted_reason = null;
    }
    s.cost_cap_usd = args.costCap;
    return s;
  }
  return {
    started_at: nowIso(),
    cost_cap_usd: args.costCap,
    cost_warn_usd: 100,
    n_total_cohort: 0,    // filled in below
    n_pre_done: 0,
    n_completed_this_run: 0,
    n_failed_this_run: 0,
    consecutive_validation_failures: 0,
    consecutive_parse_failures: 0,
    consecutive_rate_limits: 0,
    consecutive_pool_timeouts: 0,
    total_spent_usd: 0,
    cost_warn_announced: false,
    last_cert: null,
    halted: false,
    halted_reason: null,
  };
}

function saveState(s: BulkState): void {
  const tmp = STATE_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  // atomic-ish rename
  writeFileSync(STATE_FILE, readFileSync(tmp, "utf-8"));
}

async function selectNextCerts(
  pool: import("pg").Pool,
  n: number,
  specificCert: string | null,
  specificCerts: string[] | null,
  alreadyTakenFromCertsList: Set<string>,
): Promise<string[]> {
  const client = await connectWithRetry(pool);
  try {
    // --certs=A,B,C calibration mode: pop the next ones we haven't taken yet
    // from the explicit list, regardless of whether they're already profiled.
    if (specificCerts && specificCerts.length > 0) {
      const remaining = specificCerts.filter((c) => !alreadyTakenFromCertsList.has(c));
      const next = remaining.slice(0, n);
      // Validate they exist in canonical.certificates
      if (next.length === 0) return [];
      const res = await client.query<{ cert: string }>(
        `SELECT faa_cert_number AS cert FROM canonical.certificates
          WHERE faa_cert_number = ANY($1::text[]) AND status = 'active_operating'`,
        [next],
      );
      const found = new Set(res.rows.map((r) => r.cert));
      const ordered = next.filter((c) => found.has(c));
      return ordered;
    }
    if (specificCert) {
      const res = await client.query<{ cert: string }>(
        `SELECT faa_cert_number AS cert FROM canonical.certificates
          WHERE faa_cert_number = $1 AND status = 'active_operating'`,
        [specificCert],
      );
      return res.rows.map((r) => r.cert);
    }
    const res = await client.query<{ cert: string }>(
      `WITH counts AS (
         SELECT c.faa_cert_number AS cert,
                COALESCE((SELECT count(*) FROM canonical.aircraft_on_certificate aoc WHERE aoc.cert_id = c.cert_id), 0) AS fleet
           FROM canonical.certificates c
          WHERE c.status = 'active_operating' AND c.faa_cert_number IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM public.operator_profiles p WHERE p.faa_cert_number = c.faa_cert_number
            )
       )
       SELECT cert FROM counts ORDER BY fleet DESC, cert LIMIT $1`,
      [n],
    );
    return res.rows.map((r) => r.cert);
  } finally {
    client.release();
  }
}

async function processCert(
  client: Anthropic,
  pool: import("pg").Pool,
  cert: string,
): Promise<{ ok: true; cost: number; legal_name: string; current_brand: string | null; parent: string | null; completeness: string } | { ok: false; reason: string; cost: number; detail: string }> {
  // 1. Pull cert context (with pool-retry resilience)
  let ctx;
  try {
    const dbClient = await connectWithRetry(pool);
    try {
      ctx = await fetchCertContext(dbClient, cert);
    } finally {
      dbClient.release();
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "pool_timeout", cost: 0, detail: `fetchCertContext: ${detail}` };
  }
  if (!ctx) {
    return { ok: false, reason: "cert_not_found", cost: 0, detail: `${cert} not in canonical.certificates` };
  }

  // 2. Run agent (with retry-on-validation-failure inside)
  const result = await runAgentForCert(client, pool, ctx);
  if ("reason" in result) {
    return { ok: false, reason: result.reason, cost: result.cost_usd, detail: result.detail };
  }

  // 3. Upsert profile (with pool-retry resilience)
  try {
    const upsertClient = await connectWithRetry(pool);
    try {
      await upsertProfile(upsertClient, cert, result.response);
    } finally {
      upsertClient.release();
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "pool_timeout", cost: result.cost_usd, detail: `upsertProfile: ${detail}` };
  }
  return {
    ok: true,
    cost: result.cost_usd,
    legal_name: result.response.legal_name,
    current_brand: result.response.current_brand,
    parent: result.response.parent_company,
    completeness: result.response.research_completeness,
  };
}

let SHUTDOWN_REQUESTED = false;

async function main(): Promise<void> {
  const args = parseArgs();

  // Validate required env BEFORE doing any work
  for (const k of ["ANTHROPIC_API_KEY", "PERPLEXITY_API_KEY", "FIRECRAWL_API_KEY", "SUPABASE_DATABASE_URL"]) {
    if (!process.env[k]) { console.error(`env ${k} is required`); process.exit(2); }
  }

  process.on("SIGINT",  () => { SHUTDOWN_REQUESTED = true; log("SIGINT received — completing in-flight then shutting down"); });
  process.on("SIGTERM", () => { SHUTDOWN_REQUESTED = true; log("SIGTERM received — completing in-flight then shutting down"); });

  // Catch any unhandled rejections — log + continue rather than crash.
  // This is a belt-and-suspenders defense against the V1.2 pg-pool ETIMEDOUT
  // crash; the per-cert connectWithRetry is the primary defense.
  process.on("unhandledRejection", (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`[unhandledRejection caught, non-fatal] ${msg}`);
  });

  const state = loadOrInitState(args);
  const pool = getPool();
  attachPoolErrorHandler(pool);
  const anth = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"]! });

  // Initial cohort metrics
  {
    const dbc = await pool.connect();
    try {
      const total = await dbc.query<{ n: string }>(
        `SELECT count(*) AS n FROM canonical.certificates
          WHERE status = 'active_operating' AND faa_cert_number IS NOT NULL`,
      );
      const profiled = await dbc.query<{ n: string }>(`SELECT count(*) AS n FROM public.operator_profiles`);
      state.n_total_cohort = parseInt(total.rows[0]!.n, 10);
      state.n_pre_done = parseInt(profiled.rows[0]!.n, 10);
    } finally {
      dbc.release();
    }
  }
  saveState(state);

  log(`START n_total=${state.n_total_cohort} n_pre_done=${state.n_pre_done} concurrency=${args.concurrency} cost_cap=$${args.costCap} max=${args.max ?? "none"}${args.specificCerts ? ` certs=[${args.specificCerts.join(",")}]` : ""}`);

  const certsTaken = new Set<string>();
  while (!SHUTDOWN_REQUESTED) {
    // Halt checks
    if (state.total_spent_usd >= state.cost_cap_usd) {
      state.halted = true; state.halted_reason = `cost_cap_breached:${state.total_spent_usd}>=${state.cost_cap_usd}`;
      saveState(state); log(`HALT ${state.halted_reason}`); break;
    }
    if (state.consecutive_validation_failures >= 5) {
      state.halted = true; state.halted_reason = "5_consecutive_validation_failures";
      saveState(state); log(`HALT ${state.halted_reason}`); break;
    }
    if (state.consecutive_parse_failures >= 10) {
      state.halted = true; state.halted_reason = "10_consecutive_parse_failures";
      saveState(state); log(`HALT ${state.halted_reason}`); break;
    }
    if (state.consecutive_pool_timeouts >= 5) {
      state.halted = true; state.halted_reason = "5_consecutive_pool_timeouts";
      saveState(state); log(`HALT ${state.halted_reason}`); break;
    }
    // Soft halt: 5 consecutive 429s → back off 5 min then resume
    if (state.consecutive_rate_limits >= 5) {
      log(`BACKOFF rate_limit_storm consecutive=${state.consecutive_rate_limits} — sleeping 5 min`);
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
      state.consecutive_rate_limits = 0;
      saveState(state);
      log(`RESUME after rate_limit backoff`);
    }
    if (args.max !== null && state.n_completed_this_run >= args.max) {
      log(`STOP max=${args.max} reached (completed=${state.n_completed_this_run})`); break;
    }

    // Select next batch
    const want = args.max !== null
      ? Math.min(args.concurrency, args.max - state.n_completed_this_run)
      : args.concurrency;
    const batch = await selectNextCerts(pool, want, args.specificCert, args.specificCerts, certsTaken);
    if (batch.length === 0) {
      log(`COMPLETE no more unprofiled certs — done`);
      break;
    }
    for (const c of batch) certsTaken.add(c);

    log(`BATCH starting size=${batch.length} certs=${batch.join(",")}`);

    // Run concurrently
    const results = await Promise.all(batch.map((cert) => processCert(anth, pool, cert).then((r) => ({ cert, r }))));

    // Update state per result, in order
    for (const { cert, r } of results) {
      state.last_cert = cert;
      if (r.ok) {
        state.n_completed_this_run++;
        state.total_spent_usd = round4(state.total_spent_usd + r.cost);
        // Reset all consecutive-failure counters on any success
        state.consecutive_validation_failures = 0;
        state.consecutive_parse_failures = 0;
        state.consecutive_rate_limits = 0;
        state.consecutive_pool_timeouts = 0;
        const totalDone = state.n_pre_done + state.n_completed_this_run;
        log(`DONE ${totalDone}/${state.n_total_cohort} cert=${cert} legal=${truncate(r.legal_name, 30)} brand=${truncate(r.current_brand ?? "null", 20)} parent=${truncate(r.parent ?? "null", 30)} completeness=${r.completeness} cost=$${r.cost} total=$${state.total_spent_usd}`);
      } else {
        state.n_failed_this_run++;
        state.total_spent_usd = round4(state.total_spent_usd + r.cost);
        // Classify failure by reason
        if (r.reason === "validation_failed" || r.reason === "validation_failed_after_retries") {
          state.consecutive_validation_failures++;
          state.consecutive_rate_limits = 0;
          state.consecutive_pool_timeouts = 0;
        } else if (r.reason === "json_parse" || r.reason === "no_response") {
          state.consecutive_parse_failures++;
          state.consecutive_rate_limits = 0;
          state.consecutive_pool_timeouts = 0;
        } else if (r.reason === "pool_timeout") {
          state.consecutive_pool_timeouts++;
        } else if (r.reason === "sdk_error" && isRateLimitError(r.detail)) {
          state.consecutive_rate_limits++;
        } else if (r.reason === "sdk_error" && isPoolTimeoutError(r.detail)) {
          state.consecutive_pool_timeouts++;
        }
        logError({ cert, reason: r.reason, detail: r.detail, cost: r.cost });
        log(`FAIL cert=${cert} reason=${r.reason} cost=$${r.cost}`);
      }
    }

    // Cost-warn milestone
    if (!state.cost_warn_announced && state.total_spent_usd >= state.cost_warn_usd) {
      state.cost_warn_announced = true;
      log(`MILESTONE cost passed $${state.cost_warn_usd} (now $${state.total_spent_usd})`);
    }
    // Every-100 progress milestone
    const totalDone = state.n_pre_done + state.n_completed_this_run;
    if (totalDone > 0 && totalDone % 100 === 0) {
      const meanCost = state.total_spent_usd / Math.max(1, state.n_completed_this_run);
      log(`MILESTONE every_100_done total=${totalDone}/${state.n_total_cohort} mean_cost=$${meanCost.toFixed(4)} cumulative=$${state.total_spent_usd}`);
    }

    saveState(state);
  }

  log(`END halted=${state.halted} reason=${state.halted_reason ?? "n/a"} completed_this_run=${state.n_completed_this_run} failed_this_run=${state.n_failed_this_run} total_spent=$${state.total_spent_usd}`);
  saveState(state);
  await pool.end();

  if (state.halted && state.halted_reason && !state.halted_reason.startsWith("cost_cap")) {
    process.exit(3);
  }
  process.exit(0);
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

void main().catch((err: unknown) => {
  const detail = err instanceof Error ? err.message + "\n" + err.stack : String(err);
  log(`FATAL ${detail}`);
  process.exit(99);
});
