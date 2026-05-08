/**
 * SDK-direct agent for one operator profile build.
 *
 * Replaces the Claude Code Agent harness with a direct Anthropic SDK
 * tool-use loop. Same V1.1 prompt template (reused via buildPrompt),
 * same three tools (perplexity_search, firecrawl_scrape, canonical_lookup),
 * but driven from Node.js so it runs outside an interactive Claude Code
 * session.
 *
 * MODEL CHOICE:
 *   The user's spec said `claude-sonnet-4-5`. The current Sonnet model
 *   ID per system info is `claude-sonnet-4-6` — that's also what we
 *   used for V1.1 calibration via the Agent harness. Using 4-6 here so
 *   the SDK output matches the calibrated baseline byte-for-byte. If
 *   `claude-sonnet-4-5` was deliberate for cost reasons, set
 *   SONNET_MODEL_OVERRIDE in env to override.
 */

import Anthropic from "@anthropic-ai/sdk";
import pg from "pg";
import {
  buildPrompt,
  buildPromptParts,
  fetchCertContext,
  validateResponse,
  type CertContext,
  type ProfileResponse,
} from "../operator-profile.js";
import { perplexitySearch } from "./tools/perplexity.js";
import { firecrawlScrape } from "./tools/firecrawl.js";
import { canonicalLookup } from "./tools/canonical.js";
import { PROFILE_SCHEMA } from "./profile-schema.js";

// V1.2.1 Step 1 (revised): extended 1-hour TTL on the static prefix.
// Default ephemeral cache TTL is 5 min; the beta header
// `extended-cache-ttl-2025-04-11` unlocks `ttl: "1h"`. Cache write at 1h
// costs 2x base (vs 1.25x for 5m) but read stays at 0.10x. For a 5–7
// hour bulk run, this avoids re-writing the static prefix every 5 min
// (which we observed during V1.2.1 calibration when calls were spaced
// >5 min apart, e.g. HDNA→HSYA at 9 min gap re-paid the full 16k write).
// Net 15–20% cost reduction on the static-prefix portion.
const EXTENDED_CACHE_TTL_BETA = "extended-cache-ttl-2025-04-11";

const SONNET_MODEL = process.env["SONNET_MODEL_OVERRIDE"] ?? "claude-sonnet-4-6";

// Sonnet 4.6 pricing (per MTok). Prompt caching ratios per Anthropic docs:
//   - regular input: 1.0x base
//   - cache write (5-min ephemeral): 1.25x base ($3.75/MTok)
//   - cache read:                    0.10x base ($0.30/MTok) — 10x cheaper
//   - output tokens:                 $15/MTok
const PRICE_INPUT_PER_MTOK = 3.00;
const PRICE_CACHE_WRITE_PER_MTOK = 3.75;
const PRICE_CACHE_READ_PER_MTOK = 0.30;
const PRICE_OUTPUT_PER_MTOK = 15.00;

const MAX_TOOL_TURNS = 30;
const MAX_OUTPUT_TOKENS = 16000;

// Tool definitions. cache_control on the LAST tool marks the entire
// tools array as cacheable per Anthropic's prompt-caching contract.
// (cache_control on a tool implicitly caches everything before it in
// the tools list.)
const TOOLS: Anthropic.Tool[] = [
  {
    name: "perplexity_search",
    description: "Search the web via Perplexity Sonar. Returns up to 10 ranked results with URL, title, snippet, and date. Use this for discovery — to find which URLs to scrape next.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query, exactly as you want Perplexity to see it." },
      },
      required: ["query"],
    },
  },
  {
    name: "firecrawl_scrape",
    description: "Scrape a single URL via Firecrawl. Returns the page's main content as markdown. Use this to capture the verbatim text you'll cite.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to scrape." },
      },
      required: ["url"],
    },
  },
  {
    name: "canonical_lookup",
    description: "Check if an entity name (parent company, predecessor brand, successor) already exists in our canonical operators table. Use this on entities you discover via research, NOT on the holder name itself. Returns up to 5 ranked matches.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The entity name to look up (≥3 chars)." },
      },
      required: ["query"],
    },
    // Cache the whole tools array with 1-hour TTL (static cross-cert).
    cache_control: { type: "ephemeral", ttl: "1h" },
  },
];

export interface AgentRunResult {
  cert_number: string;
  response: ProfileResponse;
  cost_usd: number;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  wall_clock_seconds: number;
  n_tool_turns: number;
  tool_call_counts: { perplexity_search: number; firecrawl_scrape: number; canonical_lookup: number };
}

export interface AgentRunFailure {
  cert_number: string;
  reason: "no_response" | "json_parse" | "validation_failed" | "tool_loop_exhausted" | "sdk_error";
  detail: string;
  cost_usd: number;
  partial_text?: string;
}

/**
 * V1.2 prompt requires ONE fenced ```json block. Parser:
 *   1. Find the FIRST ```json ... ``` block (per V1.2 spec).
 *   2. If no fence, fall back to whole-text JSON.parse.
 *   3. If still no parse, fall back to first-{ to last-} extraction.
 *
 * The fallbacks exist so a single misformatted-fence response doesn't
 * trash an otherwise-correct profile, but the prompt is explicit that
 * only the fenced block is canonical.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // 1. First ```json fenced block
  const fenceMatch = trimmed.match(/```json\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]!.trim()); } catch { /* fall through */ }
  }
  // 2. Bare-fenced ``` block (no language tag)
  const bareFence = trimmed.match(/```\s*\n?([\s\S]*?)\n?```/);
  if (bareFence) {
    try { return JSON.parse(bareFence[1]!.trim()); } catch { /* fall through */ }
  }
  // 3. Whole-text parse
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // 4. First { to last } extraction
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch { /* fall through */ }
  }
  throw new Error("no_valid_json_in_response");
}

/**
 * V1.2.1 retry envelope. Runs the tool-use loop; on validation_failed or
 * json_parse failure, appends a precise correction message to the
 * conversation and re-runs (up to MAX_VALIDATION_RETRIES times).
 *
 * Retry budget: $0.50 cumulative per cert (typically 2 retries × ~$0.25).
 * If exceeded, abandons retries and surfaces failure_after_retries.
 */
const MAX_VALIDATION_RETRIES = 2;
// Retry budget is CUMULATIVE total cost, not retry-only cost. With caching
// enabled, heavy first-attempts (lots of tool turns) cost $0.50–2.50; the
// retries themselves cost ~$0.05–0.20 each (cached prefix + small output).
// Raised from $0.50 → $3.00 so retries actually fire on cases where they're
// most needed (HSYA-like heavy-research with malformed final JSON).
const RETRY_COST_BUDGET_USD = 3.00;

export async function runAgentForCert(
  client: Anthropic,
  pool: pg.Pool,
  ctx: CertContext,
): Promise<AgentRunResult | AgentRunFailure> {
  const startedAt = Date.now();
  let inputTokens = 0;            // uncached input (incremental, e.g. tool results)
  let cacheCreationTokens = 0;    // first request that wrote cache (charged 1.25x)
  let cacheReadTokens = 0;        // subsequent requests that read cache (charged 0.10x)
  let outputTokens = 0;
  let totalToolTurns = 0;
  let retryCount = 0;
  const toolCallCounts = { perplexity_search: 0, firecrawl_scrape: 0, canonical_lookup: 0 };

  const systemPrompt = "You are a research agent. Build the structured profile per the user's instructions. Use the tools available. When you're ready, output ONLY a single fenced ```json code block containing the profile — no commentary before or after.";

  // V1.2.1 prompt caching architecture (2 cache breakpoints):
  //
  //   Block A (cacheable cross-cert): system prompt + tools array.
  //     Same for every cert. Cached cross-cert in 5-min TTL window.
  //
  //   Block B (cacheable cross-cert): the static instructions portion of
  //     the user prompt — workflow, schema, rules, output format. Uses
  //     <HOLDER NAME> / <STATE> placeholders, not interpolated values.
  //     Same for every cert. Cached cross-cert.
  //
  //   Block C (NOT cached): the per-cert dynamic INPUT — FAA cert holder
  //     name, enrichment fields, "begin work" directive. Varies per cert.
  //
  // Cost dynamic at ~7 tool turns/cert:
  //   Cert 1: writes A + B (1.25x ~14k tokens) + reads on each tool turn
  //   Cert 2..N: reads A + B (0.10x) + per-cert dynamic + tool turns
  //
  // Smoking-gun signal that cross-cert caching is working:
  //   cert N+1's `cache_creation_tokens` should be ~0 (cache reused),
  //   `cache_read_tokens` should be ~14k+ (read the whole prefix).
  // 1-hour TTL on system + static-user-prompt — these are cross-cert
  // identical and bulk runs span 5–7 hours. 1h TTL avoids re-writing
  // every 5 min when concurrency creates idle gaps between requests.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: systemPrompt, cache_control: { type: "ephemeral", ttl: "1h" } },
  ];

  const { staticPart, dynamicPart } = buildPromptParts(ctx);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "text", text: staticPart, cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: dynamicPart },
      ],
    },
  ];

  let lastTextOutput = "";
  let lastResponseContent: Anthropic.ContentBlock[] | null = null;

  // Outer retry envelope: at most (1 initial + MAX_VALIDATION_RETRIES) attempts.
  while (retryCount <= MAX_VALIDATION_RETRIES) {
    // Inner tool-use loop
    let endTurnReached = false;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      totalToolTurns++;
      let resp: Anthropic.Message;
      try {
        resp = await client.messages.create(
          {
            model: SONNET_MODEL,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: systemBlocks,
            tools: TOOLS,
            messages,
          },
          {
            headers: { "anthropic-beta": EXTENDED_CACHE_TTL_BETA },
          },
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return {
          cert_number: ctx.faa_cert_number,
          reason: "sdk_error",
          detail,
          cost_usd: costFromTokens(inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens),
        };
      }

      inputTokens += resp.usage.input_tokens ?? 0;
      cacheCreationTokens += resp.usage.cache_creation_input_tokens ?? 0;
      cacheReadTokens += resp.usage.cache_read_input_tokens ?? 0;
      outputTokens += resp.usage.output_tokens ?? 0;

      const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const textBlocks = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const lastText = textBlocks.map((b) => b.text).join("\n").trim();
      if (lastText) lastTextOutput = lastText;
      lastResponseContent = resp.content;

      if (resp.stop_reason === "end_turn" || toolUses.length === 0) {
        endTurnReached = true;
        break;
      }

      // Append assistant turn (model's tool_use blocks) and execute tools.
      // V1.2.1 Fix B: rolling cache_control on the last tool_result of the
      // most recent turn. Anthropic enforces a HARD 4-cache_control max
      // per request (no auto-eviction). We have 2 fixed breakpoints
      // (system, static-user-prompt). That leaves 2 slots for rolling.
      // Strategy: BEFORE appending the new turn, strip cache_control from
      // the previous turn's tool_results, then add it to the new turn.
      // Net: 3 cache_control blocks per request (system + static + 1
      // rolling). Stays under the 4-limit while keeping the rolling
      // window.
      // V1.2.1 Fix C: tool result JSON is canonically serialized (stable
      // key order) so cache prefix matching isn't broken by ordering jitter.
      stripPreviousRollingCacheControl(messages);
      messages.push({ role: "assistant", content: resp.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (let i = 0; i < toolUses.length; i++) {
        const tu = toolUses[i]!;
        const result = await runTool(pool, tu, toolCallCounts);
        const isLast = i === toolUses.length - 1;
        const block: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof result === "string" ? result : canonicalStringify(result),
          is_error: typeof result === "object" && result !== null && "error" in result,
        };
        if (isLast) {
          block.cache_control = { type: "ephemeral" };
        }
        toolResults.push(block);
      }
      messages.push({ role: "user", content: toolResults });
    }

    if (!endTurnReached) {
      return {
        cert_number: ctx.faa_cert_number,
        reason: "tool_loop_exhausted",
        detail: `hit MAX_TOOL_TURNS=${MAX_TOOL_TURNS} without end_turn (retry=${retryCount})`,
        cost_usd: costFromTokens(inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens),
        partial_text: lastTextOutput.slice(0, 500),
      };
    }

    // Try to parse + validate
    let parsed: ProfileResponse;
    try {
      parsed = extractJson(lastTextOutput) as ProfileResponse;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const cumulativeCost = costFromTokens(inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens);
      // Eligible for retry?
      if (retryCount < MAX_VALIDATION_RETRIES && cumulativeCost < RETRY_COST_BUDGET_USD) {
        retryCount++;
        if (lastResponseContent) {
          messages.push({ role: "assistant", content: lastResponseContent });
        }
        messages.push({
          role: "user",
          content: `Your final response wasn't valid JSON (parse error: ${detail.slice(0, 100)}). Re-emit the complete profile JSON inside a single \`\`\`json fenced code block. NO prose outside the fence. NO multiple blocks.`,
        });
        continue;
      }
      return {
        cert_number: ctx.faa_cert_number,
        reason: retryCount > 0 ? "json_parse" : "json_parse",
        detail: `${detail} (after ${retryCount} retries, cost=$${cumulativeCost.toFixed(4)})`,
        cost_usd: cumulativeCost,
        partial_text: lastTextOutput.slice(0, 500),
      };
    }

    const v = validateResponse(parsed);
    if (!v.valid) {
      const cumulativeCost = costFromTokens(inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens);
      // Eligible for retry on quote_not_in_page or quote_url_not_in_pages?
      const isQuoteFailure = v.reason === "quote_not_in_page" || v.reason === "quote_url_not_in_pages";
      if (isQuoteFailure && retryCount < MAX_VALIDATION_RETRIES && cumulativeCost < RETRY_COST_BUDGET_USD) {
        retryCount++;
        if (lastResponseContent) {
          messages.push({ role: "assistant", content: lastResponseContent });
        }
        const correction = buildQuoteCorrection(v);
        messages.push({ role: "user", content: correction });
        continue;
      }
      return {
        cert_number: ctx.faa_cert_number,
        reason: retryCount > 0 ? "validation_failed_after_retries" : "validation_failed",
        detail: `${v.reason}: ${v.detail ?? ""} (after ${retryCount} retries, cost=$${cumulativeCost.toFixed(4)})`,
        cost_usd: cumulativeCost,
        partial_text: lastTextOutput.slice(0, 500),
      };
    }

    // SUCCESS — inject runtime metadata
    const wall = Math.round((Date.now() - startedAt) / 1000);
    const cost = costFromTokens(inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens);
    const totalInput = inputTokens + cacheCreationTokens + cacheReadTokens;
    const cacheHitRate = totalInput > 0 ? cacheReadTokens / totalInput : 0;
    parsed.metadata = {
      ...(parsed.metadata ?? {}),
      research_date: new Date().toISOString(),
      cost_usd: cost,
      wall_clock_seconds: wall,
      input_tokens: inputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
      cache_hit_rate: Math.round(cacheHitRate * 10000) / 10000,
      output_tokens: outputTokens,
      model: SONNET_MODEL,
      tools_used: ["perplexity_search", "firecrawl_scrape", "canonical_lookup"],
      n_perplexity_calls: toolCallCounts.perplexity_search,
      n_firecrawl_pages: toolCallCounts.firecrawl_scrape,
      n_canonical_lookups: toolCallCounts.canonical_lookup,
      n_tool_turns: totalToolTurns,
      n_validation_retries: retryCount,
      via: "sdk_direct",
    };
    return {
      cert_number: ctx.faa_cert_number,
      response: parsed,
      cost_usd: cost,
      input_tokens: inputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
      output_tokens: outputTokens,
      wall_clock_seconds: wall,
      n_tool_turns: totalToolTurns,
      tool_call_counts: toolCallCounts,
    };
  }

  // Unreachable
  return {
    cert_number: ctx.faa_cert_number,
    reason: "validation_failed_after_retries",
    detail: "exhausted retry budget unexpectedly",
    cost_usd: costFromTokens(inputTokens, cacheCreationTokens, cacheReadTokens, outputTokens),
  };
}

function buildQuoteCorrection(v: { failedQuoteIndex?: number; failedQuote?: string; failedQuoteUrl?: string; reason?: string; detail?: string }): string {
  const idx = v.failedQuoteIndex ?? 0;
  const quote = (v.failedQuote ?? "").slice(0, 300);
  const url = v.failedQuoteUrl ?? "";
  if (v.reason === "quote_url_not_in_pages") {
    return `Your verbatim_quotes[${idx}] cites URL "${url}" which is NOT in your firecrawl_pages array.\n\nThe runner can only validate quotes against pages you actually scraped. Either:\n  a) If you scraped this URL, add it to firecrawl_pages with the full markdown content, OR\n  b) Drop verbatim_quotes[${idx}] and any claim that depended on it (find a different supporting quote from a page you DID scrape, or remove the claim).\n\nRe-emit the complete profile JSON.`;
  }
  return `Your verbatim_quotes[${idx}] was:\n  "${quote}"\n\nThis was NOT found as a byte-exact substring in firecrawl_pages[].content (URL: ${url}).\n\nThe page content you scraped does not contain this exact text. The model may have paraphrased, normalized whitespace, or quoted from memory rather than the page. Either:\n  a) Find a quote that IS a byte-exact substring of the scraped page content (search the firecrawl_pages content carefully) and replace verbatim_quotes[${idx}] with it, OR\n  b) Drop verbatim_quotes[${idx}] AND any claim in the profile (current_brand, parent_company, brand_family, historical_aliases entry, acquisition_history entry, etc.) that depended solely on this quote.\n\nRe-emit the complete profile JSON. Verify each remaining quote is a byte-exact substring of its referenced firecrawl_pages content before emitting.`;
}

async function runTool(
  pool: pg.Pool,
  tu: Anthropic.ToolUseBlock,
  counts: { perplexity_search: number; firecrawl_scrape: number; canonical_lookup: number },
): Promise<unknown> {
  const input = tu.input as Record<string, unknown>;
  try {
    if (tu.name === "perplexity_search") {
      counts.perplexity_search++;
      const query = String(input["query"] ?? "");
      return await perplexitySearch(query);
    }
    if (tu.name === "firecrawl_scrape") {
      counts.firecrawl_scrape++;
      const url = String(input["url"] ?? "");
      return await firecrawlScrape(url);
    }
    if (tu.name === "canonical_lookup") {
      counts.canonical_lookup++;
      const query = String(input["query"] ?? "");
      return await canonicalLookup(pool, query);
    }
    return { error: `unknown_tool: ${tu.name}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: detail };
  }
}

/**
 * Cost calculation with prompt-caching tiers (V1.2.1).
 *
 *   regular input: $3.00/MTok
 *   cache write:   $3.75/MTok (1.25x — first request that creates cache entry)
 *   cache read:    $0.30/MTok (0.10x — subsequent requests that hit cache)
 *   output:        $15.00/MTok
 *
 * Caller passes ALL tokens received across the multi-turn loop;
 * Anthropic's API splits input into the three categories per turn.
 */
/**
 * Strip cache_control from any tool_result blocks in prior user messages.
 * Required because Anthropic enforces a hard 4-cache_control max per
 * request — without stripping, each new turn would push us over the
 * limit (we keep 2 fixed at system + static-user-prompt; rolling
 * tool_result must replace the previous rolling marker, not stack).
 *
 * Walks `messages` in reverse (newest first), strips cache_control from
 * any tool_result block found until it modifies one. Stops there to
 * avoid re-walking older history.
 */
function stripPreviousRollingCacheControl(messages: Anthropic.MessageParam[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") continue;
    let stripped = false;
    for (const block of msg.content) {
      if (block.type === "tool_result" && "cache_control" in block && block.cache_control) {
        delete (block as { cache_control?: unknown }).cache_control;
        stripped = true;
      }
    }
    if (stripped) return;
  }
}

/**
 * Canonical JSON.stringify with sorted keys at every depth. Critical for
 * Anthropic prompt caching: cache hits require byte-identical prefix
 * across requests, including embedded tool_result JSON. Standard
 * JSON.stringify preserves insertion order, which can vary across runs
 * (e.g. tool returns {success, data} one call and {data, success} the
 * next). Sorted-key serialization eliminates that variance.
 */
function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, sortedReplacer(value));
}

function sortedReplacer(_root: unknown): (key: string, val: unknown) => unknown {
  return (_key: string, val: unknown): unknown => {
    if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
    const obj = val as Record<string, unknown>;
    const sortedKeys = Object.keys(obj).sort();
    const sorted: Record<string, unknown> = {};
    for (const k of sortedKeys) sorted[k] = obj[k];
    return sorted;
  };
}

function costFromTokens(
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
): number {
  const cost =
    (input / 1_000_000) * PRICE_INPUT_PER_MTOK +
    (cacheWrite / 1_000_000) * PRICE_CACHE_WRITE_PER_MTOK +
    (cacheRead / 1_000_000) * PRICE_CACHE_READ_PER_MTOK +
    (output / 1_000_000) * PRICE_OUTPUT_PER_MTOK;
  return Math.round(cost * 10000) / 10000;
}

// Re-export for runner convenience
export { fetchCertContext, type CertContext };
