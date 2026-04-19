-- Gold canonical: operators.
-- One row per real-world charter/fractional/corporate operator, regardless of
-- how many sources (FAA, ARGUS, Wyvern, Wyvern-Registered, ADS-B-derived,
-- manual) describe it. The UUID id is stable forever; per-source linkage
-- lives in operator_identities; name variants in operator_aliases; ambiguous
-- match candidates land in operator_match_review.
--
-- Empty on arrival — backfill happens in Phase 1 commits 6 and 7. No
-- agent/MCP code reads these tables directly (Schema Evolution Rule 6);
-- Sourcing consumes them via Gold agent-facing views landed in Phase 2.

CREATE TABLE IF NOT EXISTS operators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name TEXT NOT NULL,
  -- Multi-valued taxonomy (Q8 resolution). Real operators often span multiple
  -- categories; enum would force one-hot assignments that don't reflect reality.
  type_tags TEXT[] NOT NULL DEFAULT '{}'
    CHECK (type_tags <@ ARRAY[
      'charter','fractional','corporate','air_ambulance',
      'cargo','management','military','government'
    ]::TEXT[]),
  headquarters_icao TEXT,
  -- Computed 0.0–1.0 confidence in this record. Formula lives in the Phase 1
  -- trust-score job (commit 10); defaults to 0 until first computation.
  trust_score NUMERIC(3, 2) NOT NULL DEFAULT 0.0
    CHECK (trust_score >= 0.0 AND trust_score <= 1.0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_operators_name ON operators(canonical_name);
CREATE INDEX IF NOT EXISTS idx_operators_hq ON operators(headquarters_icao);
CREATE INDEX IF NOT EXISTS idx_operators_trust ON operators(trust_score);
CREATE INDEX IF NOT EXISTS idx_operators_type_tags ON operators USING GIN (type_tags);

-- Per-source link. Every (source, source_id) tuple maps to exactly one operator.
-- The match_confidence + match_method + match_evidence triple is the audit
-- trail for how the link was established; ambiguous matches go through
-- operator_match_review before landing here with confidence='manual'.
CREATE TABLE IF NOT EXISTS operator_identities (
  id SERIAL PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  source TEXT NOT NULL
    CHECK (source IN ('faa','argus','wyvern','isbao','adsb','manual')),
  source_id TEXT NOT NULL,
  name_as_provided TEXT NOT NULL,
  match_confidence TEXT NOT NULL
    CHECK (match_confidence IN ('exact','high','medium','low','manual')),
  match_method TEXT,
  match_evidence JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_operator_identities_operator
  ON operator_identities(operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_identities_source
  ON operator_identities(source);
CREATE INDEX IF NOT EXISTS idx_operator_identities_confidence
  ON operator_identities(match_confidence);

-- All known name variants for an operator. legal = FAA-registered legal name,
-- dba = "doing business as" / trade name, marketing = customer-facing brand,
-- historical = prior name before rebrand. Used by the matcher to catch
-- variants without having to re-score the whole space.
CREATE TABLE IF NOT EXISTS operator_aliases (
  id SERIAL PRIMARY KEY,
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  alias_type TEXT NOT NULL
    CHECK (alias_type IN ('legal','dba','marketing','historical')),
  source TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (operator_id, alias_normalized)
);
CREATE INDEX IF NOT EXISTS idx_operator_aliases_operator
  ON operator_aliases(operator_id);
CREATE INDEX IF NOT EXISTS idx_operator_aliases_normalized
  ON operator_aliases(alias_normalized);

-- Manual review queue for ambiguous entity-resolution matches.
-- The backfill and refresh scripts enqueue pending rows when a scraped
-- record scores in the 'low' tier or has multiple medium-tier candidates.
-- A human walks the queue via scripts/operators-review.ts (commit 9) and
-- either picks a candidate (status='matched'), creates a new canonical row
-- (status='new_operator'), or defers (status='skipped'). Never auto-merge
-- below 'high' confidence.
CREATE TABLE IF NOT EXISTS operator_match_review (
  id SERIAL PRIMARY KEY,
  scraped_name TEXT NOT NULL,
  scraped_source TEXT NOT NULL
    CHECK (scraped_source IN ('faa','argus','wyvern','isbao','adsb','manual')),
  scraped_source_id TEXT,
  scraped_payload JSONB NOT NULL,
  -- Array of {operator_id, canonical_name, score, signals} objects, sorted
  -- by score desc. May be empty when no candidate scored above 0.60.
  candidate_matches JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','matched','new_operator','skipped')),
  -- Set when a reviewer picks a candidate or creates a new operator.
  resolution_operator_id UUID REFERENCES operators(id),
  reviewer_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_operator_match_review_status
  ON operator_match_review(status);
CREATE INDEX IF NOT EXISTS idx_operator_match_review_source
  ON operator_match_review(scraped_source);
