-- Namespace schemas beyond public.
--
-- public holds legacy/migrated-from-monolith tables (operators, faa_aircraft,
-- adsb_completed_legs, etc). canonical holds the five-entity ER layer
-- (aircraft, fbo, airport, person) plus every cross-entity temporal link
-- table (operator_aircraft_link, fbo_operator_link, etc).
--
-- Rationale: starts namespacing discipline without big-bang migration of
-- existing public tables. See docs/er-architecture-plan.md §"The five
-- entities" for the discipline and docs/temporal-link-pattern.md for the
-- link-table shape.
--
-- Loaded by src/db/migrate-pg.ts immediately after _extensions.sql.

CREATE SCHEMA IF NOT EXISTS canonical;
