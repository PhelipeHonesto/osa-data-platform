-- Rollback for migration 2026-05-06-001 — drops the new ER-oriented
-- public.operator_profiles and re-creates the deprecated transactional one
-- as it existed in schema/transactional/profiles.sql, so the rollback
-- restores the pre-migration state byte-equivalent.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
--
-- Idempotent.

DROP TRIGGER IF EXISTS operator_profiles_updated_at_touch ON public.operator_profiles;
DROP FUNCTION IF EXISTS public.operator_profiles_touch_updated_at();
DROP TABLE IF EXISTS public.operator_profiles CASCADE;

-- Restore the pre-migration deprecated transactional shape (mirrors
-- schema/transactional/profiles.sql exactly).
CREATE TABLE IF NOT EXISTS public.operator_profiles (
  name TEXT PRIMARY KEY,
  home_base TEXT NOT NULL DEFAULT '',
  certs JSONB NOT NULL DEFAULT '[]',
  fleet JSONB NOT NULL DEFAULT '[]',
  avg_response_time REAL NOT NULL DEFAULT 0,
  reliability_score REAL NOT NULL DEFAULT 0,
  pricing_delta REAL NOT NULL DEFAULT 0,
  payment_speed REAL NOT NULL DEFAULT 0,
  quote_to_book_rate REAL NOT NULL DEFAULT 0,
  cancel_rate REAL NOT NULL DEFAULT 0,
  deal_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL DEFAULT 1
);
