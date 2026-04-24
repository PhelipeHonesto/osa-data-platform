-- Rollback for Checkpoint 1 — FAA bulk backfill into canonical.aircraft.
--
-- Apply manually. Matches rows by backfill_run_id stored in
-- canonical.aircraft_identities.match_evidence JSONB. Replace the run_id
-- value below with the run_id from the backfill script's stdout log.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -v run_id='<RUN_ID>' \
--     -f schema/rollback/2026-04-24-checkpoint-1-rollback.sql

BEGIN;

-- 1. Delete the aircraft_identities rows written by this run.
WITH deleted_identities AS (
  DELETE FROM canonical.aircraft_identities
  WHERE source = 'faa'
    AND match_method = 'faa_registry_tail'
    AND match_evidence->>'backfill_run_id' = :'run_id'
  RETURNING aircraft_id
)
-- 2. Delete canonical.aircraft rows that became orphan (no remaining identity).
DELETE FROM canonical.aircraft a
WHERE aircraft_id IN (SELECT aircraft_id FROM deleted_identities)
  AND NOT EXISTS (
    SELECT 1 FROM canonical.aircraft_identities ai WHERE ai.aircraft_id = a.aircraft_id
  );

-- Verify.
SELECT
  (SELECT COUNT(*) FROM canonical.aircraft)                                   AS aircraft_rows,
  (SELECT COUNT(*) FROM canonical.aircraft_identities WHERE source='faa')     AS faa_identities,
  (SELECT COUNT(*) FROM canonical.aircraft_identities
     WHERE source='faa' AND match_evidence->>'backfill_run_id' = :'run_id')   AS this_run_identities;

COMMIT;
