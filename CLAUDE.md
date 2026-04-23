# osa-data-platform

Aviation data platform for Orange Sunshine Aviation. Sibling repo to `dumont-agent` (the charter brokerage orchestrator). This repo owns ingestion, entity resolution, and analytics compute. It does NOT contain agent capabilities, MCP servers, or any HTTP API.

## Scope

- **Ingestion** (`src/ingestion/`) — ADS-B (adsb.lol + opensky), FAA registry (full + daily diff + document index + airmen), NTSB accidents, safety ratings scrapes, live workers, archive writers, cross-validation, pipeline orchestration.
- **Entity resolution** (`src/entity-resolution/`) — canonical operator matching (Jaro-Winkler, trigram, field priority, trust scoring, thresholds).
- **Analytics compute** (`src/analytics/`) — WINGX engine, data-quality rules, embeddings builder, safety-enhanced joins.
- **Schema SSOT** (`schema/`) — SQL at repo root: `_extensions.sql`, `silver/`, `gold/`, `transactional/` (data-platform-owned subset), `analytics/`, `migrations/`.
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
