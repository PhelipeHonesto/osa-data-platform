-- Evaluation + data quality run logs.
-- eval_runs / eval_run_summaries: quote accuracy evaluation scenarios.
-- data_quality_runs: holistic + per-check (Phase 7 verify) data quality history.

CREATE TABLE IF NOT EXISTS eval_runs (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_title TEXT NOT NULL,
  departure TEXT,
  arrival TEXT,
  aircraft_class TEXT,
  estimate_low_cents INTEGER,
  estimate_high_cents INTEGER,
  estimate_median_cents INTEGER,
  osa_price_cents INTEGER,
  market_low_cents INTEGER,
  market_high_cents INTEGER,
  within_20_pct BOOLEAN NOT NULL DEFAULT FALSE,
  error_pct REAL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'skip', 'error')),
  error_message TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_run_id ON eval_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_scenario ON eval_runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs(status);

CREATE TABLE IF NOT EXISTS eval_run_summaries (
  id SERIAL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  total_scenarios INTEGER NOT NULL,
  scored_scenarios INTEGER NOT NULL,
  within_20_pct_count INTEGER NOT NULL,
  accuracy_pct REAL NOT NULL,
  mean_error_pct REAL,
  median_error_pct REAL,
  max_error_pct REAL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- Added live post-creation; codified here 2026-04-18 during schema split audit.
  slice_results JSONB
);
CREATE INDEX IF NOT EXISTS idx_eval_summaries_run ON eval_run_summaries(run_id);

-- Base table. Phase 7 per-check columns (run_id, check_name, status, threshold,
-- actual_value, context) are added by migrations/2026-04-18-001, not here — the
-- original schema-pg.sql declared them inline inside CREATE TABLE IF NOT EXISTS,
-- so existing Supabase DBs never received them. See the migration file header.
CREATE TABLE IF NOT EXISTS data_quality_runs (
  id SERIAL PRIMARY KEY,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  malformed_tails INTEGER NOT NULL DEFAULT 0,
  invalid_icao INTEGER NOT NULL DEFAULT 0,
  duplicate_legs INTEGER NOT NULL DEFAULT 0,
  orphaned_records INTEGER NOT NULL DEFAULT 0,
  empty_fields INTEGER NOT NULL DEFAULT 0,
  stale_data INTEGER NOT NULL DEFAULT 0,
  anomalies INTEGER NOT NULL DEFAULT 0,
  overall_status TEXT NOT NULL CHECK (overall_status IN ('green', 'yellow', 'red')),
  details JSONB,
  schema_version INTEGER NOT NULL DEFAULT 1
);
