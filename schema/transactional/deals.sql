-- Deal lifecycle tables: the core transactional state of a charter deal.
-- deals + deal_events (append-only audit trail) + deal_outcomes + validation_ledger.

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  route_departure TEXT NOT NULL,
  route_arrival TEXT NOT NULL,
  route_distance REAL NOT NULL DEFAULT 0,
  estimate_low_cents INTEGER,
  estimate_high_cents INTEGER,
  operator_quote_cents INTEGER,
  osa_price_cents INTEGER,
  estimate_delta REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  operator_name TEXT,
  operator_base TEXT,
  operator_response_time REAL,
  operator_conversion INTEGER NOT NULL DEFAULT 0,
  aircraft_type TEXT,
  aircraft_class TEXT,
  client_name TEXT,
  client_contact TEXT,
  client_type TEXT NOT NULL DEFAULT 'new',
  client_budget_min_cents INTEGER,
  client_budget_max_cents INTEGER,
  client_conversion INTEGER NOT NULL DEFAULT 0,
  decision_time REAL,
  result TEXT NOT NULL,
  revenue_cents INTEGER,
  margin REAL,
  total_deal_time REAL,
  day_of_week INTEGER NOT NULL DEFAULT 0,
  season TEXT NOT NULL DEFAULT 'off',
  guardian_flags JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_deals_route ON deals(route_departure, route_arrival);
CREATE INDEX IF NOT EXISTS idx_deals_operator ON deals(operator_name);
CREATE INDEX IF NOT EXISTS idx_deals_client ON deals(client_name, client_contact);
CREATE INDEX IF NOT EXISTS idx_deals_timestamp ON deals(timestamp);

-- Append-only audit trail. No UPDATE, no DELETE.
CREATE TABLE IF NOT EXISTS deal_events (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_deal_events_deal_id ON deal_events(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_events_type ON deal_events(event_type);

CREATE TABLE IF NOT EXISTS deal_outcomes (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  quoted_price_cents INTEGER NOT NULL,
  actual_price_cents INTEGER NOT NULL,
  client_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  operator_response_time_seconds INTEGER NOT NULL DEFAULT 0,
  aircraft_substituted BOOLEAN NOT NULL DEFAULT FALSE,
  substitution_details TEXT,
  reason_lost TEXT CHECK (reason_lost IS NULL OR reason_lost IN ('price', 'timing', 'aircraft', 'competitor', 'other')),
  dumont_confidence_at_quote REAL NOT NULL DEFAULT 0,
  price_error_pct REAL NOT NULL DEFAULT 0,
  operator_name TEXT NOT NULL,
  aircraft_class TEXT NOT NULL,
  route_origin TEXT NOT NULL,
  route_destination TEXT NOT NULL,
  lead_time_hours REAL NOT NULL DEFAULT 0,
  day_of_week INTEGER NOT NULL DEFAULT 0 CHECK (day_of_week >= 0 AND day_of_week <= 6),
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_deal_id ON deal_outcomes(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_operator ON deal_outcomes(operator_name);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_route ON deal_outcomes(route_origin, route_destination);
CREATE INDEX IF NOT EXISTS idx_deal_outcomes_class ON deal_outcomes(aircraft_class);

CREATE TABLE IF NOT EXISTS validation_ledger (
  id SERIAL PRIMARY KEY,
  route TEXT NOT NULL,
  date TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
  lead_time_hours REAL NOT NULL DEFAULT 0,
  rli_at_quote TEXT NOT NULL DEFAULT 'low',
  dumont_physics_estimate_cents INTEGER,
  ghost_positioning_value REAL,
  operator_quoted_price_cents INTEGER,
  osa_client_price_cents INTEGER,
  realized_margin_pct REAL,
  rfqs_sent INTEGER NOT NULL DEFAULT 1,
  quotes_received INTEGER NOT NULL DEFAULT 0,
  operator_response_minutes REAL,
  client_decision_minutes REAL,
  outcome TEXT NOT NULL DEFAULT 'lost_other',
  fleet_resilience_used INTEGER NOT NULL DEFAULT 0,
  trip_completed INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  schema_version INTEGER NOT NULL DEFAULT 1,
  -- migration 12 additions
  ghost_value_cents INTEGER NOT NULL DEFAULT 0,
  ghost_description TEXT,
  rli_score REAL,
  trip_outcome TEXT NOT NULL DEFAULT 'completed',
  recovery_time_min REAL,
  route_page_views_7d INTEGER,
  options_presented_at TEXT,
  client_confirmed_at TEXT,
  operators_in_network INTEGER,
  operators_in_metro INTEGER,
  estimate_delta_percent REAL,
  operator_name TEXT,
  operator_base TEXT,
  operator_reliability_score REAL,
  revenue_cents INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'pending',
  client_paid_at TEXT,
  operator_paid_at TEXT,
  float_window_hours REAL,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_validation_ledger_route ON validation_ledger(route);
CREATE INDEX IF NOT EXISTS idx_validation_ledger_date ON validation_ledger(date);
CREATE INDEX IF NOT EXISTS idx_validation_ledger_outcome ON validation_ledger(outcome);
