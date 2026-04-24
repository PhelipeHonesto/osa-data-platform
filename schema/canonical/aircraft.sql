-- canonical.aircraft + supporting overlay tables.
--
-- One row per real-world airframe, regardless of how many sources (FAA
-- registry, ADS-B observation, Argus, Wyvern, JetNet claim, manual) describe
-- it. The UUID aircraft_id is stable forever; per-source linkage lives in
-- aircraft_identities; alternate names in aircraft_aliases (scaffold only
-- in Stage 2a).
--
-- Empty on arrival — backfill is Stage 2b, a separate data session. Follows
-- the same overlay pattern as public.operators + operator_identities +
-- operator_aliases (see schema/gold/canonical/operators.sql).
--
-- Spec: docs/er/aircraft.md.
-- ER plan context: docs/er-architecture-plan.md §"Aircraft — Stage 2a".
-- Depends on: schema/_schemas.sql (CREATE SCHEMA canonical).

CREATE TABLE IF NOT EXISTS canonical.aircraft (
  aircraft_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity anchors, priority-ordered.
  --   icao_hex:            24-bit ICAO address burned into the transponder.
  --                        Immutable for airframe life (absent physical
  --                        transponder replacement). Preferred canonical anchor.
  --                        Stored as uppercase hex, no padding, no prefix.
  --   serial_number:       Manufacturer construction serial. Stable across
  --                        re-registrations and international transfers.
  --                        Not enforced unique (independent registries
  --                        occasionally collide on serials).
  --   current_tail_number: Current registration (e.g., "N123AB"). MUTABLE.
  --                        Reused ~90 days after cancellation by the FAA.
  --                        Represents current state only; historical tails
  --                        live in aircraft_aliases (when populated).
  icao_hex TEXT,
  serial_number TEXT,
  current_tail_number TEXT,

  -- Airframe attributes (facts of the airframe, not relationships).
  -- Relationships (who owns / operates / finances this airframe at time T)
  -- live in canonical.operator_aircraft_link — see docs/temporal-link-pattern.md.
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured INTEGER,

  -- Lifecycle
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

-- Partial unique: icao_hex is 1:1 with airframe while the aircraft exists on
-- the transponder. Not a full UNIQUE constraint because canonical rows can
-- exist before ADS-B observation (e.g., imported from FAA registry alone).
CREATE UNIQUE INDEX IF NOT EXISTS ux_aircraft_icao_hex
  ON canonical.aircraft (icao_hex)
  WHERE icao_hex IS NOT NULL;

-- Serial lookups by (manufacturer, serial). Not unique — international
-- registries occasionally collide. See docs/er/aircraft.md §"Identity model".
CREATE INDEX IF NOT EXISTS idx_aircraft_serial
  ON canonical.aircraft (manufacturer, serial_number)
  WHERE serial_number IS NOT NULL;

-- Tail lookups. Never unique — N-number reuse.
CREATE INDEX IF NOT EXISTS idx_aircraft_current_tail
  ON canonical.aircraft (current_tail_number)
  WHERE current_tail_number IS NOT NULL;

-- Model lookups for fleet-by-type queries (Utilization by model, etc.)
CREATE INDEX IF NOT EXISTS idx_aircraft_model
  ON canonical.aircraft (manufacturer, model);


-- Per-source link. Every (source, source_id) tuple maps to exactly one
-- aircraft row. The match_confidence + match_method + match_evidence triple
-- is the audit trail for how the link was established.
--
-- Mirrors public.operator_identities exactly in shape; source enum adapted
-- to the aircraft domain.
CREATE TABLE IF NOT EXISTS canonical.aircraft_identities (
  id SERIAL PRIMARY KEY,
  aircraft_id UUID NOT NULL REFERENCES canonical.aircraft(aircraft_id) ON DELETE CASCADE,
  -- Three distinct ADS-B sources because their raw feeds disagree on hex
  -- formatting, flight-identity stitching, and gap handling. Claims from
  -- each are kept separately so cross-source agreement is meaningful.
  --   adsb:          adsb.lol / adsblol-derived
  --   adsb_exchange: adsb.fi-network / adsbexchange-derived
  --   opensky:       OpenSky Network
  source TEXT NOT NULL
    CHECK (source IN ('faa','adsb','adsb_exchange','opensky','argus','wyvern','jetnet_claim','manual')),
  -- FAA: tail_number or serial. adsb/opensky: icao_hex. argus/wyvern: their aircraft id.
  source_id TEXT NOT NULL,
  match_confidence TEXT NOT NULL
    CHECK (match_confidence IN ('exact','high','medium','low','manual')),
  match_method TEXT,
  match_evidence JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_aircraft_identities_aircraft
  ON canonical.aircraft_identities(aircraft_id);
CREATE INDEX IF NOT EXISTS idx_aircraft_identities_source
  ON canonical.aircraft_identities(source);
CREATE INDEX IF NOT EXISTS idx_aircraft_identities_confidence
  ON canonical.aircraft_identities(match_confidence);


-- SCAFFOLD: canonical.aircraft_aliases
--
-- Reserved for alternate names (hex_code variants, tail reuse history,
-- callsign aliases). Populate only when resolution strategy requires it.
--
-- Intentionally not populated in Stage 2a. The Stage 2a resolver (Stage 2c,
-- separate session) will decide whether alias lookup is needed or whether
-- aircraft_identities.source_id + aircraft anchor fields are sufficient.
--
-- TODO (separate session, see docs/er-architecture-plan.md §"Operator"):
-- audit whether public.operator_aliases is dead infrastructure (1 row after
-- Stage 1 complete) or a resolver bug before replicating the pattern here
-- in production use.
CREATE TABLE IF NOT EXISTS canonical.aircraft_aliases (
  id SERIAL PRIMARY KEY,
  aircraft_id UUID NOT NULL REFERENCES canonical.aircraft(aircraft_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  alias_type TEXT NOT NULL
    CHECK (alias_type IN ('tail_historical','hex_variant','callsign','other')),
  source TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (aircraft_id, alias_normalized, alias_type)
);
CREATE INDEX IF NOT EXISTS idx_aircraft_aliases_aircraft
  ON canonical.aircraft_aliases(aircraft_id);
CREATE INDEX IF NOT EXISTS idx_aircraft_aliases_normalized
  ON canonical.aircraft_aliases(alias_normalized);
