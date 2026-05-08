# Profile-builder roadmap

Living doc tracking the architectural state of the operator profile-builder
and the deferred upgrades. Updated by Claude Code per Phelipe's direction.

## Current state — V1.2 (2026-05-07)

**Architecture**

```
canonical.certificates  →  fetchCertContext()  →  buildPrompt(ctx)
                                                         ↓
                                                      Sonnet 4.6 (Anthropic SDK)
                                                  with Structured Outputs (JSON schema)
                                                         ↓
                                              ┌──────────┼──────────┐
                                       perplexity_search  firecrawl_scrape  canonical_lookup
                                       (Perplexity Sonar) (Firecrawl /v1/scrape) (local pg query)
                                                         ↓
                                                   ProfileResponse
                                                         ↓
                                                   validateResponse()
                                                         ↓
                                                   upsertProfile()
                                                         ↓
                                                public.operator_profiles
                                                (architectural_status='provisional_profile_v1')
```

**V1.2 changes from V1.1:**
- `current_brand` definition pinned with NetJets/Summit/Vista/Western Air Charter examples
- VERBATIM RULE block added (no paraphrase, no smart-quote substitution, drop the claim before fabricating)
- Anthropic Structured Outputs replacing markdown-JSON extraction (eliminates parse-failure class)
- SDK runner replaces Claude Code Agent harness (autonomous, not session-bound)

**Calibration baseline:** 169 profiles built via Claude Code Agent harness
under V1.1 (mixed Sonnet 4.6 / Opus 4.7). V1.2 calibrates on 5 of those certs
to verify SDK + Structured Outputs harness produces equivalent structural ER.

## Deferred upgrades — Phase 8

These are real wins but require failure-mode data from the full V1.2 universe
run before scoping. Don't implement until we have ≥1,000 V1.2 profiles in DB.

### Multi-agent decomposition
Split the single profile-build agent into specialists:
- Discovery agent (Perplexity-only, returns ranked URL list)
- Research agent (Firecrawl-only, scrapes the URLs and returns structured evidence)
- Synthesis agent (no tools, takes evidence and emits ProfileResponse)

**Why deferred:** the V1.2 single-agent architecture works. Multi-agent
adds complexity (3x API calls, coordination overhead) and we don't yet have
data showing where the single agent fails systematically. Build on observed
failures, not speculation.

### Multi-model cascade Haiku → Sonnet → Opus
Try the cheapest model first; escalate only on validation failure or low
confidence:
- Haiku 4.5 first attempt (~$0.005/profile)
- If validation fails or confidence < 0.5 → Sonnet 4.6 retry (~$0.05)
- If Sonnet still fails or confidence < 0.4 → Opus 4.7 final (~$0.30)

**Why deferred:** the V1.2 single-Sonnet baseline averages ~$0.05/profile.
Cascade complexity is justified only if Haiku handles ≥30% of cases cleanly.
Need to measure that empirically.

### Iteration loop on thin/partial cases
For `research_completeness ∈ {thin, partial}`, retry once with:
- A redirected Perplexity query targeting the specific information gap
- A confidence-weighted prompt: "you said partial; here's another shot"

**Why deferred:** V1.1 produced ~3% partial / ~3% thin. Worth optimizing only
if the V1.2 universe run shows the partial/thin rate stays in that range AND
the partial/thin certs cluster on patterns we can target (e.g., recently-rebranded,
small operators with no web presence, defunct).

### Anthropic Structured Outputs — TRIED, DIDN'T FIT (V1.2 attempt 2026-05-07)

Tried wiring `output_config: { format: { type: "json_schema", schema: PROFILE_SCHEMA } }` into the Sonnet 4.6 `messages.create` call to eliminate JSON-parse failures.

Two API constraints blocked the schema as designed:

1. **`additionalProperties: true` not supported** — every nested object in the schema must declare `additionalProperties: false`. Required listing every legal field for every nested array item (historical_aliases, predecessor_certs, sister_certs, acquisition_history, perplexity_queries, firecrawl_pages, verbatim_quotes, metadata).

2. **24 optional-parameter limit across all tool + output schemas** — exceeded with 38 optionals when fields were marked optional. Worked around by making every field required and using `anyOf: [string, null]` for nullable values.

3. **Compiled grammar size limit** — even with all fields required (0 optionals), the combined grammar from 3 tool schemas + the 7-nested-object output schema exceeded the API's grammar-size budget. Returned 400 "compiled grammar is too large".

**Why deferred:** the V1.1 calibration showed only 1 parse failure in 5 (HSYA at $2.40 wasted). At the V1.1 production scale (169 profiles), HSYA was the only json_parse failure observed — ~0.6% rate. The prompt-driven OUTPUT FORMAT block + robust fenced-extraction parser is sufficient.

**Two-phase approach (tool loop unconstrained, final formatting call constrained)** deferred — costs ~+$0.02/profile (+$40 on full bulk) and adds an API roundtrip. Only worth it if HSYA-class failures prove >5% at scale.

**Schema flattening (arrays of strings instead of arrays of objects)** rejected — defeats profile-first ER architecture by losing the structured JSONB queryability.

`scripts/profile-builder/sdk/profile-schema.ts` is preserved as reference for the next attempt (e.g., when Anthropic raises the grammar limit, or for a tools-less formatting-only call).

### Sonar as research layer — REJECTED
Considered: use Perplexity Sonar's synthesized answer (not just URLs) as
direct evidence in the profile, skipping Firecrawl.

**Why rejected:** CJR study (Q4 2025) measured 37% citation hallucination rate
for Sonar's synthesized answers — Sonar fabricates citations that look real
but don't exist on the cited page. Our current architecture (Perplexity for
URL discovery → Firecrawl for verbatim capture → Sonnet for reasoning over
captured evidence) is structurally stronger because verbatim_quotes are
byte-checked against actual scraped content. We'd lose the anti-hallucination
backstop by trusting Sonar's synthesis directly.

## Lifecycle states (architectural_status)

- `provisional_profile_v1` — current default; LLM-asserted with citations,
  not yet curated
- `review_pending` — flagged for human review (post-V1.2 followup)
- `curated` — human-reviewed and promoted to authoritative
- `superseded` — replaced by a newer version (V2+)

## Where canonical lineage lives

- LLM claims (verbatim citations + agent inference) → `public.operator_profiles`
- Curated relational lineage → `canonical.certificate_events`,
  `canonical.operator_brand_membership`, etc.
- Curation pass = post-V1.2 followup; SQL views project profile JSONB into
  canonical structured tables once corroborated.

## Tracking

| Date       | Version | Cohort built | Notes |
|------------|---------|--------------|-------|
| 2026-05-06 | V1   pre-calibration | 3 (eval calibration: B8MA, W6JA, VQMA) | Schema design + first profiles |
| 2026-05-06 | V1.1 calibration | 5 + top-50 fleet (3 → 50) | canonical_lookup tool, valid_to convention, 4th Perplexity query |
| 2026-05-06 | V1.1 bulk | 50 → 169 (Claude Code Agent harness) | Halted at 169 by Claude Code rate limit |
| 2026-05-07 | V1.2 SDK | 5 calibration re-run | Structured Outputs, current_brand pin, VERBATIM RULE |
| TBD        | V1.2 bulk | full 1989 universe | Pending V1.2 calibration acceptance |
