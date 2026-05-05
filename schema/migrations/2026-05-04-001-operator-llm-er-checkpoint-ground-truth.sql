-- 2026-05-04-001: Track 6 Step 2c.5 Phase 2 P.2 — ground_truth_outcome column on
-- public.operator_llm_er_checkpoint.
--
-- NULLable column for post-review human verdicts. Populated during the --commit
-- sweep and any later manual triage. Substrate for calibration analysis after
-- Session B — without this column, calibration would require re-walking every
-- review to backfill the human verdict.
--
-- The CHECK enum captures both confirmation cases (LLM and reviewer agreed) and
-- override cases (reviewer disagreed and chose a different decision). This
-- distinction matters for calibration: confirmed cases provide direct ground
-- truth, while overrides flag systematic LLM bias.
--
-- Per the CLAUDE.md §4 three-step migration verification rule, this file is
-- verified via:
--   1. Local Docker Postgres rollback test (apply → rollback → re-apply).
--   2. npm run db:migrate-pg against Supabase production.
--   3. Production object verification via psql \d+ public.operator_llm_er_checkpoint
--      showing the new column with the CHECK constraint.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + named CHECK constraint guarded by
-- pg_constraint lookup. Re-applying is safe.

ALTER TABLE public.operator_llm_er_checkpoint
  ADD COLUMN IF NOT EXISTS ground_truth_outcome TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.operator_llm_er_checkpoint'::regclass
      AND conname = 'operator_llm_er_checkpoint_ground_truth_outcome_check'
  ) THEN
    ALTER TABLE public.operator_llm_er_checkpoint
      ADD CONSTRAINT operator_llm_er_checkpoint_ground_truth_outcome_check
      CHECK (
        ground_truth_outcome IS NULL
        OR ground_truth_outcome IN (
          'confirmed_match',
          'confirmed_new_entity',
          'confirmed_ambiguous',
          'reviewer_overrode_to_match',
          'reviewer_overrode_to_new_entity',
          'reviewer_overrode_to_ambiguous'
        )
      );
  END IF;
END $$;

COMMENT ON COLUMN public.operator_llm_er_checkpoint.ground_truth_outcome IS
  'Post-review human verdict. NULL until reviewed. Populated during --commit '
  'sweep and manual triage. Substrate for calibration analysis (temperature '
  'scaling, reliability diagrams). Six values: three confirmations (LLM '
  'and reviewer agreed) and three overrides (reviewer chose differently).';
