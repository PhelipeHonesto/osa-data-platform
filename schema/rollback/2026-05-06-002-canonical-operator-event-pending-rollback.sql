-- Rollback for the canonical.operator_event_pending table appended to
-- schema/canonical/operator_events.sql (Path A — Stage 5 schema
-- scaffolding, A.9 Phase 5).
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Tested via local Docker Postgres: up → down → up cycle must succeed.
--
-- Drops only the pending sidecar. Leaves canonical.operator_events
-- intact (that table has its own separate rollback at
-- 2026-04-24-operator-events-rollback.sql).
--
-- Refuses to run if the pending table has rows — guardrail per
-- CLAUDE.md §3 (pending sidecar holds queued event claims that
-- shouldn't be dropped silently). Mirrors
-- 2026-04-26-002-canonical-operator-holds-certificate-pending-rollback.sql.
--
-- After this rollback runs, the operator_events.sql file's CREATE TABLE
-- IF NOT EXISTS for operator_event_pending becomes runnable again — the
-- file itself is unchanged; only the table's row in pg_tables is removed.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -f schema/rollback/2026-05-06-002-canonical-operator-event-pending-rollback.sql

BEGIN;

DO $$
DECLARE
  row_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'canonical' AND tablename = 'operator_event_pending'
  ) THEN
    SELECT COUNT(*) FROM canonical.operator_event_pending INTO row_count;
    IF row_count > 0 THEN
      RAISE EXCEPTION
        'canonical.operator_event_pending has % rows — refusing to drop. '
        'Resolve via Phase 7 LLM ER design / manual review, or promote the '
        'rows to canonical.operator_events first via the Two-Source Rule '
        'corroboration path, or DROP TABLE manually if you really mean it.',
        row_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS canonical.operator_event_pending;

COMMIT;
