/**
 * Database Migrations — creates tables on startup, idempotently.
 *
 * Design decisions:
 * - All money fields are INTEGER cents (no floats, ever)
 * - Every money field has a companion currency TEXT column (default 'USD')
 * - Every table has schema_version for forward-compatible evolution
 * - deal_events is append-only (no UPDATE, no DELETE) — audit trail
 * - JSON columns for arrays/nested objects (topOperators, fleet, certs, dealHistory, etc.)
 */

import type Database from "better-sqlite3";

interface Migration {
  id: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "create_migrations_table",
    sql: `
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 2,
    name: "create_deals",
    sql: `
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sim', 'live')),
        schema_version INTEGER NOT NULL DEFAULT 1,

        -- Route
        route_departure TEXT NOT NULL,
        route_arrival TEXT NOT NULL,
        route_distance REAL NOT NULL DEFAULT 0,

        -- Pricing (INTEGER cents)
        estimate_low_cents INTEGER,
        estimate_high_cents INTEGER,
        operator_quote_cents INTEGER,
        osa_price_cents INTEGER,
        estimate_delta REAL,
        currency TEXT NOT NULL DEFAULT 'USD',

        -- Operator
        operator_name TEXT,
        operator_base TEXT,
        operator_response_time REAL,
        operator_conversion INTEGER NOT NULL DEFAULT 0,

        -- Aircraft
        aircraft_type TEXT,
        aircraft_class TEXT,

        -- Client
        client_name TEXT,
        client_contact TEXT,
        client_type TEXT NOT NULL DEFAULT 'new',
        client_budget_min_cents INTEGER,
        client_budget_max_cents INTEGER,
        client_conversion INTEGER NOT NULL DEFAULT 0,
        decision_time REAL,

        -- Outcome
        result TEXT NOT NULL,
        revenue_cents INTEGER,
        margin REAL,

        -- Timing
        total_deal_time REAL,
        day_of_week INTEGER NOT NULL DEFAULT 0,
        season TEXT NOT NULL DEFAULT 'off',

        -- Meta
        guardian_flags TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS idx_deals_route ON deals(route_departure, route_arrival);
      CREATE INDEX IF NOT EXISTS idx_deals_operator ON deals(operator_name);
      CREATE INDEX IF NOT EXISTS idx_deals_client ON deals(client_name, client_contact);
      CREATE INDEX IF NOT EXISTS idx_deals_timestamp ON deals(timestamp);
    `,
  },
  {
    id: 3,
    name: "create_route_intel",
    sql: `
      CREATE TABLE IF NOT EXISTS route_intel (
        route TEXT NOT NULL,
        aircraft_class TEXT NOT NULL,
        avg_price_30d_cents INTEGER,
        deal_count INTEGER NOT NULL DEFAULT 0,
        demand_trend TEXT NOT NULL DEFAULT 'stable',
        top_operators TEXT NOT NULL DEFAULT '[]',
        seasonal_factor REAL NOT NULL DEFAULT 1.0,
        avg_margin_delta REAL NOT NULL DEFAULT 0,
        last_updated TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        schema_version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (route, aircraft_class)
      );
    `,
  },
  {
    id: 4,
    name: "create_operator_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS operator_profiles (
        name TEXT PRIMARY KEY,
        home_base TEXT NOT NULL DEFAULT '',
        certs TEXT NOT NULL DEFAULT '[]',
        fleet TEXT NOT NULL DEFAULT '[]',
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
    `,
  },
  {
    id: 5,
    name: "create_client_profiles",
    sql: `
      CREATE TABLE IF NOT EXISTS client_profiles (
        email TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        deal_history TEXT NOT NULL DEFAULT '[]',
        avg_payment_time REAL NOT NULL DEFAULT 0,
        total_spend_cents INTEGER NOT NULL DEFAULT 0,
        trip_frequency REAL NOT NULL DEFAULT 0,
        preferred_aircraft_class TEXT,
        preferred_routes TEXT NOT NULL DEFAULT '[]',
        last_updated TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_client_profiles_name ON client_profiles(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_client_profiles_email ON client_profiles(email COLLATE NOCASE);
    `,
  },
  {
    id: 6,
    name: "create_validation_ledger",
    sql: `
      CREATE TABLE IF NOT EXISTS validation_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_validation_ledger_route ON validation_ledger(route);
      CREATE INDEX IF NOT EXISTS idx_validation_ledger_date ON validation_ledger(date);
      CREATE INDEX IF NOT EXISTS idx_validation_ledger_outcome ON validation_ledger(outcome);
    `,
  },
  {
    id: 7,
    name: "create_deal_events",
    sql: `
      CREATE TABLE IF NOT EXISTS deal_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_deal_events_deal_id ON deal_events(deal_id);
      CREATE INDEX IF NOT EXISTS idx_deal_events_type ON deal_events(event_type);
    `,
  },
  {
    id: 8,
    name: "create_messages",
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        deal_id TEXT,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT,
        from_name TEXT,
        subject TEXT,
        body TEXT NOT NULL,
        body_html TEXT,
        attachments TEXT NOT NULL DEFAULT '[]',
        drafted_by TEXT,
        approved_by TEXT,
        edit_distance INTEGER,
        original_draft TEXT,
        received_at TEXT,
        drafted_at TEXT,
        approved_at TEXT,
        sent_at TEXT,
        response_to_id TEXT,
        response_time_ms REAL,
        thread_id TEXT,
        intent TEXT,
        parsed_data TEXT,
        confidence REAL,
        confidence_level TEXT,
        platform_message_id TEXT,
        platform_metadata TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_messages_deal_id ON messages(deal_id);
      CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
      CREATE INDEX IF NOT EXISTS idx_messages_thread_id ON messages(thread_id);
    `,
  },
  {
    id: 9,
    name: "create_calls",
    sql: `
      CREATE TABLE IF NOT EXISTS calls (
        call_id TEXT PRIMARY KEY,
        deal_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        participants TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_sec REAL,
        transcript TEXT NOT NULL DEFAULT '[]',
        detected_entities TEXT NOT NULL DEFAULT '[]',
        summary TEXT,
        recording_url TEXT,
        recording_expires_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_calls_deal_id ON calls(deal_id);
    `,
  },
  {
    id: 10,
    name: "create_autonomy_rules",
    sql: `
      CREATE TABLE IF NOT EXISTS autonomy_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        intent TEXT NOT NULL,
        recipient_type TEXT NOT NULL,
        auto_send_enabled INTEGER NOT NULL DEFAULT 0,
        auto_send_after INTEGER NOT NULL DEFAULT 10,
        current_approvals INTEGER NOT NULL DEFAULT 0,
        max_delay_seconds INTEGER NOT NULL DEFAULT 30,
        schema_version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(channel, intent, recipient_type)
      );
    `,
  },
  {
    id: 11,
    name: "create_processed_webhooks",
    sql: `
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        idempotency_key TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    id: 12,
    name: "expand_validation_ledger",
    sql: `
      ALTER TABLE validation_ledger ADD COLUMN ghost_value_cents INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE validation_ledger ADD COLUMN ghost_description TEXT;
      ALTER TABLE validation_ledger ADD COLUMN rli_score REAL;
      ALTER TABLE validation_ledger ADD COLUMN trip_outcome TEXT NOT NULL DEFAULT 'completed';
      ALTER TABLE validation_ledger ADD COLUMN recovery_time_min REAL;
      ALTER TABLE validation_ledger ADD COLUMN route_page_views_7d INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN options_presented_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN client_confirmed_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operators_in_network INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN operators_in_metro INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN estimate_delta_percent REAL;
      ALTER TABLE validation_ledger ADD COLUMN operator_name TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operator_base TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operator_reliability_score REAL;
      ALTER TABLE validation_ledger ADD COLUMN revenue_cents INTEGER;
      ALTER TABLE validation_ledger ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE validation_ledger ADD COLUMN client_paid_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN operator_paid_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN float_window_hours REAL;
      ALTER TABLE validation_ledger ADD COLUMN created_at TEXT;
      ALTER TABLE validation_ledger ADD COLUMN updated_at TEXT;
    `,
  },
  {
    id: 13,
    name: "create_knowledge_graph",
    sql: `
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
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_class ON faa_aircraft(aircraft_class);
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_cert ON faa_aircraft(certificate_number);
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_model ON faa_aircraft(common_name);

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
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
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
        has_instrument_approach INTEGER DEFAULT 0,
        fuel_types TEXT,
        tower_controlled INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_faa_airports_state ON faa_airports(state);
      CREATE INDEX IF NOT EXISTS idx_faa_airports_coords ON faa_airports(latitude, longitude);
    `,
  },
  {
    id: 14,
    name: "create_adsb_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS adsb_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        icao_hex TEXT NOT NULL,
        tail_number TEXT,
        callsign TEXT,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude_ft REAL,
        ground_speed_kts REAL,
        heading REAL,
        vertical_rate REAL,
        on_ground INTEGER NOT NULL DEFAULT 0,
        nearest_airport TEXT,
        timestamp INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
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
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_adsb_state_class ON adsb_aircraft_state(aircraft_class);
      CREATE INDEX IF NOT EXISTS idx_adsb_state_state ON adsb_aircraft_state(state);
      CREATE INDEX IF NOT EXISTS idx_adsb_state_airport ON adsb_aircraft_state(nearest_airport);

      ALTER TABLE faa_aircraft ADD COLUMN icao_hex TEXT;
      CREATE INDEX IF NOT EXISTS idx_faa_aircraft_hex ON faa_aircraft(icao_hex);
    `,
  },
  {
    id: 15,
    name: "create_adsb_completed_legs",
    sql: `
      CREATE TABLE IF NOT EXISTS adsb_completed_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_legs_tail ON adsb_completed_legs(tail_number);
      CREATE INDEX IF NOT EXISTS idx_legs_origin ON adsb_completed_legs(origin_icao);
      CREATE INDEX IF NOT EXISTS idx_legs_dest ON adsb_completed_legs(destination_icao);
      CREATE INDEX IF NOT EXISTS idx_legs_class ON adsb_completed_legs(aircraft_class);
      CREATE INDEX IF NOT EXISTS idx_legs_time ON adsb_completed_legs(departure_time);
    `,
  },
  {
    id: 16,
    name: "create_deal_outcomes",
    sql: `
      CREATE TABLE IF NOT EXISTS deal_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deal_id TEXT NOT NULL REFERENCES deals(id),
        quoted_price_cents INTEGER NOT NULL,
        actual_price_cents INTEGER NOT NULL,
        client_accepted INTEGER NOT NULL DEFAULT 0,
        operator_response_time_seconds INTEGER NOT NULL DEFAULT 0,
        aircraft_substituted INTEGER NOT NULL DEFAULT 0,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deal_outcomes_deal_id ON deal_outcomes(deal_id);
      CREATE INDEX IF NOT EXISTS idx_deal_outcomes_operator ON deal_outcomes(operator_name);
      CREATE INDEX IF NOT EXISTS idx_deal_outcomes_route ON deal_outcomes(route_origin, route_destination);
      CREATE INDEX IF NOT EXISTS idx_deal_outcomes_class ON deal_outcomes(aircraft_class);
    `,
  },
  {
    id: 17,
    name: "create_faa_registry_changes",
    sql: `
      CREATE TABLE IF NOT EXISTS faa_registry_changes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tail_number TEXT NOT NULL,
        change_type TEXT NOT NULL CHECK (change_type IN ('new', 'deregistered', 'ownership_change', 'field_change')),
        field_name TEXT,
        old_value TEXT,
        new_value TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_faa_changes_tail ON faa_registry_changes(tail_number);
      CREATE INDEX IF NOT EXISTS idx_faa_changes_type ON faa_registry_changes(change_type);
      CREATE INDEX IF NOT EXISTS idx_faa_changes_date ON faa_registry_changes(detected_at);
    `,
  },
  {
    id: 18,
    name: "create_pipeline_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
        steps_completed INTEGER NOT NULL DEFAULT 0,
        failed_step TEXT,
        new_aircraft INTEGER NOT NULL DEFAULT 0,
        deregistered INTEGER NOT NULL DEFAULT 0,
        ownership_changes INTEGER NOT NULL DEFAULT 0,
        field_changes INTEGER NOT NULL DEFAULT 0,
        aircraft_classified INTEGER NOT NULL DEFAULT 0,
        ghost_candidates INTEGER NOT NULL DEFAULT 0,
        total_in_graph INTEGER NOT NULL DEFAULT 0,
        charter_tracked INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_date ON pipeline_runs(started_at);
    `,
  },
  {
    id: 19,
    name: "create_faa_docindex",
    sql: `
      CREATE TABLE IF NOT EXISTS faa_docindex (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(collateral_raw, doc_id, receipt_date, doc_type, serial_id)
      );
      CREATE INDEX IF NOT EXISTS idx_docindex_tail ON faa_docindex(tail_number);
      CREATE INDEX IF NOT EXISTS idx_docindex_type ON faa_docindex(doc_type);
      CREATE INDEX IF NOT EXISTS idx_docindex_date ON faa_docindex(receipt_date);
      CREATE INDEX IF NOT EXISTS idx_docindex_serial ON faa_docindex(serial_id);
      CREATE INDEX IF NOT EXISTS idx_docindex_collateral_type ON faa_docindex(collateral_type);
    `,
  },
  {
    id: 20,
    name: "create_pilot_contacts",
    sql: `
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
        ratings TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_pilot_contacts_state ON pilot_contacts(state);
      CREATE INDEX IF NOT EXISTS idx_pilot_contacts_city_state ON pilot_contacts(city, state);
      CREATE INDEX IF NOT EXISTS idx_pilot_contacts_last_name ON pilot_contacts(last_name);

      CREATE TABLE IF NOT EXISTS pilot_aircraft_link (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(certificate_number, tail_number)
      );
      CREATE INDEX IF NOT EXISTS idx_pal_tail ON pilot_aircraft_link(tail_number);
      CREATE INDEX IF NOT EXISTS idx_pal_cert ON pilot_aircraft_link(certificate_number);
      CREATE INDEX IF NOT EXISTS idx_pal_state ON pilot_aircraft_link(pilot_state);
      CREATE INDEX IF NOT EXISTS idx_pal_base ON pilot_aircraft_link(aircraft_base_icao);
    `,
  },
  {
    id: 21,
    name: "create_aircraft_listings",
    sql: `
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
        price_history_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reduced', 'delisted', 'sold')),
        days_on_market INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (tail_number, source)
      );
      CREATE INDEX IF NOT EXISTS idx_listings_status ON aircraft_listings(status);
      CREATE INDEX IF NOT EXISTS idx_listings_type ON aircraft_listings(aircraft_type);
      CREATE INDEX IF NOT EXISTS idx_listings_price ON aircraft_listings(asking_price_cents);
      CREATE INDEX IF NOT EXISTS idx_listings_first_seen ON aircraft_listings(first_seen_at);
      CREATE INDEX IF NOT EXISTS idx_listings_days ON aircraft_listings(days_on_market);
    `,
  },
  {
    id: 22,
    name: "create_target_companies",
    sql: `
      CREATE TABLE IF NOT EXISTS target_companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_name TEXT NOT NULL UNIQUE,
        tail_numbers TEXT NOT NULL DEFAULT '[]',
        aircraft_classes TEXT NOT NULL DEFAULT '[]',
        fleet_size INTEGER NOT NULL DEFAULT 0,
        estimated_annual_trips INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_target_companies_fleet ON target_companies(fleet_size);
      CREATE INDEX IF NOT EXISTS idx_target_companies_trips ON target_companies(estimated_annual_trips);

      CREATE TABLE IF NOT EXISTS target_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL REFERENCES target_companies(id),
        name TEXT,
        title TEXT,
        email TEXT,
        phone TEXT,
        source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_target_contacts_company ON target_contacts(company_id);
    `,
  },
  {
    id: 23,
    name: "create_eval_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS eval_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        scenario_title TEXT NOT NULL,
        departure TEXT,
        arrival TEXT,
        aircraft_class TEXT,
        estimate_low_cents INTEGER,
        estimate_high_cents INTEGER,
        estimate_median_cents INTEGER,
        osa_price_cents INTEGER,
        market_low_cents INTEGER,
        market_high_cents INTEGER,
        within_20_pct INTEGER NOT NULL DEFAULT 0,
        error_pct REAL,
        status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'skip', 'error')),
        error_message TEXT,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_eval_runs_run_id ON eval_runs(run_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_scenario ON eval_runs(scenario_id);
      CREATE INDEX IF NOT EXISTS idx_eval_runs_status ON eval_runs(status);

      CREATE TABLE IF NOT EXISTS eval_run_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        total_scenarios INTEGER NOT NULL,
        scored_scenarios INTEGER NOT NULL,
        within_20_pct_count INTEGER NOT NULL,
        accuracy_pct REAL NOT NULL,
        mean_error_pct REAL,
        median_error_pct REAL,
        max_error_pct REAL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        schema_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_eval_summaries_run ON eval_run_summaries(run_id);
    `,
  },
  {
    id: 24,
    name: "create_backfill_progress",
    sql: `
      CREATE TABLE IF NOT EXISTS backfill_progress (
        date TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed')),
        legs_found INTEGER NOT NULL DEFAULT 0,
        charter_legs INTEGER NOT NULL DEFAULT 0,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        processed_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    id: 25,
    name: "add_safety_ratings",
    sql: `
      ALTER TABLE faa_operators ADD COLUMN argus_rating TEXT CHECK (argus_rating IS NULL OR argus_rating IN ('gold', 'gold_plus', 'platinum', 'platinum_elite'));
      ALTER TABLE faa_operators ADD COLUMN wyvern_rating TEXT CHECK (wyvern_rating IS NULL OR wyvern_rating IN ('wingman'));
      ALTER TABLE faa_operators ADD COLUMN is_bao_stage INTEGER CHECK (is_bao_stage IS NULL OR is_bao_stage IN (1, 2, 3));
      ALTER TABLE faa_operators ADD COLUMN safety_verified_at TEXT;

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
        last_leg_dest TEXT
      );

      ALTER TABLE knowledge_graph ADD COLUMN operator_argus TEXT;
      ALTER TABLE knowledge_graph ADD COLUMN operator_wyvern TEXT;
      ALTER TABLE knowledge_graph ADD COLUMN operator_safety_score INTEGER DEFAULT 0;
    `,
  },
  {
    id: 26,
    name: "create_archive_progress",
    sql: `
      CREATE TABLE IF NOT EXISTS archive_progress (
        date TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'no_release')),
        files_archived INTEGER NOT NULL DEFAULT 0,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        s3_prefix TEXT,
        archived_at TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    id: 27,
    name: "create_analytics_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS operator_market_share (
        month TEXT NOT NULL,
        operator_name TEXT NOT NULL,
        total_legs INTEGER NOT NULL DEFAULT 0,
        total_flight_hours REAL NOT NULL DEFAULT 0,
        market_share_pct REAL NOT NULL DEFAULT 0,
        avg_flight_time_min REAL NOT NULL DEFAULT 0,
        top_route TEXT,
        aircraft_classes TEXT,
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
        class_breakdown TEXT,
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

      INSERT OR IGNORE INTO fuel_burn_estimates (aircraft_class, avg_gph, avg_fuel_price_per_gallon) VALUES
        ('light', 150, 6.50),
        ('midsize', 220, 6.50),
        ('super_mid', 280, 6.50),
        ('heavy', 350, 6.50),
        ('turboprop', 80, 6.50);
    `,
  },
  {
    id: 28,
    name: "create_faa_reference_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS faa_deregistered (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    `,
  },
  {
    id: 29,
    name: "create_ntsb_accidents",
    sql: `
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
    `,
  },
  {
    id: 30,
    name: "create_data_quality_runs",
    sql: `
      CREATE TABLE IF NOT EXISTS data_quality_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_at TEXT NOT NULL DEFAULT (datetime('now')),
        malformed_tails INTEGER NOT NULL DEFAULT 0,
        invalid_icao INTEGER NOT NULL DEFAULT 0,
        duplicate_legs INTEGER NOT NULL DEFAULT 0,
        orphaned_records INTEGER NOT NULL DEFAULT 0,
        empty_fields INTEGER NOT NULL DEFAULT 0,
        stale_data INTEGER NOT NULL DEFAULT 0,
        anomalies INTEGER NOT NULL DEFAULT 0,
        overall_status TEXT NOT NULL CHECK (overall_status IN ('green', 'yellow', 'red')),
        details TEXT,
        schema_version INTEGER NOT NULL DEFAULT 1
      );
    `,
  },
  {
    id: 31,
    name: "add_route_vectors_and_lineage",
    sql: `
      ALTER TABLE adsb_completed_legs ADD COLUMN source_batch TEXT;
      ALTER TABLE eval_run_summaries ADD COLUMN slice_results TEXT;
    `,
  },
];

/**
 * Run all pending migrations. Idempotent — skips already-applied migrations.
 */
export function runMigrations(db: Database.Database): void {
  // Migration 1 creates the tracking table — always run it first
  db.exec(MIGRATIONS[0]!.sql);

  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r) => (r as { id: number }).id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.exec(migration.sql);
    db.prepare("INSERT INTO _migrations (id, name) VALUES (?, ?)").run(
      migration.id,
      migration.name,
    );
  }
}
