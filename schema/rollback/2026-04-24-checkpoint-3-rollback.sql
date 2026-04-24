-- Rollback for Checkpoint 3 — operator_aircraft_link backfill.
--
-- Apply manually. Replace :'run_id' with the backfill_run_id from the
-- script's stdout log.
--
-- Order matters:
--   1. Delete operator_aircraft_link rows for this run (found via the log).
--   2. Delete operator_match_review rows for this run (via log).
--   3. Delete resolution_log rows for this run.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -v run_id='<RUN_ID>' \
--     -f schema/rollback/2026-04-24-checkpoint-3-rollback.sql

BEGIN;

-- 1. Delete operator_aircraft_link rows.
DELETE FROM canonical.operator_aircraft_link l
 WHERE l.id IN (
   SELECT link_id
     FROM canonical.operator_aircraft_resolution_log
    WHERE backfill_run_id = :'run_id' AND link_id IS NOT NULL
 );

-- 2. Delete operator_match_review rows.
DELETE FROM public.operator_match_review r
 WHERE r.id IN (
   SELECT review_id
     FROM canonical.operator_aircraft_resolution_log
    WHERE backfill_run_id = :'run_id' AND review_id IS NOT NULL
 );

-- 3. Delete resolution_log rows.
DELETE FROM canonical.operator_aircraft_resolution_log
 WHERE backfill_run_id = :'run_id';

-- Verify.
SELECT
  (SELECT COUNT(*) FROM canonical.operator_aircraft_link)                              AS link_rows,
  (SELECT COUNT(*) FROM public.operator_match_review)                                  AS review_rows,
  (SELECT COUNT(*) FROM canonical.operator_aircraft_resolution_log)                    AS log_rows,
  (SELECT COUNT(*) FROM canonical.operator_aircraft_resolution_log
     WHERE backfill_run_id = :'run_id')                                                AS run_log_remaining;

COMMIT;
