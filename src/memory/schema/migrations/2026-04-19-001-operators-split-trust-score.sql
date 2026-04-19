-- 2026-04-19-001: Split operators.trust_score into two orthogonal signals.
--
-- Rationale: "trust_score" conflated two different questions that Dumont's
-- agents need to answer separately:
--
--   data_confidence_score — "How confident are we in THIS RECORD?"
--     Meta question. Governed by source reliability, freshness, agreement,
--     completeness. Computed by the trust-score.ts module (Phase 1 commit 4).
--
--   operator_trust_score — "How trustworthy is this OPERATOR as an entity?"
--     Substantive question. Governed by safety ratings, accident history,
--     multi-source corroboration, identity stability. Computed by the
--     operator-trust-score.ts module (Phase 1 commit 10).
--
-- The existing trust_score column (populated with 0.0 by commit 6) is
-- renamed to data_confidence_score. The new operator_trust_score column
-- is added with the same NUMERIC(3,2) / [0,1] CHECK / default 0.

-- Idempotent rename: stock PG has no "RENAME COLUMN IF EXISTS", so guard
-- with information_schema. First run renames; subsequent runs are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'operators' AND column_name = 'trust_score'
  ) THEN
    ALTER TABLE operators RENAME COLUMN trust_score TO data_confidence_score;
  END IF;
END $$;

ALTER TABLE operators ADD COLUMN IF NOT EXISTS operator_trust_score NUMERIC(3, 2)
  NOT NULL DEFAULT 0.0
  CHECK (operator_trust_score >= 0.0 AND operator_trust_score <= 1.0);

-- Rename the existing trust index to match the new column name; the
-- old index only existed for the old column name.
DROP INDEX IF EXISTS idx_operators_trust;
CREATE INDEX IF NOT EXISTS idx_operators_data_confidence
  ON operators(data_confidence_score);
CREATE INDEX IF NOT EXISTS idx_operators_trust
  ON operators(operator_trust_score);
