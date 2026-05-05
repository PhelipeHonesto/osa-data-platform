-- Rollback for migration 2026-05-04-001 — drops ground_truth_outcome column
-- (and its CHECK constraint) from public.operator_llm_er_checkpoint.
--
-- Applied manually — migrate-pg.ts does not load schema/rollback/.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS + DROP COLUMN IF EXISTS. Re-applying is safe.
--
-- Apply via:
--   psql "$OSA_MCP_WRITE_URL" -f schema/rollback/2026-05-04-001-operator-llm-er-checkpoint-ground-truth-rollback.sql

ALTER TABLE public.operator_llm_er_checkpoint
  DROP CONSTRAINT IF EXISTS operator_llm_er_checkpoint_ground_truth_outcome_check;

ALTER TABLE public.operator_llm_er_checkpoint
  DROP COLUMN IF EXISTS ground_truth_outcome;
