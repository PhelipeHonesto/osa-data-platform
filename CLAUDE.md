# osa-data-platform

Aviation data platform for Orange Sunshine Aviation. Sibling repo to `dumont-agent` (the charter brokerage orchestrator). This repo owns ingestion, entity resolution, and analytics compute. It does NOT contain agent capabilities, MCP servers, or any HTTP API.

---

## Load-bearing conventions (read first)

### 1. `canonical` schema is the home for new ER entities

All new entity-resolution tables — aircraft, FBO, airport, person, and every cross-entity temporal link table — land in the `canonical` schema, never in `public`. `public` is legacy; it holds pre-split tables (`operators`, `faa_aircraft`, `adsb_completed_legs`, and the original `operator_identities` / `operator_aliases` overlay). Do not add new tables to `public`. When `public.operators` eventually moves to `canonical.operators`, the change is a one-line `ALTER TABLE ... SET SCHEMA` — FKs auto-update — not a rebuild (see `docs/phase1-followups.md` §"Future migration: operators schema move").

### 2. `src/analytics/wingx-engine.ts` is frozen

`wingx-engine.ts` currently anchors 26 aggregations on the free-text `adsb_completed_legs.operator_name` column. **Do not edit it in place** to point at `canonical.aircraft` / `canonical.operator_aircraft_link`. The migration path is dbt (Phase 12 in `docs/data-platform-plan.md`) — the wingx computations will be re-expressed as dbt marts reading properly-staged silver tables, not patched with partial canonical wiring. Touching it now creates a hybrid that has to be unwound during Phase 12.

### 3. Five-entity discipline

Exactly five canonical entities: `operator`, `aircraft`, `fbo`, `airport`, `person`. **No sixth entity is added until all five have resolution pipelines in place.** This is a design-gravity decision — expanding the node set before the existing set resolves produces a half-built ontology nobody can reason about. Current status: operator done, aircraft Stage 2a shipped (tables empty), FBO/airport/person not started. Status lives in `docs/er-architecture-plan.md` §"Build sequence."

### 4. Architecture docs (read before structural changes)

- `docs/er-architecture-plan.md` — five-entity model, Two-Source Rule, funnel detection, build tracks
- `docs/er/aircraft.md` — aircraft entity spec (seven-role model, N-number reuse, hex_code as identity)
- `docs/temporal-link-pattern.md` — canonical shape for every cross-entity relationship; write rules (append-only, close-then-insert); worked example
- `docs/data-sources.md` — tier 1–4 source map + LinkedIn exclusion (pinned, non-negotiable)
- `docs/decisions/` — accepted ADRs (currently: why `adsb_completed_legs` TEXT timestamps are deferred to Phase 12)
- `docs/data-platform-plan.md` — transformation / orchestration / tooling direction (dbt, Dagster, AGE deferral)

## Scope

- **Ingestion** (`src/ingestion/`) — ADS-B (adsb.lol + opensky), FAA registry (full + daily diff + document index + airmen), NTSB accidents, safety ratings scrapes, live workers, archive writers, cross-validation, pipeline orchestration.
- **Entity resolution** (`src/entity-resolution/`) — canonical operator matching (Jaro-Winkler, trigram, field priority, trust scoring, thresholds).
- **Analytics compute** (`src/analytics/`) — WINGX engine (**frozen**, see above), data-quality rules, embeddings builder, safety-enhanced joins.
- **Schema SSOT** (`schema/`) — SQL at repo root: `_extensions.sql`, `_schemas.sql` (namespace creation), `silver/`, `gold/`, `canonical/` (new ER tables), `transactional/` (data-platform-owned subset), `analytics/`, `migrations/`, `rollback/` (manual down-migrations, not loaded by migrate-pg).
- **Scripts** (`scripts/`) — one-off backfills, calibration, dedup, phase verification, S3 restore orchestration, dq-check, layer-isolation audit.

Out of scope:
- Agent capabilities (intake/sourcing/quote/scenario/guardian) — `dumont-agent`.
- MCP server — `dumont-agent`.
- HTTP API (Vapi webhook, dashboard) — `dumont-agent`.
- Agent-owned transactional tables (`deals`, `deal_events`, `messages`, `calls`, `autonomy_*`, `route_intel`, `operator_profiles`, `client_profiles`) — `dumont-agent` owns writes; this repo reads them only for analytics if ever needed.

Pointer back: `~/osa/dumont-agent/CLAUDE.md` is the agent-side manual.

## Host awareness

- **Mac**: `~/osa/osa-data-platform` (dev).
- **Lightsail**: `~/osa-data-platform` (prod; NOT `~/osa/osa-data-platform`).
- Match paths to host. Use `tmux` for long jobs.

## Shared code (Option A duplication)

SSOT lives in `dumont-agent`. Duplicated here (not imported):
- `src/utils/{logger,sentry,haversine,errors}.ts`
- `src/db/{database,pg-database}.ts` (DbBridge; mirrors `dumont-agent/src/memory/`)
- `src/db/{migrate-pg,migrate-data}.ts` (schema migration runners; this repo becomes authoritative after 3B.7)
- `src/schemas/` — minimal Zod subset (`Aircraft`, `Operator`, `AirportCode`, ADS-B raw).

Changes to these files must be synced manually across both repos.

## Verify before shipping

- `npx tsc --noEmit`
- `npm test`
- `npm run lint:layers` (regression guard — this repo should never grow agent-layer dirs)
