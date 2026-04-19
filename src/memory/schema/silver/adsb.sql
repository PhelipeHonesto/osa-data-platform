-- ADS-B Silver tables. Live positions (hot tier, 48h TTL), per-aircraft state
-- summary, and materialized flight legs.

CREATE TABLE IF NOT EXISTS adsb_positions (
  id SERIAL PRIMARY KEY,
  icao_hex TEXT NOT NULL,
  tail_number TEXT,
  callsign TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  altitude_ft REAL,
  ground_speed_kts REAL,
  heading REAL,
  vertical_rate REAL,
  on_ground BOOLEAN NOT NULL DEFAULT FALSE,
  nearest_airport TEXT,
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adsb_icao ON adsb_positions(icao_hex);
CREATE INDEX IF NOT EXISTS idx_adsb_timestamp ON adsb_positions(timestamp);
CREATE INDEX IF NOT EXISTS idx_adsb_tail ON adsb_positions(tail_number);

CREATE TABLE IF NOT EXISTS adsb_aircraft_state (
  icao_hex TEXT PRIMARY KEY,
  tail_number TEXT,
  operator_name TEXT,
  aircraft_type TEXT,
  aircraft_class TEXT,
  state TEXT NOT NULL DEFAULT 'unknown',
  latitude REAL,
  longitude REAL,
  nearest_airport TEXT,
  idle_since TEXT,
  idle_hours REAL DEFAULT 0,
  last_seen TEXT NOT NULL,
  last_leg_origin TEXT,
  last_leg_destination TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_adsb_state_class ON adsb_aircraft_state(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_adsb_state_state ON adsb_aircraft_state(state);
CREATE INDEX IF NOT EXISTS idx_adsb_state_airport ON adsb_aircraft_state(nearest_airport);

-- Materialized flight legs. Rebuilt by Phase 7 runbook; contaminated until
-- the in-flight rebuild completes. See docs/phase7-rebuild-runbook.md.
CREATE TABLE IF NOT EXISTS adsb_completed_legs (
  id SERIAL PRIMARY KEY,
  icao_hex TEXT NOT NULL,
  tail_number TEXT,
  operator_name TEXT,
  aircraft_type TEXT,
  aircraft_class TEXT,
  origin_icao TEXT,
  destination_icao TEXT,
  departure_time TEXT NOT NULL,
  arrival_time TEXT NOT NULL,
  flight_time_min INTEGER,
  distance_nm REAL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Added live post-creation (Phase 7 rebuild); codified here 2026-04-18
  -- during schema split audit so fresh DBs mirror production.
  source_batch TEXT
);
CREATE INDEX IF NOT EXISTS idx_legs_tail ON adsb_completed_legs(tail_number);
CREATE INDEX IF NOT EXISTS idx_legs_origin ON adsb_completed_legs(origin_icao);
CREATE INDEX IF NOT EXISTS idx_legs_dest ON adsb_completed_legs(destination_icao);
CREATE INDEX IF NOT EXISTS idx_legs_class ON adsb_completed_legs(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_legs_time ON adsb_completed_legs(departure_time);
