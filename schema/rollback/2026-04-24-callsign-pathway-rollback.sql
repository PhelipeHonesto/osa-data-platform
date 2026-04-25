-- Rollback for the Stage 2c callsign-pathway backfill
-- (scripts/backfill-operator-aircraft-link-from-callsign.ts).
--
-- Deletes canonical.operator_aircraft_link rows tagged with the given
-- backfill_run_id in evidence. No refused-if-empty guardrail —
-- operator_aircraft_link is meant to grow, and clearing one bad run is
-- a real recovery scenario. But the run_id MUST be supplied; without
-- it, the script halts.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -v run_id='<RUN_ID>' \
--     -f schema/rollback/2026-04-24-callsign-pathway-rollback.sql

BEGIN;

DO $$
BEGIN
  IF :'run_id' IS NULL OR :'run_id' = '' OR :'run_id' = ':run_id' THEN
    RAISE EXCEPTION
      'run_id is required. Re-run with -v run_id=<uuid>. Refusing to delete without an explicit target run.';
  END IF;
END $$;

-- Preview.
SELECT COUNT(*) AS rows_to_delete
FROM canonical.operator_aircraft_link
WHERE source = 'adsb_callsign'
  AND evidence->>'backfill_run_id' = :'run_id';

DELETE FROM canonical.operator_aircraft_link
WHERE source = 'adsb_callsign'
  AND evidence->>'backfill_run_id' = :'run_id';

-- Verify.
SELECT COUNT(*) AS remaining_rows_for_run
FROM canonical.operator_aircraft_link
WHERE source = 'adsb_callsign'
  AND evidence->>'backfill_run_id' = :'run_id';

COMMIT;
