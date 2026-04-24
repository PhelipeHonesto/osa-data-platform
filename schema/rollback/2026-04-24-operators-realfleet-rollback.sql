-- Rollback for the real-fleet operator backfill
-- (scripts/backfill-operators-canonical-faa-realfleet.ts).
--
-- Apply manually. Matches rows by backfill_run_id stored in
-- public.operator_identities.match_evidence JSONB. Replace :run_id with
-- the backfill_run_id printed by the script at the end of its --commit run.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -v run_id='<RUN_ID>' \
--     -f schema/rollback/2026-04-24-operators-realfleet-rollback.sql
--
-- Cascade behaviour: public.operator_identities.operator_id and
-- public.operator_aliases.operator_id are FK REFERENCES public.operators(id)
-- ON DELETE CASCADE. Deleting the operators rows removes the matching
-- identities + aliases automatically.

BEGIN;

-- Preview: show what will be deleted for this run_id.
SELECT
  (SELECT COUNT(*) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id')                          AS identities_to_delete,
  (SELECT COUNT(DISTINCT operator_id) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id')                          AS operators_to_delete;

-- Delete the operators rows written by this run. FK cascade removes
-- the matching identities + aliases.
DELETE FROM public.operators
WHERE id IN (
  SELECT operator_id
  FROM public.operator_identities
  WHERE source='faa'
    AND match_method='faa_operators_realfleet_merge'
    AND match_evidence->>'backfill_run_id' = :'run_id'
);

-- Post-delete verify.
SELECT
  (SELECT COUNT(*) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id')                          AS remaining_identities_for_run;

COMMIT;
