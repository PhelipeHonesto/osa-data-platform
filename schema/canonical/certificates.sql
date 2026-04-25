-- canonical.certificates — first-class certificate entity (FAA Part 135/121/91K/etc.).
-- Architectural decision logged 2026-04-25 in commit 3b37d7f. Schema spec:
-- docs/er/certificate.md. Pattern: docs/temporal-link-pattern.md.
--
-- Six tables bundled here in dependency order so the canonical/ folder load
-- (alphabetical) resolves FKs correctly. Mirrors the aircraft.sql bundling
-- pattern (aircraft + identities + aliases in one file).
--
-- Empty on arrival. Population is Track 6 Step 2+ (FAA Air Carrier DB,
-- OpSpec D085 fleet auth, DOT Part 295/298 corroboration, ARGUS/Wyvern).
--
-- ── canonical.certificate_identities.source — allowed values ──────────────
-- Free-text; ingestion scripts populate with stable slugs. Mirrors
-- canonical.operator_events.source idiom — CHECK is too brittle when ER
-- ingestion sources expand monthly during Stage 6 build-out.
--   faa_air_carrier_db          FAA Air Carrier Certificate database
--   faa_d085                    OpSpec D085 (Part 135 Operators and Aircraft list)
--   faa_dereg                   FAA deregistered registry (transfer evidence)
--   faa_genot                   FAA General Notice bulletins
--   dot_part_298                DOT Part 298 air taxi commuter list
--   dot_part_295                DOT Part 295 broker list
--   operator_self_disclosure    Operator-provided cert reference
--   loud_hawk_<article-slug>    Loud Hawk editorial pieces
--   manual                      Human-entered, see notes in evidence

-- ── canonical.certificates ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS canonical.certificates (
  cert_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identity anchors (priority-ordered per docs/er/certificate.md):
  -- faa_cert_number > dot_number > OpSpec D085 cert_id. faa_cert_number
  -- nullable to support foreign certs (CAACI, EASA, etc.) when those
  -- ingestion sources come online in Step 5+.
  cert_authority TEXT NOT NULL DEFAULT 'faa'
    CHECK (cert_authority IN ('faa','caaci','easa','dgca','anac','other')),
  faa_cert_number TEXT,

  -- Holder name from canonical resolution. NULL until Step 3 backfill from
  -- FAA Air Carrier Certificate database.
  canonical_holder_name TEXT,

  -- Operating authority granted. Multi-part allowed comma-separated
  -- (e.g. '135,91K' for fractional dual-cert programs). Opaque-but-greppable
  -- to avoid a TEXT[] column when cardinality is tiny and stable.
  operating_part TEXT
    CHECK (operating_part IS NULL OR operating_part ~ '^[0-9]+[A-Z]?(,[0-9]+[A-Z]?)*$'),

  -- Lifecycle state. Transitions land in canonical.certificate_events
  -- (event-edge); status here is derived state, set by ingestion.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('active_operating','surrendered','revoked','consolidated','pending')),

  -- State-change anchor dates. Populated when the corresponding event lands.
  issued_date DATE,
  surrendered_date DATE,
  revoked_date DATE,

  -- Pointer to surviving cert when status='consolidated' (e.g. Vista America
  -- subsuming Jet Select / XOJET / Red Wing).
  consolidated_into_cert_id UUID REFERENCES canonical.certificates(cert_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'consolidated' AND consolidated_into_cert_id IS NOT NULL)
    OR (status <> 'consolidated' AND consolidated_into_cert_id IS NULL)
  ),

  -- Trust scoring (surfaced; never used to filter — six-entity discipline).
  data_confidence_score NUMERIC(3, 2) NOT NULL DEFAULT 0.0
    CHECK (data_confidence_score >= 0.0 AND data_confidence_score <= 1.0),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_certificates_faa_cert_number
  ON canonical.certificates (faa_cert_number)
  WHERE faa_cert_number IS NOT NULL AND cert_authority = 'faa';

CREATE INDEX IF NOT EXISTS idx_certificates_holder_name_lower
  ON canonical.certificates (LOWER(canonical_holder_name))
  WHERE canonical_holder_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_certificates_status
  ON canonical.certificates (status);


-- ── canonical.certificate_identities ──────────────────────────────────────
-- Multi-source overlay. One row per (source, source_id) seen in ingestion.
-- Mirrors canonical.aircraft_identities shape.
CREATE TABLE IF NOT EXISTS canonical.certificate_identities (
  id SERIAL PRIMARY KEY,
  cert_id UUID NOT NULL REFERENCES canonical.certificates(cert_id) ON DELETE CASCADE,

  -- Free-text source. Allowed values documented in this file's header.
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  holder_name_as_provided TEXT,

  match_confidence TEXT NOT NULL
    CHECK (match_confidence IN ('exact','high','medium','low','manual')),
  match_method TEXT,
  match_evidence JSONB,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_certificate_identities_cert
  ON canonical.certificate_identities(cert_id);
CREATE INDEX IF NOT EXISTS idx_certificate_identities_source
  ON canonical.certificate_identities(source);
CREATE INDEX IF NOT EXISTS idx_certificate_identities_confidence
  ON canonical.certificate_identities(match_confidence);


-- ── canonical.certificate_aliases ─────────────────────────────────────────
-- Names attached to a cert that aren't the canonical_holder_name —
-- DBAs (Vista America DBA Vista Jet, etc.), prior legal names from M&A,
-- predecessor holder names from cert transfers.
CREATE TABLE IF NOT EXISTS canonical.certificate_aliases (
  id SERIAL PRIMARY KEY,
  cert_id UUID NOT NULL REFERENCES canonical.certificates(cert_id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  alias_type TEXT NOT NULL
    CHECK (alias_type IN ('dba','former_legal_name','predecessor_cert_holder','other')),
  source TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cert_id, alias_normalized, alias_type)
);

CREATE INDEX IF NOT EXISTS idx_certificate_aliases_cert
  ON canonical.certificate_aliases(cert_id);
CREATE INDEX IF NOT EXISTS idx_certificate_aliases_normalized
  ON canonical.certificate_aliases(alias_normalized);


-- ── canonical.aircraft_on_certificate ─────────────────────────────────────
-- Temporal link: which aircraft are/were on which OpSpec D085 fleet auth.
-- Sourced primarily from FAA Part 135 Operators and Aircraft list (Tier 1)
-- and operator self-disclosure (Tier 2). Same airframe may appear on two
-- certs simultaneously (e.g. Part 91K + Part 135 fractional dual-cert) —
-- exclusion constraint blocks duplicate (aircraft, cert) pairs only, not
-- multi-cert presence.
-- Full canonical column shape per docs/temporal-link-pattern.md, mirroring
-- canonical.operator_aircraft_link.
CREATE TABLE IF NOT EXISTS canonical.aircraft_on_certificate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aircraft_id UUID NOT NULL REFERENCES canonical.aircraft(aircraft_id) ON DELETE RESTRICT,
  cert_id UUID NOT NULL REFERENCES canonical.certificates(cert_id) ON DELETE RESTRICT,

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

CREATE INDEX IF NOT EXISTS idx_aircraft_on_certificate_aircraft_valid_from
  ON canonical.aircraft_on_certificate (aircraft_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_aircraft_on_certificate_cert_valid_from
  ON canonical.aircraft_on_certificate (cert_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_aircraft_on_certificate_current
  ON canonical.aircraft_on_certificate (aircraft_id, cert_id)
  WHERE valid_to IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'aircraft_on_certificate_no_overlap'
      AND conrelid = 'canonical.aircraft_on_certificate'::regclass
  ) THEN
    ALTER TABLE canonical.aircraft_on_certificate
      ADD CONSTRAINT aircraft_on_certificate_no_overlap
      EXCLUDE USING gist (
        aircraft_id WITH =,
        cert_id     WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      );
  END IF;
END $$;


-- ── canonical.operator_holds_certificate ──────────────────────────────────
-- Temporal link: which operator (commercial brand) holds which cert.
-- One operator group may hold multiple certs (West Coast Aviation Services
-- holds WCW + WCC). One cert may persist across operator brand changes
-- (Vista America consolidating Jet Select + XOJET + Red Wing under one cert).
-- role discriminator reserved for future expansion (DBA brand, managing
-- operator with limited delegation).
CREATE TABLE IF NOT EXISTS canonical.operator_holds_certificate (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id UUID NOT NULL REFERENCES public.operators(id) ON DELETE RESTRICT,
  cert_id UUID NOT NULL REFERENCES canonical.certificates(cert_id) ON DELETE RESTRICT,

  role TEXT NOT NULL DEFAULT 'holder_of_record'
    CHECK (role IN ('holder_of_record','dba_brand','managing_operator','other')),

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

CREATE INDEX IF NOT EXISTS idx_operator_holds_certificate_operator_valid_from
  ON canonical.operator_holds_certificate (operator_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_operator_holds_certificate_cert_valid_from
  ON canonical.operator_holds_certificate (cert_id, valid_from DESC);
CREATE INDEX IF NOT EXISTS idx_operator_holds_certificate_current
  ON canonical.operator_holds_certificate (operator_id, role)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_operator_holds_certificate_cert_current
  ON canonical.operator_holds_certificate (cert_id)
  WHERE valid_to IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'operator_holds_certificate_no_overlap'
      AND conrelid = 'canonical.operator_holds_certificate'::regclass
  ) THEN
    ALTER TABLE canonical.operator_holds_certificate
      ADD CONSTRAINT operator_holds_certificate_no_overlap
      EXCLUDE USING gist (
        operator_id WITH =,
        cert_id     WITH =,
        role        WITH =,
        daterange(valid_from, valid_to, '[)') WITH &&
      );
  END IF;
END $$;


-- ── canonical.certificate_events ──────────────────────────────────────────
-- Event-edge variant per docs/temporal-link-pattern.md. Discrete events,
-- not continuous windows — no exclusion constraint, idempotency via
-- natural_key.
--
-- Subsumes canonical.operator_events.event_type='cert_transfer' (deprecated
-- in same commit). Two-Source Rule applies to identity-changing events
-- (transferred, consolidated).
--
-- predecessor_holder_id / successor_holder_id are loose UUIDs (no FK) —
-- backfill from FAA/DOT cert-transfer records often runs before the
-- counter-party operator is resolved into public.operators. *_name TEXT
-- columns preserve the claim until a future session resolves the UUID.
CREATE TABLE IF NOT EXISTS canonical.certificate_events (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cert_id UUID NOT NULL REFERENCES canonical.certificates(cert_id) ON DELETE RESTRICT,

  event_type TEXT NOT NULL
    CHECK (event_type IN (
      'issued',
      'transferred',
      'surrendered',
      'revoked',
      'consolidated',
      'fleet_added',
      'fleet_removed'
    )),

  event_date DATE NOT NULL,

  -- Operator parties on transfer events. Loose UUID by design.
  predecessor_holder_id UUID,
  successor_holder_id UUID,
  predecessor_holder_name TEXT,
  successor_holder_name TEXT,

  -- Aircraft party on fleet_added / fleet_removed. Internal-canonical FK.
  aircraft_id UUID REFERENCES canonical.aircraft(aircraft_id) ON DELETE RESTRICT,

  -- Surviving cert on consolidated events.
  consolidated_into_cert_id UUID REFERENCES canonical.certificates(cert_id) ON DELETE RESTRICT,

  source TEXT NOT NULL,
  source_url TEXT,
  source_timestamp TIMESTAMPTZ,
  ingestion_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence NUMERIC(3, 2) NOT NULL DEFAULT 1.0
    CHECK (confidence >= 0.0 AND confidence <= 1.0),
  evidence JSONB NOT NULL,
  corroborated_by JSONB,
  contradicted_by JSONB,

  -- Claim-level validity (append-only; corrections close prior claims).
  valid_from DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_to DATE,
  CHECK (valid_to IS NULL OR valid_to > valid_from),

  -- Idempotency guardrail. Ingestion scripts compute (e.g.
  -- 'faa_d085_2024-03-15_DCUA716B_fleet_added_N123AB') so replays no-op.
  natural_key TEXT UNIQUE,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_certificate_events_cert_date
  ON canonical.certificate_events (cert_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_certificate_events_type
  ON canonical.certificate_events (event_type);
CREATE INDEX IF NOT EXISTS idx_certificate_events_aircraft_date
  ON canonical.certificate_events (aircraft_id, event_date DESC)
  WHERE aircraft_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_certificate_events_predecessor
  ON canonical.certificate_events (predecessor_holder_id)
  WHERE predecessor_holder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_certificate_events_successor
  ON canonical.certificate_events (successor_holder_id)
  WHERE successor_holder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_certificate_events_current
  ON canonical.certificate_events (event_type, event_date)
  WHERE valid_to IS NULL;
