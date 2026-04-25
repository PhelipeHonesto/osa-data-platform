/**
 * Track 6 Step 2c.5 Phase 2 — LLM-augmented entity resolution driver.
 *
 * SCAFFOLDING ONLY (this commit). Subagent invocation is stubbed; eval +
 * reasoning + commit are wired but rely on the stub. Next-session work:
 *   1. Run --smoke-firecrawl after Firecrawl MCP install lands
 *   2. Wire invokeSubagent() to the Agent tool with Firecrawl MCP access
 *   3. Run --eval-mode against scripts/fixtures/llm-eval-holdout-30.json,
 *      iterate selecting prompt to F1 ≥ 0.95
 *   4. Run --reason-only against the full work queue (~451 records)
 *   5. Human review of status='ready_for_review' rows
 *   6. Run --commit to land canonical writes
 *
 * ── Architecture ─────────────────────────────────────────────────────────
 *
 *   loadWorkQueue ──> claimNextRow (SELECT FOR UPDATE SKIP LOCKED)
 *                          │
 *                          ▼
 *                    invokeSubagent (stub) ── Firecrawl MCP scrape ──┐
 *                          │                                         │
 *                          ▼                                         ▼
 *                    validateLLMResponse                   firecrawl_pages
 *                          │
 *                ┌─────────┴─────────┐
 *                ▼                   ▼
 *          status=completed    status=failed
 *                │
 *           --commit
 *                │
 *      ┌─────────┴──────────┐
 *      ▼                    ▼
 *   auto-approve      ready_for_review
 *   (canonical writes)  (human review)
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
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   tsx scripts/llm-er-pass-firecrawl.ts --smoke-firecrawl
 *   tsx scripts/llm-er-pass-firecrawl.ts --eval-mode
 *   tsx scripts/llm-er-pass-firecrawl.ts --reason-only [--max-records=N]
 *   tsx scripts/llm-er-pass-firecrawl.ts --commit [--auto-approve-all]
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

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

// ── Types ─────────────────────────────────────────────────────────────────

type InputStep = (typeof ELIGIBLE_INPUT_STEPS)[number];

type Mode =
  | "smoke-firecrawl"
  | "eval"
  | "reason-only"
  | "commit"
  | "help";

interface Args {
  mode: Mode;
  maxRecords: number | null;
  autoApproveAll: boolean;
  budgetCapUsd: number;
}

interface WorkRecord {
  review_id: number;
  input_step: InputStep;
  scraped_name: string;
  scraped_payload: Record<string, unknown>;
  candidate_matches: Array<Record<string, unknown>>;
}

interface CandidateOperator {
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

/** What the subagent returns. Driver validates this before persisting. */
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

/** Status values match the migration's CHECK constraint. */
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

/** What the subagent receives. */
interface SubagentRequest {
  record: WorkRecord;
  topKCandidates: CandidateOperator[];
  selectingPrompt: string;
  budgetCapUsd: number;
  maxFirecrawlPages: number;
}

// ── Args parsing ──────────────────────────────────────────────────────────

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let mode: Mode = "help";
  if (args.includes("--smoke-firecrawl")) mode = "smoke-firecrawl";
  else if (args.includes("--eval-mode")) mode = "eval";
  else if (args.includes("--reason-only")) mode = "reason-only";
  else if (args.includes("--commit")) mode = "commit";

  const maxFlag = args.find((a) => a.startsWith("--max-records="));
  const budgetFlag = args.find((a) => a.startsWith("--budget-cap-usd="));

  return {
    mode,
    maxRecords: maxFlag ? Number.parseInt(maxFlag.split("=")[1]!, 10) : null,
    autoApproveAll: args.includes("--auto-approve-all"),
    budgetCapUsd: budgetFlag
      ? Number.parseFloat(budgetFlag.split("=")[1]!)
      : DEFAULT_BUDGET_CAP_USD,
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
Usage: tsx scripts/llm-er-pass-firecrawl.ts [mode] [flags]

Modes (exactly one):
  --smoke-firecrawl   Verify Firecrawl MCP is healthy before any work.
                      Scrapes 5 known-good URLs and asserts response shape.
                      Aborts if MCP not installed.

  --eval-mode         Run the LLM pipeline against the 30-row holdout fixture
                      (scripts/fixtures/llm-eval-holdout-30.json) in two modes:
                      visible-truth + hidden-truth. Outputs F1/P/R + confusion
                      matrix. NO canonical writes. NO checkpoint writes.

  --reason-only       Process the work queue from public.operator_match_review
                      (input_step in ('step2c', 'step2c.5_phase1_collision')).
                      Writes results to public.operator_llm_er_checkpoint.
                      NO canonical writes. Resumable via checkpoint state.

  --commit            Read status='completed' checkpoint rows. For each:
                      auto-approve to canonical IF (a) llm_confidence >= 0.75,
                      (b) decision_subtype != 'rebrand_to_canonical',
                      (c) citation_validated, (d) target NOT in
                      top-20-by-fleet. Otherwise mark status='ready_for_review'
                      (no canonical write).

Flags:
  --max-records=N     Cap records processed (default: all).
  --budget-cap-usd=N  Hard cap on Claude API + Firecrawl spend (default: 300).
                      Driver aborts cleanly at 90% of cap.
  --auto-approve-all  --commit only: bypass surface-for-review filter.
                      Logged with separate run_id.
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

/**
 * Bootstrap a checkpoint row for every match_review entry whose step is
 * eligible. UPSERT semantics — re-runs are no-ops on existing rows.
 */
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

/**
 * Claim the next available work row. Atomic via SELECT FOR UPDATE SKIP LOCKED
 * + status flip. Returns null if the queue is empty.
 */
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

/**
 * Driver-side anti-hallucination guard. Runs after subagent returns, BEFORE
 * persisting the decision. Failed validation marks the row 'failed' (no
 * silent retries with the same prompt — the operator decides whether to
 * retry, re-prompt, or escalate).
 *
 * Pure function — no DB access, no side effects. Easy to unit-test.
 */
export function validateLLMResponse(
  response: SubagentResponse,
): ValidationResult {
  // 1. Ambiguous + error decisions skip citation requirements (those decisions
  //    don't write to canonical and may legitimately have no citations).
  if (response.decision === "ambiguous" || response.decision === "error") {
    return { valid: true };
  }

  // 2. Match + new_entity require at least one citation.
  if (response.verbatim_quotes.length === 0) {
    return {
      valid: false,
      reason: "missing_citation_for_decision",
      detail: `decision='${response.decision}' but no verbatim_quotes provided`,
    };
  }

  // 3. URL containment — every cited URL must appear in firecrawl_urls_fetched.
  for (const q of response.verbatim_quotes) {
    if (!response.firecrawl_urls_fetched.includes(q.url)) {
      return {
        valid: false,
        reason: "cited_url_not_fetched",
        detail: `URL ${q.url} cited but not in firecrawl_urls_fetched`,
      };
    }
  }

  // 4. Verbatim substring — each quote must be a substring of the page content.
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

  // 5. Two-Source Rule — non-ambiguous decisions need ≥2 distinct domains.
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

  // 6. decision='match' requires decision_target_operator_id to be a valid UUID.
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

// ── Selecting prompt template ─────────────────────────────────────────────

/**
 * Renders the selecting-strategy prompt for one record. The subagent receives
 * this as its task description and is expected to return a SubagentResponse
 * shaped JSON object.
 *
 * The full text mirrors the plan's "Selecting prompt template" section
 * verbatim — keeping the prompt in code (not a separate text file) so the
 * eval harness can version it alongside the validator.
 */
export function renderSelectingPrompt(
  record: WorkRecord,
  candidates: CandidateOperator[],
): string {
  const certWindow = (() => {
    const wins = (record.scraped_payload["windows"] as
      | Array<{ valid_from?: string; valid_to?: string | null }>
      | undefined) ?? [];
    if (wins.length === 0) {
      const vf = record.scraped_payload["valid_from"];
      const vt = record.scraped_payload["valid_to"];
      return `${vf ?? "?"} to ${vt ?? "current"}`;
    }
    const first = wins[0]!;
    return `${first.valid_from ?? "?"} to ${first.valid_to ?? "current"}`;
  })();
  const certDesignator =
    (record.scraped_payload["cert_designator"] as string | undefined) ??
    ((record.scraped_payload["cert_designators"] as string[] | undefined) ?? [])[0] ??
    "?";
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
1. Use the Firecrawl MCP tool to scrape AT LEAST TWO INDEPENDENTLY PUBLISHED sources
   about "${record.scraped_name}". Independence means different publishers
   (an operator's own website + Wikipedia = two; two different aviation news outlets
   = two; the same outlet's two articles = ONE). Required scrape order:
     a. Operator's own website (try https://www.{normalized_lowercase}.com if no other URL)
     b. Wikipedia (en.wikipedia.org/wiki/{name})
     c. AINonline OR AvWeb OR Aviation Week OR Business Jet Traveler search
     d. SEC EDGAR if the holder name suggests a public company
     e. State Secretary of State business search if the LLC suffix suggests a state
     f. Aggregator search for "{holder_name} acquisition" / "rebrand" / "merger"
   Stop after you have 2+ INDEPENDENT sources, max ${FIRECRAWL_MAX_PAGES_PER_RECORD} total scrapes.

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

OUTPUT FORMAT — RETURN VALID JSON, NO COMMENTARY OUTSIDE THE JSON:
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
    {"url": "https://...", "content": "full scraped content", "fetched_at": "2026-..."}
  ],
  "additional_evidence_needed": "..." | null,
  "cost_estimate_usd": 0.04
}

ANTI-HALLUCINATION RULES (violations = decision='error'):
- Every URL in "verbatim_quotes" MUST exactly match a URL in "firecrawl_urls_fetched".
- Every "quote" MUST be verbatim text from the scraped page (case-sensitive substring
  match against the Firecrawl response).
- If you cannot find ≥2 independent sources, return decision='ambiguous' with
  "additional_evidence_needed" filled. Do not fabricate.
- If Firecrawl returns errors or empty content for all attempts, return
  decision='error' with the error in "reasoning".
- Do NOT use prior knowledge (training data) as the sole basis for any claim.
  Every claim must trace to a Firecrawl-fetched quote.`;
}

// ── Subagent invocation (STUB — wire next session) ────────────────────────

/**
 * STUB. Wire this in the post-Firecrawl-MCP-install session.
 *
 * Implementation contract (next session):
 *   - Render selecting prompt via renderSelectingPrompt(record, candidates)
 *   - Spawn an Agent (general-purpose subagent_type) with Firecrawl MCP tools
 *     attached. Give it the prompt + a budget (max 8 scrapes, ~$X).
 *   - Subagent decides, scrapes, returns JSON matching SubagentResponse.
 *   - Parse JSON, validate via validateLLMResponse.
 *
 * Output shape MUST match SubagentResponse interface above. The driver
 * validates citations and persists.
 *
 * Callers: invokeSubagent({record, topKCandidates, selectingPrompt,
 *                          budgetCapUsd, maxFirecrawlPages})
 */
async function invokeSubagent(_req: SubagentRequest): Promise<SubagentResponse> {
  throw new Error(
    "[llm-er-pass] subagent invocation not wired. " +
      "See scripts/llm-er-pass-firecrawl.ts:invokeSubagent — wire after " +
      "Firecrawl MCP install lands. See plan: " +
      "~/.claude/plans/groovy-exploring-marshmallow.md (Phase 2 Step 0).",
  );
}

// ── Top-K candidate loader ────────────────────────────────────────────────

async function loadTopKCandidates(
  client: pg.PoolClient,
  record: WorkRecord,
): Promise<CandidateOperator[]> {
  // Pull top K from candidate_matches in the work record itself (already
  // shortlisted by Step 2c's matcher). Enrich each with current alias list +
  // operator_type + icao_callsign from public.operators.
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
    .filter((c): c is CandidateOperator => c !== null);
}

// ── Top-20-by-fleet membership check ──────────────────────────────────────

interface Top20Fixture {
  operator_substrings: string[];
  rationale: string;
}

async function loadTop20OperatorIds(
  client: pg.PoolClient,
): Promise<Set<string>> {
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

// ── Mode dispatchers ──────────────────────────────────────────────────────

async function runSmokeFirecrawl(): Promise<void> {
  console.log(`[llm-er-pass] mode=smoke-firecrawl`);
  console.log(
    `[llm-er-pass] Firecrawl MCP smoke test not yet wired. ` +
      `See plan ~/.claude/plans/groovy-exploring-marshmallow.md ` +
      `Phase 2 Step 0 for the test specification.`,
  );
  console.log(
    `[llm-er-pass] EXPECTED PROCEDURE (next session, after MCP install):
  1. Scrape these 5 URLs via mcp__firecrawl__scrape:
       - https://en.wikipedia.org/wiki/NetJets
       - https://www.netjets.com/en-us/about
       - https://www.ainonline.com/aviation-news/business-aviation
       - https://en.wikipedia.org/wiki/Flexjet
       - https://www.vistaglobal.com/about/
  2. For each response, assert:
       - Response has \`url\` and \`content\` (or equivalent) fields
       - content.length > 1000 chars
       - URL in response matches requested URL
  3. ≥4 of 5 succeed → MCP healthy, exit 0. Else → exit 1 with diagnostic.`,
  );
  console.log(`[llm-er-pass] STUB exit. Wire mcp__firecrawl__scrape calls when MCP lands.`);
}

async function runEval(): Promise<void> {
  console.log(`[llm-er-pass] mode=eval`);
  const fixturePath = resolve(process.cwd(), FIXTURE_HOLDOUT_PATH);
  if (!fixturePath) {
    console.error(`[llm-er-pass] eval fixture not found: ${FIXTURE_HOLDOUT_PATH}`);
    process.exit(1);
  }
  const fixtureRaw = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
    description?: string;
    cases: Array<{
      holdout_id: string;
      truth_operator_id: string;
      truth_canonical_name: string;
      cert_id: string;
      cert_designator: string;
      holder_name_as_provided: string;
      holder_name_normalized: string;
      valid_from: string;
      valid_to: string | null;
    }>;
  };
  const fixture = fixtureRaw.cases;
  console.log(`[llm-er-pass] loaded ${fixture.length} holdout cases`);
  console.log(
    `[llm-er-pass] eval execution not yet wired (depends on invokeSubagent stub). ` +
      `See plan: each holdout runs in TWO modes (visible truth / hidden truth) ` +
      `for 60 total runs. F1 ≥ 0.95 required to greenlight --commit.`,
  );
  console.log(`[llm-er-pass] STUB exit. Wire invokeSubagent first.`);
}

async function runReasonOnly(args: Args): Promise<void> {
  const runId = formatRunId();
  console.log(`[llm-er-pass] mode=reason-only run_id=${runId}`);
  console.log(`[llm-er-pass] budget cap: $${args.budgetCapUsd}`);
  if (args.maxRecords !== null)
    console.log(`[llm-er-pass] --max-records=${args.maxRecords}`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = '600s'`);

    const inserted = await bootstrapCheckpointRows(client);
    console.log(`[llm-er-pass] bootstrapped ${inserted} new checkpoint rows`);

    const queueState = await client.query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::bigint AS n
         FROM public.operator_llm_er_checkpoint
        WHERE input_step = ANY($1::text[])
        GROUP BY status ORDER BY status`,
      [ELIGIBLE_INPUT_STEPS as unknown as string[]],
    );
    console.log(`[llm-er-pass] queue state:`);
    for (const r of queueState.rows) console.log(`  ${r.status}: ${r.n}`);

    let processed = 0;
    let totalCost = 0;
    for (
      let i = 0;
      args.maxRecords === null || i < args.maxRecords;
      i++
    ) {
      if (totalCost >= args.budgetCapUsd * 0.9) {
        console.log(
          `[llm-er-pass] budget 90% threshold reached ($${totalCost.toFixed(2)} / $${args.budgetCapUsd}). Stopping.`,
        );
        break;
      }
      const claimed = await claimNextRow(client, runId);
      if (!claimed) {
        console.log(`[llm-er-pass] queue empty. Done.`);
        break;
      }

      // Load the source match_review row for the prompt
      const reviewRes = await client.query<{
        scraped_name: string;
        scraped_payload: Record<string, unknown>;
        candidate_matches: Array<Record<string, unknown>>;
      }>(
        `SELECT scraped_name, scraped_payload, candidate_matches
           FROM public.operator_match_review
          WHERE id = $1`,
        [claimed.input_review_id],
      );
      if (reviewRes.rowCount === 0) {
        await writeFailedCheckpoint(
          client,
          claimed.id,
          `match_review row ${claimed.input_review_id} not found`,
          0,
        );
        continue;
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

      try {
        const response = await invokeSubagent({
          record,
          topKCandidates: candidates,
          selectingPrompt: prompt,
          budgetCapUsd: args.budgetCapUsd - totalCost,
          maxFirecrawlPages: FIRECRAWL_MAX_PAGES_PER_RECORD,
        });
        const validation = validateLLMResponse(response);
        await writeCompletedCheckpoint(client, claimed.id, response, validation);
        totalCost += response.cost_estimate_usd;
        processed++;
        console.log(
          `[llm-er-pass] [${processed}] review_id=${claimed.input_review_id} ` +
            `decision=${response.decision} valid=${validation.valid} ` +
            `cost=$${response.cost_estimate_usd.toFixed(4)} total=$${totalCost.toFixed(2)}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await writeFailedCheckpoint(client, claimed.id, msg, 0);
        console.log(
          `[llm-er-pass] [FAIL] review_id=${claimed.input_review_id} attempt=${claimed.attempt_count} err=${msg.slice(0, 100)}`,
        );
        // On the first failure (which is the stub error), bail out cleanly so
        // the operator sees the wiring TODO immediately.
        if (msg.includes("subagent invocation not wired")) {
          console.log(
            `[llm-er-pass] STUB: invokeSubagent not yet wired. ` +
              `Aborting to surface the wiring TODO. ` +
              `Reset checkpoint state via: DELETE FROM public.operator_llm_er_checkpoint WHERE run_id='${runId}';`,
          );
          break;
        }
      }
    }

    console.log(`\n[llm-er-pass] reason-only summary: processed=${processed}, total_cost=$${totalCost.toFixed(2)}`);
  } finally {
    client.release();
    await pool.end();
  }
}

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
      if (
        cp.llm_decision_target !== null &&
        top20Ids.has(cp.llm_decision_target)
      ) {
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

      // Auto-approve path. STUB the canonical writes — wire next session.
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
        if (msg.includes("commitToCanonical not wired")) {
          console.log(
            `[llm-er-pass] STUB: commitToCanonical not yet wired. ` +
              `${completedRows.rowCount} rows would have been auto-approved or surfaced. ` +
              `Wire after eval F1 ≥ 0.95 confirmed.`,
          );
          break;
        }
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

/**
 * STUB. Wire next session — writes to:
 *   - public.operator_aliases (alias_type='legal' | 'historical')
 *   - canonical.operator_holds_certificate (source='llm_firecrawl_research')
 *   - canonical.operator_holds_certificate_pending (resolve)
 *   - public.operator_match_review (status='matched' | 'new_operator')
 * within a single transaction. See plan §"What gets written for each LLM
 * outcome (Two-Source Rule application)" for the full decision table.
 */
async function commitToCanonical(
  _client: pg.PoolClient,
  _checkpoint: { id: string; input_review_id: number; llm_decision: Decision },
  _runId: string,
  _autoApproveAll: boolean,
): Promise<void> {
  throw new Error(
    "[llm-er-pass] commitToCanonical not wired. " +
      "Implements alias / OHC / pending writes per plan decision table. " +
      "Wire after eval F1 ≥ 0.95.",
  );
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
      await runEval();
      break;
    case "reason-only":
      await runReasonOnly(args);
      break;
    case "commit":
      await runCommit(args);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
