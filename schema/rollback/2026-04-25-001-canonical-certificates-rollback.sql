-- Rollback for schema/canonical/certificates.sql (Track 6 Step 1).
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Tested via local Docker Postgres: up → down → up cycle must succeed.
--
-- Drops in reverse dependency order. Refuses to run if any of the six
-- tables has rows — guardrail per CLAUDE.md §3 (six-entity discipline).
-- Drops the canonical schema only with RESTRICT, so other canonical
-- tables (aircraft, operator_aircraft_link, operator_events, etc.) keep
-- the schema alive.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -f schema/rollback/2026-04-25-001-canonical-certificates-rollback.sql

BEGIN;

DO $$
DECLARE
  tbl TEXT;
  row_count BIGINT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'certificate_events',
    'operator_holds_certificate',
    'aircraft_on_certificate',
    'certificate_aliases',
    'certificate_identities',
    'certificates'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_tables
      WHERE schemaname = 'canonical' AND tablename = tbl
    ) THEN
      EXECUTE format('SELECT COUNT(*) FROM canonical.%I', tbl) INTO row_count;
      IF row_count > 0 THEN
        RAISE EXCEPTION
          'canonical.% has % rows — refusing to drop. '
          'Migrate data first or DROP TABLE manually if you really mean it.',
          tbl, row_count;
      END IF;
    END IF;
  END LOOP;
END $$;

DROP TABLE IF EXISTS canonical.certificate_events;
DROP TABLE IF EXISTS canonical.operator_holds_certificate;
DROP TABLE IF EXISTS canonical.aircraft_on_certificate;
DROP TABLE IF EXISTS canonical.certificate_aliases;
DROP TABLE IF EXISTS canonical.certificate_identities;
DROP TABLE IF EXISTS canonical.certificates;

COMMIT;

-- Schema drop runs outside the transaction so its harmless failure (when
-- aircraft / operator_aircraft_link / operator_events still depend on the
-- schema) doesn't roll back the table drops above. Catches the expected
-- dependent_objects_still_exist error and logs informationally.
DO $$
BEGIN
  DROP SCHEMA canonical RESTRICT;
  RAISE NOTICE 'canonical schema dropped (was empty after table drops)';
EXCEPTION
  WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'canonical schema retained — other tables still depend on it';
  WHEN invalid_schema_name THEN
    RAISE NOTICE 'canonical schema did not exist';
END $$;
