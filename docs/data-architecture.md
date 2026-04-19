# OSA Data Architecture

> Status: **Target architecture, not yet implemented.**
> Current state: Silver-only (one table per source). Phase 1 of MDM migration planned.

## Motivation

OSA started with two primary data sources (FAA registry, ADS-B feed) and a handful of derived tables. That shape is already strained: today's attempt to sync 313 scraped ARGUS/Wyvern operator ratings into `faa_operators` returned **1 match out of 313** because each rating system uses its own internal ID (Wyvern `PRIA248H` ≠ FAA `1OCA082A`), and we had conflated source-specific IDs with a canonical operator identity. The code wasn't wrong; the data model was.

OSA's trajectory is more sources, not fewer — IS-BAO, Aviapages, NTSB cross-matches, for-sale listings, client CRM, and the Loud Hawk editorial layer all land on the same operator/aircraft/route universe. Every new source brings different IDs, different name conventions, and different record granularity. Without a canonical layer that resolves "same real-world operator across five systems" once at ingest, every downstream feature (Sourcing agent ranking, ghost positioning, fleet intelligence) pays a compounding join tax and ships with quiet data gaps.

The second forcing function is AI agents. Dumont's Sourcing, Quote, and Scenario capabilities need to answer questions like "what do we know about NetJets?" with one table lookup, not a four-table JOIN the LLM has to author correctly every time. Per Zach Wilson's [AI-native modeling](https://blog.dataexpert.io/p/how-to-data-model-for-your-ai-context), "AI thrives at mapping question → appropriate dataset." Dimensional correctness at the base, question-shaped aggregations on top, is the right split.

## Three-Layer Medallion Model

The 2026 industry consensus (Databricks, Snowflake, Microsoft, Azure) is **three layers**, not four:

- **Bronze** — raw ingestion, audit trail.
- **Silver** — cleaned + typed + per-source facts.
- **Gold** — canonical entities + agent-facing views.

Earlier versions of this document described a fourth "Platinum" layer for AI-facing denormalized views. That was over-engineering. Denormalized views are a *shape* of Gold, not a separate layer.

### Bronze (raw ingestion)

**What**: untouched source data, preserved for auditability and reproducibility. If a Silver transform turns out to be wrong two quarters from now, Bronze is how we recompute without re-scraping.

**Where OSA is**: partial. ADS-B daily tars live in S3 Glacier (`osa-dumont-backup`, 2023-present). Daily FAA zips + monthly airmen zips also archive to S3. Scraper outputs (ARGUS / Wyvern markdown) are not archived today — that's a gap.

**Naming**: `raw_{source}_{entity}` (for in-DB Bronze) or `s3://osa-dumont-backup/raw/{source}/{date}/...` (for object-storage Bronze).

**Examples**: `raw_faa_master`, `raw_adsb_traces`, `raw_argus_scrape`.

### Silver (cleaned + typed, per-source)

**What**: structured, typed, validated data with source attribution intact. One Silver table per (source, entity) pair. Silver is the authoritative record of what each source told us, not what we concluded.

**Where OSA is**: mostly complete. `faa_operators`, `adsb_completed_legs`, `ntsb_accidents`, `aircraft_listings`, and today's new `safety_ratings` are all Silver tables. This is the layer that already works.

**Naming**: `{source}_{entity}` — e.g., `faa_operators`, `adsb_completed_legs`, `argus_ratings` (future, renamed from today's combined `safety_ratings`).

**Purpose**: authoritative source-of-record for per-source facts, source-specific analytics, and the input to the canonical layer.

### Gold (canonical entities + agent-facing views)

Gold has two conceptual sub-tiers that share the same layer:

**Gold canonical** — entity-resolved master data. One row per real-world entity regardless of how many sources describe it. This is where "NetJets Aviation" (FAA), "NetJets" (ARGUS), and "NetJets Aviation Inc." (Wyvern) converge to one `operator_id`.

**Gold agent-facing views** — denormalized, OBT-style (One Big Table) materialized views, one per question class. This is the surface Dumont and the MCP tools read. No agent is expected to JOIN canonical + identity + Silver facts at query time. Refresh model: materialized views, rebuilt after each relevant ingestion run (nightly pipeline, monthly safety refresh, etc.). Stale-by-up-to-24-hours is acceptable for everything except `ghost_positioning_live` (near-realtime).

**Core canonical tables to build** (operators first):

```
operators
  - id                   UUID (stable forever — never reused)
  - canonical_name       TEXT NOT NULL
  -- Multi-valued (Q8 resolution). Real operators often span multiple
  -- categories (charter + management, cargo + air_ambulance) and an
  -- enum would force one-hot assignments that don't reflect reality.
  - type_tags            TEXT[] NOT NULL DEFAULT '{}' CHECK (type_tags <@ ARRAY[
                           'charter','fractional','corporate','air_ambulance',
                           'cargo','management','military','government'
                         ]::TEXT[])
  - headquarters_icao    TEXT
  - trust_score          NUMERIC(3,2)           -- see Data Trust Scores
  - first_seen_at        TIMESTAMPTZ NOT NULL
  - last_updated_at      TIMESTAMPTZ NOT NULL
  - schema_version       INTEGER NOT NULL DEFAULT 1

operator_identities
  - operator_id          UUID REFERENCES operators(id)
  - source               TEXT CHECK (... IN ('faa','argus','wyvern','isbao','adsb','manual'))
  - source_id            TEXT NOT NULL          -- their ID in their system
  - name_as_provided     TEXT NOT NULL
  - match_confidence     TEXT CHECK (... IN ('exact','high','medium','low','manual'))
  - match_method         TEXT                   -- 'cert_number','name_fuzzy','manual',...
  - match_evidence       JSONB                  -- weighted-signal breakdown
  - first_seen_at        TIMESTAMPTZ NOT NULL
  - last_verified_at     TIMESTAMPTZ NOT NULL
  - UNIQUE (source, source_id)

operator_aliases
  - operator_id          UUID REFERENCES operators(id)
  - alias                TEXT NOT NULL
  - alias_normalized     TEXT NOT NULL
  - alias_type           TEXT CHECK (... IN ('legal','dba','marketing','historical'))
  - source               TEXT
  - UNIQUE (operator_id, alias_normalized)
```

**Same pattern applied to other entities over time** (priority order):

- `aircraft` + `aircraft_identities` — links FAA tail number ↔ ADS-B ICAO hex ↔ type-rating records.
- `airports` + `airport_identities` — reconcile ICAO / IATA / FAA-ident / NTSB-short.
- `pilots` + `pilot_identities` — airmen record ↔ observed-in-ADS-B links.
- `clients` + `client_identities` — future, as CRM data enters the system.

**Initial agent-facing views planned**:

- **`operator_profile`** — one row per operator, all attributes flat (canonical name, all aliases, home base, fleet size, Part 135 status, all safety ratings from all sources, reliability score, trust score). Answers *"Tell me everything about operator X."*
- **`operator_safety_summary`** — one row per operator, best-known rating from each source flattened to a single safety tier. Answers *"Which operators meet our safety threshold?"*
- **`fleet_intelligence`** (Phase 3) — per-aircraft registration + type + current operator + last position + recent legs + ghost flag. Answers *"What is N123AB doing? Who operates it?"*
- **`route_intelligence`** (Phase 3) — per origin-destination-month: volume, avg price, seasonality, top operators. Answers *"KORD → KTEB demand trends?"*
- **`ghost_positioning_live`** (Phase 3) — current repositioning opportunities, updated on each ADS-B tick. Answers *"Any charter aircraft empty near KTEB today?"*

## Compute and Storage Strategy

Not every table belongs in Postgres. The 2026 pattern for teams at OSA's scale is a Postgres + DuckDB hybrid, with each engine handling the workload it's actually good at.

**Postgres (Supabase)** — the transactional + operational store:

- All transactional data (deals, calls, messages, events).
- Silver tables for small/medium sources (FAA registry, scrapers, NTSB).
- All Gold canonical + agent-facing views.
- `pgvector` embeddings for RAG.
- Entity resolution match queue.

**DuckDB + Parquet on S3** — the analytical store:

- Large append-mostly time-series (ADS-B completed legs, ADS-B positions).
- Historical data that doesn't need transactional semantics.
- Ad-hoc analytical queries that would slow Postgres under operational load.

**Decision rule**:

- `rows < 1M` AND updated frequently AND queried operationally → **Postgres**.
- `rows > 10M` AND append-mostly AND queried analytically → **Parquet on S3 via DuckDB**.
- Borderline → default to Postgres unless it hurts.

**Explicit non-adoption (for now)**:

- **DuckLake table format** — v1.0 released 2026-04-13 (5 days ago). Production-ready but too new; Snowflake's principal engineer pushed back publicly, and Iceberg/Delta are entrenched. Revisit in 12 months.
- **Iceberg / Delta table formats** — not needed at OSA's current scale.
- We use **plain Parquet in S3, accessed directly via DuckDB**, until the format war settles. See Adoption Triggers for the revisit conditions.

## Transformation Framework

Where Compute and Storage Strategy covers *where* data lives, this section covers *how* it moves between layers.

### Current state (Phase 0–1)

Bronze → Silver transformations run in TypeScript ingestion code (`src/ingestion/`). Phase 1's entity resolution — weighted scoring, tiered confidence, manual review queue — also stays in TypeScript. The matching algorithm is iterative and stateful; SQL is a poor fit.

### Target state (Phase 2+)

**dbt (data build tool)** handles Silver → Gold canonical and Gold canonical → Gold agent-facing view transformations. dbt is the 2026 industry standard for SQL-first transformations and integrates natively with Postgres + DuckDB via the `dbt-postgres` and `dbt-duckdb` adapters.

**Why dbt**:

- Auto-generated lineage and documentation.
- SQL-first — fits Silver → Gold transformations cleanly.
- Built-in testing (uniqueness, not-null, referential integrity, custom).
- First-class Postgres + `dbt-duckdb` adapter support.
- Semantic metadata via `schema.yml` files — ties directly to the Semantic Layer section above.
- Staging / intermediate / marts pattern maps onto Bronze / Silver / Gold.

**Why NOT in Phase 1**:

- Entity resolution is algorithmic with weighted scoring and a manual review queue — better expressed in TypeScript than SQL.
- Phase 1 has a handful of transformations, small enough to hand-code.
- dbt pays off at 10+ models, not 3.

### Adoption trigger

Start of Phase 2 — when we build the first agent-facing Gold view on top of the canonical operators layer.

### Phase 2 dbt project structure

```
dbt/
  models/
    staging/         — mirror of Silver with light cleanup
    intermediate/    — entity-resolved Gold canonical (refs Phase 1 tables)
    marts/           — agent-facing Gold views (operator_profile,
                       fleet_intelligence, route_intelligence)
  tests/             — custom tests for business logic
  snapshots/         — slowly-changing dimension capture
  seeds/             — small reference data
```

### Alternative considered

**SQLMesh** — newer dbt competitor with better incremental-build semantics. Ecosystem maturity and the `dbt-duckdb` adapter currently tilt toward dbt; reassess at Phase 2 entry.

## Entity Resolution Strategy

Matching new records to canonical operators happens **at ingestion time, not query time**. Query-time matching means every agent call pays the cost and gets subtly different answers depending on fuzzy-match thresholds.

### Tier 1 — Deterministic (`match_confidence = 'exact'`)

Shared IDs across sources. If FAA cert `1OCA082A` appears in both the FAA registry and a prior ARGUS scrape with the same cert number, it's the same entity. Bindings are one-shot and never re-evaluated unless the source record changes.

### Tier 2 — Probabilistic (`match_confidence` ∈ `'high' | 'medium' | 'low'`)

Weighted scoring on multiple signals:

- Normalized name similarity (Jaro-Winkler + trigram).
- Home base ICAO match.
- Address match (street + city + state).
- Fleet overlap (if known tails are shared across sources).
- Phone number match.

**Thresholds** (indicative — calibrated in Phase 1 against a labeled sample):

- `score ≥ 0.90` → `'high'` → auto-match.
- `0.75 ≤ score < 0.90` → `'medium'` → auto-match with flag for monthly review.
- `0.60 ≤ score < 0.75` → `'low'` → manual review queue. Never auto-matched.
- `score < 0.60` → treat as a new operator; create a new canonical row.

### Tier 3 — Manual review

Ambiguous cases — multiple medium matches, conflicting signals (name matches but home base contradicts), cross-national collisions — go to a manual review queue. A human confirms the match and `match_confidence` is set to `'manual'`. This prevents auto-merges from contaminating canonical data during the initial backfill when heuristic thresholds haven't been calibrated yet.

## Data Trust Scores

Every canonical entity in Gold carries a computed `trust_score` (0.0–1.0). Agents use it to weight data in reasoning. This is what Qlik and Datafold shipped in 2026; OSA builds it in from day one.

Column `trust_score` on `operators`, `aircraft`, `routes`, `deals`.

**Computed from**:

- `source_reliability` — FAA 1.0, ARGUS 0.9, Wyvern 0.85, scrape-only 0.7, user-reported 0.5.
- `data_freshness` — decay function on `last_verified_at` (e.g., half-life of 90 days for safety ratings, 30 days for operational data).
- `cross_source_agreement` — how many sources confirm key fields.
- `completeness` — fraction of expected fields populated.

Recomputed on every update (trigger or scheduled job).

**Agents use `trust_score` for**:

- Weighting conflicting data ("FAA says X, ARGUS says Y" — pick the one with higher `trust_score`, surface the disagreement in the audit trail).
- Deciding whether to answer or escalate (`trust_score < 0.5` → flag to human, don't auto-proceed).
- Audit trail ("we relied on data with `trust_score = 0.87`").

Specific formula tuning is Phase 1 work. The column and architecture are established now.

## Semantic Layer

The semantic layer is metadata describing what tables **mean**, not just what they contain. In 2026 it's the single highest-leverage improvement to AI accuracy on enterprise data: raw SQL queries from agents yield 10–20% accuracy, while agents with a semantic layer yield 70–90% (dbt / Snowflake / Databricks research; Databricks Agent Bricks reports 70% higher accuracy than standard RAG via Unity Catalog metadata).

OSA's semantic layer is two-tiered.

### Tier 1 — Semantic metadata files (per Gold table)

Each Gold table has a YAML or markdown file describing:

- **Business purpose** — what the table means, in plain English.
- **Grain** — what one row represents.
- **Owner + refresh cadence**.
- **Key metrics** — formulas, not just column names.
- **Key dimensions** — categorical slices for filtering.
- **Source attribution** — where data originates.
- **Trust score inputs** — which fields feed `trust_score`.

Location: `docs/semantic/*.yaml`.

### Tier 2 — MCP tools as the semantic interface

**Agents never write SQL against OSA tables.** They call MCP tools. Every Gold agent-facing view has a paired MCP tool. The tool description is the semantic contract.

- **Bad pattern**: agent writes SQL, might get column names wrong, might misread grain, can't know freshness.
- **Good pattern**: agent calls `get_operator_profile(id)`; the tool handles SQL generation internally, returns a structured result, and includes `trust_score` + `view_last_refreshed_at` in the payload.

This encapsulates the semantic layer at the tool interface — the surface agents natively work with.

### Implementation order

- **Phase 1**: semantic metadata files for each Gold canonical table as they're built.
- **Phase 2**: MCP tools wrapping Gold agent-facing views (not raw Silver or canonical tables).
- **Phase 3+**: formal semantic layer spec (dbt semantic layer, Cube, or equivalent) as OSA grows.

## Context Engineering

Context engineering is the discipline of architecting the full information environment for AI agents — prompts, memory, tools, retrieval, and state. Gartner's "breakout AI capability of 2026." Meta's April 2026 engineering blog reported 40% fewer tool calls with structured context files.

### Five layers of context

1. **System instructions** — what the agent is supposed to do.
2. **Memory** — short-term + long-term, session + persistent.
3. **Retrieved data** — RAG results, tool outputs.
4. **Tool definitions** — what capabilities the agent has.
5. **Conversation state** — what's happened so far.

### OSA already does context engineering, informally

- **OSA-Brain** (Obsidian vault, 140+ summaries) — long-term founder context.
- **CLAUDE.md** — project context.
- **.claude/lessons.md** — learned-from-experience context.
- **docs/WORKFLOW.md** — operational context.
- **MCP tool descriptions** — tool context.
- **Agent orchestration** (Intake → Sourcing → Quote → Scenario → Guardian) — conversation-state context.

### Principles for OSA

- Context files are **25–35 lines max** — "compass, not encyclopedia" per Meta's April 2026 engineering blog.
- Context self-refreshes — scheduled jobs validate and update.
- **Context decay is worse than no context** — stale context produces confidently wrong outputs.
- Every agent gets **minimum viable context**, not maximum possible.

### Future state

- Per-agent context files (Sourcing context, Quote context, etc.).
- Auto-refresh jobs that update context as data changes.
- Explicit context budget per agent (token allocation).

## Schema Evolution Principles

These rules govern how the schema evolves as Phase 1–4+ land. They prevent a well-intentioned architecture from degrading into the exact mess it was designed to prevent.

### Rule 1 — Schema is split by layer

The schema lives in `src/memory/schema/`, split by layer:

```
src/memory/schema/
  _extensions.sql              (CREATE EXTENSION pgvector, ...)
  ├── silver/                  (ingested: FAA, ADS-B, NTSB, scrapers)
  │   ├── faa.sql
  │   ├── adsb.sql
  │   ├── safety-ratings.sql
  │   └── ...
  ├── gold/
  │   ├── canonical/           (entity-resolved master data)
  │   │   ├── operators.sql
  │   │   └── aircraft.sql     (Phase 3)
  │   ├── infra/               (Gold plumbing — refresh log, etc.)
  │   │   └── gold-view-refresh.sql
  │   └── views/               (agent-facing materialized views — Phase 2+)
  │       ├── operator-views.sql
  │       └── fleet-views.sql  (Phase 3)
  ├── transactional/           (app-born: deals, messages, calls, ops state)
  │   ├── deals.sql
  │   ├── communications.sql
  │   └── ...
  ├── analytics/               (derived aggregates: knowledge_graph, WINGX)
  │   ├── knowledge-graph.sql
  │   └── wingx.sql
  └── migrations/
      └── YYYY-MM-DD-NNN-<name>.sql
```

Medallion (`silver/`, `gold/`) applies to ingested data. `transactional/` and `analytics/` are sibling folders for data that doesn't fit the medallion pattern — tables born in the app or derived from it, not ingested.

`src/memory/migrate-pg.ts` concatenates files in deterministic load order (`_extensions` → `transactional` → `silver` → `analytics` → `gold/canonical` → `gold/infra` → `gold/views` → `migrations`) and executes against Postgres. Every statement is `CREATE ... IF NOT EXISTS`, so re-applying is idempotent.

### Rule 2 — Migration naming

Format: `YYYY-MM-DD-NNN-<kebab-case-name>.sql`

```
2026-04-28-001-operators-canonical.sql
2026-04-28-002-operator-identities.sql
2026-05-05-001-argus-ratings-facts.sql
```

- Numbers disambiguate multiple migrations on the same day.
- Kebab-case names explain what the migration does at a glance.
- **Never use just a number.** "Migration 38" tells nobody anything.

### Rule 3 — Deprecation has a lifecycle

A table cannot be "soft deprecated" and left to rot. Every deprecation requires:

1. **Header comment** at the top of the table definition:
   ```sql
   -- DEPRECATED YYYY-MM-DD
   -- Replaced by: <new table or view>
   -- Readers migrate to: <new query target>
   -- Scheduled removal: YYYY-MM-DD (minimum 6 weeks after deprecation)
   ```
2. **Code assertion**: ingestion that previously wrote to the table now throws or `log.error("attempted write to deprecated X, use Y instead")`.
3. **Monitoring**: query logs flag any writes or reads from deprecated tables.
4. **Actual removal**: on the scheduled removal date, `DROP` the table in a dedicated commit.

### Rule 4 — Gold agent-facing views expose freshness

Every materialized view must include:

```sql
view_last_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

Every refresh operation logs to:

```sql
gold_view_refresh_log (
  view_name, refreshed_at, row_count, duration_ms, status, error
)
```

Agents can check freshness:

```sql
SELECT MAX(view_last_refreshed_at) FROM operator_profile;
```

Stale views (>24h old for most, >1h for real-time) trigger alerts.

### Rule 5 — Additive-first, destructive-last

Phase order within any migration:

1. Create new tables/views.
2. Dual-write: writers populate **both** old and new tables.
3. Migrate readers one-by-one to new tables.
4. Verify: no reads from old table for 1 week.
5. Mark old table `DEPRECATED` (Rule 3 lifecycle begins).
6. 6 weeks later: `DROP` old table.

**Never do 1 → 6 in a single migration.** The cost of dual-writing for 1–2 weeks is vastly lower than the cost of a broken reader you didn't know about.

**New indexes on new columns belong ONLY in the migration file — never duplicated in the canonical `CREATE TABLE` block.** `CREATE TABLE IF NOT EXISTS` is a no-op on pre-migration DBs (the table already exists without the new column), so any `CREATE INDEX` that references the new column will hard-fail before the migration runs. Declare the column in the CREATE TABLE body (so fresh installs get it), but leave the index to the migration. This bit commits 1, 10, and 13 — learn from it.

**Migration idempotency**: every `migrations/YYYY-MM-DD-NNN-*.sql` file must be safe to re-apply. `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` are idempotent by construction. Statements without an `IF NOT EXISTS` form (e.g. `ALTER TABLE ... RENAME COLUMN`) must be wrapped in an `information_schema` guard:

```sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'operators' AND column_name = 'trust_score'
  ) THEN
    ALTER TABLE operators RENAME COLUMN trust_score TO data_confidence_score;
  END IF;
END $$;
```

This lets `npm run db:migrate-pg` re-run any number of times without failing on "column already renamed" / "table already exists" / "index already present" errors. Migrations that can't be made idempotent don't belong in `migrations/` — they belong in a one-shot admin script run manually.

### Rule 6 — Gold agent-facing views are the ONLY direct SQL interface

Non-negotiable:

- Agent code (`src/capabilities/`, `src/orchestrator/`) **never** reads Silver or Gold canonical tables directly.
- All agent reads go through **MCP tools**, which internally query **Gold agent-facing views**.
- **CI grep check**: if an agent file references a Silver or Gold canonical table name, fail the build.

Why: agent queries are the hardest to refactor. Lock them to the stable MCP + view interface from day one. If a view is missing for a query class, build the view — don't shortcut by reading Silver.

### Rule 7 — Source attribution is mandatory

Every row in **Gold** must have:

- `first_seen_at`
- `last_verified_at`
- `source_of_creation` (which identity source first created this record)

Every row in **Silver** must have:

- `scraped_at` or `ingested_at` (event time)
- `source` (explicit, even when the table name implies it)
- `scrape_run_id` or `ingest_run_id` (FK to a runs table for audit)

Every row in **Bronze** must have:

- `ingested_at`
- `source_url` or `source_file`
- `raw_sha256` (hash of the raw content)

No shortcuts. If a source doesn't provide enough attribution, don't ingest until it does.

## Naming Conventions

### Tables

| Layer | Pattern | Example |
|---|---|---|
| Bronze | `raw_{source}_{entity}` | `raw_faa_master`, `raw_argus_scrape` |
| Silver | `{source}_{entity}` | `faa_operators`, `argus_ratings` |
| Gold canonical | `{entity}` | `operators`, `aircraft` |
| Gold identity | `{entity}_identities` | `operator_identities` |
| Gold aliases | `{entity}_aliases` | `operator_aliases` |
| Gold view | `{entity}_{question_noun}` | `operator_profile`, `fleet_intelligence` |

### Columns

- `id` — primary keys. **UUID** for Gold canonical (stable across rebuilds); **SERIAL** for Silver (source-specific, rebuildable).
- `{entity}_id` — foreign keys to the canonical Gold row.
- `source_id` — the external system's ID (FAA cert number, ARGUS ID, Wyvern AOC, etc.).
- `schema_version` — on every table, forward-compat for migrations.
- `first_seen_at`, `last_verified_at` — on Gold rows.
- `seen_at` — on fact tables (ADS-B positions, rating observations) for time-series use.
- `trust_score` — on Gold canonical (see Data Trust Scores).
- `view_last_refreshed_at` — on every Gold agent-facing view (see Schema Evolution Rule 4).

## Source Attribution

Every Gold / agent-facing-view record must trace back to at least one Silver record, which must trace back to a Bronze event.

For any data point in OSA, we must be able to answer:

1. **Where did this come from?** — which source(s).
2. **When was it scraped/ingested?** — timestamp(s).
3. **How confident are we?** — `match_confidence` on the identity link, plus any probabilistic score on the underlying fact, plus the rolled-up `trust_score`.
4. **What's the raw version?** — a Bronze reference or S3 URI.

This is mandatory. No "just trust the data" shortcuts. Every agent-facing view must carry (or be joinable to) source attribution and freshness timestamps — silent staleness is worse than no data.

## Scale of Ambition

OSA's data layer evolves at three time horizons. Each horizon is driven by **adoption triggers**, not calendar dates. Build the foundation before the ornament.

### Today (Phase 1–3, next ~2 months)

- 3-layer medallion (Bronze / Silver / Gold).
- Postgres + DuckDB hybrid.
- MDM with entity resolution in Gold.
- `pgvector` for RAG + hybrid search (vector + BM25).
- Postgres-native knowledge graph (recursive CTEs, FK edges).
- Semantic layer via metadata files + MCP tools.
- Data trust scores on Gold entities.
- Context engineering via the OSA-Brain + CLAUDE.md ecosystem.

### Medium-term (Phase 4–7, months 3–6)

- Formal Agentic RAG via framework (LangGraph or similar) when complexity justifies.
- Richer knowledge graph (incidents, filings, market listings).
- Evaluation harness for retrieval quality.
- Auto-refreshing context files per agent.
- Per-agent trust-score thresholds.

### Long-term (Phase 8+, 6+ months)

- GraphRAG with dedicated infrastructure (Neo4j or Postgres AGE) when entity count > 50,000 with validated resolution.
- Open table format (DuckLake, Iceberg, or Delta) — decision after the format war settles.
- Multi-agent observability + human-in-loop governance.
- SLA-backed Gold views for external consumption.
- Data mesh patterns if OSA becomes multi-team.

## Adoption Triggers

For each deferred architecture component, the explicit conditions that justify adoption. No component moves up-horizon without at least one of its triggers firing.

### DuckLake / Iceberg / Delta Lake table format

Adopt when **any** of:

- Multiple writers to the lakehouse (OSA not solo anymore).
- Time-travel or audit requirements from compliance.
- Cross-team data sharing with versioning needs.
- Table-format ecosystem stabilizes (12+ months of v1.0+ in production across ecosystem).

### GraphRAG with dedicated graph DB (Neo4j or Postgres AGE)

Adopt when **any two** of:

- Canonical entities > 50,000 with validated resolution.
- Multi-hop queries (3+ hops) are regular agent patterns.
- Explainability / audit requirements from customers or regulators.
- Recursive CTE query latency exceeds 500 ms p95.

### LangGraph / formal agent orchestration framework

Adopt when **any** of:

- 5+ agents with complex handoffs.
- Human-in-the-loop approval workflows required.
- Observability of agent decisions becomes a support problem.
- Multiple developers building agents simultaneously.

### Multi-modal lakehouse (LanceDB, etc.) for images / audio / video

Adopt when:

- OSA ingests non-text media at scale (aircraft photos, voice notes, video tours).

Until then, handle media via S3 + metadata pointers.

## Migration Path (current → target)

### Phase 0 — Decisions (complete)

- Document target architecture (this file).
- Lock lessons in `.claude/lessons.md` so future sessions inherit context.
- **Freeze new scrape sources** until Phase 1 is complete. Adding IS-BAO or Aviapages to today's Silver-only shape would compound the problem we're trying to solve.

### Phase 1 — Operators canonical layer (3–5 days)

- Build `operators` + `operator_identities` + `operator_aliases`.
- Build the entity resolution matching algorithm (tiered, weighted, calibrated on a labeled sample).
- Build the manual review queue (simple admin page + `operator_identities.match_confidence = 'pending'` state).
- Migration: re-interpret today's `faa_operators` + `safety_ratings` through the canonical layer. Keep Silver tables as the source-of-truth for per-source facts — they don't go away.
- Split `src/memory/schema-pg.sql` into the `src/memory/schema/` directory per Schema Evolution Rule 1.
- Adopt migration naming per Schema Evolution Rule 2 (`YYYY-MM-DD-NNN-<kebab-name>.sql`).
- Add the `gold_view_refresh_log` table for Schema Evolution Rule 4 (even though the first Gold view arrives in Phase 2 — plumbing in now).
- Add `trust_score` column + computation trigger on `operators` (formula calibrated in this phase).
- Start the semantic-layer habit: one `docs/semantic/<table>.yaml` per Gold canonical table introduced.

### Phase 2 — Safety ratings on new structure + first Gold agent-facing views (2–3 days)

- Rename today's unified `safety_ratings` into per-source Silver shape: `argus_ratings`, `wyvern_ratings`. Source-specific fields (ARGUS home base, Wyvern country) belong on each source's table, not on a merged row.
- Build `operator_profile` Gold agent-facing view.
- Build `operator_safety_summary` Gold agent-facing view.
- Wrap both views in MCP tools (`get_operator_profile`, `get_operator_safety_summary`). **Sourcing agent reads tools, not SQL.**
- Deprecate the denormalized `faa_operators.argus_rating / wyvern_rating / is_bao_stage` columns once Sourcing has cut over (Rule 5 dual-write → migrate readers → deprecate).
- Semantic metadata files for both new Gold views.

### Phase 3 — Aircraft canonical (3–5 days)

- `aircraft` + `aircraft_identities` (links FAA tail ↔ ADS-B ICAO hex ↔ future NTSB).
- `fleet_intelligence` Gold view.
- `ghost_positioning_live` Gold view.
- Move ADS-B completed legs to Parquet on S3 if volume justifies per Compute and Storage decision rule.

### Phase 4+ — Other entities as needed

Routes, deals, clients, airports, pilots. Same three-layer pattern, repeated. Adoption triggers determine when the medium-term / long-term items kick in.

## References

- Zach Wilson, *"How do One Big Table and AI fit together"* — https://blog.dataexpert.io/p/how-to-data-model-for-your-ai-context
- Medallion architecture (Microsoft / Azure) — https://learn.microsoft.com/en-us/azure/databricks/lakehouse/medallion
- DuckDB + Postgres hybrid (MotherDuck) — https://motherduck.com/learn/duckdb-vs-postgres-embedded-analytics/
- Semantic layer + AI accuracy (Promethium, 2026) — https://promethium.ai/guides/conversational-analytics-ai-agents-enterprise-data-access-2026/
- Context engineering overview (Taskade) — https://www.taskade.com/blog/context-engineering
- Meta's context-file approach (Engineering blog, April 2026) — https://engineering.fb.com/2026/04/06/developer-tools/how-meta-used-ai-to-map-tribal-knowledge-in-large-scale-data-pipelines/
- Databricks Agent Bricks — https://www.databricks.com/blog/agent-bricks-governed-enterprise-agent-platform
- DuckLake v1.0 announcement (2026-04-13) — https://ducklake.select/2026/04/13/ducklake-10/
- Kimball dimensional modeling (background reading).
- Databricks Lakehouse whitepapers (Bronze / Silver / Gold origin of the pattern).
- Airbnb "Unified Metadata" blog post (practical MDM experience report).

## Related files

- [`.claude/lessons.md`](../.claude/lessons.md) — 2026-04-18 entries explain the forcing incident (1-of-313 FAA match).
- [`docs/schema.md`](./schema.md) — current Silver-only schema, to be expanded as Gold canonical + views land.
- [`src/memory/schema-pg.sql`](../src/memory/schema-pg.sql) — SSOT for current tables (split into `src/memory/schema/` during Phase 1).
