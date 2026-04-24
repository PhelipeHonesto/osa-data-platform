-- Rollback for canonical.operator_events (schema/canonical/operator_events.sql).
--
-- Drops the table and all its indexes. Safe re-run via DROP IF EXISTS.
-- No data loss concern: the table is empty on arrival in this session;
-- if rollback runs against a populated table in a later session, halt
-- and migrate data first.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -f schema/rollback/2026-04-24-operator-events-rollback.sql

BEGIN;

-- Safety probe: refuse to drop if the table has rows.
DO $$
DECLARE
  row_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'canonical' AND tablename = 'operator_events'
  ) THEN
    EXECUTE 'SELECT COUNT(*) FROM canonical.operator_events' INTO row_count;
    IF row_count > 0 THEN
      RAISE EXCEPTION
        'canonical.operator_events has % rows — refusing to drop. '
        'Migrate data first or DROP TABLE manually if you really mean it.',
        row_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS canonical.operator_events;

-- Indexes drop with the table. No standalone DROP INDEX needed.

COMMIT;
