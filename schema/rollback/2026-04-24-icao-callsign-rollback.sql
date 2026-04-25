-- Rollback for 2026-04-24-001-operators-icao-callsign.sql.
--
-- Drops public.operators.icao_callsign and its partial index. Refuses
-- to drop the column if any rows have a non-NULL value — matches the
-- safety pattern in 2026-04-24-operator-events-rollback.sql.
--
-- Usage:
--   psql "$SUPABASE_DATABASE_URL" \
--     -f schema/rollback/2026-04-24-icao-callsign-rollback.sql

BEGIN;

DO $$
DECLARE
  populated_count BIGINT;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'operators'
      AND column_name = 'icao_callsign'
  ) THEN
    SELECT COUNT(*) INTO populated_count
    FROM public.operators WHERE icao_callsign IS NOT NULL;
    IF populated_count > 0 THEN
      RAISE EXCEPTION
        'public.operators has % rows with icao_callsign set — refusing to drop the column. Truncate the column (UPDATE ... SET icao_callsign = NULL) first or DROP COLUMN manually if you really mean it.',
        populated_count;
    END IF;
  END IF;
END $$;

DROP INDEX IF EXISTS public.idx_operators_icao_callsign;
ALTER TABLE public.operators DROP COLUMN IF EXISTS icao_callsign;

COMMIT;
