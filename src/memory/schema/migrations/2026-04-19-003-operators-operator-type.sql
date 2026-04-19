-- 2026-04-19-003: Add operator_type discriminator to operators.
--
-- Rationale: Phase 1 calibration (docs/phase1-followups.md §1) found at
-- least 5 rows in the operators canonical that are not operating carriers —
-- Accent Airways (billing agent), Global Jet Capital (financier), TAG
-- Aviation USA (defunct), VistaJet US (broker), and likely more. Without a
-- type discriminator the Phase 2 Gold views will recommend non-carriers.
-- This is ER plan build step 2, called out as a pre-Phase-2 blocker in
-- docs/er-architecture-plan.md.
--
-- Nullable on purpose — only well-known classifications backfill here (via
-- scripts/backfill-operator-types.ts). Remaining ~260 rows stay NULL for
-- later audit against FAA Part 135 OpSpec D085 (when it's next publicly
-- available) or FAA-registry + safety-ratings presence.
--
-- Convention: TEXT + CHECK constraint, matching the project's other
-- enumerated columns (match_confidence, alias_type, operator_match_review
-- status, scraped_source). No CREATE TYPE — ALTER TYPE for future additions
-- is substantially more painful than ALTER TABLE ... DROP/ADD CONSTRAINT.
--
-- Column lives in operators.sql's CREATE TABLE body (so fresh installs
-- pick it up); this migration is the ALTER for existing Supabase DBs plus
-- the supporting index. Per Schema Evolution Rule 5 (new-indexes-on-
-- new-columns), the index lives ONLY in the migration, never duplicated
-- in the CREATE TABLE block.

ALTER TABLE operators ADD COLUMN IF NOT EXISTS operator_type TEXT
  CHECK (operator_type IS NULL OR operator_type IN (
    'part_135','part_121','part_91k','foreign_aoc','broker',
    'billing_agent','financier','holding_co','defunct','trust_holder'
  ));

CREATE INDEX IF NOT EXISTS idx_operators_type ON operators(operator_type);
