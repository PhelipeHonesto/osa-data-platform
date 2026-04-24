-- PostgreSQL extensions required by the Dumont schema.
-- Loaded first by src/memory/migrate-pg.ts before any table definitions.

CREATE EXTENSION IF NOT EXISTS vector;

-- btree_gist lets GiST indexes and EXCLUDE constraints combine equality on
-- btree-friendly types (UUID, TEXT) with range overlap operators. Required
-- by canonical temporal link tables' non-overlapping-windows exclusion
-- constraint — see docs/temporal-link-pattern.md §"Non-overlapping-windows
-- constraint" and schema/canonical/operator_aircraft_link.sql.
CREATE EXTENSION IF NOT EXISTS btree_gist;
