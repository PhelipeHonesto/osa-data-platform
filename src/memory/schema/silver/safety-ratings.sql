-- INTERNAL USE ONLY. Scraped ARGUS/Wyvern ratings consumed by the Sourcing
-- agent for operator ranking. NEVER display publicly, NEVER expose via public
-- API, NEVER redistribute. Refresh monthly max — scripts/refresh-safety-ratings.ts
-- guards against <25-day re-runs.
--
-- Downstream contract: the refresh script syncs matched rows (non-null
-- certificate_number) into faa_operators.argus_rating / wyvern_rating /
-- is_bao_stage, which is the join target Sourcing and knowledge_graph read.
-- International operators (certificate_number NULL) stay in this table only
-- and never leak into Sourcing decisions.

CREATE TABLE IF NOT EXISTS safety_ratings (
  id SERIAL PRIMARY KEY,
  certificate_number TEXT,
  operator_name TEXT NOT NULL,
  operator_name_normalized TEXT NOT NULL,

  argus_rating TEXT CHECK (argus_rating IS NULL OR argus_rating IN
    ('gold', 'gold_plus', 'platinum', 'platinum_elite')),
  argus_home_base_icao TEXT,
  argus_aircraft_count INTEGER,
  argus_last_seen_at TIMESTAMPTZ,

  wyvern_status TEXT CHECK (wyvern_status IS NULL OR wyvern_status IN
    ('registered', 'wingman')),
  wyvern_country TEXT,
  wyvern_last_seen_at TIMESTAMPTZ,

  first_scraped_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scraped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_urls JSONB,
  schema_version INTEGER NOT NULL DEFAULT 1,

  UNIQUE (operator_name_normalized)
);
CREATE INDEX IF NOT EXISTS idx_safety_ratings_cert
  ON safety_ratings(certificate_number);
CREATE INDEX IF NOT EXISTS idx_safety_ratings_argus
  ON safety_ratings(argus_rating);
CREATE INDEX IF NOT EXISTS idx_safety_ratings_wyvern
  ON safety_ratings(wyvern_status);
