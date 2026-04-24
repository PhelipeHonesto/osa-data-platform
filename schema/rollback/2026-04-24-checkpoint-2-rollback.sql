-- Rollback for Checkpoint 2 — ADS-B identity merge onto canonical.aircraft.
--
-- Apply manually. Matches rows by backfill_run_id stored in
-- canonical.aircraft_identities.match_evidence JSONB. Replace run_id below.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -v run_id='<RUN_ID>' \
--     -f schema/rollback/2026-04-24-checkpoint-2-rollback.sql

BEGIN;

-- 1. Delete ADS-B identity rows written by this run.
WITH deleted_identities AS (
  DELETE FROM canonical.aircraft_identities
   WHERE source = 'adsb'
     AND match_evidence->>'backfill_run_id' = :'run_id'
  RETURNING aircraft_id, match_evidence->>'case' AS case_label
)
-- 2. For Case B (orphan) rows, the canonical.aircraft row was created by
--    this run too and becomes an orphan after the identity is gone —
--    delete it. Case A rows' canonical row pre-existed (from FAA
--    backfill) and must be preserved.
DELETE FROM canonical.aircraft a
 WHERE aircraft_id IN (
         SELECT aircraft_id FROM deleted_identities WHERE case_label = 'B_orphan_no_faa_row'
       )
   AND NOT EXISTS (
         SELECT 1 FROM canonical.aircraft_identities ai WHERE ai.aircraft_id = a.aircraft_id
       );

-- Verify.
SELECT
  (SELECT COUNT(*) FROM canonical.aircraft)                                 AS aircraft_rows,
  (SELECT COUNT(*) FROM canonical.aircraft_identities WHERE source='adsb')  AS adsb_identities_remaining,
  (SELECT COUNT(*) FROM canonical.aircraft_identities
     WHERE source='adsb' AND match_evidence->>'backfill_run_id' = :'run_id') AS this_run_identities;

COMMIT;
