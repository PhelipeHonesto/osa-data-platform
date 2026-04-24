-- canonical.operator_aircraft_resolution_log
--
-- PERMANENT audit trail for Stage 2b Checkpoint 3 (and future re-runs)
-- of the operator_aircraft_link backfill. One row per resolution decision
-- — matched, review, no_match, or any skipped_* bucket from pre-filters.
-- Never truncated; never a temp/staging table. Every threshold tuning,
-- every new operator added to public.operators, every re-run against an
-- expanded operator set inspects this log to decide what changed.
--
-- Spec discussion: docs/er-architecture-plan.md §"operator_aircraft_link
-- — resolution log".
-- Companion: schema/canonical/operator_aircraft_link.sql (matched rows
-- from this log are promoted to the link table).
--
-- Empty on arrival. Populated by
-- scripts/backfill-operator-aircraft-link.ts.

CREATE TABLE IF NOT EXISTS canonical.operator_aircraft_resolution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The aircraft whose certificate_holder was resolved.
  aircraft_id UUID NOT NULL REFERENCES canonical.aircraft(aircraft_id) ON DELETE CASCADE,

  -- Input snapshot — what the resolver / pre-filter saw. Kept here (rather
  -- than re-joined at query time) because faa_aircraft.certificate_holder
  -- mutates as the FAA publishes updates, and the log must remain accurate
  -- about what was decided with what input.
  certificate_holder TEXT,
  registrant_type TEXT,

  -- Bucket the input landed in. Bracketed enum to match the bucket taxonomy
  -- in src/entity-resolution/pre-filters.ts plus the resolver actions.
  resolver_action TEXT NOT NULL
    CHECK (resolver_action IN (
      'matched',
      'matched_blocked_operator_type',
      'review',
      'no_match',
      'exact',
      'skipped_null',
      'skipped_placeholder',
      'skipped_individual',
      'skipped_trustee',
      'skipped_manufacturer'
    )),

  -- For matched / matched_blocked_operator_type / exact / review: the top
  -- candidate's operator_id. NULL for no_match and every skipped_* row.
  operator_id UUID REFERENCES public.operators(id) ON DELETE SET NULL,

  -- Operator's operator_type at resolution time — snapshotted so future
  -- audit queries can see whether the row was blocked by today's blocklist
  -- even if the operator_type classification changes later. NULL when
  -- resolver_action doesn't involve an operator.
  operator_type TEXT,

  -- Scoring signals — populated for matched / matched_blocked / review /
  -- no_match. NULL for skipped_* rows (the resolver never ran).
  tier TEXT
    CHECK (tier IS NULL OR tier IN ('high', 'medium', 'low', 'new_operator')),
  score NUMERIC(4, 3)
    CHECK (score IS NULL OR (score >= 0.0 AND score <= 1.0)),
  second_best_score NUMERIC(4, 3)
    CHECK (second_best_score IS NULL OR (second_best_score >= 0.0 AND second_best_score <= 1.0)),
  signals JSONB,

  -- Why a resolved row landed in 'review' (see match-thresholds.ts).
  reason TEXT
    CHECK (reason IS NULL OR reason IN ('ambiguous_runner_up', 'low_tier', 'medium_name_only')),

  -- For matched rows that were promoted to canonical.operator_aircraft_link,
  -- the link row's id. NULL when the row was not promoted (review,
  -- matched_blocked_operator_type, no_match, skipped_*).
  link_id UUID REFERENCES canonical.operator_aircraft_link(id) ON DELETE SET NULL,

  -- For review-tier rows promoted to public.operator_match_review, the
  -- review queue id. NULL otherwise.
  review_id INTEGER REFERENCES public.operator_match_review(id) ON DELETE SET NULL,

  -- Provenance
  backfill_run_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency anchor: one row per (aircraft_id, backfill_run_id). Re-running
-- the backfill with the same run_id would no-op; a new run_id creates a
-- fresh row (re-resolution after operator coverage expanded, threshold
-- tuning, etc.).
CREATE UNIQUE INDEX IF NOT EXISTS ux_oarl_aircraft_run
  ON canonical.operator_aircraft_resolution_log (aircraft_id, backfill_run_id);

CREATE INDEX IF NOT EXISTS idx_oarl_action
  ON canonical.operator_aircraft_resolution_log (resolver_action);

CREATE INDEX IF NOT EXISTS idx_oarl_operator
  ON canonical.operator_aircraft_resolution_log (operator_id)
  WHERE operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_oarl_run
  ON canonical.operator_aircraft_resolution_log (backfill_run_id);

CREATE INDEX IF NOT EXISTS idx_oarl_tier
  ON canonical.operator_aircraft_resolution_log (tier)
  WHERE tier IS NOT NULL;
