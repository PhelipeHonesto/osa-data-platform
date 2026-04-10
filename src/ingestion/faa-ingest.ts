/**
 * FAA Knowledge Graph Ingestion — v1 (seed files)
 *
 * Seeds faa_operators and faa_airports from local JSON files.
 * Run: npm run ingest:faa
 *
 * // v2: download ReleasableAircraft.zip from registry.faa.gov
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../memory/database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface OperatorSeed {
  certificateNumber: string;
  name: string;
  dbaName?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
}

interface AirportSeed {
  icaoCode: string;
  iataCode?: string | null;
  faaId?: string | null;
  name: string;
  city?: string;
  state?: string | null;
  country?: string;
  latitude: number;
  longitude: number;
  elevationFt?: number | null;
  longestRunwayFt?: number | null;
  runwaySurface?: string | null;
  hasInstrumentApproach?: boolean;
  fuelTypes?: string | null;
  towerControlled?: boolean;
}

function main(): void {
  const db = getDb();

  // ── Operators ──────────────────────────────────────────────────────────
  const operatorsPath = resolve(__dirname, "part135-operators.json");
  const operators: OperatorSeed[] = JSON.parse(readFileSync(operatorsPath, "utf-8"));

  const insertOperator = db.prepare(`
    INSERT OR REPLACE INTO faa_operators
      (certificate_number, name, dba_name, address, city, state, zip, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertOperators = db.transaction((ops: OperatorSeed[]) => {
    for (const op of ops) {
      insertOperator.run(
        op.certificateNumber,
        op.name,
        op.dbaName ?? null,
        op.address ?? null,
        op.city ?? null,
        op.state ?? null,
        op.zip ?? null,
        op.phone ?? null,
      );
    }
  });

  insertOperators(operators);

  // ── Airports ───────────────────────────────────────────────────────────
  const airportsPath = resolve(__dirname, "airports-seed.json");
  const airports: AirportSeed[] = JSON.parse(readFileSync(airportsPath, "utf-8"));

  const insertAirport = db.prepare(`
    INSERT OR REPLACE INTO faa_airports
      (icao_code, iata_code, faa_id, name, city, state, country,
       latitude, longitude, elevation_ft, longest_runway_ft, runway_surface,
       has_instrument_approach, fuel_types, tower_controlled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAirports = db.transaction((apts: AirportSeed[]) => {
    for (const a of apts) {
      insertAirport.run(
        a.icaoCode,
        a.iataCode ?? null,
        a.faaId ?? null,
        a.name,
        a.city ?? null,
        a.state ?? null,
        a.country ?? "US",
        a.latitude,
        a.longitude,
        a.elevationFt ?? null,
        a.longestRunwayFt ?? null,
        a.runwaySurface ?? null,
        a.hasInstrumentApproach ? 1 : 0,
        a.fuelTypes ?? null,
        a.towerControlled ? 1 : 0,
      );
    }
  });

  insertAirports(airports);

  // ── Summary ────────────────────────────────────────────────────────────
  const opCount = (db.prepare("SELECT COUNT(*) as c FROM faa_operators").get() as { c: number }).c;
  const aptCount = (db.prepare("SELECT COUNT(*) as c FROM faa_airports").get() as { c: number }).c;

  console.log(`Ingested ${opCount} operators, ${aptCount} airports`);
}

main();
