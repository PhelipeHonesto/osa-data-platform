/**
 * Operator profile-builder V1 — Phase 2.2-C.
 *
 * Architecture
 *   FAA Part 135 cert (authoritative)
 *     → Perplexity (discovery)
 *     → hosted Firecrawl (verbatim capture)
 *     → Sonnet 4.6 (reasoning + synthesis)
 *     → public.operator_profiles row with citations
 *
 *   ER decisions (dedup, brand groups, rebrand events) become DERIVED
 *   views over profile data, not the agent's primary output.
 *
 *   Same skeleton will generalize to aircraft_profiles, fbo_profiles,
 *   etc. — only the input record + prompt scaffolding change.
 *
 * Orchestration model
 *   This script provides DB plumbing + prompt construction. Claude Code
 *   is the orchestrator: it spawns the agent (claude-sonnet-4-6 inherited
 *   via the Agent tool) per cert, gets back a response.json, then calls
 *   `commit` to persist. Mirrors the eval/live-queue pattern in
 *   scripts/llm-er-pass-firecrawl.ts.
 *
 * Subcommands
 *   prepare --cert=ABCD123      Pull faa_operators row, build V1 prompt,
 *                               write .work/profile-builder/<cert>/{claim.json,prompt.txt}.
 *                               Prints {run_dir, cert_number, ...} as JSON.
 *
 *   commit  --cert=ABCD123      Read .work/profile-builder/<cert>/response.json,
 *                               validate citations, UPSERT into public.operator_profiles.
 *                               Prints {cert_number, status, ...} as JSON.
 *
 *   status  [--cohort=<file>]   Show n_profiled / n_total + recent profiles.
 *                               Cohort defaults to all active faa_operators rows.
 *
 *   help                        Print usage.
 */

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

export const PROMPT_VERSION = "profile-builder-v1.2.1";
const WORK_ROOT = ".work/profile-builder";
export const FIRECRAWL_PAGE_TRUNCATE = 30000; // chars per page

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

// Cert context for prompt input.
//
// Primary source is canonical.certificates — that's the platform's source
// of truth for active Part 135 cert holders (1,989 rows, 4-char FAA
// designators like W6JA, B8MA, VQMA). canonical_holder_name there is the
// authoritative legal name from the FAA D085 ingestion.
//
// Best-effort enrichment from public.faa_operators: this is a separate
// older ingestion using synthetic 7-char IDs (KSMR001, WHEE001, ...)
// that doesn't share keys with canonical.certificates. We name-match
// (case + whitespace normalized) to fold in city/state/fleet count and
// ARGUS/Wyvern/BAO ratings when available. ~50% of canonical certs
// match cleanly; the rest go to the agent without ratings (fine — the
// agent can rediscover those from operator websites).
export interface CertContext {
  faa_cert_number: string;
  canonical_holder_name: string;
  operating_part: string | null;
  status: string;
  // Enrichment from faa_operators (all nullable — may not match)
  enrich_dba_name: string | null;
  enrich_city: string | null;
  enrich_state: string | null;
  enrich_zip: string | null;
  enrich_aircraft_count: number | null;
  enrich_argus_rating: string | null;
  enrich_wyvern_rating: string | null;
  enrich_is_bao_stage: number | null;
}

export interface ProfileResponse {
  legal_name: string;
  dba_name: string | null;
  current_brand: string | null;
  parent_company: string | null;
  brand_family: string | null;
  historical_aliases: unknown[];
  predecessor_certs: unknown[];
  sister_certs: unknown[];
  acquisition_history: unknown[];
  perplexity_queries: unknown[];
  firecrawl_pages: Array<{
    url: string;
    content: string;
    fetched_at: string;
    content_length?: number;
  }>;
  verbatim_quotes: Array<{
    url: string;
    quote: string;
    supports_claim: string;
    claim_path?: string;
  }>;
  confidence: number;
  research_completeness: "thin" | "partial" | "complete";
  metadata: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// DB
// ────────────────────────────────────────────────────────────────────────────

export function getPool(): pg.Pool {
  const cs = process.env["SUPABASE_DATABASE_URL"];
  if (!cs) {
    console.error("SUPABASE_DATABASE_URL not set");
    process.exit(2);
  }
  return new pg.Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
  });
}

export async function fetchCertContext(
  client: pg.PoolClient,
  certNumber: string,
): Promise<CertContext | null> {
  const certRes = await client.query<{
    faa_cert_number: string;
    canonical_holder_name: string | null;
    operating_part: string | null;
    status: string;
  }>(
    `SELECT faa_cert_number, canonical_holder_name, operating_part, status
       FROM canonical.certificates
      WHERE faa_cert_number = $1`,
    [certNumber],
  );
  if (!certRes.rowCount) return null;
  const cert = certRes.rows[0]!;
  if (!cert.canonical_holder_name) return null;

  // Best-effort enrichment from faa_operators by case+whitespace-normalized
  // name match. Returns at most one row; if none, all enrich_* fields stay null.
  const enrichRes = await client.query<{
    dba_name: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    aircraft_count: number | null;
    argus_rating: string | null;
    wyvern_rating: string | null;
    is_bao_stage: number | null;
  }>(
    `SELECT dba_name, city, state, zip, aircraft_count,
            argus_rating, wyvern_rating, is_bao_stage
       FROM public.faa_operators
      WHERE UPPER(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))
          = UPPER(REGEXP_REPLACE($1, '\\s+', ' ', 'g'))
      ORDER BY aircraft_count DESC NULLS LAST
      LIMIT 1`,
    [cert.canonical_holder_name],
  );
  const enrich = enrichRes.rowCount && enrichRes.rowCount > 0 ? enrichRes.rows[0]! : null;

  return {
    faa_cert_number: cert.faa_cert_number,
    canonical_holder_name: cert.canonical_holder_name,
    operating_part: cert.operating_part,
    status: cert.status,
    enrich_dba_name: enrich?.dba_name ?? null,
    enrich_city: enrich?.city ?? null,
    enrich_state: enrich?.state ?? null,
    enrich_zip: enrich?.zip ?? null,
    enrich_aircraft_count: enrich?.aircraft_count ?? null,
    enrich_argus_rating: enrich?.argus_rating ?? null,
    enrich_wyvern_rating: enrich?.wyvern_rating ?? null,
    enrich_is_bao_stage: enrich?.is_bao_stage ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Prompt builder — V1
// ────────────────────────────────────────────────────────────────────────────

/**
 * Two-part prompt builder for cross-cert prompt caching (V1.2.1).
 *
 * `staticPart` is the same for every cert — instructions, workflow
 * (with <HOLDER NAME> / <STATE> placeholders instead of interpolated
 * values), schema, rules. The SDK runner marks this with cache_control
 * so it's cached cross-cert: cert 1 writes the cache (~14k tokens at
 * 1.25x = paid expensive), certs 2..N read it (10x cheaper).
 *
 * `dynamicPart` is per-cert — the FAA INPUT section. Comes AFTER the
 * cached static prefix. Not cached.
 */
export function buildPromptParts(ctx: CertContext): { staticPart: string; dynamicPart: string } {
  return { staticPart: STATIC_INSTRUCTIONS, dynamicPart: dynamicInputBlock(ctx) };
}

export function buildPrompt(ctx: CertContext): string {
  const { staticPart, dynamicPart } = buildPromptParts(ctx);
  return `${staticPart}\n\n${dynamicPart}`;
}

function dynamicInputBlock(ctx: CertContext): string {
  const dba = ctx.enrich_dba_name && ctx.enrich_dba_name.trim() ? ctx.enrich_dba_name : "(none reported)";
  const ratings: string[] = [];
  if (ctx.enrich_argus_rating) ratings.push(`ARGUS: ${ctx.enrich_argus_rating}`);
  if (ctx.enrich_wyvern_rating) ratings.push(`Wyvern: ${ctx.enrich_wyvern_rating}`);
  if (ctx.enrich_is_bao_stage) ratings.push(`BAO Stage ${ctx.enrich_is_bao_stage}`);
  const ratingsStr = ratings.length > 0 ? ratings.join(", ") : "(none reported)";
  const addr = [ctx.enrich_city, ctx.enrich_state, ctx.enrich_zip]
    .filter(Boolean)
    .join(", ") || "(not in enrichment table)";
  const fleet = ctx.enrich_aircraft_count !== null ? `${ctx.enrich_aircraft_count}` : "(not in enrichment table)";

  return `═══════════════════════════════════════════════════════════════════════
INPUT — FAA Part 135 cert holder (authoritative natural key)
═══════════════════════════════════════════════════════════════════════
  CERT NUMBER:    ${ctx.faa_cert_number}      (canonical.certificates.faa_cert_number)
  LEGAL NAME:     ${ctx.canonical_holder_name}  (FAA D085 D087 ingestion)
  OPERATING PART: ${ctx.operating_part ?? "(unknown)"}
  CERT STATUS:    ${ctx.status}

  Enrichment (from public.faa_operators by name match — best-effort,
  may be missing if no clean match):
    DBA:            ${dba}
    LOCATION:       ${addr}
    AIRCRAFT COUNT: ${fleet}
    RATINGS:        ${ratingsStr}

Now execute the workflow above for this cert. Use the canonical_holder_name
(${ctx.canonical_holder_name}) wherever the workflow says <HOLDER NAME>, and
${ctx.enrich_state ?? "(skip the state qualifier — state unknown)"} wherever it says <STATE>.
Output ONLY the final fenced \`\`\`json profile block.`;
}

const STATIC_INSTRUCTIONS = `You are an operator-profile research agent for Orange Sunshine
Aviation's data platform. For the FAA Part 135 cert holder shown in
the INPUT section at the END of this prompt, build a structured
operator profile with every claim citation-backed.

PROMPT VERSION: ${PROMPT_VERSION}

═══════════════════════════════════════════════════════════════════════
GOAL
═══════════════════════════════════════════════════════════════════════
Produce a structured profile capturing:

  • Identity      — legal_name, dba_name (carry from FAA unless evidence overrides)
  • Current state — current_brand, parent_company, brand_family
  • History       — historical_aliases, predecessor_certs, sister_certs,
                    acquisition_history (each citation-backed)
  • Evidence      — perplexity_queries, firecrawl_pages, verbatim_quotes
  • Quality       — confidence (0.0–1.0), research_completeness ('thin'|'partial'|'complete')

The schema is the public.operator_profiles row. Every non-trivial claim
must trace to a verbatim_quote (url + byte-exact substring of the
scraped page).

═══════════════════════════════════════════════════════════════════════
RESEARCH WORKFLOW
═══════════════════════════════════════════════════════════════════════

Step 1 — Perplexity discovery (4 queries, in order):
  Substitute <HOLDER NAME> below with the canonical_holder_name from
  the INPUT section at the end of this prompt. Substitute <STATE> with
  the cert's state (drop the qualifier if state is unknown).

  perplexity_search('<HOLDER NAME>')
  perplexity_search('<HOLDER NAME> <STATE> FAA Part 135')
  perplexity_search('<HOLDER NAME> acquisition merger rebrand parent')
  perplexity_search('<HOLDER NAME> history founded acquired 2010 2015 2018 predecessor')

  Don't reformulate. These four intentionally cast a wide net. The 4th
  query specifically targets pre-2020 lineage that recency-biased general
  queries miss (older acquisitions, predecessor companies, founding
  history) — V1's calibration on Wheels Up surfaced Mountain (2021) and
  GrandView but missed TMC (~2017) and Delta Private Jets (~2020).

Step 2 — URL selection:
  From the Perplexity results, pick 3-8 URLs covering ≥2 distinct
  source types. Prefer:
    - Operator's own website (current brand AND any prior brand sites)
    - Parent company site
    - Aviation press: AINonline, BJT, Corporate Jet Investor,
      Aviation Week, FlightGlobal, Wikipedia
    - SEC filings (sec.gov) for public-parent operators
    - Regulatory: faa.gov, regulations.gov, ntsb.gov

  Same-name disambiguation: when multiple unrelated entities share
  the legal name, use city/state from the FAA row to filter. Discard
  URLs about unrelated same-name entities — do NOT cite them.

Step 3 — firecrawl_scrape:
  formats: ["markdown"]
  onlyMainContent: true
  Truncate page bodies to <${FIRECRAWL_PAGE_TRUNCATE} chars when persisting.
  If a scrape returns empty/minimal, drop it; don't retry indefinitely.

Step 4 — canonical_lookup on discovered entities:
  When research surfaces a parent company, predecessor brand, or
  successor entity (e.g. "<HOLDER NAME> was acquired by ACME Holdings
  in 2022"), check whether ACME Holdings already exists in our
  canonical operators table:

    npx tsx scripts/canonical-lookup.ts "ACME Holdings"

  Returns JSON: {entity_type, query, n_results, results: [...]}.
  If a strong match (match_strength ≥ 0.8) returns, record the
  canonical operator_id in the relevant profile field's evidence
  (e.g., parent_company_canonical_id, predecessor_canonical_id) so
  downstream curation can link without re-research.

  Lookup is for RESEARCH-IDENTIFIED ENTITIES ONLY. Don't call this
  on the holder name itself — the goal is to enrich the profile with
  canonical refs to OTHER operators it relates to.

  SELF-MATCH GUARD (V1.1): If canonical_lookup returns a row whose
  canonical_name matches the legal_name of the cert you're profiling
  (case-insensitive, whitespace-normalized — i.e., the
  canonical_holder_name shown in the INPUT section below), treat that
  as a self-match and DO NOT use it as
  parent / predecessor / counterparty evidence. That's the canonical
  row for the cert you're building a profile for, not a relationship
  to another operator. Skip it. (E.g., on cert W6JA "Western Air
  Charter, Inc.", a canonical_lookup for "Vista America" might return
  "Vista America - Western Air Charter" which is just W6JA's own
  canonical row — not Vista America the parent brand. Don't link.)

Step 5 — Synthesis:
  Combine FAA defaults + Perplexity + Firecrawl + canonical_lookup
  into the structured profile. Default rules:
    - legal_name defaults to FAA name; override only with strong
      evidence (e.g., recent legal rename in SEC filing)
    - dba_name defaults to FAA dba_name; populate from website if
      FAA shows none and the operator markets a different brand
    - current_brand: the brand-of-the-day (often != legal_name when
      operator is a sub-LLC of a parent brand)
    - parent_company: NULL if independent; otherwise the corporate
      parent (e.g., "Vista Global Holding S.A.")
    - brand_family: cross-cert cluster identifier (e.g., "Vista" for
      operators under Vista Global). NULL when independent.

Step 6 — CROSS-SOURCE CONSISTENCY CHECK (V1.2.1):
  Before emitting your final profile JSON, verify your own work
  along four dimensions. This catches claim-without-citation and
  wrong-entity-binding errors before they trigger validation
  retries (each retry costs ~$0.25).

  a) Quote-claim binding:
     For every populated field — current_brand, parent_company,
     brand_family, AND each entry in historical_aliases /
     predecessor_certs / sister_certs / acquisition_history — verify
     your verbatim_quotes array contains a quote that directly
     supports the claim. If a populated claim has no supporting
     quote, DROP THE CLAIM. Set the field to null (for scalars) or
     remove the entry (for arrays).

  b) FAA enrichment vs research conflict:
     The input includes FAA enrichment fields (city, state,
     aircraft_count). Does the entity you identified in research
     match these? If MAJOR mismatch (different state, different
     fleet size by >2x): you may have identified the WRONG entity.
     Either:
       - Re-bind to a different entity in your research that
         matches FAA enrichment (often a same-name disambiguation
         the first pass got wrong), OR
       - Set research_completeness='partial' with the conflict
         documented in metadata.conflicts

  c) Same-name disambiguation final pass:
     Did your research surface multiple entities with similar names?
     Which one's identifying details (FAA cert ID, ICAO callsign,
     fleet size, geographic base, founding date) actually match the
     cert input? If you can't bind to a single entity with high
     confidence: research_completeness='partial', confidence ≤0.6,
     document the unresolvable ambiguity in metadata.conflicts.

  d) Output reasoning:
     Briefly summarize your cross-check in metadata.cross_source_check
     (3-5 lines max, free-text). What did you verify? What conflicts
     did you find / resolve? Why are you confident or uncertain?
     This is your audit trail.

Step 7 — PRE-SUBMISSION SELF-CHECK (verify before emitting JSON):
  • Each verbatim_quotes[].url is in firecrawl_pages[].url
  • Each verbatim_quotes[].quote is a byte-exact substring of the
    corresponding firecrawl_pages[].content
  • Every non-FAA-default claim has at least one verbatim_quote
    backing it (Step 6a above is the deeper check; this is the
    final scan)
  • confidence is sensible: 'thin' research → ≤0.4; 'partial' → 0.4-0.7;
    'complete' → 0.7-0.95 (cap at 0.95, never 1.0)

═══════════════════════════════════════════════════════════════════════
QUALITY BARS
═══════════════════════════════════════════════════════════════════════
  • parent_company can be NULL — independent operators are valid
  • historical_aliases can be empty array — many operators have one name
  • Thin research (Perplexity returned nothing useful, no operator
    website, no press): set research_completeness='thin', emit a minimal
    profile with FAA defaults carried forward, set confidence ≤ 0.4. DO
    NOT error.
  • Conflicting evidence (different sources disagree on parent / dates):
    surface in metadata.conflicts[] as
    {field, source_a_url, source_a_value, source_b_url, source_b_value,
     resolution: 'unresolved'}.
    Don't pick a side; let curation decide.

═══════════════════════════════════════════════════════════════════════
ANTI-HALLUCINATION RULES
═══════════════════════════════════════════════════════════════════════
  • Every URL in verbatim_quotes MUST be in firecrawl_pages.
  • Each quote MUST be a byte-exact substring of the scraped markdown
    (NOT a paraphrase, NOT whitespace-stripped). The validator runs
    String.includes — no fuzziness.
  • firecrawl_pages MUST include the actual scraped markdown for each
    cited URL, truncated to <${FIRECRAWL_PAGE_TRUNCATE} chars.
  • Don't extrapolate from prior knowledge. Every claim must trace
    to a citation OR be flagged as a FAA-default carry-over.
  • If Perplexity returns nothing across all 3 queries AND no firecrawl
    yields a usable page: research_completeness='thin', proceed with
    minimal profile (legal_name + dba_name from FAA, all else NULL),
    confidence ≤ 0.3.

═══════════════════════════════════════════════════════════════════════
VERBATIM RULE (V1.2)
═══════════════════════════════════════════════════════════════════════
Every entry in verbatim_quotes MUST be a byte-exact substring of one
of the firecrawl_pages[].content fields.
  • Do not paraphrase
  • Do not normalize whitespace, smart quotes, or punctuation
  • Do not "clean up" the text — copy character-for-character,
    including any odd capitalization, parenthetical inserts, or
    formatting artifacts
  • If you cannot find a verbatim substring supporting a claim,
    DROP THE CLAIM. Do not fabricate or paraphrase a quote.

Before emitting the final JSON, mentally verify each quote appears
literally inside firecrawl_pages content. If a quote doesn't appear
verbatim, remove it from verbatim_quotes and remove any claim that
depended solely on it.

═══════════════════════════════════════════════════════════════════════
OUTPUT SCHEMA — see field-level rules below; final wrapper format is
the OUTPUT FORMAT (CRITICAL) section at the very end.
═══════════════════════════════════════════════════════════════════════
{
  "legal_name":     "<string, defaults to FAA name>",
  "dba_name":       "<string or null>",
  // ─── current_brand definition (V1.2) ──────────────────────────────────
  // The brand name the operator uses to market itself to the public on
  // its CURRENT operating website today.
  //   • This is NOT the FAA legal_name (that goes in legal_name).
  //   • This is NOT the parent company or umbrella brand
  //     (those go in parent_company or brand_family).
  //   • This IS the name on the operator's own website header,
  //     in their press releases, and how they're referenced in industry
  //     coverage today.
  // Examples:
  //   legal_name="Western Air Charter, Inc." →
  //       current_brand="Jet Edge"
  //       (NOT "Vista America" — that's brand_family)
  //   legal_name="Summit Aviation, Inc." →
  //       current_brand="TransMedics Aviation"
  //       (NOT "Summit Aviation" — that's the legacy legal name)
  //   legal_name="NetJets Aviation, Inc." →
  //       current_brand="NetJets"
  //       (NOT "Berkshire Hathaway" — that's parent_company)
  //   legal_name="Jet Select, LLC" →
  //       current_brand="Jet Select"
  //       (NOT "Vista America" — that's brand_family; the operator
  //       markets as Jet Select even under the Vista umbrella)
  // If the operator has no public-facing brand distinct from its legal
  // name, current_brand may equal legal_name minus corporate suffix
  // (e.g., "Metro Aviation, Inc." → "Metro Aviation").
  "current_brand":  "<string or null>",
  "parent_company": "<string or null>",
  "brand_family":   "<string or null>",

  "historical_aliases": [
    {
      "alias": "<string>",
      "alias_type": "legal" | "dba" | "marketing" | "historical",
      "valid_from": "<YYYY-MM-DD or null>",
      "valid_to":   "<YYYY-MM-DD or null>",
      "source_url": "<url>",
      "quote": "<verbatim>",
      "supports_claim": "<short>"
    }
  ],
  // valid_to convention (V1.1): set valid_to to the date the alias
  // STOPPED BEING USED PUBLICLY (rebrand completion, shutdown,
  // dissolution), NOT the date of any underlying corporate event
  // (acquisition, ownership change). Corporate events go in
  // acquisition_history regardless of whether the alias kept being
  // used after.
  //   Example: Keystone Aviation was acquired by Elevate Holdings on
  //   2022-01-06 but kept the "Keystone Aviation" brand publicly until
  //   the rebrand to Elevate Jet completed on 2023-11-30.
  //   → historical_aliases entry: valid_to = "2023-11-30"
  //   → acquisition_history entry: event_date = "2022-01-06",
  //     event_type = "acquisition"
  // The acquisition and the alias-end-date are separate facts; record
  // both, don't conflate.

  "predecessor_certs": [
    {
      "cert_number": "<string>",
      "name": "<string>",
      "succeeded_at": "<YYYY-MM-DD or null>",
      "source_url": "<url>",
      "quote": "<verbatim>"
    }
  ],

  "sister_certs": [
    {
      "cert_number": "<string>",
      "name": "<string>",
      "relationship": "<sister|parent|child|brand_family>",
      "source_url": "<url>",
      "quote": "<verbatim>"
    }
  ],

  "acquisition_history": [
    {
      "event_type": "acquisition" | "merger" | "spinoff" | "rebrand"
                  | "cert_surrender" | "dissolution" | "formation",
      "counterparty": "<string>",
      "counterparty_canonical_id": "<uuid or null — from canonical_lookup>",
      "event_date": "<YYYY-MM-DD or null>",
      "source_url": "<url>",
      "quote": "<verbatim>"
    }
  ],

  "perplexity_queries": [
    {"query": "<string>", "n_results": <int>, "selected_urls": ["<url>", ...]}
  ],

  "firecrawl_pages": [
    {"url": "<url>", "content": "<markdown, ≤${FIRECRAWL_PAGE_TRUNCATE} chars>",
     "fetched_at": "<iso8601>", "content_length": <int>}
  ],

  "verbatim_quotes": [
    {"url": "<url>", "quote": "<verbatim>", "supports_claim": "<short>",
     "claim_path": "current_brand" | "parent_company" | "acquisition_history[0]" | ...}
  ],

  "confidence": <float 0.0-0.95>,
  "research_completeness": "thin" | "partial" | "complete",

  "metadata": {
    "research_date": "<iso8601>",
    "cost_usd": <float>,
    "wall_clock_seconds": <int>,
    "prompt_version": "${PROMPT_VERSION}",
    "model": "claude-sonnet-4-6",
    "tools_used": ["perplexity_search", "firecrawl_scrape", "canonical_lookup"],
    "n_perplexity_calls": <int>,
    "n_firecrawl_pages": <int>,
    "n_canonical_lookups": <int>,
    "conflicts": []
  }
}

═══════════════════════════════════════════════════════════════════════
JSON ENCODING RULE
═══════════════════════════════════════════════════════════════════════
firecrawl_pages[].content is markdown — contains literal " chars,
backslashes, newlines. JSON-escape: " → \\\", \\ → \\\\, newline → \\n.
JSON.parse runs on the orchestrator side; any unescaped quote fails
the run.

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT (CRITICAL) — V1.2
═══════════════════════════════════════════════════════════════════════
Your response MUST consist of EXACTLY ONE fenced JSON code block,
formatted as:

\`\`\`json
{ ...profile fields... }
\`\`\`

  • NO prose before the code block
  • NO prose after the code block
  • NO multiple JSON blocks
  • NO commentary, reasoning, or summary text outside the JSON
  • If you have additional notes about uncertainty or conflicts, put
    them inside the JSON's metadata.notes or metadata.conflicts field
  • The runner parses the FIRST \`\`\`json code block in your response.
    Any output outside that block is discarded.

If your reasoning runs long during the tool-use phase, that's fine —
those messages are processed normally. But your FINAL message (after
stop_reason="end_turn") must be ONLY the JSON code block.

═══════════════════════════════════════════════════════════════════════
THE PER-CERT FAA INPUT SECTION FOLLOWS BELOW
═══════════════════════════════════════════════════════════════════════
`;

// ────────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  detail?: string;
  /** V1.2.1: failed quote index, populated on quote_url_not_in_pages / quote_not_in_page */
  failedQuoteIndex?: number;
  /** V1.2.1: the failing quote text (full, not truncated) */
  failedQuote?: string;
  /** V1.2.1: the URL of the failing quote */
  failedQuoteUrl?: string;
}

export function validateResponse(resp: ProfileResponse): ValidationResult {
  if (typeof resp.legal_name !== "string" || !resp.legal_name.trim()) {
    return { valid: false, reason: "missing_legal_name", detail: "legal_name is required and non-empty" };
  }
  if (typeof resp.confidence !== "number" || resp.confidence < 0 || resp.confidence > 0.95) {
    return { valid: false, reason: "bad_confidence", detail: `confidence must be 0.0-0.95 (got ${resp.confidence})` };
  }
  if (!["thin", "partial", "complete"].includes(resp.research_completeness)) {
    return { valid: false, reason: "bad_research_completeness", detail: `got ${resp.research_completeness}` };
  }

  const pageUrls = new Set(resp.firecrawl_pages.map((p) => p.url));
  const pagesByUrl = new Map(resp.firecrawl_pages.map((p) => [p.url, p]));

  for (let i = 0; i < resp.verbatim_quotes.length; i++) {
    const q = resp.verbatim_quotes[i]!;
    if (!pageUrls.has(q.url)) {
      return {
        valid: false,
        reason: "quote_url_not_in_pages",
        detail: `verbatim_quotes[${i}].url=${q.url} not in firecrawl_pages`,
        failedQuoteIndex: i,
        failedQuote: q.quote,
        failedQuoteUrl: q.url,
      };
    }
    const page = pagesByUrl.get(q.url);
    if (!page || !page.content.includes(q.quote)) {
      const preview = q.quote.slice(0, 60).replace(/\n/g, "\\n");
      return {
        valid: false,
        reason: "quote_not_in_page",
        detail: `verbatim_quotes[${i}] not byte-exact in page content. Quote start: "${preview}..."`,
        failedQuoteIndex: i,
        failedQuote: q.quote,
        failedQuoteUrl: q.url,
      };
    }
  }

  return { valid: true };
}

// ────────────────────────────────────────────────────────────────────────────
// Subcommands
// ────────────────────────────────────────────────────────────────────────────

async function cmdPrepare(certNumber: string): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const ctx = await fetchCertContext(client, certNumber);
    if (!ctx) {
      console.error(JSON.stringify({
        status: "error",
        reason: "cert_not_found",
        cert_number: certNumber,
        detail: "Not in canonical.certificates with non-null canonical_holder_name",
      }));
      process.exit(1);
    }

    const runDir = resolve(WORK_ROOT, certNumber);
    mkdirSync(runDir, { recursive: true });

    const claim = {
      cert_number: certNumber,
      cert_context: ctx,
      prompt_version: PROMPT_VERSION,
      prepared_at: new Date().toISOString(),
    };
    writeFileSync(resolve(runDir, "claim.json"), JSON.stringify(claim, null, 2));
    writeFileSync(resolve(runDir, "prompt.txt"), buildPrompt(ctx));

    console.log(JSON.stringify({
      status: "prepared",
      cert_number: certNumber,
      run_dir: runDir,
      legal_name: ctx.canonical_holder_name,
      operating_part: ctx.operating_part,
      enrichment_matched: ctx.enrich_state !== null || ctx.enrich_aircraft_count !== null,
      prompt_version: PROMPT_VERSION,
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Pure DB write — UPSERTs an already-validated profile into
 * public.operator_profiles. Used by both cmdCommit (file-based path)
 * and the SDK runner (in-memory path).
 *
 * Caller is responsible for: validating the response (validateResponse),
 * holding the pg client, releasing it.
 */
export async function upsertProfile(
  client: pg.PoolClient,
  certNumber: string,
  resp: ProfileResponse,
): Promise<{ n_pages: number }> {
  const pages = resp.firecrawl_pages.map((p) => ({
    ...p,
    content: p.content.length > FIRECRAWL_PAGE_TRUNCATE ? p.content.slice(0, FIRECRAWL_PAGE_TRUNCATE) : p.content,
    content_length: p.content.length,
  }));

  await client.query(
    `INSERT INTO public.operator_profiles (
       faa_cert_number, legal_name, dba_name,
       current_brand, parent_company, brand_family,
       historical_aliases, predecessor_certs, sister_certs, acquisition_history,
       perplexity_queries, firecrawl_pages, verbatim_quotes,
       confidence, research_completeness, metadata,
       architectural_status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
             $11::jsonb, $12::jsonb, $13::jsonb, $14::numeric, $15::text, $16::jsonb,
             'provisional_profile_v1')
     ON CONFLICT (faa_cert_number) DO UPDATE SET
       legal_name           = EXCLUDED.legal_name,
       dba_name             = EXCLUDED.dba_name,
       current_brand        = EXCLUDED.current_brand,
       parent_company       = EXCLUDED.parent_company,
       brand_family         = EXCLUDED.brand_family,
       historical_aliases   = EXCLUDED.historical_aliases,
       predecessor_certs    = EXCLUDED.predecessor_certs,
       sister_certs         = EXCLUDED.sister_certs,
       acquisition_history  = EXCLUDED.acquisition_history,
       perplexity_queries   = EXCLUDED.perplexity_queries,
       firecrawl_pages      = EXCLUDED.firecrawl_pages,
       verbatim_quotes      = EXCLUDED.verbatim_quotes,
       confidence           = EXCLUDED.confidence,
       research_completeness= EXCLUDED.research_completeness,
       metadata             = EXCLUDED.metadata,
       architectural_status = EXCLUDED.architectural_status`,
    [
      certNumber,
      resp.legal_name,
      resp.dba_name,
      resp.current_brand,
      resp.parent_company,
      resp.brand_family,
      JSON.stringify(resp.historical_aliases),
      JSON.stringify(resp.predecessor_certs),
      JSON.stringify(resp.sister_certs),
      JSON.stringify(resp.acquisition_history),
      JSON.stringify(resp.perplexity_queries),
      JSON.stringify(pages),
      JSON.stringify(resp.verbatim_quotes),
      resp.confidence,
      resp.research_completeness,
      JSON.stringify(resp.metadata),
    ],
  );
  return { n_pages: pages.length };
}

async function cmdCommit(certNumber: string): Promise<void> {
  const runDir = resolve(WORK_ROOT, certNumber);
  const responsePath = resolve(runDir, "response.json");
  if (!existsSync(responsePath)) {
    console.error(JSON.stringify({
      status: "error",
      reason: "response_missing",
      detail: `expected ${responsePath} — agent must write before commit`,
    }));
    process.exit(1);
  }

  let resp: ProfileResponse;
  try {
    resp = JSON.parse(readFileSync(responsePath, "utf-8")) as ProfileResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ status: "error", reason: "json_parse", detail: msg }));
    process.exit(1);
  }

  const v = validateResponse(resp);
  if (!v.valid) {
    console.error(JSON.stringify({ status: "error", reason: v.reason, detail: v.detail }));
    process.exit(1);
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    const { n_pages } = await upsertProfile(client, certNumber, resp);
    console.log(JSON.stringify({
      status: "committed",
      cert_number: certNumber,
      legal_name: resp.legal_name,
      current_brand: resp.current_brand,
      parent_company: resp.parent_company,
      research_completeness: resp.research_completeness,
      confidence: resp.confidence,
      n_quotes: resp.verbatim_quotes.length,
      n_pages,
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

async function cmdStatus(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const total = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM canonical.certificates
        WHERE status = 'active_operating'
          AND faa_cert_number IS NOT NULL`,
    );
    const profiled = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.operator_profiles`,
    );
    const recent = await client.query<{
      faa_cert_number: string;
      legal_name: string;
      current_brand: string | null;
      parent_company: string | null;
      research_completeness: string;
      confidence: string;
      created_at: string;
    }>(
      `SELECT faa_cert_number, legal_name, current_brand, parent_company,
              research_completeness, confidence::text, created_at::text
         FROM public.operator_profiles
        ORDER BY created_at DESC
        LIMIT 10`,
    );
    const completeness = await client.query<{ rc: string; n: string }>(
      `SELECT research_completeness AS rc, count(*)::text AS n
         FROM public.operator_profiles
        GROUP BY 1
        ORDER BY 1`,
    );

    console.log(JSON.stringify({
      n_total_active_certs: parseInt(total.rows[0]!.n, 10),
      n_profiled: parseInt(profiled.rows[0]!.n, 10),
      n_remaining: parseInt(total.rows[0]!.n, 10) - parseInt(profiled.rows[0]!.n, 10),
      completeness_breakdown: completeness.rows.map((r) => ({ research_completeness: r.rc, count: parseInt(r.n, 10) })),
      recent_profiles: recent.rows.map((r) => ({ ...r, confidence: parseFloat(r.confidence) })),
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CLI dispatch
// ────────────────────────────────────────────────────────────────────────────

function flagVal(name: string): string | null {
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return null;
}

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/profile-builder/operator-profile.ts prepare --cert=<cert_number>
  npx tsx scripts/profile-builder/operator-profile.ts commit  --cert=<cert_number>
  npx tsx scripts/profile-builder/operator-profile.ts status
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") usage();

  if (sub === "prepare") {
    const cert = flagVal("cert");
    if (!cert) usage();
    await cmdPrepare(cert);
  } else if (sub === "commit") {
    const cert = flagVal("cert");
    if (!cert) usage();
    await cmdCommit(cert);
  } else if (sub === "status") {
    await cmdStatus();
  } else {
    usage();
  }
}

// Only run the CLI when this module is invoked directly (e.g. via tsx).
// When imported as a library (by the SDK runner), exports are loaded
// without triggering the CLI dispatch.
import { fileURLToPath } from "node:url";
import { argv as procArgv } from "node:process";
const isEntryPoint = (() => {
  try {
    const me = fileURLToPath(import.meta.url);
    return procArgv[1] === me || procArgv[1]?.endsWith("/operator-profile.ts") || procArgv[1]?.endsWith("/operator-profile.js");
  } catch { return false; }
})();
if (isEntryPoint) {
  void main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ status: "fatal_error", detail: msg }));
    process.exit(99);
  });
}
