/**
 * FAA Operators Full Ingestion — build complete Part 135 operator list
 *
 * Since the FAA's av-info.faa.gov blocks automated access, this script
 * builds a comprehensive operator list from data we already have:
 *
 * 1. Mines faa_aircraft.certificate_holder for ICAO operator designators
 *    and full operator names on charter-class aircraft
 * 2. Resolves ICAO codes to full names via adsb_completed_legs.operator_name
 * 3. Cross-references owner_name for fleet linkage and city/state
 * 4. Counts fleet size and annual trips from adsb_completed_legs
 * 5. Upserts into faa_operators (preserves existing seed data)
 * 6. Updates adsb_aircraft_state.operator_name where resolvable
 *
 * Also accepts an optional local JSON file of operators to merge in:
 *   npm run ingest:operators -- /path/to/operators.json
 *
 * Usage:
 *   npm run ingest:operators
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "../memory/database.js";

// ── Constants ─────────────────────────────────────────────────────────────

const CHARTER_CLASSES = [
  "light", "midsize", "super_mid", "heavy", "turboprop",
];

/** Known ICAO operator designator → full name mappings */
const ICAO_OPERATOR_MAP: Record<string, string> = {
  EJA: "NetJets Aviation",
  EJM: "Executive Jet Management",
  LXJ: "Flexjet",
  TWY: "Textron Aviation",
  GLF: "Gulfstream Aerospace",
  JTL: "JetSuite / JSX",
  DCM: "Directional Aviation Capital",
  PCH: "PlaneSense",
  WUP: "Wheels Up",
  JRE: "JetRight",
  FFL: "FlyExclusive",
  BBA: "Biggin Hill Executive Aviation",
  VJA: "VistaJet",
  EMB: "Embraer Executive Jets",
  XSR: "XO (formerly JetSmarter)",
  CDR: "Comlux Aviation",
  CYC: "Tradewind Aviation",
  CNS: "Contour Aviation",
  FDY: "Sun Country Airlines",
  JAS: "JetAviation",
  TMB: "Thrive Aviation",
  CPT: "Corporate Air",
  HON: "Honeywell Flight Operations",
  YEL: "Yellow Checker Star",
  LAK: "Lakeland Aero",
  FTH: "Freestream Aircraft",
  BTQ: "Boutique Air",
  GPD: "Global Crossing Airlines",
  SLH: "Silver Air",
  COL: "Comlux Completion",
  RAX: "Royal Air Freight",
  NJM: "Northern Jet Management",
  LJY: "Jet Linx Aviation",
  KFS: "Key Air",
  JTZ: "JetAccess Aviation",
  CFS: "Corporate Flight Services",
  SIS: "Solairus Aviation",
  PCM: "Pacific Mission Aviation",
  JCY: "Jet City Aviation",
  XFL: "XcelAir",
  STJ: "Stratton Jet",
  SKI: "SkyService Business Aviation",
  GAI: "Gama Aviation",
  GNJ: "Global Jet Luxembourg",
  RIS: "Rise Aviation",
  PST: "Priester Aviation",
};

/** Trust companies / banks / non-operators to exclude */
const EXCLUDE_PATTERNS = [
  "TRUSTEE", "BANK OF UTAH", "TVPX", "WELLS FARGO", "WILMINGTON TRUST",
  "PNC BANK", "UMB BANK", "CSC DELAWARE", "AIRCRAFT HOLDING SOLUTIONS",
  "VALIAIR", "KALININ PARTNERS", "REGISTRATION PENDING", "CANCELLED",
  "NOT ASSIGNED", "FEDERAL AVIATION ADMINISTRATION",
];

// ── Types ─────────────────────────────────────────────────────────────────

interface OperatorCandidate {
  code: string;
  name: string;
  isIcaoCode: boolean;
  tailNumbers: Set<string>;
  aircraftClasses: Set<string>;
  city: string | null;
  state: string | null;
}

interface LocalOperator {
  certificateNumber?: string;
  certificate_number?: string;
  name: string;
  dbaName?: string;
  dba_name?: string;
  city?: string;
  state?: string;
  phone?: string;
  address?: string;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const localFile = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;

  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const classPlaceholders = CHARTER_CLASSES.map(() => "?").join(",");

  console.log("[operators] Building operator list from FAA aircraft data...");

  // ── Step 1: Mine certificate_holder from charter-class aircraft ────────

  const certHolders = db.prepare(
    `SELECT certificate_holder, tail_number, aircraft_class, owner_name, owner_city, owner_state
     FROM faa_aircraft
     WHERE aircraft_class IN (${classPlaceholders})
       AND certificate_holder IS NOT NULL
       AND certificate_holder != '' AND certificate_holder != '-'`,
  ).all(...CHARTER_CLASSES) as Array<{
    certificate_holder: string;
    tail_number: string;
    aircraft_class: string;
    owner_name: string | null;
    owner_city: string | null;
    owner_state: string | null;
  }>;

  console.log(`[operators] Found ${certHolders.length} charter aircraft with certificate_holder`);

  // ── Step 2: Group by operator, resolve ICAO codes ─────────────────────

  const operatorMap = new Map<string, OperatorCandidate>();

  for (const row of certHolders) {
    const code = row.certificate_holder.trim();
    if (!code) continue;

    // Skip excluded patterns (trusts, banks, registration pending)
    if (EXCLUDE_PATTERNS.some((p) => code.toUpperCase().includes(p))) continue;

    const isIcao = code.length <= 5 && /^[A-Z]{2,5}$/.test(code);
    const name = isIcao ? (ICAO_OPERATOR_MAP[code] ?? code) : code;

    let op = operatorMap.get(code);
    if (!op) {
      op = {
        code,
        name,
        isIcaoCode: isIcao,
        tailNumbers: new Set(),
        aircraftClasses: new Set(),
        city: null,
        state: null,
      };
      operatorMap.set(code, op);
    }

    op.tailNumbers.add(row.tail_number);
    op.aircraftClasses.add(row.aircraft_class);

    // Grab city/state from owner data (non-trust owners)
    if (!op.city && row.owner_city && !EXCLUDE_PATTERNS.some((p) => (row.owner_name ?? "").toUpperCase().includes(p))) {
      op.city = row.owner_city;
      op.state = row.owner_state;
    }
  }

  console.log(`[operators] ${operatorMap.size} unique operators after filtering`);

  // ── Step 3: Try to resolve unmapped ICAO codes from adsb_completed_legs ─

  const resolveIcao = db.prepare(
    `SELECT DISTINCT operator_name FROM adsb_completed_legs
     WHERE operator_name IS NOT NULL AND operator_name != ''
       AND LENGTH(operator_name) > 5
       AND tail_number IN (SELECT value FROM json_each(?))
     LIMIT 1`,
  );

  let resolved = 0;
  for (const op of operatorMap.values()) {
    if (!op.isIcaoCode || op.name !== op.code) continue;
    // Try to find a full name from legs data
    const tails = [...op.tailNumbers].slice(0, 50); // limit for query size
    const row = resolveIcao.get(JSON.stringify(tails)) as { operator_name: string } | undefined;
    if (row) {
      op.name = row.operator_name;
      resolved++;
    }
  }
  console.log(`[operators] Resolved ${resolved} ICAO codes to full names from ADS-B legs`);

  // ── Step 4: Get trip counts ───────────────────────────────────────────

  const tripCountStmt = db.prepare(
    `SELECT COUNT(*) as trips FROM adsb_completed_legs
     WHERE tail_number IN (SELECT value FROM json_each(?))
       AND departure_time >= datetime('now', '-12 months')`,
  );

  // ── Step 5: Merge local file if provided ──────────────────────────────

  if (localFile && existsSync(localFile)) {
    console.log(`[operators] Merging local file: ${localFile}`);
    const raw = readFileSync(localFile, "utf-8");
    const localOps: LocalOperator[] = JSON.parse(raw);
    let merged = 0;

    for (const lo of localOps) {
      const certNum = lo.certificateNumber ?? lo.certificate_number ?? "";
      const name = lo.name?.trim();
      if (!name) continue;

      // Check if we already have this operator by name
      let found = false;
      for (const op of operatorMap.values()) {
        if (op.name.toUpperCase() === name.toUpperCase()) {
          if (lo.city) op.city = lo.city;
          if (lo.state) op.state = lo.state;
          found = true;
          break;
        }
      }

      if (!found) {
        operatorMap.set(certNum || `LOCAL_${name}`, {
          code: certNum || name,
          name,
          isIcaoCode: false,
          tailNumbers: new Set(),
          aircraftClasses: new Set(),
          city: lo.city ?? null,
          state: lo.state ?? null,
        });
        merged++;
      }
    }
    console.log(`[operators] Merged ${merged} new operators from local file`);
  }

  // ── Step 6: Upsert into faa_operators ─────────────────────────────────

  console.log("[operators] Upserting into faa_operators...");

  const upsertOp = db.prepare(
    `INSERT INTO faa_operators (certificate_number, name, dba_name, city, state, aircraft_count, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT(certificate_number) DO UPDATE SET
       name = CASE WHEN LENGTH(excluded.name) > LENGTH(faa_operators.name) THEN excluded.name ELSE faa_operators.name END,
       city = COALESCE(excluded.city, faa_operators.city),
       state = COALESCE(excluded.state, faa_operators.state),
       aircraft_count = excluded.aircraft_count,
       updated_at = excluded.updated_at`,
  );

  let upserted = 0;
  const allOperators: Array<{
    name: string; fleetSize: number; trips: number; classes: string[];
  }> = [];

  const upsertAll = db.transaction(() => {
    for (const op of operatorMap.values()) {
      const fleetSize = op.tailNumbers.size;
      const tails = [...op.tailNumbers];
      const trips = tails.length > 0
        ? (tripCountStmt.get(JSON.stringify(tails.slice(0, 200))) as { trips: number }).trips
        : 0;

      // Use ICAO code as certificate_number for ICAO operators, name hash otherwise
      const certNum = op.isIcaoCode ? op.code : op.code;
      const dbaName = op.isIcaoCode && op.name !== op.code ? op.code : null;

      upsertOp.run(certNum, op.name, dbaName, op.city, op.state, fleetSize, now);
      upserted++;

      allOperators.push({
        name: op.name,
        fleetSize,
        trips,
        classes: [...op.aircraftClasses],
      });
    }
  });

  upsertAll();
  console.log(`[operators] Upserted ${upserted} operators`);

  // ── Step 7: Update adsb_aircraft_state operator_name ──────────────────

  console.log("[operators] Updating adsb_aircraft_state operator names...");

  const updateState = db.prepare(
    `UPDATE adsb_aircraft_state SET operator_name = ?
     WHERE tail_number IN (SELECT value FROM json_each(?))
       AND (operator_name IS NULL OR operator_name = '' OR operator_name = ?)`,
  );

  let stateUpdated = 0;
  const updateStateTx = db.transaction(() => {
    for (const op of operatorMap.values()) {
      if (op.isIcaoCode && op.name === op.code) continue; // unresolved ICAO, skip
      const tails = JSON.stringify([...op.tailNumbers]);
      // Update rows where operator_name is null/empty or still the raw ICAO code
      const result = updateState.run(op.name, tails, op.code);
      stateUpdated += result.changes;
    }
  });

  updateStateTx();
  console.log(`[operators] Updated ${stateUpdated} aircraft state rows with operator names`);

  // ── Step 8: Also update from faa_aircraft.certificate_holder → adsb_aircraft_state ─

  // For aircraft where adsb_aircraft_state has no operator but faa_aircraft has certificate_holder
  const backfillState = db.prepare(
    `UPDATE adsb_aircraft_state
     SET operator_name = (
       SELECT f.certificate_holder FROM faa_aircraft f
       WHERE f.tail_number = adsb_aircraft_state.tail_number
         AND f.certificate_holder IS NOT NULL
         AND f.certificate_holder != '' AND f.certificate_holder != '-'
         AND LENGTH(f.certificate_holder) > 5
     )
     WHERE (operator_name IS NULL OR operator_name = '')
       AND tail_number IN (
         SELECT tail_number FROM faa_aircraft
         WHERE certificate_holder IS NOT NULL
           AND certificate_holder != '' AND certificate_holder != '-'
           AND LENGTH(certificate_holder) > 5
       )`,
  );

  const backfillResult = backfillState.run();
  console.log(`[operators] Backfilled ${backfillResult.changes} more aircraft state rows from FAA registry`);

  // ── Report ────────────────────────────────────────────────────────────

  const totalOps = (db.prepare("SELECT COUNT(*) as cnt FROM faa_operators").get() as { cnt: number }).cnt;
  const withFleet = (db.prepare("SELECT COUNT(*) as cnt FROM faa_operators WHERE aircraft_count > 0").get() as { cnt: number }).cnt;
  const totalLinked = (db.prepare(
    "SELECT COUNT(*) as cnt FROM adsb_aircraft_state WHERE operator_name IS NOT NULL AND operator_name != '' AND operator_name != '-'",
  ).get() as { cnt: number }).cnt;
  const totalState = (db.prepare("SELECT COUNT(*) as cnt FROM adsb_aircraft_state").get() as { cnt: number }).cnt;

  // Sort for display
  allOperators.sort((a, b) => b.fleetSize - a.fleetSize || b.trips - a.trips);

  console.log(`\n═══ FAA Operators Ingestion Report ═══`);
  console.log(`Total operators in DB:    ${totalOps}`);
  console.log(`Operators with fleet:     ${withFleet}`);
  console.log(`Aircraft with operator:   ${totalLinked.toLocaleString()} / ${totalState.toLocaleString()} (${Math.round(totalLinked / totalState * 100)}%)`);

  // Fleet size distribution
  const dist = db.prepare(
    `SELECT
       SUM(CASE WHEN aircraft_count >= 50 THEN 1 ELSE 0 END) as large,
       SUM(CASE WHEN aircraft_count >= 10 AND aircraft_count < 50 THEN 1 ELSE 0 END) as medium,
       SUM(CASE WHEN aircraft_count >= 2 AND aircraft_count < 10 THEN 1 ELSE 0 END) as small,
       SUM(CASE WHEN aircraft_count = 1 THEN 1 ELSE 0 END) as single
     FROM faa_operators WHERE aircraft_count > 0`,
  ).get() as { large: number; medium: number; small: number; single: number };

  console.log(`\n── Fleet Size Distribution ──`);
  console.log(`  50+ aircraft:  ${dist.large}`);
  console.log(`  10-49 aircraft: ${dist.medium}`);
  console.log(`  2-9 aircraft:  ${dist.small}`);
  console.log(`  1 aircraft:    ${dist.single}`);

  // Top 20
  console.log(`\n── Top 20 Operators by Fleet Size ──`);
  console.log(`${"#".padStart(3)}  ${"Operator".padEnd(45)} Fleet  Trips  Classes`);
  console.log("─".repeat(100));
  for (let i = 0; i < Math.min(20, allOperators.length); i++) {
    const t = allOperators[i]!;
    console.log(
      `${String(i + 1).padStart(3)}  ${t.name.slice(0, 45).padEnd(45)} ${String(t.fleetSize).padStart(5)}  ${String(t.trips).padStart(5)}  ${t.classes.join(", ")}`,
    );
  }

  closeDb();
  console.log(`\n[operators] Done.`);
}

main();
