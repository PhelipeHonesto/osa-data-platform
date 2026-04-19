-- WINGX-equivalent analytics tables. Periodic aggregations (mostly monthly)
-- built by src/analytics/. Not Silver (derived), not Gold canonical (analytical
-- not entity-resolved).

CREATE TABLE IF NOT EXISTS operator_market_share (
  month TEXT NOT NULL,
  operator_name TEXT NOT NULL,
  total_legs INTEGER NOT NULL DEFAULT 0,
  total_flight_hours REAL NOT NULL DEFAULT 0,
  market_share_pct REAL NOT NULL DEFAULT 0,
  avg_flight_time_min REAL NOT NULL DEFAULT 0,
  top_route TEXT,
  aircraft_classes JSONB,
  PRIMARY KEY (month, operator_name)
);
CREATE INDEX IF NOT EXISTS idx_oms_month ON operator_market_share(month);

CREATE TABLE IF NOT EXISTS aircraft_utilization (
  month TEXT NOT NULL,
  tail_number TEXT NOT NULL,
  icao_hex TEXT,
  operator_name TEXT,
  aircraft_class TEXT,
  total_legs INTEGER NOT NULL DEFAULT 0,
  total_flight_hours REAL NOT NULL DEFAULT 0,
  total_distance_nm REAL NOT NULL DEFAULT 0,
  days_active INTEGER NOT NULL DEFAULT 0,
  avg_daily_hours REAL NOT NULL DEFAULT 0,
  home_airport TEXT,
  PRIMARY KEY (month, tail_number)
);
CREATE INDEX IF NOT EXISTS idx_au_month ON aircraft_utilization(month);
CREATE INDEX IF NOT EXISTS idx_au_class ON aircraft_utilization(aircraft_class);
CREATE INDEX IF NOT EXISTS idx_au_operator ON aircraft_utilization(operator_name);

CREATE TABLE IF NOT EXISTS airport_activity (
  date TEXT NOT NULL,
  airport_icao TEXT NOT NULL,
  hour INTEGER NOT NULL,
  departures INTEGER NOT NULL DEFAULT 0,
  arrivals INTEGER NOT NULL DEFAULT 0,
  total_movements INTEGER NOT NULL DEFAULT 0,
  unique_aircraft INTEGER NOT NULL DEFAULT 0,
  charter_movements INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, airport_icao, hour)
);
CREATE INDEX IF NOT EXISTS idx_aa_airport ON airport_activity(airport_icao);
CREATE INDEX IF NOT EXISTS idx_aa_date ON airport_activity(date);

CREATE TABLE IF NOT EXISTS route_trends (
  month TEXT NOT NULL,
  origin_icao TEXT NOT NULL,
  destination_icao TEXT NOT NULL,
  total_flights INTEGER NOT NULL DEFAULT 0,
  avg_flight_time_min REAL NOT NULL DEFAULT 0,
  dominant_class TEXT,
  class_breakdown JSONB,
  yoy_change_pct REAL,
  PRIMARY KEY (month, origin_icao, destination_icao)
);
CREATE INDEX IF NOT EXISTS idx_rt_month ON route_trends(month);
CREATE INDEX IF NOT EXISTS idx_rt_route ON route_trends(origin_icao, destination_icao);

CREATE TABLE IF NOT EXISTS fleet_snapshot (
  date TEXT NOT NULL,
  aircraft_class TEXT NOT NULL,
  total_registered INTEGER NOT NULL DEFAULT 0,
  total_tracked INTEGER NOT NULL DEFAULT 0,
  total_airborne INTEGER NOT NULL DEFAULT 0,
  total_idle INTEGER NOT NULL DEFAULT 0,
  avg_utilization_hours REAL NOT NULL DEFAULT 0,
  new_registrations INTEGER NOT NULL DEFAULT 0,
  deregistrations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, aircraft_class)
);
CREATE INDEX IF NOT EXISTS idx_fs_class ON fleet_snapshot(aircraft_class);

CREATE TABLE IF NOT EXISTS fuel_burn_estimates (
  aircraft_class TEXT PRIMARY KEY,
  avg_gph REAL NOT NULL,
  avg_fuel_price_per_gallon REAL NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

INSERT INTO fuel_burn_estimates (aircraft_class, avg_gph, avg_fuel_price_per_gallon)
VALUES ('light', 150, 6.50), ('midsize', 220, 6.50), ('super_mid', 280, 6.50),
       ('heavy', 350, 6.50), ('turboprop', 80, 6.50)
ON CONFLICT (aircraft_class) DO NOTHING;
