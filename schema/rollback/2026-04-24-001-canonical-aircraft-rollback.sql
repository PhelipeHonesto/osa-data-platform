-- Rollback for schema/canonical/aircraft.sql (Stage 2a aircraft ER tables).
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Tested via local Docker Postgres: up → down → up cycle must succeed.
--
-- Drops dependents first (aircraft_aliases, aircraft_identities reference
-- canonical.aircraft). Drops the schema only if empty, so rolling back this
-- migration alone doesn't nuke a schema that later migrations have populated
-- with other tables (fbo, airport, person, link tables).

DROP TABLE IF EXISTS canonical.aircraft_aliases;
DROP TABLE IF EXISTS canonical.aircraft_identities;
DROP TABLE IF EXISTS canonical.aircraft;

-- Drop the schema only if it's empty. Safe: if a later migration added
-- canonical.operator_aircraft_link or canonical.fbo, this DROP fails the
-- RESTRICT (noisy, and correct).
DROP SCHEMA IF EXISTS canonical RESTRICT;
