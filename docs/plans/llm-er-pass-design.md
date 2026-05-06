# LLM ER pass — design doc

**Status**: v1 — 2026-05-06 (Path A Phase 7, Session A.10)
**Plan**: `/Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md`
**Predecessors**:
- `docs/sessions/2026-05-06-session-a8-close-out.md` (471 NULL-typed → 154 mechanical, 317 LLM ER)
- `docs/sessions/2026-05-06-session-a9-stage5-scaffolding.md` (4 new canonical tables live)

---

## Context

Stage 2 close-out (Phases 1–6) is done across A.7–A.9. The remaining work
is the LLM ER pass itself (Session B). This document specifies how that
pass should run: input scope, output categories, DB write paths, prompt
design, citation validation, Two-Source Rule mechanics, source trust
tiering, failure modes, cost ceiling, and integration with the existing
`scripts/llm-er-pass-firecrawl.ts` driver + `public.operator_llm_er_checkpoint`
table.

**This is planning only.** No code, no schema, no writes. Session B
applies the design.

The pass runs against a queue of operator-resolution cases. For each
case the LLM (via Firecrawl-augmented research) emits a structured
decision that maps to exactly one DB write path. Single-source claims
land in `_pending` sidecar tables; promotion to canonical requires
Two-Source Rule corroboration.

---

## Scope — input queue

The queue combines two cohorts:

**Cohort A — step2c medium-tier residual (351 cases)**
The original LLM ER queue from Track 6 Step 2c.5 Phase 2. Already in
`public.operator_llm_er_checkpoint` with `input_step IN ('step2c',
'step2c.5_phase1_collision')` per migration 2026-04-25-002. Phase 2 ran
a 19-case eval against this cohort; Session B finishes the run.

**Cohort B — A.8 NULL-typed deferrals (317 cases)**
Routed into the queue as Phase 4b (Session B's pre-flight). Each row
carries a reason slug so the prompt knows the context. Per A.8's
session doc:

| sub-cohort | n | reason slug | notes |
|------------|--:|-------------|-------|
| P1 has_ohc_no_may1_attestation | 166 | `p1_d085_seed_no_may1_attestation` | cert in canonical, not in May 1 attestation; LLM verifies operator is currently active |
| P2 single_p2_only | 147 | `p2_apr19_burst_synthetic` | freestanding Apr 19 burst row, no cert link, mostly wyvern/argus/foreign |
| P2 multi_no_safer_sibling | 14 | `p2_apr19_burst_multi` | multiple Apr 19 identities, no safer sibling |
| P3 (Silver Air, Solairus) | 2 | `p3_realfleet_merge_no_canonical_cert` | realfleet operator with no canonical cert; LLM finds the actual FAA cert number |

**Total: 668 cases.** Cost ceiling design (§Cost estimate) targets this
total.

**Phase 4b routing implementation** (Session B pre-flight): a small
script `scripts/route-a8-deferrals-to-llm-er-2026-XX-XX.ts` (NEW) inserts
317 rows into `public.operator_llm_er_checkpoint` with
`input_step` = a new value `a8_null_typed_deferral`. The reason slug
goes into `firecrawl_pages` evidence JSONB at INIT time so the prompt
template can reference it. Add `'a8_null_typed_deferral'` to the
`ELIGIBLE_INPUT_STEPS` constant in `llm-er-pass-firecrawl.ts`.

---

## Output categories — five decisions, five DB write paths

The parent plan calls for five output categories. The existing
`operator_llm_er_checkpoint.llm_decision` enum has four
(`match | new_entity | ambiguous | error`). Rather than alter the enum
(which forces a schema migration), we use `llm_decision_subtype` as the
discriminator within `match` and `new_entity`. The five-category mental
model maps cleanly onto the existing enum:

| Phase 7 category | `llm_decision` | `llm_decision_subtype` | DB write path |
|------------------|----------------|-------------------------|---------------|
| **match** | `match` | `exact_alias` | `INSERT public.operator_identities` (source='llm_firecrawl_research', match_method='llm_firecrawl_alias') + close checkpoint as `committed` |
| **new** | `new_entity` | `distinct_legal_entity` OR `distinct_brand` | `INSERT public.operators` + `INSERT public.operator_identities` |
| **brand_member** | `match` | `subsidiary_of_canonical` | `INSERT canonical.brand_membership_pending` (reason='single_source_brand_finding'); promote to `canonical.operator_brand_membership` when 2nd independent source corroborates |
| **event** | `match` | `rebrand_to_canonical` | `INSERT canonical.operator_event_pending` (event_type='rebrand', reason='single_source_event_finding'); promote to `canonical.operator_events` when 2nd source corroborates |
| **review_human** | `ambiguous` OR `error` | NULL | Status `ready_for_review` only — no canonical writes; manual triage via the existing `--commit` sweep tooling |

**Two consequences**:

1. **No schema migration needed for Phase 7.** The existing schema
   covers all five categories via decision + subtype. Phase 7's
   contribution is the routing logic in the driver, not new columns.

2. **Existing eval results carry forward.** The 19-case Phase 2 eval
   used the same enum. The 84.2% citation validation rate, $0.0468/record
   cost, and 100% visible-mode accuracy from
   `.work/llm-er-pass/er-evaluation-baseline-2026-05-04.md` apply to
   Session B's run as the starting baseline.

**Two enum gaps to close** before Session B:

- The driver's existing subtype enum has `subsidiary_of_canonical` but
  no role-discriminator within it. The LLM should output role in
  evidence JSONB (`brand_role` ∈ {`parent`,`subsidiary`,`sister`,
  `divested`,`dba_only`}); the driver reads it when writing
  `canonical.brand_membership_pending.role`.
- `rebrand_to_canonical` only covers one of the 10 `operator_events`
  event types. The LLM should output `event_type` in evidence JSONB
  (one of `rebrand`/`legal_rename`/`acquisition`/`merger`/`spinoff`/
  `cert_surrender`/`cert_revocation`/`dissolution`/`formation`/
  `aoc_change`); the driver reads it when writing
  `canonical.operator_event_pending.event_type`. See §Event-type
  taxonomy decision below.

---

## Event-type taxonomy decision

The parent plan asked: does the prompt naturally produce
`billing_reroute` / `shell_mask` outputs that aren't in the existing
10-value `operator_events.event_type` CHECK enum?

**Decision: run Session B with the existing 10 types. Do NOT pre-ALTER
the CHECK constraint.**

Rationale:
- Existing 10 cover the structural events the canonical schema models
  today: `rebrand`, `legal_rename`, `acquisition`, `merger`, `spinoff`,
  `cert_surrender`, `cert_revocation`, `dissolution`, `formation`,
  `aoc_change`. These are events with clear FAA/SEC/state-SOS evidence
  paths.
- `billing_reroute` and `shell_mask` are charter-brokerage edge cases
  (Vista America cert consolidations, TAG San Marino AOC shopping)
  surfaced in earlier discussion. They're real but rare. Adding them
  pre-emptively risks the LLM over-using them — a model with 11
  options uses #11 more than expected just because it's there.
- The Session B output has `evidence` JSONB on every row. Any
  attempted LLM output that doesn't fit the 10 types lands as
  `event_type='aoc_change'` (the most generic) with the original
  intended type captured in `evidence.intended_event_type`. Post-hoc
  analysis on Session B's output then decides whether new types are
  warranted.

**Session B-bis (post-Session B)**: if the post-hoc analysis surfaces
≥10 cases of intended_event_type ∈ {`billing_reroute`,`shell_mask`},
propose the ALTER on the CHECK constraint as a separate migration.
Threshold of 10 keeps the schema from chasing one-off edge cases.

The prompt explicitly enumerates the 10 allowed types in its output
schema. The driver's response validator rejects any other value as
`error` (lifecycle: `failed`, retried via the existing retry budget).

---

## Prompt design + iteration plan

### Initial prompt structure

The orchestrator (Claude Code) spawns a subagent (Sonnet 4.6) per case
with Firecrawl MCP access. The prompt has six sections:

1. **Role & objective** — "You are a charter-brokerage entity-resolution
   specialist. For the input record below, decide whether it matches an
   existing canonical operator, is a brand-member of one, represents a
   structural event (rebrand/M&A/cert lifecycle), is a genuinely new
   entity, or requires human review."

2. **Input record** — scraped_name, scraped_source (faa | wyvern |
   argus), source_id, name_as_provided, candidate_matches (top 5
   canonical operators with similarity scores), reason slug
   (the A.8 deferral reason if present, else step2c-derived).

3. **Research budget** — "You have up to 8 Firecrawl page fetches
   ($0.005/page) and one final reasoning step. Spend 1–3 fetches on
   tier-1 sources (FAA registry, SEC, NTSB), 0–2 on tier-2
   (operator's own website), 0–3 on tier-3 (aggregators) IF tier-1
   doesn't conclude."

4. **Output schema** — strict JSON. Required fields:
   - `decision` ∈ {`match`,`new_entity`,`ambiguous`,`error`}
   - `decision_subtype` (when applicable per §Output categories table)
   - `target_operator_id` (when decision=`match`, the chosen canonical UUID)
   - `confidence` ∈ [0.0, 1.0]
   - `citations` — array of `{url, quote_text}` pairs (≥2 from
     distinct domains for non-ambiguous decisions; see §Two-Source Rule)
   - `reasoning` — free text, ≤500 chars
   - `event_type` (when subtype=`rebrand_to_canonical`)
   - `brand_role` (when subtype=`subsidiary_of_canonical`)
   - `intended_event_type` (when LLM wanted a type outside the 10-enum;
     for post-hoc analysis per §Event-type taxonomy decision)

5. **Two-Source Rule reminder** — "For non-ambiguous decisions you must
   cite ≥2 distinct independent publishers (different domains, NOT
   different pages of the same site). Aggregators (BJT, AIN, Corporate
   Jet Investor) collectively count as ONE source. If only one source
   is available, return `decision='ambiguous'` with reasoning."

6. **Failure-mode hints** — "Watch for: recently-renamed operators with
   no web presence yet (likely `ambiguous`); foreign jurisdictions
   without FAA cert (likely `new_entity` with `distinct_brand` subtype);
   defunct operators with stale web pages (likely `match` to canonical
   defunct entity OR `event` with `dissolution` event_type); brand-vs-LLC
   discrimination (e.g. is "Wheels Up Partners LLC" the brand 'Wheels Up'
   or a distinct legal entity? — usually `match` with
   `subsidiary_of_canonical`)."

### Iteration plan

Phase 2's eval (19 cases, 100% visible accuracy, 88.9% hidden, 84.2%
citation validated) is the baseline. Session B targets:
- **Visible accuracy ≥ 95%** (matches when truth is in candidate set).
- **Hidden accuracy ≥ 85%** (new_entity when truth is removed).
- **Citation validation ≥ 90%** post-fix-pass (better than the 84.2%
  baseline).
- **Auto-approve rate ≥ 60%** at confidence ≥ 0.75 threshold (rest go to
  ready_for_review for human triage).

**Iteration loop**:
1. Run 30-case calibration batch from `scripts/fixtures/llm-eval-holdout-30.json`
   (existing fixture used in eval mode).
2. If metrics below target, edit prompt and re-run the SAME 30 cases.
3. Once metrics hold for two consecutive iterations, commit the prompt
   text into the driver as a versioned constant (e.g.
   `LLM_ER_PROMPT_V3`) with the iteration history in the commit message.
4. Run the full 668-case batch.

The 30-case fixture uses a stratified mix: visible-mode (truth in
candidates), hidden-mode (truth removed), known rebrand cases (Tradewind
Charter LLC → Tradewind Aviation, etc.), known subsidiaries (Wheels Up
Partners LLC, JetRight Aerospace Holdings), known foreign operators
(Acropolis Aviation Ltd), known defunct operators. The fixture composition
is in `scripts/fixtures/llm-eval-holdout-30.json` (already exists).

---

## Citation validation as automated gate

Every Session B response carries `llm_evidence.citations` — an array of
`{url, quote_text}` pairs. The validator:

1. **URL fetch check**. Every cited URL must appear in the row's
   `firecrawl_pages` JSONB. Mismatch → `citation_validated=false`.
2. **Verbatim quote check**. The quote_text must be a substring of
   the corresponding `firecrawl_pages[i].content` (after trim +
   whitespace-fold). Substring mismatch → `citation_validated=false`.
3. **Independence check**. For non-ambiguous decisions, at least 2
   citations must be from distinct domains. Violation →
   `citation_validated=false`.

Only rows with `citation_validated=true` are eligible for auto-approve
on `--commit`. The remaining rows route to `ready_for_review` regardless
of confidence score.

**Recovery from validation miss**: the driver's existing retry budget
(default 3) re-runs the LLM with a feedback line: "Your previous
response failed citation validation: [specific reason]. Re-do with
verbatim quotes from the pages you actually fetched." Phase 2 eval saw
the post-fix rate jump from 84.2% to 100% on the post-fix subset
(`.work/llm-er-pass/er-evaluation-baseline-2026-05-04.md`).

**False-positive risk**: a citation that's verbatim but pulled from a
page the LLM didn't fetch (e.g. memorized from training data) would
pass URL-fetch + verbatim-quote checks. Mitigation: the
`firecrawl_pages.content_hash` is a SHA-256 of the page content as
fetched at decision time. The validator re-hashes the cited content
slice; if the hash range doesn't intersect the page's hash, flag
suspicious. This is a Session B-bis enhancement; not blocking the
initial run.

---

## Two-Source Rule mechanics

The Two-Source Rule (per `docs/er-architecture-plan.md`) requires
2+ independent publishers for any entity-changing claim. The LLM
counts as ONE source — its outputs are treated as a single inference
regardless of how many pages it cited.

**Independence test** (driver-enforced):
- Two URLs from `faa.gov` and `registry.faa.gov` → ONE source (same
  publisher, different sub-properties).
- Two URLs from `corporatejetinvestor.com` and `bjtonline.com` → ONE
  source (LLM aggregators collectively).
- Two URLs from `faa.gov` and `sec.gov` → TWO sources.
- Two URLs from `faa.gov` and the operator's own site → TWO sources.

The independence test is implemented as a domain-bucketing function in
the driver (extends the existing `validateLLMResponse`). Bucket map:

```typescript
const SOURCE_BUCKETS = new Map<string, string>([
  // Tier 1 — public authoritative (each domain its own bucket)
  ["faa.gov", "tier1_faa"],
  ["registry.faa.gov", "tier1_faa"],
  ["av-info.faa.gov", "tier1_faa"],
  ["ntsb.gov", "tier1_ntsb"],
  ["data.ntsb.gov", "tier1_ntsb"],
  ["sec.gov", "tier1_sec"],
  ["www.sec.gov", "tier1_sec"],
  // Tier 2 — operator self-published (one bucket per operator domain)
  // (resolved at runtime via root-domain extraction)
  // Tier 3 — aggregators (collectively one bucket)
  ["corporatejetinvestor.com", "tier3_aggregator"],
  ["bjtonline.com", "tier3_aggregator"],
  ["ainonline.com", "tier3_aggregator"],
  ["aviationweek.com", "tier3_aggregator"],
  ["flightglobal.com", "tier3_aggregator"],
  ["loudhawk.com", "tier3_aggregator"],
]);
```

**Two-Source enforcement is at the DECISION level, not the WRITE level.**
The validator counts buckets across `citations`. If the count is < 2
distinct buckets, the decision fails validation regardless of citation
count.

**Pending-table writes are SINGLE-SOURCE by design**:
- `canonical.brand_membership_pending` — single LLM finding.
- `canonical.operator_event_pending` — single LLM finding.

These tables exist precisely to hold single-source claims durably while
waiting for a second independent source. A separate ingestion pass
(future work, not Session B) corroborates by INSERTing into
`canonical.operator_brand_membership` / `canonical.operator_events`
proper and setting the pending row's `resolved_at` + `resolved_to_*_id`.

For Session B: every brand_member or event decision lands in pending
with `confidence < 0.70` (regardless of LLM-reported confidence — the
pending-write logic floors confidence at 0.69). This signals downstream
that the claim awaits second-source corroboration.

For match and new decisions, two distinct buckets ARE required — these
are direct writes to `public.operators` / `public.operator_identities`,
which are not _pending tables.

---

## Source trust tiering

| tier | sources | trust | LLM ER role |
|------|---------|-------|-------------|
| **Tier 1** | faa.gov, ntsb.gov, sec.gov, state SOS portals | A (authoritative) | Highest trust. One Tier-1 citation can satisfy the second-source requirement when paired with any other tier. |
| **Tier 2** | operator's own website, official press releases on operator domain | B (claimant-self-disclosure) | Medium trust. One Tier-2 cite + one Tier-1 cite = Two-Source satisfied. Two Tier-2 cites alone = single source (the operator). |
| **Tier 3** | Corporate Jet Investor, BJT, AIN, Aviation Week, FlightGlobal, Loud Hawk, generic Firecrawl-search results | C (aggregator) | Low trust. Aggregators COLLECTIVELY count as one source per parent plan. Two Tier-3 cites alone = single source. |

The `SOURCE_BUCKETS` map above implements this. Tier 2 is resolved at
runtime: the citation URL's root domain is checked against
`canonical.operators.canonical_name` (or operator_aliases) — if it
matches a known operator-self-domain, it's tier 2 with a unique bucket
per operator; otherwise it falls back to tier 3.

**Edge case**: state SOS portals are Tier 1 but only for state-of-
incorporation entity claims (formation, dissolution, M&A filings). For
charter-brokerage cert questions, a state SOS hit is supplementary; the
Tier-1 evidence path is FAA. The prompt instructs the LLM to prefer
state SOS for entity-existence questions and FAA for cert/operations
questions.

---

## Failure mode catalog

The Phase 2 eval surfaced these recurring failure patterns. Session B's
prompt addresses each explicitly.

### F1. Recently-renamed operators with no web presence yet

**Symptom**: scraped_name appears in faa_operators but no aviation press
or operator-self site mentions it. LLM returns `decision='match'` to a
plausible candidate based on name similarity, but the candidate is
actually the predecessor.

**Mitigation**: prompt explicitly asks for the cert-issuance date and
checks recency. If the cert was issued in the last 90 days AND no Tier
1/2 source mentions the operator by name, return `ambiguous` with reason
`'recent_rename_no_corroborating_publisher'`.

### F2. Foreign markets without FAA cert

**Symptom**: scraped_name is a foreign operator (Acropolis Aviation Ltd,
Aerolineas Ejecutivas SA de CV) with NO FAA cert. The prompt's
candidate set is FAA-tilted, so all candidates are wrong.

**Mitigation**: the prompt's input record includes a flag if the source
is wyvern/argus and no faa identity exists. The LLM is instructed to
default to `new_entity` with `distinct_brand` subtype for foreign
operators rather than forcing a (wrong) FAA-cert match.

### F3. Brand-vs-LLC discrimination

**Symptom**: scraped_name is "Wheels Up Partners LLC" or "JetRight
Aerospace Holdings, LLC". These are subsidiary legal entities under a
brand parent. LLM either matches to the parent brand (correct) OR
creates a `new_entity` (wrong, scatters the brand).

**Mitigation**: prompt provides explicit examples in the failure-mode
hints section. The LLM should recognize the LLC/Inc/Holdings/Partners
suffix patterns + name overlap with a candidate as a strong signal for
`subsidiary_of_canonical`. Output flow:
```
decision='match'
decision_subtype='subsidiary_of_canonical'
target_operator_id=<parent UUID>
brand_role='subsidiary'  (in evidence JSONB)
```
which lands a row in `canonical.brand_membership_pending`.

### F4. Defunct operators with stale web pages

**Symptom**: Wikipedia or aviation-press article describes the operator
as currently active, but FAA cert is surrendered/revoked. LLM defaults
to active-operator framing.

**Mitigation**: prompt tells the LLM to check FAA cert status first
(faa.gov registry inquiry) before reading any aviation press. If FAA
shows surrendered/revoked, the decision_subtype is
`rebrand_to_canonical` (writing operator_event_pending with
event_type='cert_surrender' or 'cert_revocation' or 'dissolution') OR
`exact_alias` to the canonical defunct operator (if one exists).

### F5. P3 zero-ohc operators (Silver Air, Solairus)

**New for Session B** — the 2 P3 operators have 0 ohc rows in canonical.
The prompt's input record includes an explicit flag
`zero_canonical_cert=true`. The LLM is instructed to find the actual
FAA cert number via faa.gov registry inquiry, then output
`decision='match'` with `decision_subtype='exact_alias'` AND
`evidence.found_canonical_cert_number` populated. Phase 4a-bis (post-
Session B) inserts the missing cert + ohc using that cert number.

### F6. Single-source corroboration gap

**Symptom**: LLM finds one strong Tier-1 source for a non-ambiguous
decision but no second source. Two-Source Rule fails.

**Mitigation** (driver-enforced): the validator returns `ambiguous`
even if the LLM returned a strong decision, when independence test
fails. This is the right call — single-source claims for direct writes
to `public.operators` would skip the Two-Source Rule. For brand_member
and event decisions, single-source is acceptable (lands in pending),
so the validator distinguishes write paths and only enforces the
2-source rule for direct writes.

---

## Cost estimate

**Phase 2 baseline** (19 cases, 2026-04-25):
- Total cost: $0.89
- Per-record average: $0.0468
- Citation validation: 84.2% first-pass, 100% post-fix-pass

**Session B projection**:

| Component | Per-record | Total (668 cases) |
|-----------|-----------:|------------------:|
| LLM tokens (Sonnet 4.6) | $0.025 | $16.70 |
| Firecrawl scrapes (avg 4 pages × $0.005) | $0.020 | $13.36 |
| Retry overhead (15% rerun) | $0.007 | $4.51 |
| **Subtotal** | **$0.052** | **$34.57** |
| 30-case prompt-iteration calibration | n/a | $1.56 (30 × $0.052) |
| **Total Session B budget** | | **~$36** |

**Budget cap**: $50 (provides ~40% cushion over projection). The driver
has `DEFAULT_BUDGET_CAP_USD = 300` already — Session B can use a tighter
local cap via the existing `--budget-cap` flag.

**Post-fix re-run cost**: if citation validation post-fix rate drops
below 90% (Phase 2 hit 100% post-fix on its corpus), worst-case 668 ×
15% = 100 reruns × $0.052 = $5.20 additional. Still inside budget.

**What this estimate excludes**:
- Manual review time for `ready_for_review` rows. Estimated 668 × 40% =
  ~267 rows go to review (auto-approve target is ≥60%). At 1–2 minutes
  per row, that's 4–9 hours of human time, not LLM cost.
- The 30-case prompt-iteration loop assumes 2 iterations to lock the
  prompt. If 4+ iterations needed, add ~$3 per iteration.

---

## Integration with `public.operator_llm_er_checkpoint`

The existing checkpoint table covers Session B's needs. No schema
changes required. Lifecycle stays:

```
queued → in_progress → completed → (ready_for_review | committed) | failed
```

**Per-row evidence shape** post-Session-B (`llm_evidence` JSONB):

```json
{
  "model": "claude-sonnet-4-6-20260301",
  "scraped_at": "2026-05-XX T XX:XX:XX Z",
  "verbatim_quotes": [
    {"url": "https://registry.faa.gov/aircraftinquiry/...", "quote": "..."},
    {"url": "https://wheelsup.com/about", "quote": "..."}
  ],
  "reasoning": "FAA registry shows Wheels Up Partners LLC as the cert holder ...",
  "decision_subtype_extras": {
    "brand_role": "subsidiary",                    // when subtype='subsidiary_of_canonical'
    "event_type": "rebrand",                       // when subtype='rebrand_to_canonical'
    "intended_event_type": "billing_reroute",      // when LLM wanted out-of-enum type
    "found_canonical_cert_number": "SLH"           // when input had zero_canonical_cert flag
  }
}
```

**Per-row firecrawl_pages shape**:

```json
[
  {"url": "...", "fetched_at": "...", "content_hash": "sha256:...", "content_length": 12345},
  ...
]
```

**ground_truth_outcome column** (added 2026-05-04, migration 001) gets
populated post-`--commit`:
- `confirmed_match` / `confirmed_new_entity` / `confirmed_ambiguous` —
  reviewer agreed with LLM.
- `reviewer_overrode_to_match` / etc. — reviewer disagreed.

This becomes the substrate for the post-Session-B calibration analysis
(reliability diagrams, temperature scaling). The 19-case Phase 2 eval
already validated the calibration framework
(`.work/llm-er-pass/er-evaluation-baseline-2026-05-04.md` §2).

---

## Session B execution checklist

### Pre-flight (one-shot)

1. Run the existing `npm run db:migrate-pg` against Supabase. Should be
   no-op (Phases 5–6 already applied the schema in A.9).
2. Write `scripts/route-a8-deferrals-to-llm-er-2026-XX-XX.ts` that
   inserts 317 rows into `operator_llm_er_checkpoint` with
   `input_step='a8_null_typed_deferral'` and the appropriate reason
   slug per A.8 sub-cohort. Defaults to `--dry-run`; `--write`
   commits in a single transaction with row-count assertion.
3. Add `'a8_null_typed_deferral'` to `ELIGIBLE_INPUT_STEPS` in
   `scripts/llm-er-pass-firecrawl.ts`.
4. Update the prompt template in `llm-er-pass-firecrawl.ts` per
   §Prompt design + iteration plan. Bump prompt version to `V3`. Commit
   the prompt change before any LLM run so git history matches the
   evidence.commit_sha.
5. Extend `validateLLMResponse` to enforce the §Two-Source Rule
   independence test using `SOURCE_BUCKETS`.
6. Extend the driver's `--commit` write paths so `subsidiary_of_canonical`
   writes to `canonical.brand_membership_pending` and
   `rebrand_to_canonical` writes to `canonical.operator_event_pending`.
   The existing match / new_entity write paths to `public.operators` and
   `public.operator_identities` are unchanged.
7. Run the 30-case prompt-iteration loop. Iterate until visible accuracy
   ≥95% and hidden accuracy ≥85%. Lock the prompt.

### Main run

8. Run the 668-case batch via the existing orchestration loop:
   ```
   while true; do
     work=$(npx tsx scripts/llm-er-pass-firecrawl.ts --claim-next)
     echo "$work" | jq -e '.empty' > /dev/null && break
     # ... spawn agent, capture response, submit
   done
   ```
9. Monitor cost via `SELECT SUM(cost_estimate_usd) FROM
   public.operator_llm_er_checkpoint`. Halt if approaching $50 cap.
10. After all rows reach `status='completed'`:
    - Re-validate citations en masse via a sweep query.
    - Run `--commit --auto-approve-all` for rows with
      `confidence ≥ 0.75` AND `citation_validated=true`.
    - Remaining rows go to `ready_for_review`.

### Post-run

11. Manual triage of `ready_for_review` queue. Populate
    `ground_truth_outcome` for each row.
12. Run calibration analysis script (Session C work — uses
    `er-evaluation` library validated in P.1 baseline doc) over the
    full 668-case ground-truth set.
13. Decide on event-type taxonomy expansion based on
    `intended_event_type` distribution per §Event-type taxonomy
    decision. If ≥10 cases of {billing_reroute, shell_mask}, propose
    ALTER on `canonical.operator_events.event_type` CHECK enum + same
    on `canonical.operator_event_pending.event_type` CHECK enum.
14. Write Session B close-out doc:
    `docs/sessions/2026-05-XX-session-b-llm-er-pass.md`. Cover:
    auto-approve rate, citation validation rate, cost actual,
    per-category outcomes, prompt-iteration history, calibration
    summary, followups.

---

## Out of scope for Session B

Each of these has its own future session.

- **Phase 4a-bis: Silver Air + Solairus cert insertion.** Once Session B
  finds the actual FAA cert numbers (per failure mode F5), a small
  script inserts the missing canonical certs + ohc rows + re-runs A.5
  Phase 3's tag query. Keeps the 154 → 156 mechanical tag count
  honest.
- **Two-Source corroboration sweep.** A future ingestion pass walks
  pending tables and INSERTs into canonical proper when a second
  independent source lands (FAA GENOT, SEC EDGAR, etc.). Not Session B
  work.
- **Calibration / probability scoring.** Session C uses the
  `er-evaluation` library + `ground_truth_outcome` to fit a
  temperature-scaled calibration model. Not Session B.
- **Loud Hawk editorial enrichment loop.** When Loud Hawk publishes a
  rebrand/M&A scoop, the writer-side workflow inserts into
  `canonical.operator_events` directly (post-publication, with
  `source='loud_hawk_<article-slug>'`). The pending-table corroboration
  path also picks up these inserts. Not Session B.
- **dedup-operator-rows.ts FK extension** for the new tables. A.9
  followup.
- **Pre-2026-05-01 ohc close-date investigation.** A.8 followup.

---

## Key decisions surfaced in this design (gate review)

1. **No schema migration for Phase 7.** Existing decision/subtype enum
   covers the 5 categories. Stage 5 schema (A.9) provides the landing
   tables. Routing logic lives in the driver, not in the DB.

2. **Existing 10 event types are sufficient for Session B.** New types
   (`billing_reroute`, `shell_mask`) deferred until post-hoc analysis
   shows ≥10 cases in `intended_event_type`. Threshold prevents
   one-off-driven schema churn.

3. **Single-source brand_member / event findings ARE acceptable** —
   they land in `_pending` tables. Two-Source Rule applies only to
   direct writes (match / new). The pending-table mechanic is
   load-bearing for the LLM's value-add.

4. **The LLM counts as ONE source.** Independence test requires ≥2
   distinct domain buckets in citations for non-ambiguous direct
   writes. Aggregators (BJT, AIN, etc.) collectively are one bucket.

5. **Session B input is 668, not 351.** Phase 4b (A.8 deferrals)
   becomes a Session B pre-flight script, not its own session.

6. **Cost cap $50.** ~$36 projected baseline + cushion. Existing
   driver's $300 default cap stays as the upper bound, but
   Session B sets a local $50 cap.

---

## References

- Parent plan: `/Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md`
- Two-Source Rule: `docs/er-architecture-plan.md`
- Source tiers: `docs/data-sources.md`
- Temporal link pattern: `docs/temporal-link-pattern.md`
- Driver: `scripts/llm-er-pass-firecrawl.ts`
- Checkpoint table: `schema/migrations/2026-04-25-002-operator-llm-er-checkpoint.sql`
- Ground truth column: `schema/migrations/2026-05-04-001-operator-llm-er-checkpoint-ground-truth.sql`
- Phase 2 eval baseline: `.work/llm-er-pass/er-evaluation-baseline-2026-05-04.md`
- Stage 5 landing tables (A.9): `schema/canonical/brand_groups.sql`,
  `schema/canonical/operator_events.sql` (operator_event_pending bundle).
- A.8 NULL-typed deferral cohorts: `docs/sessions/2026-05-06-session-a8-close-out.md`
