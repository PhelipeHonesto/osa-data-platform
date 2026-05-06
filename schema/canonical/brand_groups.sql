-- canonical.brand_groups — first-class brand entity for the OSA ER graph.
-- Per /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md §Phase 5.
--
-- A brand_group bundles one or more canonical operators under a single
-- public-facing brand identity. Examples:
--   "Vista America" brand_group → primary=Vista America operator,
--     subsidiaries: Jet Select, XOJET, Red Wing
--   "Wheels Up" brand_group → primary=Wheels Up operator,
--     subsidiaries: Wheels Up Partners LLC, DELUX PUBLIC CHARTER
--   "TAG Aviation" brand_group → siblings under shared management
--     (TAG Aviation USA, TAG San Marino, etc.)
--
-- Three tables bundled here in dependency order (matches the
-- certificates.sql bundling pattern — keeps FKs in alphabetical-load
-- order without splitting across files):
--
--   1. canonical.brand_groups                   — the brand entity
--   2. canonical.operator_brand_membership      — temporal link table
--   3. canonical.brand_membership_pending       — sidecar for unresolved
--                                                  / single-source claims
--
-- Empty on arrival. Population is gated behind Phase 7's LLM ER design
-- doc + Session B's actual LLM ER pass.
--
-- ── Source naming convention ───────────────────────────────────────────
-- `source` is free-text; ingestion scripts populate with stable slugs:
--   sec_edgar_8k                  SEC 8-K filings (M&A disclosures)
--   sec_edgar_s1                  SEC S-1 filings (formations, IPOs)
--   company_press_release         Operator press releases
--   loud_hawk_<article-slug>      Loud Hawk editorial pieces
--   manual                        Human-entered, see notes in evidence
--   llm_er_<run-slug>             Single-source LLM ER finding
--                                  (lands in pending until corroborated)


-- ── canonical.brand_groups ────────────────────────────────────────────────
-- The brand entity. One row per brand identity. brand_name_normalized is
-- the UNIQUE anchor; brand_name preserves the canonical-form (case + spacing
-- + punctuation) for display.
CREATE TABLE IF NOT EXISTS canonical.brand_groups (
  brand_group_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Brand identity. brand_name is display form; brand_name_normalized is
  -- the deduplication anchor (LOWER + TRIM + collapse-whitespace, applied
  -- at write time by ingestion).
  brand_name TEXT NOT NULL,
  brand_name_normalized TEXT NOT NULL,

  -- The canonical operator that represents this brand publicly. Optional —
  -- some brand_groups are pure aggregations with no single primary entity
  -- (e.g. a sister-set under shared management with no public-facing parent).
  primary_operator_id UUID REFERENCES public.operators(id) ON DELETE RESTRICT,

  -- Provenance (matches docs/temporal-link-pattern.md §"Canonical column shape").
  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  evidence JSONB,
  corroborated_by JSONB,
  contradicted_by JSONB,

  -- Brand-level validity (a brand can be discontinued; corrections close
  -- the prior claim and open a new one — append-only discipline).
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  CHECK (valid_to IS NULL OR valid_to > valid_from),

  -- Idempotency. Ingestion computes a stable slug per (source, brand_name)
  -- so replays no-op. NULL allowed for manual entries.
  natural_key TEXT UNIQUE,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,

  -- Brand uniqueness. Same normalized name can't appear twice under any
  -- circumstances — defensive against the operators dedup class of bug
  -- (A.6 close-out).
  UNIQUE (brand_name_normalized)
);

CREATE INDEX IF NOT EXISTS idx_brand_groups_normalized
  ON canonical.brand_groups (brand_name_normalized);

CREATE INDEX IF NOT EXISTS idx_brand_groups_primary_operator
  ON canonical.brand_groups (primary_operator_id)
  WHERE primary_operator_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_brand_groups_current
  ON canonical.brand_groups (brand_name_normalized)
  WHERE valid_to IS NULL;


-- ── canonical.operator_brand_membership ───────────────────────────────────
-- Temporal link table per docs/temporal-link-pattern.md. One row per claim
-- about an operator's role within a brand_group. Mirrors the canonical
-- column shape of operator_holds_certificate / operator_aircraft_link.
--
-- role taxonomy:
--   parent       — primary brand-bearing operator (e.g. "Wheels Up" within
--                   the Wheels Up brand_group)
--   subsidiary   — owned/controlled operator under the parent
--                   (e.g. "Wheels Up Partners LLC" under Wheels Up)
--   sister       — co-equal operator under shared management/ownership
--                   (e.g. TAG Aviation USA ↔ TAG San Marino)
--   divested     — formerly part of the brand, now operating independently
--                   (close-then-insert pattern: prior 'subsidiary' window
--                    closed, new 'divested' window opened)
--   dba_only     — DBA name attached to a different operator legal entity
--                   (e.g. "Vista America DBA Vista Jet")
--
-- The non-overlapping-window EXCLUDE constraint on (operator_id,
-- brand_group_id, role, daterange) supports AOC-shopping cases where the
-- same operator's relationship to the brand changes over time (subsidiary
-- → divested, parent → subsidiary after restructure, etc.). Different
-- roles for the same operator+brand can coexist in time (an operator can
-- be both 'parent' and 'dba_only' under the brand simultaneously).
CREATE TABLE IF NOT EXISTS canonical.operator_brand_membership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  brand_group_id UUID NOT NULL REFERENCES canonical.brand_groups(brand_group_id) ON DELETE RESTRICT,

  role TEXT NOT NULL
    CHECK (role IN ('parent','subsidiary','sister','divested','dba_only')),

  valid_from DATE NOT NULL,
  valid_to DATE,
  CHECK (valid_to IS NULL OR valid_to > valid_from),

  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  match_method TEXT,
  evidence JSONB,
  corroborated_by JSONB,
  contradicted_by JSONB,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_operator_brand_membership_operator_valid_from
  ON canonical.operator_brand_membership (operator_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_operator_brand_membership_brand_group_valid_from
  ON canonical.operator_brand_membership (brand_group_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_operator_brand_membership_current
  ON canonical.operator_brand_membership (operator_id, brand_group_id)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_operator_brand_membership_role_current
  ON canonical.operator_brand_membership (brand_group_id, role)
  WHERE valid_to IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_brand_membership_no_overlap'
      AND conrelid = 'canonical.operator_brand_membership'::regclass
  ) THEN
    ALTER TABLE canonical.operator_brand_membership
      ADD CONSTRAINT operator_brand_membership_no_overlap
      EXCLUDE USING gist (
        operator_id    WITH =,
        brand_group_id WITH =,
        role           WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      );
  END IF;
END $$;


-- ── canonical.brand_membership_pending ────────────────────────────────────
-- Sidecar for brand-membership claims that can't yet land in
-- canonical.operator_brand_membership because either side is unresolved
-- in canonical, OR the claim is single-source and awaiting Two-Source Rule
-- corroboration.
--
-- Mirrors the column shape of canonical.operator_holds_certificate_pending
-- (the operator-side sidecar in certificates.sql). Both sides of the
-- relationship have UUID-or-text representation:
--   - operator_id (FK) OR operator_name_as_provided + operator_name_normalized
--   - brand_group_id (FK) OR brand_name_as_provided + brand_name_normalized
--
-- CHECKs ensure at least one representation per side. Ingestion writes
-- the UUID where it can resolve and the text otherwise; the resolver
-- promotes pending rows into operator_brand_membership when both sides
-- are anchored AND the Two-Source Rule is satisfied.
--
-- reason taxonomy:
--   single_source_brand_finding         — both sides resolved, awaiting
--                                          corroborating second source
--   no_canonical_brand_group_candidate  — operator resolved, brand_group
--                                          not yet in canonical
--   operator_not_in_canonical           — operator side unresolved
--                                          (brand may or may not be)
CREATE TABLE IF NOT EXISTS canonical.brand_membership_pending (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Operator side. Either operator_id OR operator_name_normalized must be
  -- populated. Both can be populated (resolver had a UUID hit but flagged
  -- the row pending for other reasons, e.g. single_source_brand_finding).
  operator_id UUID REFERENCES public.operators(id) ON DELETE RESTRICT,
  operator_name_as_provided TEXT,
  operator_name_normalized TEXT,

  -- Brand side. Same shape — either brand_group_id OR brand_name_normalized
  -- must be populated.
  brand_group_id UUID REFERENCES canonical.brand_groups(brand_group_id) ON DELETE RESTRICT,
  brand_name_as_provided TEXT,
  brand_name_normalized TEXT,

  -- Same role taxonomy as operator_brand_membership.
  role TEXT NOT NULL
    CHECK (role IN ('parent','subsidiary','sister','divested','dba_only')),

  -- Mirrors operator_brand_membership window shape so a future SELECT into
  -- operator_brand_membership (after resolution) is column-for-column.
  valid_from DATE NOT NULL,
  valid_to DATE,
  CHECK (valid_to IS NULL OR valid_to > valid_from),

  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  evidence JSONB,

  reason TEXT NOT NULL
    CHECK (reason IN (
      'single_source_brand_finding',
      'no_canonical_brand_group_candidate',
      'operator_not_in_canonical'
    )),

  -- At least one identification per side. Ingestion validates which is
  -- consistent with the reason; this CHECK catches the obvious "row with
  -- no anchor at all" failure mode.
  CHECK (
    operator_id IS NOT NULL OR operator_name_normalized IS NOT NULL
  ),
  CHECK (
    brand_group_id IS NOT NULL OR brand_name_normalized IS NOT NULL
  ),

  -- Resolution audit. Both NULL while pending; both set together once a
  -- human or LLM ER second-source corroboration lifts the row. CHECK keeps
  -- the pair consistent.
  resolved_at TIMESTAMPTZ,
  resolved_to_brand_group_id UUID REFERENCES canonical.brand_groups(brand_group_id) ON DELETE RESTRICT,
  CHECK (
    (resolved_at IS NULL AND resolved_to_brand_group_id IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_to_brand_group_id IS NOT NULL)
  ),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_bmp_operator
  ON canonical.brand_membership_pending (operator_id)
  WHERE operator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bmp_operator_name_normalized
  ON canonical.brand_membership_pending (operator_name_normalized)
  WHERE operator_name_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bmp_brand_group
  ON canonical.brand_membership_pending (brand_group_id)
  WHERE brand_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bmp_brand_name_normalized
  ON canonical.brand_membership_pending (brand_name_normalized)
  WHERE brand_name_normalized IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bmp_unresolved
  ON canonical.brand_membership_pending (id)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bmp_reason
  ON canonical.brand_membership_pending (reason);
