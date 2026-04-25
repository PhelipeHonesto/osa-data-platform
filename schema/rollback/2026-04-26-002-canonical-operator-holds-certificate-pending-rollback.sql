-- Rollback for the 8th table added to schema/canonical/certificates.sql
-- (Track 6 Step 2c — operator_holds_certificate_pending sidecar).
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
-- Tested via local Docker Postgres: up → down → up cycle must succeed.
--
-- Drops only the pending sidecar. Refuses to run if the table has rows —
-- guardrail per CLAUDE.md §3 (six-entity discipline; pending sidecar holds
-- queued cross-entity claims and shouldn't be dropped silently).
--
-- After this rollback runs, the Step 1 rollback
-- (2026-04-25-001-canonical-certificates-rollback.sql) becomes runnable
-- again because the cert_id FK from this table is gone.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -f schema/rollback/2026-04-26-002-canonical-operator-holds-certificate-pending-rollback.sql

BEGIN;

DO $$
DECLARE
  row_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'canonical' AND tablename = 'operator_holds_certificate_pending'
  ) THEN
    SELECT COUNT(*) FROM canonical.operator_holds_certificate_pending INTO row_count;
    IF row_count > 0 THEN
      RAISE EXCEPTION
        'canonical.operator_holds_certificate_pending has % rows — refusing to drop. '
        'Resolve via Step 5 corroboration / manual review or DROP TABLE manually if you really mean it.',
        row_count;
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS canonical.operator_holds_certificate_pending;

COMMIT;
