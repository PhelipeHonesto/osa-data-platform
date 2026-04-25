-- 2026-04-24-001: Add icao_callsign column to public.operators.
--
-- Three-letter ICAO airline designators (EJA=NetJets, LXJ=Flexjet,
-- WUP=Wheels Up, PCH=PlaneSense, VJA=VistaJet, etc.) are the key to
-- Stage 2c trustee unmask: aircraft squawking these callsigns on
-- ADS-B can be attributed to the operator even when the FAA registry
-- lists a trustee.
--
-- Sourced from faa_operators.dba_name where the value matches
-- ^[A-Z]{3}$. Backfilled by scripts/backfill-operators-icao-callsign.ts.
--
-- Not unique — same callsign may appear on multiple operators during
-- cert-transfer windows or across foreign subsidiaries. Future Stage
-- 2c work will resolve duplicates by combining callsign + flight
-- pattern matching.

ALTER TABLE public.operators
  ADD COLUMN IF NOT EXISTS icao_callsign TEXT;

CREATE INDEX IF NOT EXISTS idx_operators_icao_callsign
  ON public.operators(icao_callsign)
  WHERE icao_callsign IS NOT NULL;

COMMENT ON COLUMN public.operators.icao_callsign IS
  'Three-letter ICAO airline designator (EJA, LXJ, WUP, etc.). Used for Stage 2c trustee unmask: aircraft squawking this callsign on ADS-B can be attributed to this operator even when registered to a trustee. Sourced from faa_operators.dba_name where it matches ^[A-Z]{3}$. Not unique — same callsign may appear on multiple operators during cert-transfer windows or international subsidiaries.';
