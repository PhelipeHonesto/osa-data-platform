-- Rollback for schema/canonical/brand_groups.sql (Path A — Stage 5 schema
-- scaffolding, A.9 Phase 5).
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Tested via local Docker Postgres: up → down → up cycle must succeed.
--
-- Drops in reverse FK dependency order:
--   1. canonical.brand_membership_pending      (FK → operator + brand_groups)
--   2. canonical.operator_brand_membership     (FK → operator + brand_groups)
--   3. canonical.brand_groups                  (FK → operator)
--
-- Refuses to run if any of the three tables has rows — guardrail per
-- CLAUDE.md §3 (six-entity discipline; pending sidecars hold queued
-- cross-entity claims and shouldn't be dropped silently). Mirrors the
-- pattern from
-- 2026-04-26-002-canonical-operator-holds-certificate-pending-rollback.sql
-- and 2026-04-25-001-canonical-certificates-rollback.sql.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -f schema/rollback/2026-05-06-001-canonical-brand-groups-rollback.sql

BEGIN;

DO $$
DECLARE
  tbl TEXT;
  row_count BIGINT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'brand_membership_pending',
    'operator_brand_membership',
    'brand_groups'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables
      WHERE schemaname = 'canonical' AND tablename = tbl
    ) THEN
      EXECUTE format('SELECT COUNT(*) FROM canonical.%I', tbl) INTO row_count;
      IF row_count > 0 THEN
        RAISE EXCEPTION
          'canonical.% has % rows — refusing to drop. '
          'Resolve via Phase 7 LLM ER design / manual review or DROP TABLE manually if you really mean it.',
          tbl, row_count;
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS canonical.brand_membership_pending;
DROP TABLE IF EXISTS canonical.operator_brand_membership;
DROP TABLE IF EXISTS canonical.brand_groups;

COMMIT;
