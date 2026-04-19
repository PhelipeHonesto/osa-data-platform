-- 2026-04-19-002: Generalize pipeline_runs beyond the nightly FAA pipeline.
--
-- The original table was FAA-specific (new_aircraft, deregistered,
-- aircraft_classified, ghost_candidates columns that only make sense for
-- the nightly FAA diff + graph update). Commit 13 needs the table to
-- track ALL ingestion jobs — backfill, archive, dq-check, future jobs.
--
-- Additive migration:
--   job_name         TEXT  — identifies which ingestion script emitted the row.
--   row_count_delta  INTEGER — rows inserted/updated/deleted in the run.
--   metadata         JSONB — per-job structured details (job-specific fields).
--
-- Existing FAA-pipeline rows keep their FAA-specific columns; new rows
-- for other jobs leave those NULL or 0 and use metadata for their own shape.
-- Existing rows get job_name='faa_nightly' so reports can distinguish.

ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS job_name TEXT;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS row_count_delta INTEGER DEFAULT 0;
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

-- Backfill job_name on existing rows. Safe to re-run — only sets NULL rows.
UPDATE pipeline_runs SET job_name = 'faa_nightly' WHERE job_name IS NULL;

-- Once backfilled, enforce NOT NULL so future writers must set it.
ALTER TABLE pipeline_runs ALTER COLUMN job_name SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_job ON pipeline_runs(job_name, started_at DESC);
