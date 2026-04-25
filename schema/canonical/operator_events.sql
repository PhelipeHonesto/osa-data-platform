-- canonical.operator_events — historical ER lineage primitive.
-- One row per claim about a discrete change in operator identity, structure,
-- or certificate: rebrands, M&A, cert transfers, formations, dissolutions.
-- Append-only; corrections land as new rows that close prior claims via
-- valid_to. Follows docs/temporal-link-pattern.md with the "event_date
-- variant" adaptation — discrete events, not continuous windows, so no
-- non-overlap EXCLUDE constraint.
--
-- Spec: docs/er-architecture-plan.md §"canonical.operator_events".
-- Depends on: public.operators (schema/gold/canonical/operators.sql).
--
-- Empty on arrival. Population is Stage 3 (FAA GENOT + SEC EDGAR + Loud
-- Hawk editorial pipeline + manual curation). No agent/MCP reads it
-- directly — Stage 3 adds v_operator_lineage_current / v_operator_history
-- agent-facing views.
--
-- ── Deprecation note (2026-04-25) ──────────────────────────────────────
-- event_type='cert_transfer' is removed from the CHECK list as of
-- migration 2026-04-25-001 — cert lineage now lives in
-- canonical.certificate_events (event-edge variant). Architectural
-- decision logged in commit 3b37d7f. Existing rows: zero on arrival.
-- The matrix row below is retained for historical reference only.
--
-- ── Source naming convention ───────────────────────────────────────────
-- `source` is free-text; ingestion scripts populate it with stable slugs:
--   faa_genot                     FAA General Notice bulletins
--   sec_edgar_8k                  SEC 8-K filings (M&A disclosures)
--   sec_edgar_s1                  SEC S-1 filings (formations / IPOs)
--   company_press_release         Operator press releases (Firecrawl-scraped)
--   loud_hawk_<article-slug>      Loud Hawk editorial pieces
--   court_filing_<jurisdiction>   Bankruptcy / dissolution court filings
--   state_sos_<state>             Secretary of State entity filings
--   manual                        Human-entered, see notes in evidence
--
-- ── Expected-field matrix by event_type ────────────────────────────────
-- "—" = NULL expected. ✓ = populated (UUID when in canonical, else *_name).
-- Rebrands preserve the cert by definition; aoc_before/aoc_after both NULL.
--
--   event_type      | primary | predecessor | successor | other_party | aoc_before | aoc_after
--   ----------------+---------+-------------+-----------+-------------+------------+-----------
--   rebrand         |    —    |      ✓      |     ✓     |      —      |     —      |     —
--   legal_rename    |    —    |      ✓      |     ✓     |      —      |     ✓      |     ✓
--   acquisition     |   ✓     |      —      |     —     |     ✓       |     —      |     —
--                   | (acquirer)                         | (acquired)
--   merger          |    —    |      ✓      |     ✓     |     ✓       |     —      |     —
--   spinoff         |    —    |      ✓      |     ✓     |      —      |     —      |     ✓
--   cert_transfer*  |    —    |      ✓      |     ✓     |      —      |     ✓      |     ✓
--                   |         |   (from)    |    (to)
--                   |         * deprecated 2026-04-25 — refused at write time;
--                   |           use canonical.certificate_events instead.
--   cert_surrender  |   ✓     |      —      |     —     |      —      |     ✓      |    NULL
--   cert_revocation |   ✓     |      —      |     —     |      —      |     ✓      |    NULL
--   dissolution     |   ✓     |      —      |     —     |      —      |     ✓      |    NULL
--   formation       |   ✓     |      —      |     —     |      —      |    NULL    |     ✓
--   aoc_change      |   ✓     |      —      |     —     |      —      |     ✓      |     ✓
--
-- The matrix is documented, not enforced via CHECK — too brittle, breaks
-- when source data is partial. Ingestion scripts validate before INSERT.

CREATE TABLE IF NOT EXISTS canonical.operator_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Event taxonomy. Closed set — adding new types is rare and warrants review.
  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'rebrand',
      'legal_rename',
      'acquisition',
      'merger',
      'spinoff',
      'cert_surrender',
      'cert_revocation',
      'dissolution',
      'formation',
      'aoc_change'
    )),

  event_date DATE NOT NULL,

  -- Parties. NULL on sides not applicable for this event_type. See the
  -- expected-field matrix above.
  primary_operator_id UUID REFERENCES public.operators(id) ON DELETE RESTRICT,
  predecessor_id      UUID REFERENCES public.operators(id) ON DELETE RESTRICT,
  successor_id        UUID REFERENCES public.operators(id) ON DELETE RESTRICT,
  other_party_id      UUID REFERENCES public.operators(id) ON DELETE RESTRICT,

  -- Names as captured at event time. Populated when the corresponding UUID
  -- is NULL (operator not yet in canonical) so the claim survives until a
  -- future session backfills the UUID.
  predecessor_name TEXT,
  successor_name   TEXT,
  other_party_name TEXT,

  -- Certificate state change. Opaque TEXT — US Part 135 cert, foreign AOC,
  -- or synthetic ID depending on operator jurisdiction.
  aoc_before TEXT,
  aoc_after  TEXT,

  -- Provenance (matches docs/temporal-link-pattern.md §"Canonical column shape").
  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  evidence JSONB NOT NULL,

  -- Two-Source Rule tracking (shape identical to every temporal link table).
  -- Append-only arrays of {source, source_url, source_timestamp, ingestion_date[, conflict]}.
  corroborated_by JSONB,
  contradicted_by JSONB,

  -- Claim-level validity (append-only; corrections close the old claim).
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  CHECK (valid_to IS NULL OR valid_to > valid_from),

  -- Idempotency guardrail. Ingestion scripts compute this (e.g.
  -- 'faa_genot_2023-05-15_EJA_rebrand') so replays are no-ops. NULL allowed
  -- for manual entries.
  natural_key TEXT UNIQUE,

  -- Schema lifecycle.
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- Per-party history lookups.
CREATE INDEX IF NOT EXISTS idx_operator_events_primary
  ON canonical.operator_events(primary_operator_id) WHERE primary_operator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_events_predecessor
  ON canonical.operator_events(predecessor_id) WHERE predecessor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_events_successor
  ON canonical.operator_events(successor_id) WHERE successor_id IS NOT NULL;

-- Time-anchored lookups ("what happened in 2023", "who rebranded this decade").
CREATE INDEX IF NOT EXISTS idx_operator_events_date
  ON canonical.operator_events(event_date);
CREATE INDEX IF NOT EXISTS idx_operator_events_type_date
  ON canonical.operator_events(event_type, event_date);

-- Cert-tracing lookups ("who held this cert before 2022").
CREATE INDEX IF NOT EXISTS idx_operator_events_aoc_before
  ON canonical.operator_events(aoc_before) WHERE aoc_before IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_operator_events_aoc_after
  ON canonical.operator_events(aoc_after) WHERE aoc_after IS NOT NULL;

-- Current-state hot path — partial index for "active claims" sweeps.
CREATE INDEX IF NOT EXISTS idx_operator_events_current
  ON canonical.operator_events(event_type, event_date) WHERE valid_to IS NULL;
