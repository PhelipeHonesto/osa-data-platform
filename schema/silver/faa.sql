-- FAA registry Silver tables. Ingested from the FAA MASTER/ACFTREF/ENGINE
-- zips + daily diff. Authoritative source for US aircraft registrations,
-- Part 135 operator certificates, airport facilities, and document index.

CREATE TABLE IF NOT EXISTS faa_aircraft (
  tail_number TEXT PRIMARY KEY,
  serial_number TEXT,
  mfr_model_code TEXT,
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured INTEGER,
  engine_type TEXT,
  num_engines INTEGER,
  num_seats INTEGER,
  owner_name TEXT,
  owner_city TEXT,
  owner_state TEXT,
  registrant_type TEXT,
  certificate_holder TEXT,
  certificate_number TEXT,
  icao_hex TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_class ON faa_aircraft(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_cert ON faa_aircraft(certificate_number);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_model ON faa_aircraft(common_name);
CREATE INDEX IF NOT EXISTS idx_faa_aircraft_hex ON faa_aircraft(icao_hex);

CREATE TABLE IF NOT EXISTS faa_operators (
  certificate_number TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dba_name TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  aircraft_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  argus_rating TEXT CHECK (argus_rating IS NULL OR argus_rating IN ('gold', 'gold_plus', 'platinum', 'platinum_elite')),
  wyvern_rating TEXT CHECK (wyvern_rating IS NULL OR wyvern_rating IN ('wingman')),
  is_bao_stage INTEGER CHECK (is_bao_stage IS NULL OR is_bao_stage IN (1, 2, 3)),
  safety_verified_at TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_faa_operators_state ON faa_operators(state);
CREATE INDEX IF NOT EXISTS idx_faa_operators_name ON faa_operators(name);

CREATE TABLE IF NOT EXISTS faa_airports (
  icao_code TEXT PRIMARY KEY,
  iata_code TEXT,
  faa_id TEXT,
  name TEXT NOT NULL,
  city TEXT,
  state TEXT,
  country TEXT DEFAULT 'US',
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  elevation_ft INTEGER,
  longest_runway_ft INTEGER,
  runway_surface TEXT,
  has_instrument_approach BOOLEAN DEFAULT FALSE,
  fuel_types TEXT,
  tower_controlled BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_faa_airports_state ON faa_airports(state);
CREATE INDEX IF NOT EXISTS idx_faa_airports_coords ON faa_airports(latitude, longitude);

-- Daily diff — new, deregistered, ownership change, field change events.
CREATE TABLE IF NOT EXISTS faa_registry_changes (
  id SERIAL PRIMARY KEY,
  tail_number TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('new', 'deregistered', 'ownership_change', 'field_change')),
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_faa_changes_tail ON faa_registry_changes(tail_number);
CREATE INDEX IF NOT EXISTS idx_faa_changes_type ON faa_registry_changes(change_type);
CREATE INDEX IF NOT EXISTS idx_faa_changes_date ON faa_registry_changes(detected_at);

-- FAA document index — liens, bills of sale, security agreements.
CREATE TABLE IF NOT EXISTS faa_docindex (
  id SERIAL PRIMARY KEY,
  tail_number TEXT,
  collateral_type INTEGER NOT NULL,
  collateral_raw TEXT NOT NULL,
  party_name TEXT,
  doc_id TEXT,
  doc_type TEXT NOT NULL,
  receipt_date TEXT,
  processing_date TEXT,
  correction_date TEXT,
  correction_id TEXT,
  serial_id TEXT,
  faa_aircraft_match INTEGER NOT NULL DEFAULT 0,
  aircraft_class TEXT,
  owner_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(collateral_raw, doc_id, receipt_date, doc_type, serial_id)
);
CREATE INDEX IF NOT EXISTS idx_docindex_tail ON faa_docindex(tail_number);
CREATE INDEX IF NOT EXISTS idx_docindex_type ON faa_docindex(doc_type);
CREATE INDEX IF NOT EXISTS idx_docindex_date ON faa_docindex(receipt_date);
CREATE INDEX IF NOT EXISTS idx_docindex_serial ON faa_docindex(serial_id);
CREATE INDEX IF NOT EXISTS idx_docindex_collateral_type ON faa_docindex(collateral_type);

-- Historical deregistered aircraft + FAA reference tables (ACFTREF + ENGINE).
CREATE TABLE IF NOT EXISTS faa_deregistered (
  id SERIAL PRIMARY KEY,
  tail_number TEXT NOT NULL,
  serial_number TEXT,
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured TEXT,
  owner_name TEXT,
  owner_city TEXT,
  owner_state TEXT,
  owner_country TEXT,
  certificate_holder TEXT,
  cancel_date TEXT,
  last_action_date TEXT,
  status TEXT,
  mode_s_hex TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_faa_dereg_tail ON faa_deregistered(tail_number);
CREATE INDEX IF NOT EXISTS idx_faa_dereg_cancel ON faa_deregistered(cancel_date);
CREATE INDEX IF NOT EXISTS idx_faa_dereg_holder ON faa_deregistered(certificate_holder);

CREATE TABLE IF NOT EXISTS faa_aircraft_types (
  model_code TEXT PRIMARY KEY,
  manufacturer TEXT,
  model TEXT,
  type_aircraft TEXT,
  num_engines INTEGER,
  num_seats INTEGER,
  weight_class TEXT,
  speed TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS faa_engine_types (
  engine_code TEXT PRIMARY KEY,
  manufacturer TEXT,
  model TEXT,
  type_engine TEXT,
  horsepower TEXT,
  thrust TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
