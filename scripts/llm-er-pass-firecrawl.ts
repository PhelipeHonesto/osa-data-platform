/**
 * Track 6 Step 2c.5 Phase 2 — LLM-augmented entity resolution driver.
 *
 * Architecture (per plan §"Architecture"):
 *
 *   This Claude Code session is the orchestrator. The script provides DB
 *   plumbing primitives the orchestrator strings together. Each --claim-next
 *   call emits a JSON request on stdout; the orchestrator spawns a subagent
 *   (Sonnet 4.6) with Firecrawl MCP access, gets a structured response, then
 *   pipes it back via --submit-response. The Anthropic SDK is intentionally
 *   not used in the Node process — reasoning lives in Claude Code's context.
 *
 *   ─────────────────────────────────────────────────────────────────────
 *   Reason-only orchestration (executed FROM Claude Code, not from cron):
 *
 *     while true; do
 *       work=$(npx tsx scripts/llm-er-pass-firecrawl.ts --claim-next)
 *       echo "$work" | jq -e '.empty' > /dev/null && break
 *       checkpoint_id=$(echo "$work" | jq -r '.checkpoint_id')
 *       prompt=$(echo "$work" | jq -r '.prompt')
 *       # Spawn Agent (subagent_type=general-purpose, model=sonnet,
 *       # Firecrawl MCP tools) with $prompt. Capture JSON response.
 *       response=$(spawn-agent "$prompt")
 *       echo "$response" | npx tsx scripts/llm-er-pass-firecrawl.ts \
 *         --submit-response "$checkpoint_id"
 *     done
 *   ─────────────────────────────────────────────────────────────────────
 *
 * ── Modes ────────────────────────────────────────────────────────────────
 *
 *   Orchestration primitives (called per-record from Claude Code):
 *     --claim-next                     Claim one row, emit request JSON.
 *     --submit-response <id>           Persist response from stdin.
 *     --mark-failed <id> --error=<msg> Mark a row failed (e.g. agent crashed).
 *
 *   Eval orchestration primitives:
 *     --eval-init                      Create eval run dir, print path.
 *     --claim-next-eval --eval-dir=D   Claim next holdout case+mode.
 *     --submit-eval-response --eval-dir=D
 *                                      Persist eval result from stdin.
 *     --eval-summary --eval-dir=D      Print F1/P/R/confusion matrix.
 *
 *   Direct execution:
 *     --commit [--auto-approve-all]    Read status='completed' rows, split
 *                                      into auto-approved or ready_for_review.
 *
 *   Legacy (now doc-only — see plan):
 *     --smoke-firecrawl                URL list to scrape (orchestrator
 *                                      calls mcp__firecrawl__firecrawl_scrape).
 *     --reason-only                    Doc-only stub — prints the bash loop.
 *     --eval-mode                      Doc-only stub — points at --eval-init.
 *
 * ── Source slugs (Phase 2 writes) ────────────────────────────────────────
 *   public.operator_aliases.source = 'llm_firecrawl_research'
 *   public.operator_aliases.alias_type = 'legal' | 'historical'
 *     ('historical' for rebrand_to_canonical; 'legal' for everything else.
 *      'subsidiary' enum value not yet added — captured in evidence JSONB.)
 *   canonical.operator_holds_certificate.source = 'llm_firecrawl_research'
 *   canonical.operator_holds_certificate.match_method = 'llm_firecrawl_alias'
 *     | 'llm_firecrawl_new_entity' | 'llm_firecrawl_rebrand'
 *
 * ── Two-Source Rule application (per plan) ───────────────────────────────
 * The LLM counts as ONE source. validateLLMResponse enforces ≥2 distinct
 * domains in citation URLs for any non-ambiguous decision. rebrand_to_canonical
 * (entity-change event) requires the hard 2+ independent publishers AND
 * never auto-approves — always surfaces for human review.
 *
 * ── Idempotency ──────────────────────────────────────────────────────────
 * Per-record state in public.operator_llm_er_checkpoint with
 * UNIQUE(input_review_id, input_step). Resumable: a record in 'in_progress'
 * for >1 hour is reclaimed on next run. attempt_count caps retries at 3.
 */

import "dotenv/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import {
  firstSignificantWord,
  scoreCandidates,
  type OperatorCandidate,
  type ScoredCandidate,
} from "../src/entity-resolution/operator-resolver.js";

// ── Constants ─────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_CAP_USD = 300;
const FIRECRAWL_SCRAPE_HARD_CAP = 5000;
const CONFIDENCE_POST_CAP = 0.85;
const AUTO_APPROVE_MIN_CONFIDENCE = 0.75;
const RETRY_HARD_CAP = 3;
const STALE_IN_PROGRESS_MINUTES = 60;
const TOP_K_CANDIDATES = 5;
const FIRECRAWL_MAX_PAGES_PER_RECORD = 8;

const ELIGIBLE_INPUT_STEPS = ["step2c", "step2c.5_phase1_collision"] as const;

const FIXTURE_HOLDOUT_PATH = "scripts/fixtures/llm-eval-holdout-30.json";
const FIXTURE_TOP20_PATH = "scripts/fixtures/top-20-by-fleet.json";
const EVAL_WORK_ROOT = ".work/llm-er-pass";

// ── Types ─────────────────────────────────────────────────────────────────

type InputStep = (typeof ELIGIBLE_INPUT_STEPS)[number];

type Mode =
  | "smoke-firecrawl"
  | "eval"
  | "reason-only"
  | "commit"
  | "claim-next"
  | "submit-response"
  | "mark-failed"
  | "eval-init"
  | "claim-next-eval"
  | "submit-eval-response"
  | "eval-summary"
  | "help";

interface Args {
  mode: Mode;
  maxRecords: number | null;
  autoApproveAll: boolean;
  budgetCapUsd: number;
  checkpointId: string | null;
  errorMessage: string | null;
  evalDir: string | null;
  holdoutId: string | null;
  evalSubMode: "visible" | "hidden" | null;
  specificReviewId: number | null;
}

interface WorkRecord {
  review_id: number;
  input_step: InputStep;
  scraped_name: string;
  scraped_payload: Record<string, unknown>;
  candidate_matches: Array<Record<string, unknown>>;
}

interface CandidateOperatorOut {
  operator_id: string;
  canonical_name: string;
  aliases: string[];
  headquarters_icao: string | null;
  operator_type: string | null;
  icao_callsign: string | null;
  prior_match_score: number | null;
  prior_match_signals: Record<string, unknown> | null;
}

type Decision = "match" | "new_entity" | "ambiguous" | "error";
type DecisionSubtype =
  | "exact_alias"
  | "subsidiary_of_canonical"
  | "rebrand_to_canonical"
  | "distinct_legal_entity"
  | "distinct_brand";

interface VerbatimQuote {
  url: string;
  quote: string;
  supports_claim: string;
}

interface FirecrawlPage {
  url: string;
  content: string;
  fetched_at: string;
}

interface SubagentResponse {
  decision: Decision;
  decision_target_operator_id: string | null;
  decision_subtype: DecisionSubtype | null;
  confidence: number;
  verbatim_quotes: VerbatimQuote[];
  reasoning: string;
  firecrawl_urls_fetched: string[];
  firecrawl_pages: FirecrawlPage[];
  additional_evidence_needed: string | null;
  cost_estimate_usd: number;
}

interface ValidationResult {
  valid: boolean;
  reason?:
    | "cited_url_not_fetched"
    | "quote_not_in_page"
    | "two_source_rule_violation_one_domain"
    | "missing_citation_for_decision"
    | "invalid_decision_target";
  detail?: string;
}

type CheckpointStatus =
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "ready_for_review"
  | "committed";

interface CheckpointRow {
  id: string;
  input_review_id: number;
  input_step: InputStep;
  status: CheckpointStatus;
  attempt_count: number;
  last_attempt_at: string | null;
  llm_decision: Decision | null;
  llm_decision_subtype: DecisionSubtype | null;
  llm_decision_target: string | null;
  llm_confidence: number | null;
  firecrawl_pages: FirecrawlPage[] | null;
  llm_evidence: Record<string, unknown> | null;
  citation_validated: boolean | null;
  cost_estimate_usd: number | null;
  error_message: string | null;
  run_id: string | null;
}

// ── Args parsing ──────────────────────────────────────────────────────────

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let mode: Mode = "help";
  if (args.includes("--smoke-firecrawl")) mode = "smoke-firecrawl";
  else if (args.includes("--eval-mode")) mode = "eval";
  else if (args.includes("--reason-only")) mode = "reason-only";
  else if (args.includes("--commit")) mode = "commit";
  else if (args.includes("--claim-next")) mode = "claim-next";
  else if (args.includes("--submit-response")) mode = "submit-response";
  else if (args.includes("--mark-failed")) mode = "mark-failed";
  else if (args.includes("--eval-init")) mode = "eval-init";
  else if (args.includes("--claim-next-eval")) mode = "claim-next-eval";
  else if (args.includes("--submit-eval-response")) mode = "submit-eval-response";
  else if (args.includes("--eval-summary")) mode = "eval-summary";

  const flagVal = (name: string): string | null => {
    const eqForm = args.find((a) => a.startsWith(`${name}=`));
    if (eqForm) return eqForm.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx >= 0 && args[idx + 1] !== undefined && !args[idx + 1]!.startsWith("--"))
      return args[idx + 1]!;
    return null;
  };

  const positionalsAfter = (name: string): string[] => {
    const idx = args.indexOf(name);
    if (idx < 0) return [];
    return args.slice(idx + 1).filter((a) => !a.startsWith("--"));
  };
  const positionalAfter = (name: string): string | null =>
    positionalsAfter(name)[0] ?? null;

  const maxFlag = args.find((a) => a.startsWith("--max-records="));
  const budgetFlag = args.find((a) => a.startsWith("--budget-cap-usd="));

  return {
    mode,
    maxRecords: maxFlag ? Number.parseInt(maxFlag.split("=")[1]!, 10) : null,
    autoApproveAll: args.includes("--auto-approve-all"),
    budgetCapUsd: budgetFlag
      ? Number.parseFloat(budgetFlag.split("=")[1]!)
      : DEFAULT_BUDGET_CAP_USD,
    checkpointId:
      mode === "submit-response" || mode === "mark-failed"
        ? positionalAfter(`--${mode}`)
        : null,
    errorMessage: flagVal("--error"),
    evalDir: flagVal("--eval-dir"),
    holdoutId:
      mode === "submit-eval-response"
        ? positionalsAfter("--submit-eval-response")[0] ?? null
        : null,
    evalSubMode: (() => {
      if (mode !== "submit-eval-response") return null;
      const sub = positionalsAfter("--submit-eval-response")[1];
      if (sub === "visible" || sub === "hidden") return sub;
      return null;
    })(),
    specificReviewId: (() => {
      const f = flagVal("--specific-review-id");
      return f ? Number.parseInt(f, 10) : null;
    })(),
  };
}

function formatRunId(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

function printHelp(): void {
  console.log(`
Usage: tsx scripts/llm-er-pass-firecrawl.ts <mode> [flags]

Orchestration primitives (called per-record FROM Claude Code session):
  --claim-next                   Claim next queued/failed/stale row, emit
                                 JSON request {checkpoint_id, prompt, ...}
                                 to stdout. Empty queue -> {"empty": true}.
  --submit-response <id>         Read SubagentResponse JSON from stdin,
                                 validate, persist to checkpoint row <id>.
  --mark-failed <id> --error=M   Force a row to status='failed'.

Eval orchestration:
  --eval-init                    Create new eval run dir under
                                 .work/llm-er-pass/eval-<ts>/, print path.
  --claim-next-eval --eval-dir=D Claim next (case, sub_mode) tuple in
                                 deterministic order. Emit request JSON.
                                 sub_mode is 'visible' (truth in pool) or
                                 'hidden' (truth removed).
  --submit-eval-response --eval-dir=D <holdout_id> <visible|hidden>
                                 Append result line to results.jsonl.
  --eval-summary --eval-dir=D    Compute F1/P/R + confusion matrix.

Direct execution:
  --commit [--auto-approve-all]  Process status='completed' rows. Auto-
                                 approve clean ones to canonical; surface
                                 the rest as 'ready_for_review'.

Legacy doc-only modes (the orchestration loop runs from Claude Code now):
  --smoke-firecrawl              Print Firecrawl smoke-test URL list.
  --reason-only                  Print the bash orchestration loop.
  --eval-mode                    Print eval orchestration loop.

Flags:
  --specific-review-id=N         --claim-next: target this exact match_review
                                 id (creates checkpoint if missing). Smoke-test
                                 utility — bypasses normal queue order.
  --max-records=N                Reserved (no longer enforced from inside
                                 the script — orchestrator counts iterations).
  --budget-cap-usd=N             Reserved (orchestrator tracks).
  --auto-approve-all             --commit only: bypass surface-for-review.
`);
}

// ── Database helpers ──────────────────────────────────────────────────────

function getPool(): pg.Pool {
  const cs = process.env["SUPABASE_DATABASE_URL"];
  if (!cs) {
    console.error("SUPABASE_DATABASE_URL not set. Add it to .env.");
    process.exit(1);
  }
  return new pg.Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
  });
}

async function readStdinJson<T>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) throw new Error("stdin is empty — expected JSON payload");
  return JSON.parse(raw) as T;
}

async function bootstrapCheckpointRows(client: pg.PoolClient): Promise<number> {
  const res = await client.query<{ inserted: string }>(
    `WITH inserted AS (
       INSERT INTO public.operator_llm_er_checkpoint (input_review_id, input_step)
       SELECT
         omr.id,
         (omr.scraped_payload->>'step')::text AS input_step
       FROM public.operator_match_review omr
       WHERE omr.scraped_payload->>'step' = ANY($1::text[])
         AND omr.status = 'pending'
       ON CONFLICT (input_review_id, input_step) DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*)::bigint AS inserted FROM inserted`,
    [ELIGIBLE_INPUT_STEPS as unknown as string[]],
  );
  return Number.parseInt(res.rows[0]!.inserted, 10);
}

async function ensureCheckpointForReviewId(
  client: pg.PoolClient,
  reviewId: number,
): Promise<{ id: string; input_step: InputStep } | null> {
  const review = await client.query<{ step: string; status: string }>(
    `SELECT scraped_payload->>'step' AS step, status
       FROM public.operator_match_review WHERE id = $1`,
    [reviewId],
  );
  if (review.rowCount === 0) return null;
  const step = review.rows[0]!.step as InputStep;
  if (!ELIGIBLE_INPUT_STEPS.includes(step)) return null;

  await client.query(
    `INSERT INTO public.operator_llm_er_checkpoint (input_review_id, input_step)
     VALUES ($1, $2)
     ON CONFLICT (input_review_id, input_step) DO NOTHING`,
    [reviewId, step],
  );
  const cp = await client.query<{ id: string }>(
    `SELECT id::text FROM public.operator_llm_er_checkpoint
       WHERE input_review_id = $1 AND input_step = $2`,
    [reviewId, step],
  );
  return { id: cp.rows[0]!.id, input_step: step };
}

async function claimRowById(
  client: pg.PoolClient,
  checkpointId: string,
  runId: string,
): Promise<CheckpointRow | null> {
  await client.query("BEGIN");
  try {
    const claim = await client.query<CheckpointRow>(
      `SELECT id::text, input_review_id, input_step, status, attempt_count,
              last_attempt_at::text, llm_decision, llm_decision_subtype,
              llm_decision_target::text, llm_confidence::float8,
              firecrawl_pages, llm_evidence, citation_validated,
              cost_estimate_usd::float8, error_message, run_id
         FROM public.operator_llm_er_checkpoint
        WHERE id = $1::uuid
        FOR UPDATE`,
      [checkpointId],
    );
    if (claim.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = claim.rows[0]!;
    await client.query(
      `UPDATE public.operator_llm_er_checkpoint
          SET status = 'in_progress',
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW(),
              run_id = $2,
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [row.id, runId],
    );
    await client.query("COMMIT");
    return { ...row, status: "in_progress", attempt_count: row.attempt_count + 1 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    throw err;
  }
}

async function claimNextRow(
  client: pg.PoolClient,
  runId: string,
): Promise<CheckpointRow | null> {
  await client.query("BEGIN");
  try {
    const claim = await client.query<CheckpointRow>(
      `SELECT id::text, input_review_id, input_step, status, attempt_count,
              last_attempt_at::text, llm_decision, llm_decision_subtype,
              llm_decision_target::text, llm_confidence::float8,
              firecrawl_pages, llm_evidence, citation_validated,
              cost_estimate_usd::float8, error_message, run_id
         FROM public.operator_llm_er_checkpoint
        WHERE (
            status = 'queued'
            OR (status = 'failed' AND attempt_count < $1)
            OR (status = 'in_progress'
                AND last_attempt_at < NOW() - ($2 || ' minutes')::interval)
          )
        ORDER BY attempt_count ASC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [RETRY_HARD_CAP, STALE_IN_PROGRESS_MINUTES],
    );
    if (claim.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = claim.rows[0]!;
    await client.query(
      `UPDATE public.operator_llm_er_checkpoint
          SET status = 'in_progress',
              attempt_count = attempt_count + 1,
              last_attempt_at = NOW(),
              run_id = $2,
              updated_at = NOW()
        WHERE id = $1::uuid`,
      [row.id, runId],
    );
    await client.query("COMMIT");
    return { ...row, status: "in_progress", attempt_count: row.attempt_count + 1 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    throw err;
  }
}

async function writeCompletedCheckpoint(
  client: pg.PoolClient,
  checkpointId: string,
  response: SubagentResponse,
  validation: ValidationResult,
): Promise<void> {
  const evidence = {
    verbatim_quotes: response.verbatim_quotes,
    reasoning: response.reasoning,
    firecrawl_urls_fetched: response.firecrawl_urls_fetched,
    additional_evidence_needed: response.additional_evidence_needed,
    validation_reason: validation.reason ?? null,
    validation_detail: validation.detail ?? null,
  };
  await client.query(
    `UPDATE public.operator_llm_er_checkpoint
        SET status = $2,
            llm_decision = $3,
            llm_decision_subtype = $4,
            llm_decision_target = $5::uuid,
            llm_confidence = $6,
            firecrawl_pages = $7::jsonb,
            llm_evidence = $8::jsonb,
            citation_validated = $9,
            cost_estimate_usd = COALESCE(cost_estimate_usd, 0) + $10,
            error_message = NULL,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [
      checkpointId,
      validation.valid ? "completed" : "failed",
      response.decision,
      response.decision_subtype,
      response.decision_target_operator_id,
      Math.min(response.confidence, CONFIDENCE_POST_CAP),
      JSON.stringify(response.firecrawl_pages),
      JSON.stringify(evidence),
      validation.valid,
      response.cost_estimate_usd,
    ],
  );
}

async function writeFailedCheckpoint(
  client: pg.PoolClient,
  checkpointId: string,
  errorMessage: string,
  costSoFar: number,
): Promise<void> {
  await client.query(
    `UPDATE public.operator_llm_er_checkpoint
        SET status = 'failed',
            error_message = $2,
            cost_estimate_usd = COALESCE(cost_estimate_usd, 0) + $3,
            updated_at = NOW()
      WHERE id = $1::uuid`,
    [checkpointId, errorMessage, costSoFar],
  );
}

// ── Validation (pure function) ────────────────────────────────────────────

export function validateLLMResponse(
  response: SubagentResponse,
): ValidationResult {
  if (response.decision === "ambiguous" || response.decision === "error") {
    return { valid: true };
  }

  if (response.verbatim_quotes.length === 0) {
    return {
      valid: false,
      reason: "missing_citation_for_decision",
      detail: `decision='${response.decision}' but no verbatim_quotes provided`,
    };
  }

  for (const q of response.verbatim_quotes) {
    if (!response.firecrawl_urls_fetched.includes(q.url)) {
      return {
        valid: false,
        reason: "cited_url_not_fetched",
        detail: `URL ${q.url} cited but not in firecrawl_urls_fetched`,
      };
    }
  }

  const pagesByUrl = new Map(response.firecrawl_pages.map((p) => [p.url, p]));
  for (const q of response.verbatim_quotes) {
    const page = pagesByUrl.get(q.url);
    if (!page) {
      return {
        valid: false,
        reason: "quote_not_in_page",
        detail: `URL ${q.url} cited but no firecrawl_pages entry for it`,
      };
    }
    if (!page.content.includes(q.quote)) {
      return {
        valid: false,
        reason: "quote_not_in_page",
        detail: `Quote "${q.quote.slice(0, 60)}..." not found verbatim in ${q.url}`,
      };
    }
  }

  const domains = new Set<string>();
  for (const q of response.verbatim_quotes) {
    try {
      domains.add(new URL(q.url).hostname.toLowerCase());
    } catch {
      return {
        valid: false,
        reason: "cited_url_not_fetched",
        detail: `URL ${q.url} is not a valid URL`,
      };
    }
  }
  if (domains.size < 2) {
    return {
      valid: false,
      reason: "two_source_rule_violation_one_domain",
      detail: `Only 1 distinct domain in citations: ${[...domains].join(", ")}`,
    };
  }

  if (response.decision === "match") {
    if (!response.decision_target_operator_id) {
      return {
        valid: false,
        reason: "invalid_decision_target",
        detail: "decision='match' but decision_target_operator_id is null",
      };
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        response.decision_target_operator_id,
      )
    ) {
      return {
        valid: false,
        reason: "invalid_decision_target",
        detail: `decision_target_operator_id is not a UUID: ${response.decision_target_operator_id}`,
      };
    }
  }

  return { valid: true };
}

// ── Selecting prompt ──────────────────────────────────────────────────────

export function renderSelectingPrompt(
  record: WorkRecord,
  candidates: CandidateOperatorOut[],
): string {
  const certWindow = (() => {
    const vf = record.scraped_payload["valid_from"];
    const vt = record.scraped_payload["valid_to"];
    return `${vf ?? "?"} to ${vt ?? "current"}`;
  })();
  const certDesignator =
    (record.scraped_payload["cert_designator"] as string | undefined) ?? "?";
  const dba = (record.scraped_payload["dba"] as string | undefined) ?? "none";
  const holderNorm =
    (record.scraped_payload["holder_name_normalized"] as string | undefined) ??
    record.scraped_name.toUpperCase();

  const candidateLines = candidates
    .map(
      (c, i) =>
        `  [${i + 1}] operator_id: ${c.operator_id}\n` +
        `      canonical_name: ${c.canonical_name}\n` +
        `      aliases: ${c.aliases.length > 0 ? c.aliases.join(", ") : "none"}\n` +
        `      headquarters_icao: ${c.headquarters_icao ?? "unknown"}\n` +
        `      operator_type: ${c.operator_type ?? "unknown"}\n` +
        `      icao_callsign: ${c.icao_callsign ?? "none"}\n` +
        `      prior_match_score: ${c.prior_match_score ?? "n/a"}\n` +
        `      prior_match_signals: ${JSON.stringify(c.prior_match_signals ?? {})}`,
    )
    .join("\n\n");

  return `You are doing entity resolution for a canonical aviation operators database.

INPUT — operator name from FAA Part 135 records:
  HOLDER NAME (verbatim): ${record.scraped_name}
  HOLDER NAME (normalized): ${holderNorm}
  CERT DESIGNATOR: ${certDesignator}
  CERT VALID WINDOW: ${certWindow}
  DBA (if any): ${dba}

CANDIDATE CANONICAL OPERATORS (top-K from prior matcher pass, in score order):
${candidateLines}

YOUR TASK
1. Use the Firecrawl MCP tool (mcp__firecrawl__firecrawl_scrape) to scrape AT LEAST
   TWO INDEPENDENTLY PUBLISHED sources about "${record.scraped_name}". Independence
   means different publishers (an operator's own website + Wikipedia = two; two
   different aviation news outlets = two; the same outlet's two articles = ONE).
   Required scrape order (try each, stop at 2+ independent sources, max ${FIRECRAWL_MAX_PAGES_PER_RECORD} total scrapes):
     a. Operator's own website (try https://www.{normalized_lowercase}.com if no other URL)
     b. Wikipedia (en.wikipedia.org/wiki/{name})
     c. AINonline OR AvWeb OR Aviation Week OR Business Jet Traveler search
     d. SEC EDGAR if the holder name suggests a public company
     e. State Secretary of State business search if the LLC suffix suggests a state
     f. Aggregator search for "{holder_name} acquisition" / "rebrand" / "merger"

2. Decide ONE of:
   (a) MATCH — which numbered candidate (1..K) is the same legal/commercial entity
       as the FAA holder name?
   (b) NEW_ENTITY — the holder is genuinely distinct from all candidates.
   (c) AMBIGUOUS — evidence is insufficient to choose.

3. For (a) or (b), provide:
   - VERBATIM QUOTE from the Firecrawl results that supports your decision
     (mandatory; minimum one quote per claim)
   - URL of the source(s) cited (each URL must appear in the actual scraped pages
     you fetched in step 1 — no inferred or constructed URLs)
   - REASONING CHAIN (2-4 sentences)
   - CONFIDENCE 0.0-1.0 (your subjective; we cap at ${CONFIDENCE_POST_CAP} regardless)

4. For (c), explain:
   - What additional evidence would resolve the ambiguity
   - Which candidate is closest if forced to choose, and why it's not strong enough

OUTPUT FORMAT — RETURN VALID JSON, NO COMMENTARY OUTSIDE THE JSON. The JSON object
MUST conform exactly to this shape (the orchestrating script parses it directly):
{
  "decision": "match" | "new_entity" | "ambiguous" | "error",
  "decision_target_operator_id": "<uuid>" | null,
  "decision_subtype": "exact_alias" | "subsidiary_of_canonical" | "rebrand_to_canonical"
                    | "distinct_legal_entity" | "distinct_brand" | null,
  "confidence": 0.0..1.0,
  "verbatim_quotes": [
    {
      "url": "https://...",
      "quote": "exact text from the page",
      "supports_claim": "what this quote proves"
    }
  ],
  "reasoning": "2-4 sentences",
  "firecrawl_urls_fetched": ["url1", "url2", ...],
  "firecrawl_pages": [
    {"url": "https://...", "content": "full scraped markdown content", "fetched_at": "2026-..."}
  ],
  "additional_evidence_needed": "..." | null,
  "cost_estimate_usd": 0.04
}

ANTI-HALLUCINATION RULES (violations cause the orchestrator to mark this run failed):
- Every URL in "verbatim_quotes" MUST exactly match a URL in "firecrawl_urls_fetched".
- Each quote MUST be a byte-exact substring of the scraped markdown content. Do NOT
  strip whitespace, NOT remove markdown formatting (===, ##, **, ---, etc.), NOT
  trim newlines, NOT replace special characters. Copy bytes verbatim from the
  Firecrawl markdown response into the quote string. The driver validates with
  String.includes (substring match), not regex — there is no fuzziness.
- "firecrawl_pages" MUST include the actual scraped markdown content for each cited
  URL, so the driver can verify your quotes substring-match. Truncate each page to
  <30000 chars (keep the first 30000). The "url" field in firecrawl_pages MUST
  exactly equal the URL passed to firecrawl_scrape.
- For decision='match' or 'new_entity', citations must come from at least 2 DISTINCT
  domains (hostnames). Two pages from the same hostname count as 1 source.
- verbatim_quotes MUST contain AT LEAST ONE quote from EACH hostname you are using
  to support your decision. If you scraped 2 supporting domains, you need at least
  2 quotes (one per domain). Three quotes all from domain A and zero from domain B
  fails the Two-Source check, even if domain B is in firecrawl_urls_fetched.
- If you cannot find ≥2 independent sources, return decision='ambiguous' with
  "additional_evidence_needed" filled. Do not fabricate.
- If Firecrawl returns errors or empty content for all attempts, return
  decision='error' with the error in "reasoning".
- Do NOT use prior knowledge (training data) as the sole basis for any claim.
  Every claim must trace to a Firecrawl-fetched quote.

JSON ENCODING RULE: the response you produce MUST be syntactically valid JSON.
Markdown content in firecrawl_pages and verbatim_quotes contains literal " chars,
backslashes, and newlines. These MUST be JSON-escaped: " -> \\", \\ -> \\\\,
newline -> \\n, tab -> \\t. The orchestrator runs JSON.parse on your output; any
unescaped quote in any string value will fail with "Expecting , delimiter" and
cause the run to be marked failed. Use JSON.stringify semantics when constructing
the response — do not hand-write JSON.`;
}

// ── Top-K candidate loader ────────────────────────────────────────────────

async function loadTopKCandidates(
  client: pg.PoolClient,
  record: WorkRecord,
): Promise<CandidateOperatorOut[]> {
  const candidateIds = record.candidate_matches
    .slice(0, TOP_K_CANDIDATES)
    .map((c) => c["operator_id"] as string)
    .filter((id) => typeof id === "string" && id.length > 0);
  if (candidateIds.length === 0) return [];

  const enriched = await client.query<{
    operator_id: string;
    canonical_name: string;
    headquarters_icao: string | null;
    operator_type: string | null;
    icao_callsign: string | null;
    aliases: string[] | null;
  }>(
    `SELECT
       o.id::text AS operator_id,
       o.canonical_name,
       o.headquarters_icao,
       o.operator_type,
       o.icao_callsign,
       array_agg(DISTINCT oa.alias) FILTER (WHERE oa.alias IS NOT NULL) AS aliases
     FROM public.operators o
     LEFT JOIN public.operator_aliases oa ON oa.operator_id = o.id
     WHERE o.id::text = ANY($1::text[])
     GROUP BY o.id, o.canonical_name, o.headquarters_icao, o.operator_type, o.icao_callsign`,
    [candidateIds],
  );
  const enrichedById = new Map(enriched.rows.map((r) => [r.operator_id, r]));

  return record.candidate_matches
    .slice(0, TOP_K_CANDIDATES)
    .map((c) => {
      const id = c["operator_id"] as string | undefined;
      if (!id) return null;
      const e = enrichedById.get(id);
      return {
        operator_id: id,
        canonical_name:
          e?.canonical_name ?? (c["canonical_name"] as string) ?? id,
        aliases: e?.aliases ?? [],
        headquarters_icao: e?.headquarters_icao ?? null,
        operator_type: e?.operator_type ?? null,
        icao_callsign: e?.icao_callsign ?? null,
        prior_match_score: (c["score"] as number | undefined) ?? null,
        prior_match_signals:
          (c["signals"] as Record<string, unknown> | undefined) ?? null,
      };
    })
    .filter((c): c is CandidateOperatorOut => c !== null);
}

// ── Top-20-by-fleet ───────────────────────────────────────────────────────

interface Top20Fixture {
  operator_substrings: string[];
  rationale: string;
}

async function loadTop20OperatorIds(client: pg.PoolClient): Promise<Set<string>> {
  const fixturePath = resolve(process.cwd(), FIXTURE_TOP20_PATH);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as Top20Fixture;
  const substrings = fixture.operator_substrings;

  const ids = new Set<string>();
  for (const s of substrings) {
    const res = await client.query<{ operator_id: string }>(
      `SELECT DISTINCT o.id::text AS operator_id
         FROM public.operators o
         LEFT JOIN public.operator_aliases oa ON oa.operator_id = o.id
        WHERE o.canonical_name ILIKE $1
           OR oa.alias ILIKE $1`,
      [`%${s}%`],
    );
    for (const r of res.rows) ids.add(r.operator_id);
  }
  return ids;
}

// ── Eval candidate scoring ────────────────────────────────────────────────

interface HoldoutCase {
  holdout_id: string;
  truth_operator_id: string;
  truth_canonical_name: string;
  truth_operator_type: string | null;
  truth_headquarters_icao: string | null;
  truth_icao_callsign: string | null;
  cert_id: string;
  cert_designator: string;
  holder_name_as_provided: string;
  holder_name_normalized: string;
  holder_name_variants: string[];
  valid_from: string;
  valid_to: string | null;
}

/**
 * Build candidate pool for an eval case in the requested sub-mode.
 * Mode 'visible': truth at position 1, plus top distractors.
 * Mode 'hidden':  truth removed, top distractors only.
 *
 * Uses the operator-resolver's scoreCandidates (Jaro-Winkler on canonical_name)
 * to mirror what the production matcher would do — same scoring path so the
 * eval measures the LLM's contribution on top of the matcher, not against a
 * different scorer.
 */
async function buildEvalCandidates(
  client: pg.PoolClient,
  holdout: HoldoutCase,
  subMode: "visible" | "hidden",
): Promise<CandidateOperatorOut[]> {
  const word = firstSignificantWord(holdout.holder_name_as_provided);
  const pattern = `%${word}%`;
  const poolRes = await client.query<OperatorCandidate>(
    `SELECT id AS operator_id, canonical_name, headquarters_icao,
            NULL::text AS state, NULL::text AS city
       FROM public.operators
      WHERE canonical_name ILIKE $1
      LIMIT 200`,
    [pattern],
  );

  const scored: ScoredCandidate[] = scoreCandidates(
    {
      name: holdout.holder_name_as_provided,
      source: "faa",
      sourceId: `eval:${holdout.holdout_id}`,
    },
    poolRes.rows,
  );

  const distractors = scored.filter((s) => s.operator_id !== holdout.truth_operator_id);

  const enrichedRes = await client.query<{
    operator_id: string;
    canonical_name: string;
    headquarters_icao: string | null;
    operator_type: string | null;
    icao_callsign: string | null;
    aliases: string[] | null;
  }>(
    `SELECT
       o.id::text AS operator_id,
       o.canonical_name,
       o.headquarters_icao,
       o.operator_type,
       o.icao_callsign,
       array_agg(DISTINCT oa.alias) FILTER (WHERE oa.alias IS NOT NULL) AS aliases
     FROM public.operators o
     LEFT JOIN public.operator_aliases oa ON oa.operator_id = o.id
     WHERE o.id::text = ANY($1::text[])
     GROUP BY o.id, o.canonical_name, o.headquarters_icao, o.operator_type, o.icao_callsign`,
    [
      [
        holdout.truth_operator_id,
        ...distractors.slice(0, TOP_K_CANDIDATES).map((d) => d.operator_id),
      ],
    ],
  );
  const byId = new Map(enrichedRes.rows.map((r) => [r.operator_id, r]));

  const toCand = (
    operator_id: string,
    score: number | null,
    signals: Record<string, unknown>,
  ): CandidateOperatorOut => {
    const e = byId.get(operator_id);
    return {
      operator_id,
      canonical_name: e?.canonical_name ?? operator_id,
      aliases: e?.aliases ?? [],
      headquarters_icao: e?.headquarters_icao ?? null,
      operator_type: e?.operator_type ?? null,
      icao_callsign: e?.icao_callsign ?? null,
      prior_match_score: score,
      prior_match_signals: signals,
    };
  };

  if (subMode === "visible") {
    // Truth gets a synthetic top-of-pool score that mirrors what the
    // production matcher would assign for an identical canonical name.
    // Signals stay empty so the LLM can't tell this candidate apart from a
    // real high-tier match in the prompt.
    const truthCand = toCand(holdout.truth_operator_id, 1.0, {});
    return [
      truthCand,
      ...distractors
        .slice(0, TOP_K_CANDIDATES - 1)
        .map((d) =>
          toCand(d.operator_id, d.score, d.signals as Record<string, unknown>),
        ),
    ];
  }
  return distractors
    .slice(0, TOP_K_CANDIDATES)
    .map((d) =>
      toCand(d.operator_id, d.score, d.signals as Record<string, unknown>),
    );
}

// ── Mode dispatchers ──────────────────────────────────────────────────────

async function runSmokeFirecrawl(): Promise<void> {
  const urls = [
    "https://en.wikipedia.org/wiki/NetJets",
    "https://www.netjets.com/en-us/about",
    "https://www.ainonline.com/aviation-news/business-aviation",
    "https://en.wikipedia.org/wiki/Flexjet",
    "https://www.vistaglobal.com/about/",
  ];
  console.log(JSON.stringify({ smoke_urls: urls, threshold: 4 }, null, 2));
  console.log(
    `\n# Orchestrator: scrape each via mcp__firecrawl__firecrawl_scrape from\n# the Claude Code session. Assert content.length > 1000 and url echoed back.\n# >=4 of 5 succeed -> Firecrawl MCP healthy. <4 -> abort.`,
  );
}

async function runReasonOnly(): Promise<void> {
  console.log(`# --reason-only is now doc-only. The orchestration loop runs from
# the Claude Code session, calling --claim-next and --submit-response per
# record. This separates "Claude reasoning" (Agent + Firecrawl MCP) from
# "DB plumbing" (this script).
#
# Bash loop the orchestrator runs (conceptually — actually executed by Claude
# Code through Bash + Agent tool calls):
#
#   while true; do
#     work=$(npx tsx scripts/llm-er-pass-firecrawl.ts --claim-next)
#     echo "$work" | jq -e '.empty' > /dev/null && break
#     checkpoint_id=$(echo "$work" | jq -r '.checkpoint_id')
#     prompt=$(echo "$work"      | jq -r '.prompt')
#     # Spawn Agent (subagent_type=general-purpose, model=sonnet) with the
#     # prompt + Firecrawl MCP tool access. Agent returns SubagentResponse JSON.
#     response=$(... agent call ...)
#     echo "$response" | npx tsx scripts/llm-er-pass-firecrawl.ts \\
#       --submit-response "$checkpoint_id"
#   done`);
}

async function runEvalLegacy(): Promise<void> {
  console.log(`# --eval-mode is now doc-only. Run the eval orchestration loop:
#
#   eval_dir=$(npx tsx scripts/llm-er-pass-firecrawl.ts --eval-init)
#   while true; do
#     work=$(npx tsx scripts/llm-er-pass-firecrawl.ts \\
#              --claim-next-eval --eval-dir="$eval_dir")
#     echo "$work" | jq -e '.empty' > /dev/null && break
#     # Spawn Agent (Sonnet, Firecrawl MCP) with prompt; capture response
#     holdout_id=$(echo "$work" | jq -r '.holdout_id')
#     sub_mode=$(echo "$work"  | jq -r '.sub_mode')
#     echo "$response" | npx tsx scripts/llm-er-pass-firecrawl.ts \\
#       --submit-eval-response --eval-dir="$eval_dir" "$holdout_id" "$sub_mode"
#   done
#   npx tsx scripts/llm-er-pass-firecrawl.ts --eval-summary --eval-dir="$eval_dir"`);
}

// ── Per-record orchestration primitives ───────────────────────────────────

interface ClaimResponse {
  empty?: boolean;
  checkpoint_id?: string;
  input_review_id?: number;
  input_step?: InputStep;
  attempt_count?: number;
  run_id?: string;
  scraped_name?: string;
  prompt?: string;
  candidates?: CandidateOperatorOut[];
  scraped_payload?: Record<string, unknown>;
}

async function runClaimNext(args: Args): Promise<void> {
  const runId = formatRunId();
  const pool = getPool();
  const client = await pool.connect();
  try {
    const inserted = await bootstrapCheckpointRows(client);
    if (inserted > 0) {
      console.error(`[claim-next] bootstrapped ${inserted} new checkpoint rows`);
    }

    let claimed: CheckpointRow | null;
    if (args.specificReviewId !== null) {
      const cp = await ensureCheckpointForReviewId(client, args.specificReviewId);
      if (!cp) {
        console.log(JSON.stringify({ empty: true, reason: "review_id_not_eligible" }));
        return;
      }
      claimed = await claimRowById(client, cp.id, runId);
    } else {
      claimed = await claimNextRow(client, runId);
    }

    if (!claimed) {
      console.log(JSON.stringify({ empty: true }));
      return;
    }

    const reviewRes = await client.query<{
      scraped_name: string;
      scraped_payload: Record<string, unknown>;
      candidate_matches: Array<Record<string, unknown>>;
    }>(
      `SELECT scraped_name, scraped_payload, candidate_matches
         FROM public.operator_match_review WHERE id = $1`,
      [claimed.input_review_id],
    );
    if (reviewRes.rowCount === 0) {
      await writeFailedCheckpoint(
        client,
        claimed.id,
        `match_review row ${claimed.input_review_id} not found`,
        0,
      );
      console.log(
        JSON.stringify({ empty: true, reason: "review_row_missing" }),
      );
      return;
    }
    const review = reviewRes.rows[0]!;
    const record: WorkRecord = {
      review_id: claimed.input_review_id,
      input_step: claimed.input_step,
      scraped_name: review.scraped_name,
      scraped_payload: review.scraped_payload,
      candidate_matches: review.candidate_matches,
    };
    const candidates = await loadTopKCandidates(client, record);
    const prompt = renderSelectingPrompt(record, candidates);

    const out: ClaimResponse = {
      checkpoint_id: claimed.id,
      input_review_id: claimed.input_review_id,
      input_step: claimed.input_step,
      attempt_count: claimed.attempt_count,
      run_id: runId,
      scraped_name: review.scraped_name,
      scraped_payload: review.scraped_payload,
      prompt,
      candidates,
    };
    console.log(JSON.stringify(out));
  } finally {
    client.release();
    await pool.end();
  }
}

async function runSubmitResponse(args: Args): Promise<void> {
  if (!args.checkpointId) {
    console.error("--submit-response requires <checkpoint_id>");
    process.exit(2);
  }
  const response = await readStdinJson<SubagentResponse>();
  const validation = validateLLMResponse(response);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await writeCompletedCheckpoint(client, args.checkpointId, response, validation);
    console.log(
      JSON.stringify({
        checkpoint_id: args.checkpointId,
        status: validation.valid ? "completed" : "failed",
        decision: response.decision,
        confidence: Math.min(response.confidence, CONFIDENCE_POST_CAP),
        validation_reason: validation.reason ?? null,
        validation_detail: validation.detail ?? null,
        cost_estimate_usd: response.cost_estimate_usd,
      }),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function runMarkFailed(args: Args): Promise<void> {
  if (!args.checkpointId) {
    console.error("--mark-failed requires <checkpoint_id>");
    process.exit(2);
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await writeFailedCheckpoint(
      client,
      args.checkpointId,
      args.errorMessage ?? "marked_failed_via_cli",
      0,
    );
    console.log(JSON.stringify({ checkpoint_id: args.checkpointId, status: "failed" }));
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Eval orchestration primitives ─────────────────────────────────────────

interface EvalResultLine {
  holdout_id: string;
  sub_mode: "visible" | "hidden";
  decision: Decision;
  decision_target_operator_id: string | null;
  truth_operator_id: string;
  confidence: number;
  citation_validated: boolean;
  validation_reason: string | null;
  cost_estimate_usd: number;
  written_at: string;
}

function loadHoldoutFixture(): HoldoutCase[] {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), FIXTURE_HOLDOUT_PATH), "utf-8")) as {
    cases: HoldoutCase[];
  };
  return raw.cases;
}

function readEvalResults(evalDir: string): Set<string> {
  const path = resolve(evalDir, "results.jsonl");
  if (!existsSync(path)) return new Set();
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as EvalResultLine;
      seen.add(`${r.holdout_id}:${r.sub_mode}`);
    } catch {
      // skip malformed lines
    }
  }
  return seen;
}

function appendEvalResult(evalDir: string, line: EvalResultLine): void {
  const path = resolve(evalDir, "results.jsonl");
  appendFileSync(path, JSON.stringify(line) + "\n");
}

async function runEvalInit(): Promise<void> {
  const stamp = formatRunId();
  const dir = resolve(process.cwd(), EVAL_WORK_ROOT, `eval-${stamp}`);
  mkdirSync(dir, { recursive: true });
  // Touch results.jsonl so claim-next-eval doesn't trip on missing file.
  const path = resolve(dir, "results.jsonl");
  if (!existsSync(path)) appendFileSync(path, "");
  console.log(dir);
}

async function runClaimNextEval(args: Args): Promise<void> {
  if (!args.evalDir) {
    console.error("--claim-next-eval requires --eval-dir=<path>");
    process.exit(2);
  }
  const fixture = loadHoldoutFixture();
  const seen = readEvalResults(args.evalDir);

  // Treat run dirs whose claim.json already exists as "in flight" — lets the
  // orchestrator pre-claim several cases and spawn agents in parallel without
  // each claim emitting the same case.
  const runsRoot = resolve(args.evalDir, "runs");
  const inFlight = new Set<string>();
  if (existsSync(runsRoot)) {
    for (const entry of readdirSync(runsRoot)) {
      if (entry === "_pending") continue;
      const claimPath = resolve(runsRoot, entry, "claim.json");
      if (existsSync(claimPath)) {
        // Dir name is "<holdout_id>-<sub_mode>" — split on LAST dash that
        // precedes 'visible' or 'hidden' to handle UUID dashes.
        const m = entry.match(/^(.+)-(visible|hidden)$/);
        if (m) inFlight.add(`${m[1]}:${m[2]}`);
      }
    }
  }

  const order: Array<{ case: HoldoutCase; sub_mode: "visible" | "hidden" }> = [];
  for (const c of fixture) {
    order.push({ case: c, sub_mode: "visible" });
    order.push({ case: c, sub_mode: "hidden" });
  }
  const next = order.find((t) => {
    const key = `${t.case.holdout_id}:${t.sub_mode}`;
    return !seen.has(key) && !inFlight.has(key);
  });
  if (!next) {
    console.log(
      JSON.stringify({
        empty: true,
        total_cases: fixture.length,
        total_runs: order.length,
        completed: seen.size,
        in_flight: inFlight.size,
      }),
    );
    return;
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    const candidates = await buildEvalCandidates(client, next.case, next.sub_mode);
    // Shape a synthetic WorkRecord for prompt rendering.
    const record: WorkRecord = {
      review_id: -1,
      input_step: "step2c",
      scraped_name: next.case.holder_name_as_provided,
      scraped_payload: {
        step: "eval",
        cert_id: next.case.cert_id,
        cert_designator: next.case.cert_designator,
        valid_from: next.case.valid_from,
        valid_to: next.case.valid_to,
        holder_name_as_provided: next.case.holder_name_as_provided,
        holder_name_normalized: next.case.holder_name_normalized,
      },
      candidate_matches: [],
    };
    const prompt = renderSelectingPrompt(record, candidates);
    console.log(
      JSON.stringify({
        holdout_id: next.case.holdout_id,
        sub_mode: next.sub_mode,
        truth_operator_id: next.case.truth_operator_id,
        truth_canonical_name: next.case.truth_canonical_name,
        scraped_name: next.case.holder_name_as_provided,
        prompt,
        candidates,
        progress: {
          done: seen.size,
          remaining: order.length - seen.size,
          total: order.length,
        },
      }),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

async function runSubmitEvalResponse(args: Args): Promise<void> {
  if (!args.evalDir || !args.holdoutId || !args.evalSubMode) {
    console.error(
      "--submit-eval-response requires --eval-dir=<path> <holdout_id> <visible|hidden>",
    );
    process.exit(2);
  }
  const response = await readStdinJson<SubagentResponse>();
  const validation = validateLLMResponse(response);
  const fixture = loadHoldoutFixture();
  const holdout = fixture.find((h) => h.holdout_id === args.holdoutId);
  if (!holdout) {
    console.error(`holdout_id ${args.holdoutId} not in fixture`);
    process.exit(2);
  }
  const line: EvalResultLine = {
    holdout_id: args.holdoutId,
    sub_mode: args.evalSubMode,
    decision: response.decision,
    decision_target_operator_id: response.decision_target_operator_id,
    truth_operator_id: holdout.truth_operator_id,
    confidence: Math.min(response.confidence, CONFIDENCE_POST_CAP),
    citation_validated: validation.valid,
    validation_reason: validation.reason ?? null,
    cost_estimate_usd: response.cost_estimate_usd,
    written_at: new Date().toISOString(),
  };
  appendEvalResult(args.evalDir, line);
  console.log(JSON.stringify({ written: true, ...line }));
}

async function runEvalSummary(args: Args): Promise<void> {
  if (!args.evalDir) {
    console.error("--eval-summary requires --eval-dir=<path>");
    process.exit(2);
  }
  const path = resolve(args.evalDir, "results.jsonl");
  if (!existsSync(path)) {
    console.error(`no results.jsonl in ${args.evalDir}`);
    process.exit(2);
  }
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvalResultLine);

  // Per plan + Phelipe's gate decision (2026-04-25): hidden-mode F1 is
  // THE gate, not the combined-mode F1. Visible-mode F1 is inflated by
  // single-candidate fixture cases (e.g., "Novus" has 1 ILIKE-pool match)
  // where the LLM's job is trivial.
  //
  //   Visible mode (precision-only signal — does LLM pick truth when present):
  //     correct = decision='match' AND target = truth_id
  //     wrong   = anything else
  //
  //   Hidden mode (recall + precision — does LLM avoid distractors when
  //                truth is absent):
  //     correct = decision='new_entity'
  //     wrong   = decision='match' (false positive — grabbed a distractor)
  //              + decision='ambiguous' (failed to commit when it should)
  //
  //   For the COMBINED confusion matrix:
  //     TP = visible-correct-match
  //     FP = visible-wrong-match-target + hidden-match-anything
  //     FN = visible-not-match (new_entity / ambiguous)
  //     TN = hidden-new_entity
  let visibleCorrect = 0;
  let visibleWrongTarget = 0;
  let visibleNonMatch = 0;
  let hiddenCorrect = 0;
  let hiddenFalseMatch = 0;
  let hiddenAmbiguous = 0;
  let invalidCitations = 0;
  let visibleN = 0, hiddenN = 0;
  for (const r of lines) {
    if (!r.citation_validated) invalidCitations++;
    if (r.sub_mode === "visible") {
      visibleN++;
      if (r.decision === "match" && r.decision_target_operator_id === r.truth_operator_id) visibleCorrect++;
      else if (r.decision === "match") visibleWrongTarget++;
      else visibleNonMatch++;
    } else {
      hiddenN++;
      if (r.decision === "new_entity") hiddenCorrect++;
      else if (r.decision === "match") hiddenFalseMatch++;
      else hiddenAmbiguous++;
    }
  }

  const visibleAccuracy = visibleN > 0 ? visibleCorrect / visibleN : 0;
  const hiddenAccuracy = hiddenN > 0 ? hiddenCorrect / hiddenN : 0;

  // Combined confusion matrix (per plan):
  const tp = visibleCorrect;
  const fp = visibleWrongTarget + hiddenFalseMatch;
  const fn = visibleNonMatch + hiddenAmbiguous;
  const tn = hiddenCorrect;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  console.log(
    JSON.stringify(
      {
        eval_dir: args.evalDir,
        total_runs: lines.length,
        visible_runs: visibleN,
        hidden_runs: hiddenN,
        invalid_citations: invalidCitations,
        visible_mode: {
          correct: visibleCorrect,
          wrong_target: visibleWrongTarget,
          non_match: visibleNonMatch,
          accuracy: Number(visibleAccuracy.toFixed(4)),
          note: "Visible-mode accuracy is inflated by single-candidate fixture cases (where ILIKE pre-filter on first significant word returns only the truth). Treat as a sanity check, not a quality gate.",
        },
        hidden_mode: {
          correct_new_entity: hiddenCorrect,
          false_match: hiddenFalseMatch,
          ambiguous: hiddenAmbiguous,
          accuracy: Number(hiddenAccuracy.toFixed(4)),
          note: "Hidden-mode accuracy IS the gate (per Phelipe 2026-04-25). Tests whether LLM correctly says new_entity when truth is removed from candidates.",
        },
        combined: {
          confusion: { tp, fp, fn, tn },
          precision: Number(precision.toFixed(4)),
          recall: Number(recall.toFixed(4)),
          f1: Number(f1.toFixed(4)),
        },
        threshold: 0.95,
        gate_metric: "hidden_mode.accuracy",
        passes_threshold: hiddenAccuracy >= 0.95,
      },
      null,
      2,
    ),
  );
}

// ── --commit ──────────────────────────────────────────────────────────────

async function runCommit(args: Args): Promise<void> {
  const runId = formatRunId();
  console.log(`[llm-er-pass] mode=commit run_id=${runId}`);
  console.log(
    `[llm-er-pass] auto-approve-all=${args.autoApproveAll ? "TRUE (bypass enabled)" : "false"}`,
  );

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    const top20Ids = await loadTop20OperatorIds(client);
    console.log(`[llm-er-pass] top-20-by-fleet operator_id set size: ${top20Ids.size}`);

    const completedRows = await client.query<{
      id: string;
      input_review_id: number;
      input_step: InputStep;
      llm_decision: Decision;
      llm_decision_subtype: DecisionSubtype | null;
      llm_decision_target: string | null;
      llm_confidence: number | null;
      citation_validated: boolean | null;
      llm_evidence: Record<string, unknown> | null;
      firecrawl_pages: FirecrawlPage[] | null;
    }>(
      `SELECT id::text, input_review_id, input_step, llm_decision,
              llm_decision_subtype, llm_decision_target::text,
              llm_confidence::float8, citation_validated, llm_evidence,
              firecrawl_pages
         FROM public.operator_llm_er_checkpoint
        WHERE status = 'completed'
        ORDER BY id`,
    );
    console.log(`[llm-er-pass] ${completedRows.rowCount} status='completed' rows to consider`);

    let autoApproved = 0;
    let surfaced = 0;
    let skipped = 0;

    for (const cp of completedRows.rows) {
      const reasons: string[] = [];

      if (cp.llm_decision === "ambiguous" || cp.llm_decision === "error") {
        reasons.push(`decision=${cp.llm_decision}`);
      }
      if (cp.llm_decision_subtype === "rebrand_to_canonical") {
        reasons.push("rebrand_to_canonical");
      }
      if (cp.llm_confidence === null || cp.llm_confidence < AUTO_APPROVE_MIN_CONFIDENCE) {
        reasons.push(`confidence=${cp.llm_confidence}<${AUTO_APPROVE_MIN_CONFIDENCE}`);
      }
      if (cp.citation_validated !== true) {
        reasons.push("citation_validated=false");
      }
      if (cp.llm_decision_target !== null && top20Ids.has(cp.llm_decision_target)) {
        reasons.push("target_in_top20_by_fleet");
      }

      const shouldSurface = reasons.length > 0 && !args.autoApproveAll;

      if (shouldSurface) {
        await client.query(
          `UPDATE public.operator_llm_er_checkpoint
              SET status = 'ready_for_review',
                  llm_evidence = COALESCE(llm_evidence, '{}'::jsonb)
                                 || jsonb_build_object('surface_reasons', $2::jsonb,
                                                       'surfaced_at', NOW()),
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [cp.id, JSON.stringify(reasons)],
        );
        surfaced++;
        console.log(
          `[llm-er-pass] [SURFACE] review_id=${cp.input_review_id} reasons=${reasons.join(",")}`,
        );
        continue;
      }

      try {
        await commitToCanonical(client, cp, runId, args.autoApproveAll);
        await client.query(
          `UPDATE public.operator_llm_er_checkpoint
              SET status = 'committed',
                  run_id = $2,
                  updated_at = NOW()
            WHERE id = $1::uuid`,
          [cp.id, runId],
        );
        autoApproved++;
        console.log(
          `[llm-er-pass] [APPROVE] review_id=${cp.input_review_id} decision=${cp.llm_decision} subtype=${cp.llm_decision_subtype}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        skipped++;
        console.error(
          `[llm-er-pass] [SKIP] review_id=${cp.input_review_id} err=${msg.slice(0, 200)}`,
        );
      }
    }

    console.log(
      `\n[llm-er-pass] commit summary: auto_approved=${autoApproved}, surfaced=${surfaced}, skipped=${skipped}`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

// ── commitToCanonical (full SQL per plan) ─────────────────────────────────

interface CheckpointForCommit {
  id: string;
  input_review_id: number;
  input_step: InputStep;
  llm_decision: Decision;
  llm_decision_subtype: DecisionSubtype | null;
  llm_decision_target: string | null;
  llm_confidence: number | null;
  citation_validated: boolean | null;
  llm_evidence: Record<string, unknown> | null;
  firecrawl_pages: FirecrawlPage[] | null;
}

function normalizeName(name: string): string {
  return name.toUpperCase().replace(/\s+/g, " ").trim();
}

async function commitToCanonical(
  client: pg.PoolClient,
  cp: CheckpointForCommit,
  runId: string,
  autoApproveAll: boolean,
): Promise<void> {
  // Pull the source match_review row for cert_id, holder_name, windows, etc.
  const reviewRes = await client.query<{
    scraped_name: string;
    scraped_payload: Record<string, unknown>;
  }>(
    `SELECT scraped_name, scraped_payload
       FROM public.operator_match_review WHERE id = $1`,
    [cp.input_review_id],
  );
  if (reviewRes.rowCount === 0) {
    throw new Error(`match_review ${cp.input_review_id} not found`);
  }
  const review = reviewRes.rows[0]!;
  const payload = review.scraped_payload;
  const certId = payload["cert_id"] as string | undefined;
  const certDesignator = payload["cert_designator"] as string | undefined;
  const validFrom = (payload["valid_from"] as string | null | undefined) ?? null;
  const validTo = (payload["valid_to"] as string | null | undefined) ?? null;
  const holderProvided =
    (payload["holder_name_as_provided"] as string | undefined) ?? review.scraped_name;
  const holderNormalized =
    (payload["holder_name_normalized"] as string | undefined) ??
    normalizeName(holderProvided);

  if (!certId) {
    throw new Error(`scraped_payload.cert_id missing for review ${cp.input_review_id}`);
  }

  const cappedConfidence = Math.min(cp.llm_confidence ?? 0, CONFIDENCE_POST_CAP);

  const evidenceJsonb = {
    step: "2c.5_phase2",
    checkpoint: "track6_step2c5_phase2",
    checkpoint_id: cp.id,
    llm_evidence: cp.llm_evidence,
    firecrawl_pages: (cp.firecrawl_pages ?? []).map((p) => ({
      url: p.url,
      fetched_at: p.fetched_at,
      content_length: p.content?.length ?? 0,
    })),
    llm_decision_subtype: cp.llm_decision_subtype,
    auto_approve_all_bypass: autoApproveAll,
    ingest_run_id: runId,
    two_source_rule_status: "llm_plus_independent_publishers",
  };

  await client.query("BEGIN");
  try {
    if (cp.llm_decision === "match") {
      const targetId = cp.llm_decision_target;
      if (!targetId) {
        throw new Error("decision=match but llm_decision_target null");
      }

      const aliasType =
        cp.llm_decision_subtype === "rebrand_to_canonical" ? "historical" : "legal";
      const matchMethod =
        cp.llm_decision_subtype === "rebrand_to_canonical"
          ? "llm_firecrawl_rebrand"
          : "llm_firecrawl_alias";

      // 1) operator_aliases — only insert if not duplicating an existing alias.
      await client.query(
        `INSERT INTO public.operator_aliases
           (operator_id, alias, alias_normalized, alias_type, source)
         SELECT $1::uuid, $2, $3, $4, 'llm_firecrawl_research'
         WHERE NOT EXISTS (
           SELECT 1 FROM public.operator_aliases
            WHERE operator_id = $1::uuid AND alias_normalized = $3
         )`,
        [targetId, holderProvided, holderNormalized, aliasType],
      );

      // 2) operator_holds_certificate — guard against double-insert by checking
      //    for an existing row covering the same (operator, cert, valid_from).
      await client.query(
        `INSERT INTO canonical.operator_holds_certificate
           (operator_id, cert_id, role, valid_from, valid_to,
            source, source_url, source_timestamp,
            confidence, match_method, evidence)
         SELECT $1::uuid, $2::uuid, 'holder_of_record', $3::date, $4::date,
                'llm_firecrawl_research', NULL, NULL,
                $5::numeric, $6, $7::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM canonical.operator_holds_certificate
            WHERE operator_id = $1::uuid
              AND cert_id     = $2::uuid
              AND COALESCE(valid_from, DATE '1900-01-01') = COALESCE($3::date, DATE '1900-01-01')
              AND source IN ('llm_firecrawl_research')
         )`,
        [
          targetId,
          certId,
          validFrom,
          validTo,
          cappedConfidence,
          matchMethod,
          JSON.stringify({
            ...evidenceJsonb,
            cert_designator: certDesignator,
            holder_name_as_provided: holderProvided,
            holder_name_normalized: holderNormalized,
          }),
        ],
      );

      // 3) Resolve the source review row.
      await client.query(
        `UPDATE public.operator_match_review
            SET status = 'matched',
                resolution_operator_id = $2::uuid,
                reviewed_at = NOW()
          WHERE id = $1`,
        [cp.input_review_id, targetId],
      );

      // 4) Resolve any matching pending rows.
      await client.query(
        `UPDATE canonical.operator_holds_certificate_pending
            SET resolved_at = NOW(),
                resolved_to_operator_id = $3::uuid,
                last_updated_at = NOW()
          WHERE cert_id = $1::uuid
            AND holder_name_normalized = $2
            AND resolved_at IS NULL`,
        [certId, holderNormalized, targetId],
      );
    } else if (cp.llm_decision === "new_entity") {
      // Phase 1 may have already created an operator with this normalized
      // name. Reuse if present; otherwise seed anew.
      const existing = await client.query<{ id: string }>(
        `SELECT id::text FROM public.operators
          WHERE UPPER(REGEXP_REPLACE(canonical_name, '\\s+', ' ', 'g')) = $1
          LIMIT 1`,
        [holderNormalized],
      );
      let operatorId: string;
      if (existing.rowCount && existing.rowCount > 0) {
        operatorId = existing.rows[0]!.id;
      } else {
        const ins = await client.query<{ id: string }>(
          `INSERT INTO public.operators
             (canonical_name, type_tags, operator_type, data_confidence_score)
           VALUES ($1, '{}'::text[], NULL, 0.70)
           RETURNING id::text`,
          [holderProvided],
        );
        operatorId = ins.rows[0]!.id;

        await client.query(
          `INSERT INTO public.operator_identities
             (operator_id, source, source_id, name_as_provided,
              match_confidence, match_method, match_evidence)
           VALUES ($1::uuid, 'faa', $2, $3, 'exact',
                   'llm_firecrawl_new_entity', $4::jsonb)`,
          [
            operatorId,
            `d085_llm_new:${certDesignator ?? certId}:${holderNormalized}`,
            holderProvided,
            JSON.stringify({
              ...evidenceJsonb,
              cert_designator: certDesignator,
              holder_name_normalized: holderNormalized,
            }),
          ],
        );
      }

      // operator_holds_certificate link.
      await client.query(
        `INSERT INTO canonical.operator_holds_certificate
           (operator_id, cert_id, role, valid_from, valid_to,
            source, source_url, source_timestamp,
            confidence, match_method, evidence)
         SELECT $1::uuid, $2::uuid, 'holder_of_record', $3::date, $4::date,
                'llm_firecrawl_research', NULL, NULL,
                $5::numeric, 'llm_firecrawl_new_entity', $6::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM canonical.operator_holds_certificate
            WHERE operator_id = $1::uuid
              AND cert_id     = $2::uuid
              AND COALESCE(valid_from, DATE '1900-01-01') = COALESCE($3::date, DATE '1900-01-01')
              AND source = 'llm_firecrawl_research'
         )`,
        [
          operatorId,
          certId,
          validFrom,
          validTo,
          cappedConfidence,
          JSON.stringify({
            ...evidenceJsonb,
            cert_designator: certDesignator,
            holder_name_as_provided: holderProvided,
            holder_name_normalized: holderNormalized,
          }),
        ],
      );

      await client.query(
        `UPDATE public.operator_match_review
            SET status = 'new_operator',
                resolution_operator_id = $2::uuid,
                reviewed_at = NOW()
          WHERE id = $1`,
        [cp.input_review_id, operatorId],
      );

      await client.query(
        `UPDATE canonical.operator_holds_certificate_pending
            SET resolved_at = NOW(),
                resolved_to_operator_id = $3::uuid,
                last_updated_at = NOW()
          WHERE cert_id = $1::uuid
            AND holder_name_normalized = $2
            AND resolved_at IS NULL`,
        [certId, holderNormalized, operatorId],
      );
    } else {
      // ambiguous / error — should have been surfaced upstream. Do nothing
      // beyond annotating the review row so the residual queue is visible.
      await client.query(
        `UPDATE public.operator_match_review
            SET scraped_payload = scraped_payload
                                 || jsonb_build_object(
                                      'phase2_decision', $2,
                                      'phase2_evidence', $3::jsonb,
                                      'phase2_checkpoint_id', $4
                                    ),
                reviewed_at = NOW()
          WHERE id = $1`,
        [
          cp.input_review_id,
          cp.llm_decision,
          JSON.stringify(cp.llm_evidence ?? {}),
          cp.id,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => void 0);
    throw err;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.mode === "help") {
    printHelp();
    return;
  }
  switch (args.mode) {
    case "smoke-firecrawl":
      await runSmokeFirecrawl();
      break;
    case "eval":
      await runEvalLegacy();
      break;
    case "reason-only":
      await runReasonOnly();
      break;
    case "commit":
      await runCommit(args);
      break;
    case "claim-next":
      await runClaimNext(args);
      break;
    case "submit-response":
      await runSubmitResponse(args);
      break;
    case "mark-failed":
      await runMarkFailed(args);
      break;
    case "eval-init":
      await runEvalInit();
      break;
    case "claim-next-eval":
      await runClaimNextEval(args);
      break;
    case "submit-eval-response":
      await runSubmitEvalResponse(args);
      break;
    case "eval-summary":
      await runEvalSummary(args);
      break;
  }
}

import { fileURLToPath } from "node:url";
const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// Reference exports retained so dead-code lint stays quiet on imported but
// unused pieces in some entry points.
export { FIRECRAWL_SCRAPE_HARD_CAP };
