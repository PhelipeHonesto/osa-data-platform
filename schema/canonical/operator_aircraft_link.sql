-- canonical.operator_aircraft_link — FIRST implementation of the temporal
-- link pattern. The shape of this table is the reference shape that every
-- future cross-entity link (fbo_operator_link, person_operator_role_link,
-- operator_holding_link, etc.) MUST mirror.
--
-- Spec: docs/temporal-link-pattern.md (canonical column shape, write rules,
--       worked example).
-- Aircraft spec: docs/er/aircraft.md §"The seven-role model".
-- Depends on: canonical.aircraft (schema/canonical/aircraft.sql),
--             public.operators (schema/gold/canonical/operators.sql),
--             btree_gist extension (schema/_extensions.sql).
--
-- Empty on arrival. Backfill from faa_registry_changes is Stage 2b
-- (separate data session). No agent/MCP code reads this table directly —
-- Stage 2c agent-facing views (v_aircraft_current_operator, etc.) add
-- that surface.

CREATE TABLE IF NOT EXISTS canonical.operator_aircraft_link (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The two entities being linked.
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  aircraft_id UUID NOT NULL REFERENCES canonical.aircraft(aircraft_id) ON DELETE RESTRICT,

  -- Which of the seven roles this operator plays on this airframe. See
  -- docs/er/aircraft.md §"The seven-role model" for meanings. Manufacturer
  -- is deliberately excluded — it's an attribute of canonical.aircraft, not
  -- a relationship.
  role TEXT NOT NULL
    CHECK (role IN (
      'legal_owner',
      'beneficial_owner',
      'operator',
      'manager',
      'financier',
      'insurer',
      'broker'
    )),

  -- Temporal window. DATE, not TIMESTAMPTZ — relationships change on
  -- business days, not at sub-second precision. valid_to IS NULL means
  -- "still current"; do not use '9999-12-31' or 'infinity'.
  valid_from DATE NOT NULL,
  valid_to DATE,
  CHECK (valid_to IS NULL OR valid_to > valid_from),

  -- Provenance (shape identical across every temporal link table)
  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  match_method TEXT,
  evidence JSONB,

  -- Cross-source agreement tracking (Two-Source Rule audit trail).
  -- Arrays of {source, source_url, source_timestamp, ingestion_date[, conflict]}.
  corroborated_by JSONB,
  contradicted_by JSONB,

  -- Schema lifecycle
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- Mandatory indexes (see docs/temporal-link-pattern.md §"Index strategy").

-- Per-aircraft history: every query of "who played role X on this aircraft
-- between dates T1 and T2" anchors on aircraft_id + valid_from.
CREATE INDEX IF NOT EXISTS idx_operator_aircraft_link_aircraft_valid_from
  ON canonical.operator_aircraft_link (aircraft_id, valid_from);

-- Per-operator fleet: operator_id-anchored queries for "what did this
-- operator fly during period X" and "what does this operator fly now."
CREATE INDEX IF NOT EXISTS idx_operator_aircraft_link_operator_valid_from
  ON canonical.operator_aircraft_link (operator_id, valid_from);

-- "Current state" is the hot path — partial index so `WHERE valid_to IS NULL`
-- scans only open windows.
CREATE INDEX IF NOT EXISTS idx_operator_aircraft_link_current
  ON canonical.operator_aircraft_link (aircraft_id, role)
  WHERE valid_to IS NULL;

-- Role-anchored queries ("list all current operators of charter-class
-- aircraft") sweep role + valid_to filter.
CREATE INDEX IF NOT EXISTS idx_operator_aircraft_link_role_valid_from
  ON canonical.operator_aircraft_link (role, valid_from);

-- Non-overlapping windows per (aircraft_id, role). Prevents two
-- simultaneous open "operator" windows for the same airframe from a bad
-- backfill or duplicate ingest. Enforced at the DB, not in code.
-- Requires btree_gist (see schema/_extensions.sql).
--
-- ADD CONSTRAINT does not support IF NOT EXISTS for EXCLUDE constraints, so
-- wrap in a pg_constraint probe to keep migrate-pg idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_aircraft_link_no_overlap'
      AND conrelid = 'canonical.operator_aircraft_link'::regclass
  ) THEN
    ALTER TABLE canonical.operator_aircraft_link
      ADD CONSTRAINT operator_aircraft_link_no_overlap
      EXCLUDE USING gist (
        aircraft_id WITH =,
        role        WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      );
  END IF;
END $$;
