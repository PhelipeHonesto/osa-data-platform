# Cross-cutting invariants — 2026-05-04 docs read pass

Generated: 2026-05-04. Companion to `docs/codebase-map.md`.

This document captures the load-bearing invariants distilled from a full read pass over `docs/`. These are the rules that survive across plans — break them and downstream code goes wrong in subtle ways. Each invariant is anchored to its source doc and (where useful) verbatim quote.

---

## Doc inventory under `docs/`

| File | Purpose |
|---|---|
| `er-architecture-plan.md` | Five-entity ER plan + Certificate appendix; build sequence + track status |
| `er/aircraft.md` | Aircraft entity spec; seven-role model; N-number reuse; hex_code as identity |
| `er/certificate.md` | Certificate entity spec; architectural decision logged 2026-04-25, schema deferred |
| `temporal-link-pattern.md` | Canonical write rules for all temporal links; close-then-insert; Two-Source Rule |
| `data-sources.md` | Tier A–E source hierarchy; LinkedIn exclusion (non-negotiable) |
| `data-platform-plan.md` | Transformation / orchestration / tooling direction (dbt, Dagster, AGE deferral) |
| `phase1-followups.md` | Operational debt from Phase 1 (faa-operators-full, operator_aliases, pipeline_runs) |
| `phase-2-eval-summary.md` | Phase 2 LLM ER eval (n=19); four prompt fixes; cost actuals; gate decision |
| `decisions/2026-04-24-adsb-text-timestamps.md` | ADR — adsb_completed_legs TEXT timestamps deferred to Phase 12 |
| `codebase-map.md` | Generated 2026-05-04 — repo layout, schemas, scripts, S3, planner footnotes |
| `invariants-2026-05-04.md` | This file |

---

## The 17 invariants

These are the rules a planner must hold in working memory when designing or executing changes against this repo.

### 1. Temporal-link write discipline

Every cross-entity link table follows the same shape (DATE columns, EXCLUDE constraints on overlapping daterange, append-only except specific columns).

- `valid_from`, `valid_to` are `DATE` — not `TIMESTAMPTZ`.
- `valid_to IS NULL` means "current."
- Append-only, except: `valid_to`, `last_updated_at`, `corroborated_by`, `contradicted_by` may be UPDATEd.
- Relationship changes use **close-then-insert** in a single transaction:
  ```sql
  BEGIN;
  UPDATE ... SET valid_to = '2026-04-15', last_updated_at = NOW()
   WHERE aircraft_id = :id AND role = 'operator' AND valid_to IS NULL;
  INSERT INTO ... (operator_id, aircraft_id, role, valid_from, ...)
  VALUES (:new_operator_id, :id, 'operator', '2026-04-16', NULL, ...);
  COMMIT;
  ```

Source: `docs/temporal-link-pattern.md` §"Write rules" (Rule 1, Rule 2).

### 2. EXCLUDE constraints, not UNIQUE

The non-overlap guarantee is enforced at the database, not in application code.

- Each link table has an `EXCLUDE USING gist (... daterange(valid_from, valid_to, '[)') WITH &&)` constraint.
- **No `ON CONFLICT` triggers.** Writers use a `NOT EXISTS` pre-filter or a refused-if-populated guardrail at the top of the script.
- A duplicate is a code-correctness bug to fix, not a runtime to swallow.

Source: `docs/temporal-link-pattern.md` §"Exclusion vs Unique rationale": *"The exclusion constraint is non-negotiable. Without it, a bad backfill or a duplicate ingest can produce two simultaneous 'operator' windows for the same aircraft, and every downstream query returns ambiguous results. Enforce at the DB, not in code."*

### 3. Two-Source Rule for entity-change events

> "Any INSERT that closes one window and opens another within the same aircraft+role requires evidence from at least two independent sources."

Operationalized for Phase 2 LLM ER as: ≥2 distinct hostnames in `verbatim_quotes`, with ≥1 quote from each cited hostname (per-hostname-quote rule).

Source: `docs/temporal-link-pattern.md` §"Write rules" Rule 3.

### 4. Six-entity discipline

The data platform models six first-class entities, no more:
- Operator (commercial)
- Certificate (legal)
- Aircraft
- FBO
- Airport
- Person

Operator and Certificate are paired but distinct (one operator group may hold multiple certs; one cert may persist across operator brand changes). Link is temporal: `operator_holds_certificate(operator_id, cert_id, valid_from, valid_to, source, evidence)`.

Discipline rule: **No new entity beyond these six until each has a resolution pipeline in place.**

Current status (per `docs/er-architecture-plan.md` build sequence): operator done; aircraft Stage 2a/2b/2c shipped; certificate not started (architectural decision logged 2026-04-25); FBO/Airport/Person not started.

Source: `CLAUDE.md` §3 + `docs/er-architecture-plan.md` §"Build sequence."

### 5. Tier hierarchy non-negotiable

`docs/data-sources.md` defines:
- Tier 1 — Public authoritative (FAA, NTSB, court records)
- Tier 2 — Commercial reference / open data
- Tier 3 — Cross-industry independent (ADS-B, trade press)
- Tier 4 — Deep/specialized (international registries, ch-aviation)

And separately, trust tiers A–E:
- A — public authoritative
- B — operator self-published
- C — cross-industry independent
- D — paid but trustworthy (OpenSanctions, GLEIF, ch-aviation)
- E — suspect (ARGUS, Wyvern, LLM aggregators, broker "market analysis")

ARGUS and Wyvern are Tier E — enrichment-only, never authoritative, never gating.

LinkedIn is excluded entirely (see Invariant 5b).

### 5b. LinkedIn excluded — non-negotiable

> "The LinkedIn User Agreement explicitly prohibits automated access, scraping, and machine-readable ingestion. Confirmed in `hiQ Labs v. LinkedIn` (remanded 2022) — LinkedIn won the ToS-breach claim against hiQ even where the data was publicly visible. LinkedIn's position has hardened since; using it would create a documented contract-breach claim against OSA.
>
> **Non-negotiable.** Do not reopen this decision without written authorization from Phelipe."

For people-entity resolution: SEC filings, FAA airmen, state SOS officer lists, NTSB narratives, press release quotes.

Source: `docs/data-sources.md` §"Excluded sources."

### 6. Seven-role aircraft model

`canonical.operator_aircraft_link.role` enum:
```
legal_owner | beneficial_owner | operator | manager | financier | insurer | broker
```

Each role gets its own daterange window per aircraft. Multiple concurrent rows are normal (an aircraft can have a `legal_owner`, a `beneficial_owner`, and an `operator` simultaneously).

Source: `docs/er/aircraft.md` §"The seven-role model."

### 7. `aircraft_on_certificate` ≠ `operator_aircraft_link role='operator'`

These are semantically different:
- `canonical.aircraft_on_certificate` = "this aircraft is *authorized on* this cert."
- `canonical.operator_aircraft_link role='operator'` = "this operator *currently flies* this aircraft."

Authorization does not imply current operation (an aircraft on a cert may sit on the ground for months). The cert-bridge derivation (current plan Session A) joins them: cert authorization × cert holder = projected current operator.

Source: `docs/er/aircraft.md` and `docs/er/certificate.md`.

### 8. Step 2c canonical false-positives are real

The Step 2c backfill (operator_holds_certificate from D085) has known false-positive risk on look-alike operator names — flagged in `docs/phase-2-eval-summary.md` case 4 (Executive Flight Management vs Executive Jet Management). Future derivations from Step 2c output must spot-check before consuming.

Source: `docs/phase-2-eval-summary.md` case 4 (verbatim): *"Fixture truth label is 'Executive Jet Management' (NetJets/Berkshire Hathaway subsidiary, EJM callsign, large fractional/charter management company). FAA holder is 'Executive Flight Management' (single 1977 Baron 58P, Sugar Grove IL, DBA 'Trans American Charter, Ltd.'). These are genuinely different operators."*

### 9. `operator_aircraft_resolution_log` is permanent canonical

Audit logs are not staging. They live in `canonical/`, not `silver/` or transient tables. Append-only. Keep the lineage forever.

Implication: extending the resolver_action enum is preferred over creating sibling derivation-run tables (one canonical audit log per resolution pathway).

Source: `CLAUDE.md` §3 (canonical-vs-public discipline) + schema/canonical/operator_aircraft_resolution_log.sql.

### 10. Stage 2c v2 cross-pathway corroboration is documented but not implemented

When two pathways independently propose the same `(aircraft_id, role, daterange)`, the current writer behavior is: **first writer wins; second writer logs `skipped_overlap` and does not corroborate.**

The v2 design (cross-pathway corroboration with `corroborated_by` JSONB updates) is documented in `docs/temporal-link-pattern.md` but not implemented. Future writers continue to skip overlap, not corroborate.

### 11. Phase 12 dbt is load-bearing for analytics

`src/analytics/wingx-engine.ts` is frozen. Any join from `canonical.operator_aircraft_link` to `adsb_completed_legs` for agent-facing views is deferred to Phase 12 (dbt marts on properly-staged silver tables).

In the meantime: validation queries use per-row TEXT-timestamp casts; no agent views are added that depend on this join. Current plans (cert-bridge validation, LLM ER post-run summary) do per-row casts inline.

Source: `CLAUDE.md` §2 (`wingx-engine.ts` is frozen) + `docs/decisions/2026-04-24-adsb-text-timestamps.md`.

### 12. Migration verification: 3 steps, any 2 insufficient

> "Every schema change must be verified in three steps, not two. A passing local Docker rollback test proves the SQL is sound. It does NOT prove the schema is live in production. Every migration commit must end with:
>
> 1. Local Docker Postgres up → down → up idempotency test (or equivalent ad-hoc spin-up).
> 2. `npm run db:migrate-pg` against Supabase — the script must exit 0.
> 3. Explicit verification that the new object exists in production, via either `describe-schema` MCP call (for tables in public), direct `psql \d+ canonical.<table>` (for canonical schema objects not visible via describe-schema), or a SELECT against the new object that returns expected shape.
>
> All three. Not any two."

Source: `CLAUDE.md` §4. The rule exists because Stage 2a (2026-04-24) shipped three commits with passing local rollback tests but the Supabase `db:migrate-pg` step was silently dropped between rollback test and commit/push. Missing tables weren't caught for ~6 hours.

### 13. Agent-isolation

Agents in `dumont-agent` read only through Gold MCP views (`schema/gold/views/`). This repo does not ship new agent views in-place — Phase 12 dbt marts are the path. If you write `schema/gold/views/<something>.sql` here, stop and ask whether it should be a dbt mart instead.

Source: `CLAUDE.md` "Out of scope" + `docs/data-platform-plan.md` Phase 12.

### 14. Trust scores surface, never gate

Phase 7 trust scoring is for ranking and UX disclosure, not authorization. Do not filter `WHERE trust_score > X` in canonical-layer code. Filter at the agent view layer if needed.

Source: `CLAUDE.md` §3 (claim provenance + trust score discipline).

### 15. Phase 2 LLM ER requires Firecrawl

`scripts/llm-er-pass-firecrawl.ts` does not have a graceful no-web mode. It hits Firecrawl via Claude Code MCP (`mcp__firecrawl__firecrawl_scrape`), which connects to a local Mac docker stack the user runs. No fallback to "decide without web evidence." If Firecrawl is down, the orchestrator stalls until it comes back up.

Source: orchestrator code + `docs/phase1-followups.md`.

### 16. Auto-approve criteria apply during `--commit`, not Session B

The Phase 2 LLM ER orchestrator has an auto-approve gate (5 conditions), but it runs only during the `--commit` pass. The reason-only `--claim-next` / `--submit-response` loop produces verdicts in `public.operator_llm_er_checkpoint` without writing to canonical.

Auto-approve gate (all five must pass):
1. `llm_decision` ∉ `{ambiguous, error}`
2. `llm_decision_subtype` ≠ `rebrand_to_canonical` (rebrands always surface)
3. `llm_confidence ≥ 0.75`
4. `citation_validated = true`
5. `llm_decision_target` ∉ top-20-by-fleet (high-blast-radius merges always surface)

Source: `scripts/llm-er-pass-firecrawl.ts:1520–1580` (`runCommit()`).

### 17. Permanent gaps and operational debt

The repo has known gaps that planners must respect:
- `scripts/faa-operators-full.ts` is broken (synthesizer pollution: 3,848 of 3,898 rows are FAA-aircraft.certificate_holder strings, not real Part 135 operators). Fix is pre-Phase-2 priority but deferred.
- `public.operator_aliases` is dead infra (1 row after Stage 1 "complete"). Either resolver writes are broken or the table is redundant. Investigation deferred.
- `pipeline_runs` has 2 rows. Pipeline orchestration didn't get wired up after migration. Restore is on the deferred list (Lightsail PM2; manual SSH; decoupled from ER work).

Source: `docs/phase1-followups.md`.

---

## How to use this document

When planning a change:
1. Identify which invariants the change touches.
2. Confirm the change respects each.
3. If it requires breaking one, surface that explicitly in the plan and require user sign-off.

When reviewing this document:
- Invariants 1, 2, 3, 6, 7 are about *how* canonical writes work. They evolve slowly; expect them to hold across most plans.
- Invariants 4, 5, 5b, 14 are about *what* we model and *what* sources we trust. Even slower-evolving.
- Invariants 9, 10, 11, 13, 15, 16 are about *current implementation reality*. They will move as Phase 12 lands and Stage 2c v2 ships. Refresh this doc when those shift.
- Invariants 8, 12, 17 are about *known gotchas and operational debt*. New ones get added to `docs/codebase-map.md` §8 (planner footnotes).
