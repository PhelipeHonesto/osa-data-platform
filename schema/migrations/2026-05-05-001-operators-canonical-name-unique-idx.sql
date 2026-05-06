-- 2026-05-05-001: Defensive UNIQUE index on public.operators.canonical_name
-- (case + whitespace normalized).
--
-- Session A.6 followup. End-of-A.5 surfaced 10 duplicate canonical_name pairs
-- in public.operators (NetJets Aviation, Flexjet, Wheels Up, JetRight, Contour
-- Aviation, FlyExclusive, Freestream Aircraft, PlaneSense, Thrive Aviation,
-- Tradewind Aviation). Each pair was the part_135 / conf=1.00 row from the
-- 2026-04-13 faa_operators_realfleet_merge alongside an earlier conf=0.71-0.83
-- row created on 2026-04-10 / 04-19 by faa_cert_direct / self_creation /
-- name_fuzzy without normalize-and-match against existing canonical names.
-- The 10 pairs were merged via scripts/dedup-operator-rows.ts in Session A.6.
--
-- Goal: prevent this class of duplicate from recurring. The index normalizes
-- (LOWER + TRIM + collapse internal whitespace) so future writers cannot
-- evade it via case differences (NetJets vs netjets) or whitespace padding
-- ("Wheels Up" vs " Wheels  Up ").
--
--   LOWER       — case-insensitive equality
--   TRIM        — strip leading / trailing whitespace
--   REGEXP_REPLACE(\s+, ' ', 'g')  — collapse internal whitespace runs
--
-- This blocks the SYMPTOM. The underlying cause — whichever loader inserted
-- a new operator row without dedup-against-existing — still wants a code-side
-- fix (likely in src/entity-resolution/ or src/ingestion/operators/). Tracked
-- as a Session A.7 followup.

CREATE UNIQUE INDEX IF NOT EXISTS operators_canonical_name_normalized_uidx
  ON public.operators (
    LOWER(TRIM(REGEXP_REPLACE(canonical_name, '\s+', ' ', 'g')))
  );
