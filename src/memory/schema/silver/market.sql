-- Market Silver tables. aircraft_listings is scraped for-sale data.
-- target_companies / target_contacts are prospecting targets derived from
-- FAA + ADS-B (not directly "ingested" but fact-like).

CREATE TABLE IF NOT EXISTS aircraft_listings (
  tail_number TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('avbuyer', 'controller', 'trade-a-plane')),
  listing_url TEXT,
  asking_price_cents INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  aircraft_type TEXT,
  year INTEGER,
  description TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  price_history_json JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reduced', 'delisted', 'sold')),
  days_on_market INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tail_number, source)
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON aircraft_listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_type ON aircraft_listings(aircraft_type);
CREATE INDEX IF NOT EXISTS idx_listings_price ON aircraft_listings(asking_price_cents);
CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON aircraft_listings(first_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_days ON aircraft_listings(days_on_market);

CREATE TABLE IF NOT EXISTS target_companies (
  id SERIAL PRIMARY KEY,
  company_name TEXT NOT NULL UNIQUE,
  tail_numbers JSONB NOT NULL DEFAULT '[]',
  aircraft_classes JSONB NOT NULL DEFAULT '[]',
  fleet_size INTEGER NOT NULL DEFAULT 0,
  estimated_annual_trips INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_target_companies_fleet ON target_companies(fleet_size);
CREATE INDEX IF NOT EXISTS idx_target_companies_trips ON target_companies(estimated_annual_trips);

CREATE TABLE IF NOT EXISTS target_contacts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES target_companies(id),
  name TEXT,
  title TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_target_contacts_company ON target_contacts(company_id);
