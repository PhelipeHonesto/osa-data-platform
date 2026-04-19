-- Denormalized profile tables written by the learning loop.
-- These are Silver-era aggregates; Phase 2 deprecates them in favour of
-- Gold canonical (operators, clients) + agent-facing views.

CREATE TABLE IF NOT EXISTS route_intel (
  route TEXT NOT NULL,
  aircraft_class TEXT NOT NULL,
  avg_price_30d_cents INTEGER,
  deal_count INTEGER NOT NULL DEFAULT 0,
  demand_trend TEXT NOT NULL DEFAULT 'stable',
  top_operators JSONB NOT NULL DEFAULT '[]',
  seasonal_factor REAL NOT NULL DEFAULT 1.0,
  avg_margin_delta REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (route, aircraft_class)
);

CREATE TABLE IF NOT EXISTS operator_profiles (
  name TEXT PRIMARY KEY,
  home_base TEXT NOT NULL DEFAULT '',
  certs JSONB NOT NULL DEFAULT '[]',
  fleet JSONB NOT NULL DEFAULT '[]',
  avg_response_time REAL NOT NULL DEFAULT 0,
  reliability_score REAL NOT NULL DEFAULT 0,
  pricing_delta REAL NOT NULL DEFAULT 0,
  payment_speed REAL NOT NULL DEFAULT 0,
  quote_to_book_rate REAL NOT NULL DEFAULT 0,
  cancel_rate REAL NOT NULL DEFAULT 0,
  deal_count INTEGER NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS client_profiles (
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  deal_history JSONB NOT NULL DEFAULT '[]',
  avg_payment_time REAL NOT NULL DEFAULT 0,
  total_spend_cents INTEGER NOT NULL DEFAULT 0,
  trip_frequency REAL NOT NULL DEFAULT 0,
  preferred_aircraft_class TEXT,
  preferred_routes JSONB NOT NULL DEFAULT '[]',
  last_updated TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_client_profiles_name ON client_profiles(name);
CREATE INDEX IF NOT EXISTS idx_client_profiles_email ON client_profiles(email);
