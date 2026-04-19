-- NTSB accident/incident database (1962-present). ~80K records.
-- airport_code uses FAA codes (strip K prefix when joining to ICAO tables).

CREATE TABLE IF NOT EXISTS ntsb_accidents (
  event_id TEXT PRIMARY KEY,
  investigation_type TEXT,
  event_date TEXT,
  location TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  latitude REAL,
  longitude REAL,
  airport_code TEXT,
  airport_name TEXT,
  injury_severity TEXT,
  aircraft_damage TEXT,
  registration_number TEXT,
  aircraft_make TEXT,
  aircraft_model TEXT,
  aircraft_category TEXT,
  amateur_built TEXT,
  number_of_engines INTEGER,
  engine_type TEXT,
  far_description TEXT,
  total_fatal_injuries INTEGER,
  total_serious_injuries INTEGER,
  total_minor_injuries INTEGER,
  total_uninjured INTEGER,
  weather_condition TEXT,
  broad_phase_of_flight TEXT,
  report_status TEXT,
  publication_date TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ntsb_reg ON ntsb_accidents(registration_number);
CREATE INDEX IF NOT EXISTS idx_ntsb_date ON ntsb_accidents(event_date);
CREATE INDEX IF NOT EXISTS idx_ntsb_airport ON ntsb_accidents(airport_code);
CREATE INDEX IF NOT EXISTS idx_ntsb_far ON ntsb_accidents(far_description);
CREATE INDEX IF NOT EXISTS idx_ntsb_severity ON ntsb_accidents(injury_severity);
