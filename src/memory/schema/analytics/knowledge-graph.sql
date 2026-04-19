-- Joined FAA + ADS-B knowledge graph with safety scores. Rebuilt nightly by
-- src/ingestion/update-graph.ts. Pre-aggregated denorm for fast reads; new
-- Phase 2 Gold agent-facing views will supersede the ghost/fleet columns,
-- but knowledge_graph stays as a Silver-derived analytics table.

CREATE TABLE IF NOT EXISTS knowledge_graph (
  icao_hex TEXT PRIMARY KEY,
  tail_number TEXT,
  owner_name TEXT,
  operator_name TEXT,
  manufacturer TEXT,
  model TEXT,
  common_name TEXT,
  aircraft_class TEXT,
  year_manufactured INTEGER,
  num_seats INTEGER,
  certificate_number TEXT,
  state TEXT,
  latitude REAL,
  longitude REAL,
  nearest_airport TEXT,
  idle_since TEXT,
  idle_hours REAL DEFAULT 0,
  last_seen TEXT,
  last_leg_origin TEXT,
  last_leg_dest TEXT,
  operator_argus TEXT,
  operator_wyvern TEXT,
  operator_safety_score INTEGER DEFAULT 0,
  -- Graph flags (populated by src/ingestion/update-graph.ts, Phase 6 Tier 3)
  is_charter_class INTEGER DEFAULT 0,
  is_near_network_airport INTEGER DEFAULT 0,
  is_ghost_candidate INTEGER DEFAULT 0,
  ghost_airport TEXT,
  total_legs INTEGER DEFAULT 0,
  legs_last_30d INTEGER DEFAULT 0,
  updated_at TEXT
);

-- Fleet roll-up (Phase 6 Tier 3 — written by update-graph.ts).
CREATE TABLE IF NOT EXISTS fleet_stats (
  aircraft_class TEXT PRIMARY KEY,
  total_tracked INTEGER DEFAULT 0,
  airborne INTEGER DEFAULT 0,
  idle INTEGER DEFAULT 0,
  ghost_candidates INTEGER DEFAULT 0,
  updated_at TEXT
);
