-- Rollback for schema/canonical/operator_aircraft_link.sql.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Drops the table only; does not drop btree_gist (other tables may use
-- it) and does not touch canonical.aircraft or public.operators.
--
-- Tested via local Docker Postgres: up → down → up cycle must succeed.

DROP TABLE IF EXISTS canonical.operator_aircraft_link;
