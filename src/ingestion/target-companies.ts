/**
 * Target Companies Builder — corporate fleet intelligence from FAA registry
 *
 * Queries faa_aircraft for distinct corporate owners of charter-class aircraft,
 * excludes trust companies and individuals, cross-references ADS-B completed legs
 * for trip estimates, and exports top 500 by fleet size.
 *
 * Usage:
 *   npm run export:targets
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "../memory/database.js";

// ── Constants ─────────────────────────────────────────────────────────────

const TRUST_PATTERNS = [
  "TRUSTEE",
  "BANK OF UTAH",
  "TVPX",
  "WELLS FARGO",
  "WILMINGTON TRUST",
];

const CHARTER_CLASSES = [
  "light", "midsize", "super_mid", "heavy", "ultra_long_range",
  "turboprop", "vip_airliner",
  // aliases in case schema uses _jet suffix
  "light_jet", "midsize_jet", "super_mid_jet", "heavy_jet",
];

const EXPORT_DIR = resolve("./data/exports");
const EXPORT_PATH = resolve(EXPORT_DIR, "target_companies_top500.csv");

// ── Helpers ───────────────────────────────────────────────────────────────

/** Detect "LASTNAME FIRSTNAME" pattern — all caps, two+ words, no Inc/LLC/Corp */
function isIndividualName(name: string): boolean {
  const trimmed = name.trim();
  // Corporate suffixes → not an individual
  if (/\b(INC|LLC|CORP|CO|LTD|LP|COMPANY|AVIATION|AIR|AIRLINES|AIRWAYS|ENTERPRISES|GROUP|HOLDINGS|PARTNERS|SERVICES|MANAGEMENT|LEASING|CHARTER)\b/i.test(trimmed)) {
    return false;
  }
  // "LASTNAME FIRSTNAME MIDDLE" pattern: 2-3 short all-caps words, no numbers
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false;
  // Every word is all letters (no digits, no punctuation except maybe a hyphen)
  return words.every((w) => /^[A-Z][A-Za-z'-]+$/.test(w) || /^[A-Z]+$/.test(w));
}

function isTrustCompany(name: string): boolean {
  const upper = name.toUpperCase();
  return TRUST_PATTERNS.some((p) => upper.includes(p));
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  console.log("[targets] Querying corporate owners of charter-class aircraft...");

  // Get all charter-class aircraft with corporate owners
  const placeholders = CHARTER_CLASSES.map(() => "?").join(",");
  const aircraft = db.prepare(
    `SELECT tail_number, owner_name, aircraft_class
     FROM faa_aircraft
     WHERE aircraft_class IN (${placeholders})
       AND owner_name IS NOT NULL
       AND owner_name != ''
       AND status IN ('active', 'V')`,
  ).all(...CHARTER_CLASSES) as Array<{
    tail_number: string;
    owner_name: string;
    aircraft_class: string;
  }>;

  console.log(`[targets] Found ${aircraft.length} charter-class aircraft with owners`);

  // Group by owner, filtering out trusts and individuals
  const companyMap = new Map<string, {
    tailNumbers: Set<string>;
    aircraftClasses: Set<string>;
  }>();

  let skippedTrusts = 0;
  let skippedIndividuals = 0;

  for (const a of aircraft) {
    const name = a.owner_name.trim();
    if (!name) continue;

    if (isTrustCompany(name)) {
      skippedTrusts++;
      continue;
    }
    if (isIndividualName(name)) {
      skippedIndividuals++;
      continue;
    }

    let entry = companyMap.get(name);
    if (!entry) {
      entry = { tailNumbers: new Set(), aircraftClasses: new Set() };
      companyMap.set(name, entry);
    }
    entry.tailNumbers.add(a.tail_number);
    entry.aircraftClasses.add(a.aircraft_class);
  }

  console.log(`[targets] ${companyMap.size} corporate owners (excluded ${skippedTrusts} trust, ${skippedIndividuals} individual)`);

  // Get trip counts from ADS-B completed legs (last 12 months)
  const tripCountStmt = db.prepare(
    `SELECT COUNT(*) as trips FROM adsb_completed_legs
     WHERE tail_number IN (SELECT value FROM json_each(?))
       AND departure_time >= datetime('now', '-12 months')`,
  );

  // Build target_companies rows
  interface TargetRow {
    companyName: string;
    tailNumbers: string[];
    aircraftClasses: string[];
    fleetSize: number;
    estimatedAnnualTrips: number;
  }

  const targets: TargetRow[] = [];
  for (const [name, data] of companyMap) {
    const tails = [...data.tailNumbers];
    const trips = (tripCountStmt.get(JSON.stringify(tails)) as { trips: number }).trips;

    targets.push({
      companyName: name,
      tailNumbers: tails,
      aircraftClasses: [...data.aircraftClasses],
      fleetSize: tails.length,
      estimatedAnnualTrips: trips,
    });
  }

  // Sort by fleet size descending, then by trips
  targets.sort((a, b) => b.fleetSize - a.fleetSize || b.estimatedAnnualTrips - a.estimatedAnnualTrips);

  // Insert into target_companies table
  console.log("[targets] Writing to target_companies table...");

  const upsertCompany = db.prepare(
    `INSERT INTO target_companies (company_name, tail_numbers, aircraft_classes, fleet_size, estimated_annual_trips, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(company_name) DO UPDATE SET
       tail_numbers = excluded.tail_numbers,
       aircraft_classes = excluded.aircraft_classes,
       fleet_size = excluded.fleet_size,
       estimated_annual_trips = excluded.estimated_annual_trips,
       updated_at = excluded.updated_at`,
  );

  const insertAll = db.transaction(() => {
    for (const t of targets) {
      upsertCompany.run(
        t.companyName,
        JSON.stringify(t.tailNumbers),
        JSON.stringify(t.aircraftClasses),
        t.fleetSize,
        t.estimatedAnnualTrips,
        now,
      );
    }
  });
  insertAll();

  console.log(`[targets] Inserted/updated ${targets.length} companies`);

  // Export top 500 as CSV
  mkdirSync(EXPORT_DIR, { recursive: true });
  const top500 = targets.slice(0, 500);
  const csvLines = [
    "company_name,fleet_size,estimated_annual_trips,aircraft_classes,tail_numbers",
  ];
  for (const t of top500) {
    const escapeCsv = (s: string) => s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    csvLines.push([
      escapeCsv(t.companyName),
      t.fleetSize,
      t.estimatedAnnualTrips,
      escapeCsv(t.aircraftClasses.join("; ")),
      escapeCsv(t.tailNumbers.join("; ")),
    ].join(","));
  }

  writeFileSync(EXPORT_PATH, csvLines.join("\n"), "utf-8");
  console.log(`[targets] Exported ${top500.length} companies to ${EXPORT_PATH}`);

  // Print top 20
  console.log(`\n═══ Target Companies — Top 20 by Fleet Size ═══`);
  console.log(`${"#".padStart(3)}  ${"Company".padEnd(50)} Fleet  Trips  Classes`);
  console.log("─".repeat(100));
  for (let i = 0; i < Math.min(20, targets.length); i++) {
    const t = targets[i]!;
    console.log(
      `${String(i + 1).padStart(3)}  ${t.companyName.slice(0, 50).padEnd(50)} ${String(t.fleetSize).padStart(5)}  ${String(t.estimatedAnnualTrips).padStart(5)}  ${t.aircraftClasses.join(", ")}`,
    );
  }

  console.log(`\n── Summary ──`);
  console.log(`Total corporate owners: ${targets.length}`);
  console.log(`Top 500 exported to:    ${EXPORT_PATH}`);

  closeDb();
  console.log(`\n[targets] Done.`);
}

main();
