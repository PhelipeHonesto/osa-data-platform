-- Rollback for migration 2026-05-05-001 — drops the
-- operators_canonical_name_normalized_uidx UNIQUE index.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
--
-- Idempotent: DROP INDEX IF EXISTS. Re-applying is safe.
--
-- Apply via:
--   psql "$OSA_MCP_WRITE_URL" -f schema/rollback/2026-05-05-001-operators-canonical-name-unique-idx-rollback.sql

DROP INDEX IF EXISTS public.operators_canonical_name_normalized_uidx;
