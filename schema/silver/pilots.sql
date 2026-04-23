-- Pilots Silver tables. Ingested from FAA airmen records + a city/state
-- proximity heuristic that links pilots to aircraft (not FAA-authoritative).

CREATE TABLE IF NOT EXISTS pilot_contacts (
  certificate_number TEXT PRIMARY KEY,
  first_middle_name TEXT,
  last_name TEXT,
  street1 TEXT,
  street2 TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT,
  region TEXT,
  medical_class TEXT,
  medical_date TEXT,
  medical_expire_date TEXT,
  ratings JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_pilot_contacts_state ON pilot_contacts(state);
CREATE INDEX IF NOT EXISTS idx_pilot_contacts_city_state ON pilot_contacts(city, state);
CREATE INDEX IF NOT EXISTS idx_pilot_contacts_last_name ON pilot_contacts(last_name);

CREATE TABLE IF NOT EXISTS pilot_aircraft_link (
  id SERIAL PRIMARY KEY,
  certificate_number TEXT NOT NULL REFERENCES pilot_contacts(certificate_number),
  tail_number TEXT NOT NULL,
  pilot_name TEXT NOT NULL,
  pilot_city TEXT,
  pilot_state TEXT,
  aircraft_base_icao TEXT,
  aircraft_base_city TEXT,
  aircraft_base_state TEXT,
  aircraft_class TEXT,
  operator_name TEXT,
  match_type TEXT NOT NULL DEFAULT 'city_state',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(certificate_number, tail_number)
);
CREATE INDEX IF NOT EXISTS idx_pal_tail ON pilot_aircraft_link(tail_number);
CREATE INDEX IF NOT EXISTS idx_pal_cert ON pilot_aircraft_link(certificate_number);
CREATE INDEX IF NOT EXISTS idx_pal_state ON pilot_aircraft_link(pilot_state);
CREATE INDEX IF NOT EXISTS idx_pal_base ON pilot_aircraft_link(aircraft_base_icao);
