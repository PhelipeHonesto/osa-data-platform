# Session — Stage 2a aircraft ER

**Date**: 2026-04-24 (morning)
**Owner**: Phelipe Honesto
**Scope**: Expand ER from operator-only to five entities; ship `canonical.aircraft` + first temporal link table; write the architecture docs that lock the shape.

## What shipped

Three commits on `main`, pushed: `67abbb9`, `03efc47`, `eeed483`. Contents:

- `canonical` schema + `canonical.aircraft`, `aircraft_identities`, `aircraft_aliases` (scaffold only)
- `canonical.operator_aircraft_link` — first temporal link with btree_gist exclusion on `(aircraft_id, role, daterange)`
- Rollback SQL for both + local up→down→up cycle verified on Docker Postgres 16
- Five-entity expansion of `er-architecture-plan.md`; new `docs/er/aircraft.md`, `docs/temporal-link-pattern.md`, `docs/data-sources.md`, `docs/decisions/2026-04-24-adsb-text-timestamps.md`
- CLAUDE.md load-bearing-conventions section; `extractTableNames` fix for schema-qualified names
- Lightsail: Docker 29.4.1 + Compose installed, Firecrawl repo cloned (stack not started — prod RAM contention)

## What did NOT ship

- Backfill (Stage 2b); aircraft resolver (2c); FBO / airport / person tables; Firecrawl stack launch
- **`db:migrate-pg` against Supabase** — silently dropped from the Stage 2a plan. Schema in git, not in prod. Caught at Stage 2b pre-flight.

## Key decisions locked

- `canonical` schema for new ER tables; `public` is legacy. No new tables in `public`.
- Aircraft identity anchors: `icao_hex` (partial unique, preferred) > `serial_number` (not unique — international collisions) > `current_tail_number` (mutable, never unique).
- Seven-role model on `operator_aircraft_link`; manufacturer is an airframe attribute, not a role.
- Temporal pattern: append-only except `valid_to`; close-then-insert on transitions; DATE not TIMESTAMPTZ; NULL `valid_to` = current.
- ADR: defer `adsb_completed_legs` TEXT→TIMESTAMPTZ fix to Phase 12 dbt, not a functional index now.
- ARGUS / Wyvern are Tier E (subject-paid); `docs/data-sources.md` is authoritative.
- Wingx-engine.ts frozen until Phase 12.

## Surprises / learnings

- Test baseline is 375 post-split, not 640. Logged in phase1-followups.
- ADS-B hex coverage is ~100% US-registered (121,511 of 121,512 flown hex exist in `faa_aircraft`). Anticipated 60–90K international orphan population isn't in current data.

## Rule to add to CLAUDE.md next session

**Migration verification rule**: a passing local Docker rollback test proves the SQL is sound but does NOT prove the schema is live in prod. Every migration commit must end with (a) local up-down-up rollback, (b) `npm run db:migrate-pg` against Supabase, (c) `describe-schema` verification of the new tables. All three, not any two. This rule exists specifically because Stage 2a shipped with (a) + a test pass and the Supabase apply was silently dropped — caught only at Stage 2b pre-flight.

## Next session starting point

Stage 2b: Step 0 (apply schema to Supabase) → Step 1 (`resolveOperatorMatchOnly`) → Checkpoint 1 (FAA bulk) → 2 (ADS-B merge) → 3 (operator_aircraft_link initial) → 4 (temporal history from `faa_registry_changes`).
