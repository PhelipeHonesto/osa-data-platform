# OSA Data Platform Plan

**Status**: v0 — 2026-04-19
**Owner**: Phelipe Honesto
**Scope**: Architecture for the data platform that feeds Dumont. Defines how ingestion, transformation, entity resolution, and the operational ontology fit together. Companion to `docs/er-architecture-plan.md` — this document covers the machinery; the ER plan covers the content.
**Related**: `docs/er-architecture-plan.md`, `docs/data-architecture.md`, `docs/phase1-followups.md`, `docs/semantic/operators.yaml`

---

## The problem

OSA is not a charter brokerage with a database. OSA is a data platform that acts as a charter brokerage through Dumont. Data quality — coverage, freshness, resolution accuracy, provenance — is the moat. Without it, Dumont is no better than any other broker system. With it, Dumont is structurally different.

Current state is Level 2.5 on the data-engineering maturity ladder: medallion storage (S3 → Supabase), ingestion scripts with resumability, pipeline-run tracking, data quality assertions, trust scoring, entity resolution. What's missing is the machinery that makes this scale: lineage, declarative transformations, asset-based orchestration, and the operational ontology that lets Dumont invoke actions directly rather than querying and deciding.

The dataset is going to grow substantially — from 271 operators to ~3,000+ entities across operators, brokers, financiers, holdings, aircraft, accidents, and events. The platform needs to be ready to absorb FAA GENOT, SEC EDGAR, state registries, OpenSanctions, international AOC registries, NTSB accident feeds, and per-aircraft ADS-B telemetry at daily cadence. Every new source multiplies integration complexity without proper architecture.

## The thesis

**The ontology is the operational interface, not a schema.** Palantir's insight: an AI agent doesn't query data and then decide — the ontology itself is the interface through which operations happen. Dumont should invoke typed actions (`request_quote`, `merge_operators`, `flag_funnel_broker`) directly against the ontology. Actions carry provenance, permissions, and reversibility built in. This is the architectural difference between a data platform Dumont queries and a data platform Dumont is a citizen of.

**The modern open-source data stack has converged.** Dagster for asset-based orchestration. dbt for declarative SQL transformations. Postgres for storage. Great Expectations-style assertions for data quality. Neo4j / Apache AGE / Kùzu for graph queries when scale demands. Every production-grade small-team platform in 2026 looks approximately the same.

**What stays custom is what makes OSA defensible.** Ingestion of aviation-specific sources, entity resolution, multi-source verification, Dumont's agent logic, the operational ontology itself. The generic parts (transform layer, orchestration, tests) use off-the-shelf tools because they're solved problems.

## Non-goals

- **Not adopting dbt Cloud.** dbt Core is sufficient and keeps us in our own environment with our own scheduling. dbt Cloud's UI is not worth the subscription or the lock-in.
- **Not adopting Airflow.** Dagster's asset-first model aligns better with the medallion architecture we already have. Airflow is task-first, older, heavier.
- **Not rebuilding what works.** PipelineRunner, data quality assertions, trust scoring, entity resolution, the medallion schema — all stay. The platform plan augments, does not replace.
- **Not introducing LangChain / LlamaIndex abstractions.** Direct MCP tool use + Anthropic SDK is the forward direction. Adding heavy agent frameworks is the retreating direction.
- **Not scraping sources that forbid it.** LinkedIn, gated databases, anything whose ToS prohibits machine access. Platform layer inherits this constraint from the ER plan.
- **Not optimizing for team scale we don't have.** Solo-founder economics guide tool selection. A €200/month open-source stack beats a $5,000/month managed stack until the team exceeds three.

## Target architecture

Five layers, top to bottom:

**Serving layer** — Dumont (MCP tools + ontology actions), programmatic SEO route pages, Loud Hawk editorial surfaces, Charter Index API.

**Ontology layer** — Gold canonical entities (Operators, Aircraft, Certificates, Holdings, Accidents, Events) + typed actions (request_quote, merge_operators, flag_funnel) + functions (compute_funnel_ratio, resolve_identity, recompute_trust). This is where Dumont operates, not where it queries.

**Transformation layer** — dbt models for silver→gold business logic and derived analytics marts. Declarative SQL with lineage, tests, incremental materialization. Replaces most inline SQL currently embedded in TypeScript.

**Entity resolution layer** — TypeScript in `src/memory/canonical/`. Matching algorithms, trust scoring, dedup, multi-model verification. Imperative logic with external coordination — wrong shape for dbt, right shape for custom code.

**Ingestion layer** — TypeScript in `src/ingestion/`. FAA registry, NTSB, ADS-B, safety audits, state registries, international AOC. Firecrawl for Tier B/C extraction. Custom because aviation sources are idiosyncratic and rate-limited.

**Storage** — S3 (raw archives), Supabase Postgres (warehouse + ontology), pgvector (embeddings), future graph engine (AGE on Postgres when query patterns demand).

**Orchestration** — Dagster (asset-based DAGs, lineage, scheduling, retries) for new work from Stage 3 forward; existing PipelineRunner stays until pain forces migration.

**Observability** — Sentry (errors), morning report (daily health), dq:check (per-assertion validation), Dagster UI (lineage + materialization history when adopted).

## Tool selection with rationale

**Transformation: dbt Core.** Adopted first for analytics marts (charter index calibration, funnel ratios, derived aggregations). Operational Gold canonical views stay in native SQL migrations until dbt patterns prove themselves. Gradual migration toward dbt-for-everything-downstream-of-silver. Rationale: SQL-first, version-controlled, automatic lineage, industry standard, works natively on Postgres.

**Orchestration: Dagster.** Adopted in parallel starting Stage 3 (FAA GENOT ingestion). Existing pipelines (FAA nightly, ADS-B live, Phase 7 backfill, safety ratings refresh) stay on PipelineRunner until rewrite pays off. Rationale: software-defined assets map to medallion architecture; asset lineage solves what we currently lack; asset-first observability beats task-first scheduling.

**Graph queries: deferred.** Current scale doesn't justify a dedicated graph engine. When needed (Stage 8 in ER plan), Apache AGE on Postgres is the first choice — keeps us on one database. Neo4j only if the neo4j-agent-memory library becomes a strategic dependency. Kùzu considered for read-heavy analytical graphs if AGE performance doesn't hold.

**Storage: Supabase + S3 stays.** Postgres is sufficient for the foreseeable dataset size. Migrating to a cloud warehouse (BigQuery, Snowflake) happens when query patterns exceed Postgres capabilities, not before. Cost profile matters.

**Extraction: Firecrawl stays.** Self-hosted Docker stack covers Tier B/C sources. Not replacing direct FAA/SEC/NTSB feeds where APIs exist.

**Data quality: extend current approach.** `src/ingestion/data-quality/` module grows with more assertions. Evaluate Great Expectations if assertion volume exceeds what custom code handles cleanly. Dagster asset checks cover the transformation layer once adopted.

## Operational ontology pattern

The Gold canonical layer is not just entity storage. It's the operational interface for agents.

**Objects** — Operator, Aircraft, Certificate, Holding, BeneficialOwner, Accident, Broker, Audit. Every object has provenance (sources, confidence, contradictions) and temporal validity.

**Links** — HOLDS_CERT, OPERATES, OWNED_BY, FUNNELS_TO, REBRANDED_TO, CRASHED, AUDITED_BY. Typed edges with their own provenance.

**Actions** — Named operations the ontology exposes: request_quote(operator, route), merge_operators(keep, merge), flag_funnel_broker(broker, evidence), update_trust_score(operator, reason), record_accident(operator, incident). Each action has permissions, validation, audit logging, and reversibility.

**Functions** — Business logic invokable by actions: compute_funnel_ratio(broker_id), resolve_operator_identity(scraped_name, source), recompute_trust_score(operator_id), detect_rebrand_event(old_name, new_name). Functions are testable units; actions orchestrate them.

Dumont's architecture becomes: receive intent → select ontology action → invoke action with parameters → ontology handles validation, execution, provenance, rollback. Not "query, decide, update" but "invoke typed operation on the ontology."

This is the architectural difference between a platform Dumont consumes and a platform Dumont inhabits.

## What stays TypeScript forever

**Ingestion scripts** — FAA registry, NTSB, ADS-B, safety audits, state registries. Aviation sources are idiosyncratic (rate limits, pagination quirks, authentication flows, anti-bot). TypeScript lets us write procedural adapters with proper error handling and retries.

**Entity resolution** — Matching algorithms, trust scoring, dedup, review workflows, multi-model verification. Imperative logic with transaction boundaries, external service coordination, human-in-the-loop review. Wrong shape for dbt.

**Agent logic** — Dumont's reasoning, Guardian's validators, Intake's parsing, Sourcing's scoring. Agent behavior is code, not data transformation.

**MCP tool definitions** — The interface layer between Dumont and the ontology. TypeScript with Zod schemas.

**Ontology actions and functions** — Defined as TypeScript modules that wrap the ontology primitives. Each action is a typed function with validation, audit logging, and transaction boundaries.

## What migrates to dbt

**Staging models** — Silver-layer normalization (faa_aircraft_raw → faa_aircraft_staging with consistent column names and types). Low risk, pure SQL, obvious dbt fit.

**Intermediate models** — Joined, cleaned, deduplicated silver-layer entities ready for canonicalization. Prefix `int_`.

**Analytics marts** — Charter index calibration tables, funnel ratio aggregations, operator activity metrics, route volume trends. Prefix `mart_`. These are the first dbt models to build because they're read-only derived data.

**Gold operational views (later)** — Operator profile views, safety summary views, aircraft detail views that agents read via MCP tools. Migrate from native SQL once dbt patterns are proven. Prefix `gold_`.

**Not migrated** — Entity resolution writes (stay procedural), ingestion writes (stay in TypeScript), action-driven writes (stay in ontology layer).

## Dumont as ontology citizen

Current pattern: Dumont reads via MCP tools that execute SQL against Gold views. Updates happen via imperative TypeScript functions.

Target pattern: Dumont reads via MCP tools that execute against ontology object queries. Updates happen via ontology actions that wrap writes with validation + provenance + audit. Every write Dumont makes is a named, typed, reversible operation.

**Example migration path for one action**:

Before: Dumont decides to merge two operators. Calls TypeScript `mergeOperators(keepId, mergeId)`. Function runs FK migration + delete. No central audit, no uniform validation.

After: Dumont invokes ontology action `merge_operators` with parameters `{keep: uuid, merge: uuid, reason: string, evidence_sources: [string]}`. Ontology validates both exist, validates merge doesn't violate Two-Source Rule, runs the FK migration in a transaction, writes a merge_event to the audit log, recomputes affected trust scores, returns `{survivor_id, merged_id, identities_migrated, timestamp}`. Dumont receives structured result.

The current `scripts/dedup-operator-rows.ts` becomes the implementation of that action. Not a rewrite — a wrapping.

## Migration sequence

Ordering, not scheduling.

1. **Plan locked** (this document commits) — reference material, nothing changes yet.
2. **dbt bootstrap** — dbt Core installed, one staging model migrated (faa_aircraft_staging) as proof. dbt tests running. Project structure established.
3. **Analytics marts in dbt** — Charter index calibration, funnel ratio computation, operator activity metrics. First real value from dbt adoption.
4. **Dagster bootstrap** — Dagster installed, one new ingestion job (Stage 3 FAA GENOT) built as Dagster assets from day one. Existing PipelineRunner jobs stay.
5. **Ontology actions layer** — Define `src/memory/ontology/actions/` with first three actions: merge_operators (wraps current dedup script), update_trust_score (wraps current recompute), flag_operator_type (wraps current review CLI prompt).
6. **ER plan stages resume on new stack** — Stage 3 (FAA GENOT + SEC EDGAR) built as Dagster ingestion + dbt staging + ontology actions from the start. Same pattern for Stage 4 onward.
7. **Gradual migration of operational Gold** — Gold canonical views move from native SQL to dbt as confidence grows. No rush; parallel existence is fine.
8. **PipelineRunner retirement** — When Dagster covers all active jobs, remove PipelineRunner. Not before.

## Data contracts and observability

**Contracts** — Every asset (dbt model, ontology object, gold view) declares its schema, its sources, its tests, its SLAs. Downstream consumers fail loudly when upstream changes break the contract. dbt provides this natively; ontology layer requires explicit definition.

**Tests at every layer** —
- Ingestion: data-quality assertions (current 5, growing) run after every ingestion job.
- Transformation: dbt tests (unique, not_null, accepted_values, relationships) on every model.
- Ontology: action-level tests that exercise validation, provenance, rollback.
- Agent: existing Guardian checks + multi-model verification for high-stakes actions.

**Lineage** — Dagster provides asset graph lineage. dbt provides model lineage. The two integrate via dagster-dbt. Manual lineage docs for the ingestion → ER → ontology path until Dagster covers them.

**Health surfaces** — Morning report aggregates pipeline runs, dq failures, active/failed jobs. Dagster UI for asset-level health once adopted. Sentry for errors.

## Cost profile

Open-source stack targeting sub-$200/month infrastructure cost at current scale:

- Supabase Postgres + pgvector: ~$25/month (current)
- S3 archival (Glacier for old, Standard for recent): ~$10/month (current)
- Lightsail compute for cron + Dagster future: ~$20/month (current, Dagster stays on same box)
- Firecrawl self-hosted Docker: $0 (runs on dev machine or same Lightsail)
- dbt Core: $0
- Dagster OSS: $0 (Dagster Cloud would be $500+/month; not adopting)
- Sentry: $0 (free tier)

Total today: ~$55/month. Projected at 3,000 entities + full stack: $150-200/month.

Growth drivers: Supabase disk as dataset grows, S3 bytes as ADS-B history accumulates, Lightsail upgrade if Dagster scheduling demands more memory. All linear, all predictable, all far below enterprise managed-service alternatives.

## Connection to the ER architecture plan

The two documents are deliberately separate:

- **ER architecture plan** describes *what* — ontology content, entities, relationships, trust model, Two-Source Rule, funnel detection, build sequence.
- **Data platform plan** describes *how* — tooling, layering, transformation patterns, orchestration, agent integration, cost.

Every ER plan build stage will map to platform layers:
- Stage 3 (FAA GENOT rebrand tracking) = new Dagster ingestion job + new dbt staging model + new ontology action `record_rebrand_event`.
- Stage 4 (temporal operator attribution) = schema migration + dbt intermediate model + ontology query function `operator_at_time`.
- Stage 5 (corporate structure) = new Dagster ingestion jobs for state registries + OpenSanctions + new dbt models + new ontology objects.
- And so on.

The platform plan becomes the reference for *how we build* each ER stage. The ER plan remains the reference for *what we're modeling*.

## References

- `docs/er-architecture-plan.md` — Ontology content and build stages
- `docs/data-architecture.md` — Medallion architecture, migration patterns, rule 5 index discipline
- `docs/phase1-followups.md` — Operational debt and test-suite hardening
- `docs/semantic/operators.yaml` — Canonical schema semantics
- Palantir Foundry Ontology: https://www.palantir.com/docs/foundry/ontology/overview
- Dagster software-defined assets: https://dagster.io/
- dbt Core: https://www.getdbt.com/product/dbt-core
- Apache AGE (Postgres graph extension): https://age.apache.org/
- neo4j-agent-memory (future agent/graph integration reference): https://github.com/neo4j-labs/agent-memory
