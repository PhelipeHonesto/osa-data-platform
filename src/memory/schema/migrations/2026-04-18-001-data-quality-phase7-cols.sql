-- 2026-04-18-001: Phase 7 additions to data_quality_runs.
--
-- The original Phase 7 Step 2 work added six columns to data_quality_runs
-- (run_id, check_name, status, threshold, actual_value, context) directly
-- inside the CREATE TABLE body in schema-pg.sql, without a paired ALTER
-- statement. Because that block is CREATE TABLE IF NOT EXISTS, existing
-- Supabase DBs never picked up the new columns — the columns lived only in
-- source. scripts/phase7-verify.ts writes to these columns and would fail
-- against Supabase.
--
-- This migration captures the intended ALTERs so existing DBs catch up.
-- The columns were removed from transactional/eval.sql's CREATE TABLE body
-- in the same commit; this file is now the sole source of those additions.
-- Indexes for the Phase 7 columns are also created here so they only exist
-- after the ALTER has completed.

ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS run_id UUID;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS check_name TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS status TEXT
  CHECK (status IS NULL OR status IN ('pass', 'fail'));
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS threshold TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS actual_value TEXT;
ALTER TABLE data_quality_runs ADD COLUMN IF NOT EXISTS context JSONB;

CREATE INDEX IF NOT EXISTS idx_dqr_run_id     ON data_quality_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_dqr_check_name ON data_quality_runs(check_name);
