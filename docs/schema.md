# Database schema

PostgreSQL on Supabase (`dumont-agent` project, us-east-1). SQLite at
`data/dumont.db` is local-dev-only legacy.

**Source of truth**: `src/memory/schema/` — layered per Schema Evolution
Rule 1 (see `docs/data-architecture.md`). 47 tables across
`silver/ gold/ transactional/ analytics/ migrations/`, plus `_extensions.sql`.
When this doc and the SQL disagree, the SQL wins.

## Storage layers

| Layer | Storage | Contents |
|-------|---------|----------|
| Raw (immutable) | S3 Glacier (`osa-dumont-backup`) | adsb.lol daily tars (2023–present), FAA registry zips (daily), airmen zips (monthly) |
| Organized | PostgreSQL (Supabase) | `faa_aircraft`, `adsb_completed_legs`, `ntsb_accidents`, `faa_docindex`, `knowledge_graph` |
| Analytics | PostgreSQL (Supabase) | `operator_market_share`, `route_trends`, `airport_activity`, `fleet_snapshot`, `aircraft_utilization` |

## Migration index (30 blocks, ~45 tables)

| # | Table(s) | Purpose |
|---|----------|---------|
| 1 | `_migrations` | Migration tracking |
| 2 | `deals` | Deal records — route, pricing (integer cents), operator, client, outcome |
| 3 | `route_intel` | Route intelligence — avg price, demand, seasonal. PK: (route, class) |
| 4 | `operator_profiles` | Operator performance — reliability, response time, pricing delta |
| 5 | `client_profiles` | Client history — spend, frequency, preferred routes/aircraft |
| 6 | `validation_ledger` | Quote validation — estimate vs actual, margin tracking |
| 7 | `deal_events` | Append-only audit trail — stage transitions |
| 8 | `messages` | Inbound/outbound messages — all channels, threading, intent |
| 9 | `calls` | Voice call sessions — participants, transcript, entities |
| 10 | `autonomy_rules` | Auto-send thresholds per channel/intent/recipient |
| 11 | `processed_webhooks` | Idempotency keys for webhook dedup |
| 12 | *(alter)* | Expands `validation_ledger` |
| 13 | `faa_aircraft`, `faa_operators`, `faa_airports` | FAA registry, Part 135 operators, airports |
| 14 | `adsb_positions`, `adsb_aircraft_state` | ADS-B positions + current aircraft state |
| 15 | `adsb_completed_legs` | Materialized flight legs — origin, dest, time, distance, class |
| 16 | `deal_outcomes` | Structured deal outcomes for learning loop |
| 17 | `faa_registry_changes` | Daily diff — new, deregistered, ownership change |
| 18 | `pipeline_runs` | Pipeline execution log |
| 19 | `faa_docindex` | FAA document index — liens, security agreements, bills of sale |
| 20 | `pilot_contacts`, `pilot_aircraft_link` | Airmen records + pilot-aircraft proximity links |
| 21 | `aircraft_listings` | For-sale listings — price history, days on market |
| 22 | `target_companies`, `target_contacts` | Prospecting targets |
| 23 | `eval_runs`, `eval_run_summaries` | Quote eval results + aggregate stats |
| 24 | `backfill_progress` | Historical ADS-B backfill tracking by date |
| 25 | `knowledge_graph` | Joined FAA + ADS-B view with safety scores |
| 26 | `archive_progress` | S3 raw ADS-B archive tracking by date |
| 27 | `operator_market_share`, `aircraft_utilization`, `airport_activity`, `route_trends`, `fleet_snapshot`, `fuel_burn_estimates` | WINGX-equivalent analytics tables |
| 28 | `faa_deregistered`, `faa_aircraft_types`, `faa_engine_types` | Historical deregistered aircraft, ACFTREF, ENGINE reference |
| 29 | `ntsb_accidents` | NTSB accident/incident database 1962–present |
| 30 | `data_quality_runs` | Quality check history — holistic runs + Phase 7 per-check rows |

## Known issues

- `adsb_completed_legs` is **contaminated** until the in-flight Phase 7 rebuild finishes. See `docs/known-issues.md` and `docs/phase7-rebuild-runbook.md`.
- Pilot-aircraft links are city/state proximity heuristics — not FAA-authoritative.
- `faa_docindex` collateral matching is fuzzy for non-aircraft collateral types.
- Aircraft classification uses pattern matching on `common_name` — edge cases for rare types.
- NTSB `airport_code` uses FAA codes (e.g. `ORD`), not ICAO (`KORD`). Queries strip the K prefix when matching against other tables.
