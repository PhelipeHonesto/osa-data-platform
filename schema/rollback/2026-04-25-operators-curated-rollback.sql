-- Rollback for the curated operator backfill (cert-list mode).
-- Companion to scripts/backfill-operators-canonical-faa-realfleet.ts when
-- invoked with --cert-numbers=A,B,C.
--
-- Two paths in a curated run:
--   1. insert_new        — script created a new operators row + identity
--   2. merge_existing    — script appended a faa identity to a pre-existing
--                          operators row (synthetic seed, wyvern-sourced,
--                          or other prior canonical entity). The pre-existing
--                          row MUST NOT be deleted on rollback.
--
-- This rollback distinguishes the two via match_evidence->>'merged_into_existing'
-- (true on merge rows; absent on insert_new rows). Each path is reversed
-- independently.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -v run_id='<RUN_ID>' \
--     -f schema/rollback/2026-04-25-operators-curated-rollback.sql

BEGIN;

-- Preview counts.
SELECT
  (SELECT COUNT(*) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id'
       AND (match_evidence->>'merged_into_existing')::boolean = true)
                                                                               AS merged_identities_to_delete,
  (SELECT COUNT(*) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id'
       AND (match_evidence->>'merged_into_existing' IS NULL
            OR (match_evidence->>'merged_into_existing')::boolean = false))
                                                                               AS new_identities_to_delete,
  (SELECT COUNT(DISTINCT operator_id) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id'
       AND (match_evidence->>'merged_into_existing' IS NULL
            OR (match_evidence->>'merged_into_existing')::boolean = false))
                                                                               AS new_operators_to_delete;

-- Path 1 (merge_existing): delete only the appended identity. Existing
-- operator row stays untouched.
DELETE FROM public.operator_identities
WHERE source='faa'
  AND match_method='faa_operators_realfleet_merge'
  AND match_evidence->>'backfill_run_id' = :'run_id'
  AND (match_evidence->>'merged_into_existing')::boolean = true;

-- Path 2 (insert_new): delete the operator. FK CASCADE removes its
-- identity + any aliases written by this run.
DELETE FROM public.operators
WHERE id IN (
  SELECT operator_id
  FROM public.operator_identities
  WHERE source='faa'
    AND match_method='faa_operators_realfleet_merge'
    AND match_evidence->>'backfill_run_id' = :'run_id'
    AND (match_evidence->>'merged_into_existing' IS NULL
         OR (match_evidence->>'merged_into_existing')::boolean = false)
);

-- Post-delete verify.
SELECT
  (SELECT COUNT(*) FROM public.operator_identities
     WHERE source='faa'
       AND match_method='faa_operators_realfleet_merge'
       AND match_evidence->>'backfill_run_id' = :'run_id')
                                                                               AS remaining_identities_for_run;

COMMIT;
