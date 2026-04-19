-- Operational bookkeeping: autonomy rules, webhook dedup, pipeline/backfill/archive
-- progress tracking, cross-validation reports, nightly packager audit.

CREATE TABLE IF NOT EXISTS autonomy_rules (
  id SERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  intent TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  auto_send_enabled INTEGER NOT NULL DEFAULT 0,
  auto_send_after INTEGER NOT NULL DEFAULT 10,
  current_approvals INTEGER NOT NULL DEFAULT 0,
  max_delay_seconds INTEGER NOT NULL DEFAULT 30,
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(channel, intent, recipient_type)
);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  idempotency_key TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Generic ingestion-job tracking. Originally FAA-pipeline specific; generalized
-- in migration 2026-04-19-002 with job_name + row_count_delta + metadata.
-- Existing FAA columns (new_aircraft, deregistered, ...) kept for backward
-- compat with src/ingestion/pipeline.ts writes; new jobs use metadata JSONB.
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL DEFAULT 'faa_nightly',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  steps_completed INTEGER NOT NULL DEFAULT 0,
  failed_step TEXT,
  -- FAA-pipeline-specific columns (legacy; new jobs leave these 0)
  new_aircraft INTEGER NOT NULL DEFAULT 0,
  deregistered INTEGER NOT NULL DEFAULT 0,
  ownership_changes INTEGER NOT NULL DEFAULT 0,
  field_changes INTEGER NOT NULL DEFAULT 0,
  aircraft_classified INTEGER NOT NULL DEFAULT 0,
  ghost_candidates INTEGER NOT NULL DEFAULT 0,
  total_in_graph INTEGER NOT NULL DEFAULT 0,
  charter_tracked INTEGER NOT NULL DEFAULT 0,
  -- Generic columns (2026-04-19-002)
  row_count_delta INTEGER DEFAULT 0,
  metadata JSONB DEFAULT '{}'::jsonb,
  error_message TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_date ON pipeline_runs(started_at);
-- idx_pipeline_runs_job is created by migrations/2026-04-19-002-pipeline-runs-generic.sql
-- after the job_name column is added. Cannot live here because CREATE TABLE
-- IF NOT EXISTS is a no-op on pre-migration DBs → index would reference a
-- non-existent column → hard fail. See data-architecture.md Rule 5.

CREATE TABLE IF NOT EXISTS backfill_progress (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
  legs_found INTEGER NOT NULL DEFAULT 0,
  charter_legs INTEGER NOT NULL DEFAULT 0,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  processed_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS archive_progress (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'no_release')),
  files_archived INTEGER NOT NULL DEFAULT 0,
  total_bytes BIGINT NOT NULL DEFAULT 0,
  s3_prefix TEXT,
  archived_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- Cross-validation reports (Phase 2 D4 — cross-validation vs adsb.lol).
-- One row per UTC date. Written by src/ingestion/cross-validate.ts.
CREATE TABLE IF NOT EXISTS validation_reports (
  date TEXT PRIMARY KEY,
  validated_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT NOT NULL,

  osa_aircraft INTEGER,
  adsblol_aircraft INTEGER,
  aircraft_in_both INTEGER,
  aircraft_only_osa INTEGER,
  aircraft_only_adsblol INTEGER,

  osa_positions INTEGER,
  adsblol_positions INTEGER,
  avg_positions_per_aircraft_osa REAL,
  avg_positions_per_aircraft_adsblol REAL,

  aircraft_overlap_pct REAL,
  position_density_ratio REAL,

  sample_missing_hex_osa JSONB,
  sample_missing_hex_adsblol JSONB,
  sample_hex_both JSONB,

  osa_tar_s3_key TEXT,
  adsblol_tar_s3_key TEXT,
  error_message TEXT
);

-- Nightly packager audit (Phase 2 D2). One row per UTC day, written by
-- src/ingestion/package-positions.ts. Primary key is date so re-runs are
-- idempotent via UPSERT.
CREATE TABLE IF NOT EXISTS osa_position_archive (
  date TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  rows INTEGER,
  distinct_aircraft INTEGER,
  compressed_bytes BIGINT,
  positions_sha256 TEXT,
  tar_sha256 TEXT,
  s3_parquet_key TEXT,
  s3_tar_key TEXT,
  s3_manifest_key TEXT,
  packaged_at TIMESTAMPTZ DEFAULT NOW(),
  error_message TEXT
);
