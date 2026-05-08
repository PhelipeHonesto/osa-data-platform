/**
 * JSON schema for Anthropic Structured Outputs (V1.2.1).
 *
 * Tested with beta header `anthropic-beta: structured-outputs-2025-11-13`
 * which (per docs) unlocks maxItems / maxLength / pattern that the GA
 * version dropped. We use those to constrain output size:
 *   - verbatim_quotes: maxItems=8 (was producing up to 23 in V1.2.1 calibration)
 *   - each quote: maxLength=300 (was producing 500–800 char paragraphs)
 *   - metadata.cross_source_check: maxLength=500 (was free-form, sometimes 1k+)
 *
 * Anthropic API constraints retained from V1.2 attempt:
 *   - `additionalProperties: false` is REQUIRED on every object type.
 *   - Optional-parameter limit: 24 across all tool schemas + output schema.
 *     Schema below has every field required (anyOf-null for nullable values),
 *     so optional count = 0.
 *   - Use `anyOf` instead of `oneOf` for unions.
 *
 * If the API 400s on "compiled grammar too large" again, the runner
 * surfaces the failure and we move to Step 2 (Batch API) without falling
 * back to prompt-level constraints (quality risk per Phelipe's call).
 */

const stringOrNull = { anyOf: [{ type: "string" }, { type: "null" }] };

export const PROFILE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    legal_name: { type: "string" },
    dba_name: stringOrNull,
    current_brand: stringOrNull,
    parent_company: stringOrNull,
    brand_family: stringOrNull,

    historical_aliases: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          alias: { type: "string", maxLength: 200 },
          alias_type: { type: "string" },
          valid_from: stringOrNull,
          valid_to: stringOrNull,
          source_url: { type: "string", maxLength: 300 },
          quote: { type: "string", maxLength: 300 },
          supports_claim: { type: "string", maxLength: 200 },
        },
        required: ["alias", "alias_type", "valid_from", "valid_to", "source_url", "quote", "supports_claim"],
      },
    },

    predecessor_certs: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          cert_number: stringOrNull,
          name: { type: "string", maxLength: 200 },
          succeeded_at: stringOrNull,
          source_url: { type: "string", maxLength: 300 },
          quote: { type: "string", maxLength: 300 },
        },
        required: ["cert_number", "name", "succeeded_at", "source_url", "quote"],
      },
    },

    sister_certs: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          cert_number: stringOrNull,
          name: { type: "string", maxLength: 200 },
          relationship: { type: "string" },
          source_url: { type: "string", maxLength: 300 },
          quote: { type: "string", maxLength: 300 },
        },
        required: ["cert_number", "name", "relationship", "source_url", "quote"],
      },
    },

    acquisition_history: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          event_type: { type: "string" },
          counterparty: { type: "string", maxLength: 200 },
          counterparty_canonical_id: stringOrNull,
          event_date: stringOrNull,
          source_url: { type: "string", maxLength: 300 },
          quote: { type: "string", maxLength: 300 },
        },
        required: ["event_type", "counterparty", "counterparty_canonical_id", "event_date", "source_url", "quote"],
      },
    },

    perplexity_queries: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", maxLength: 200 },
          n_results: { type: "integer" },
        },
        required: ["query", "n_results"],
      },
    },

    firecrawl_pages: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", maxLength: 500 },
          content: { type: "string" },
          fetched_at: { type: "string" },
        },
        required: ["url", "content", "fetched_at"],
      },
    },

    // V1.2.1 hard cap: verbatim_quotes was producing up to 23 entries with
    // 500–800 char paragraph quotes. Cap to 8 quotes × 300 chars each.
    // The model should prioritize the most load-bearing quotes per claim.
    verbatim_quotes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", maxLength: 500 },
          quote: { type: "string", maxLength: 300 },
          supports_claim: { type: "string", maxLength: 200 },
          claim_path: { type: "string", maxLength: 100 },
        },
        required: ["url", "quote", "supports_claim", "claim_path"],
      },
    },

    confidence: { type: "number" },
    research_completeness: {
      type: "string",
      enum: ["thin", "partial", "complete"],
    },

    // metadata: agent fills only `notes` (free-text for any conflicts /
    // uncertainty). The runner overwrites the canonical runtime fields
    // (cost_usd, wall_clock_seconds, model, tool counts, etc.) post-parse.
    // Schema keeps it minimal to stay under the 24-optional limit.
    // metadata: agent fills `notes` (free-text, capped) and
    // `cross_source_check` (V1.2.1 Step 6 audit summary, capped). The
    // runner overwrites the canonical runtime fields (cost_usd, tokens,
    // model, etc.) post-parse.
    metadata: {
      type: "object",
      additionalProperties: false,
      properties: {
        notes: { type: "string", maxLength: 600 },
        cross_source_check: { type: "string", maxLength: 500 },
      },
      required: ["notes", "cross_source_check"],
    },
  },
  required: [
    "legal_name",
    "dba_name",
    "current_brand",
    "parent_company",
    "brand_family",
    "historical_aliases",
    "predecessor_certs",
    "sister_certs",
    "acquisition_history",
    "perplexity_queries",
    "firecrawl_pages",
    "verbatim_quotes",
    "confidence",
    "research_completeness",
    "metadata",
  ],
};
