-- 2026-05-06-001: Rebuild public.operator_profiles for Phase 2.2-C
-- profile-first ER architecture.
--
-- Background
--   The original public.operator_profiles (in schema/transactional/profiles.sql)
--   was a Silver-era denormalized aggregate keyed on operator NAME, holding
--   transactional metrics (avg_response_time, reliability_score, pricing_delta,
--   deal_count). It was 0-row, never populated, and tagged for deprecation
--   in its own header comment ("Phase 2 deprecates them in favour of Gold
--   canonical").
--
--   Phase 2.2-C reframes ER as profile-first: FAA Part 135 cert (authoritative)
--   → Perplexity (research) → Firecrawl (verbatim capture) → Sonnet (reasoning)
--   → structured per-cert profile with citations. ER decisions (dedup, brand
--   groups, rebrand events) become DERIVED views over profile data, not
--   primary outputs.
--
--   Same skeleton will generalize to aircraft_profiles (PK=tail_number),
--   fbo_profiles (PK=icao+name), people_profiles, etc.
--
-- This migration
--   1. Drops the deprecated transactional operator_profiles (CASCADE — 0 rows,
--      no FKs into it from production code).
--   2. Creates the new ER-oriented operator_profiles keyed on FAA cert number.
--
-- Per CLAUDE.md three-step verification rule, this is verified via:
--   1. Local Docker Postgres rollback test (up → migrate → verify → rollback
--      → verify-gone → re-migrate)
--   2. npm run db:migrate-pg against Supabase production
--   3. Production object verification via psql \d+ public.operator_profiles

DROP TABLE IF EXISTS public.operator_profiles CASCADE;

CREATE TABLE public.operator_profiles (
  -- ── Primary key ──────────────────────────────────────────────────────────
  -- FAA certificate_number is the authoritative natural key. One profile per
  -- cert. Multi-cert single-parent (West Coast Aviation: WCW + WCC) is
  -- represented as multiple profile rows linked via parent_company / brand_family
  -- and via sister_certs[] JSONB on each row.
  faa_cert_number TEXT PRIMARY KEY
    REFERENCES public.faa_operators(certificate_number) ON DELETE CASCADE,

  -- ── Identity ─────────────────────────────────────────────────────────────
  legal_name TEXT NOT NULL,
  dba_name TEXT,

  -- ── Current state ────────────────────────────────────────────────────────
  -- The brand-of-the-day (e.g., "Vista America" for cert W6JA today, even
  -- though the legal entity is still "Western Air Charter, Inc.").
  current_brand TEXT,
  -- The corporate parent (e.g., "Vista Global Holding S.A." for Vista America
  -- subsidiaries). NULL when the operator is independent / unaffiliated.
  parent_company TEXT,
  -- Cross-cert brand cluster identifier (e.g., "Vista" gathers Vista America +
  -- XOJET Aviation + Jet Select + Red Wing under one umbrella). Used for
  -- rolling up brand-level analytics across multiple certs.
  brand_family TEXT,

  -- ── History (LLM-asserted, citation-backed) ──────────────────────────────
  -- Each JSONB array entry should include {value, valid_from, valid_to,
  -- source_url, quote, supports_claim} so curation passes can promote into
  -- canonical.* tables with provenance intact.
  historical_aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Predecessor cert numbers (this profile's cert succeeded these). E.g.,
  -- consolidation events where multiple certs collapsed into one.
  predecessor_certs JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Sister certs operating under the same parent / brand family.
  sister_certs JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Acquisition / merger / spinoff events touching this cert holder.
  acquisition_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- ── Evidence ─────────────────────────────────────────────────────────────
  -- The Perplexity discovery queries actually executed during this profile
  -- build (audit trail of what the agent searched).
  perplexity_queries JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Full Firecrawl scrape ledger: [{url, fetched_at, content_length, content_hash}].
  -- Truncate page bodies to <30k chars per page when persisting.
  firecrawl_pages JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Verbatim quotes the agent used to back specific claims.
  -- [{url, quote, supports_claim, claim_path: "current_brand" | "acquisition_history[0]" | ...}].
  verbatim_quotes JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Agent's self-assessed confidence in the profile as a whole, 0.0–1.0.
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 0.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  -- 'thin' = sparse web presence, profile mostly defaults / unknowns;
  -- 'partial' = some structural fields filled, others uncertain;
  -- 'complete' = all relevant structural fields confidently filled.
  research_completeness TEXT NOT NULL DEFAULT 'thin'
    CHECK (research_completeness IN ('thin', 'partial', 'complete')),

  -- ── Run metadata ─────────────────────────────────────────────────────────
  -- {research_date, cost_usd, wall_clock_seconds, citation_validated,
  --  prompt_version, model, tools_used: [perplexity_search, firecrawl_scrape,
  --  canonical_lookup], n_perplexity_calls, n_firecrawl_pages,
  --  n_canonical_lookups}.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- ── Lifecycle ────────────────────────────────────────────────────────────
  -- Same parallel-write architectural-status pattern as
  -- canonical.brand_membership_pending and canonical.operator_event_pending
  -- (Phase 2.2-B). Curation passes promote rows into canonical.* views once
  -- corroborated.
  architectural_status TEXT NOT NULL DEFAULT 'provisional_profile_v1'
    CHECK (architectural_status IN (
      'provisional_profile_v1',
      'review_pending',
      'curated',
      'superseded'
    )),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- Lookup indexes for cross-cert clustering queries.
CREATE INDEX idx_operator_profiles_parent_company
  ON public.operator_profiles (parent_company)
 WHERE parent_company IS NOT NULL;

CREATE INDEX idx_operator_profiles_current_brand
  ON public.operator_profiles (current_brand)
 WHERE current_brand IS NOT NULL;

CREATE INDEX idx_operator_profiles_brand_family
  ON public.operator_profiles (brand_family)
 WHERE brand_family IS NOT NULL;

CREATE INDEX idx_operator_profiles_arch_status
  ON public.operator_profiles (architectural_status);

-- GIN indexes on JSONB columns for containment queries
-- (e.g., "find all profiles where historical_aliases contains 'Keystone'").
CREATE INDEX idx_operator_profiles_historical_aliases_gin
  ON public.operator_profiles USING GIN (historical_aliases jsonb_path_ops);

CREATE INDEX idx_operator_profiles_acquisition_history_gin
  ON public.operator_profiles USING GIN (acquisition_history jsonb_path_ops);

CREATE INDEX idx_operator_profiles_sister_certs_gin
  ON public.operator_profiles USING GIN (sister_certs jsonb_path_ops);

-- updated_at autotouch trigger
CREATE OR REPLACE FUNCTION public.operator_profiles_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS operator_profiles_updated_at_touch ON public.operator_profiles;
CREATE TRIGGER operator_profiles_updated_at_touch
  BEFORE UPDATE ON public.operator_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.operator_profiles_touch_updated_at();
