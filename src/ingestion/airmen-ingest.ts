/**
 * FAA Releasable Airmen Ingest — ATP pilots only
 *
 * Downloads ReleasableAirmen.zip from registry.faa.gov (or accepts local path),
 * parses BASIC.csv + CERT.csv, filters for ATP certificate holders,
 * and cross-references with aircraft base airports from adsb_completed_legs.
 *
 * Usage:
 *   npm run ingest:airmen                                # download from FAA
 *   npm run ingest:airmen -- /path/to/ReleasableAirmen   # local extracted folder
 *   npm run ingest:airmen -- --zip /path/to/ReleasableAirmen.zip
 *
 * Run via: npm run ingest:airmen
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { getDb, closeDb } from "../db/database.js";
import { childLogger } from "../utils/logger.js";

const log = childLogger("airmen");

// ── Constants ──────────────────────────────────────────────────────────────

const FAA_AIRMEN_URL = "https://registry.faa.gov/database/ReleasableAirmen.zip";
const TEMP_DIR = resolve("./data/faa_raw");

// ── Types ──────────────────────────────────────────────────────────────────

interface BasicRow {
  uniqueNumber: string;
  firstMiddleName: string;
  lastName: string;
  street1: string;
  street2: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  region: string;
  medicalClass: string;
  medicalDate: string;
  medicalExpireDate: string;
}

interface CertRow {
  uniqueNumber: string;
  certType: string;
  certLevel: string;
  ratings: string;
}

interface AircraftBase {
  tail_number: string;
  base_icao: string;
  base_city: string;
  base_state: string;
  aircraft_class: string;
  operator_name: string;
  leg_count: number;
}

// ── Parse CSV files ──────────────────────────────────────────────────────

function parseBasicCsv(filePath: string): Map<string, BasicRow> {
  console.log(`[airmen] Reading ${filePath}...`);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  // Parse header — strip BOM
  const headerLine = lines[0]!.replace(/^\uFEFF/, "");
  const headers = headerLine.split(",").map((h) => h.trim().toUpperCase());

  // Fuzzy column finder — FAA uses inconsistent naming across releases
  const colIdx = (candidates: string[]): number => {
    for (const name of candidates) {
      const idx = headers.indexOf(name);
      if (idx >= 0) return idx;
    }
    throw new Error(`None of [${candidates.join(", ")}] found in BASIC header. Available: ${headers.join(", ")}`);
  };

  console.log(`[airmen] BASIC headers: ${headers.join(", ")}`);

  const idx = {
    uniqueNumber: colIdx(["UNIQUE ID", "UNIQUE NUMBER", "UNIQUE_NUMBER", "UNIQUEID"]),
    firstName: colIdx(["FIRST NAME", "FIRST & MIDDLE NAME", "FIRSTNAME", "FIRST_NAME"]),
    lastName: colIdx(["LAST NAME", "LAST NAME & SUFFIX", "LASTNAME", "LAST_NAME"]),
    street1: colIdx(["STREET 1", "STREET1", "STREET_1"]),
    street2: colIdx(["STREET 2", "STREET2", "STREET_2"]),
    city: colIdx(["CITY"]),
    state: colIdx(["STATE"]),
    zip: colIdx(["ZIP CODE", "ZIP", "ZIPCODE", "ZIP_CODE"]),
    country: colIdx(["COUNTRY", "COUNTRY NAME", "COUNTRY_NAME"]),
    region: colIdx(["REGION"]),
    medClass: colIdx(["MED CLASS", "MEDICAL CLASS", "MED_CLASS", "MEDCLASS"]),
    medDate: colIdx(["MED DATE", "MEDICAL DATE", "MED_DATE", "MEDDATE"]),
    medExpDate: colIdx(["MED EXP DATE", "MEDICAL EXPIRE DATE", "MED_EXP_DATE", "MEDEXPDATE"]),
  };

  const records = new Map<string, BasicRow>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const cols = line.split(",");
    const uniqueNumber = cols[idx.uniqueNumber]?.trim() || "";
    if (!uniqueNumber) continue;

    records.set(uniqueNumber, {
      uniqueNumber,
      firstMiddleName: cols[idx.firstName]?.trim() || "",
      lastName: cols[idx.lastName]?.trim() || "",
      street1: cols[idx.street1]?.trim() || "",
      street2: cols[idx.street2]?.trim() || "",
      city: cols[idx.city]?.trim() || "",
      state: cols[idx.state]?.trim() || "",
      zip: cols[idx.zip]?.trim() || "",
      country: cols[idx.country]?.trim() || "",
      region: cols[idx.region]?.trim() || "",
      medicalClass: cols[idx.medClass]?.trim() || "",
      medicalDate: cols[idx.medDate]?.trim() || "",
      medicalExpireDate: cols[idx.medExpDate]?.trim() || "",
    });
  }

  console.log(`[airmen] Parsed ${records.size} airmen from BASIC`);
  return records;
}

function parseCertCsv(filePath: string): Map<string, CertRow[]> {
  console.log(`[airmen] Reading ${filePath}...`);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  const headerLine = lines[0]!.replace(/^\uFEFF/, "");
  const headers = headerLine.split(",").map((h) => h.trim().toUpperCase());

  const colIdx = (candidates: string[]): number => {
    for (const name of candidates) {
      const idx = headers.indexOf(name);
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const colIdxRequired = (candidates: string[]): number => {
    const idx = colIdx(candidates);
    if (idx < 0) throw new Error(`None of [${candidates.join(", ")}] found in CERT header. Available: ${headers.join(", ")}`);
    return idx;
  };

  console.log(`[airmen] CERT headers: ${headers.join(", ")}`);

  const idxUniqueNumber = colIdxRequired(["UNIQUE ID", "UNIQUE NUMBER", "UNIQUE_NUMBER", "UNIQUEID"]);
  const idxCertType = colIdxRequired(["TYPE", "CERTIFICATE TYPE", "CERT TYPE", "CERT_TYPE"]);
  const idxCertLevel = colIdxRequired(["LEVEL", "CERTIFICATE LEVEL", "CERT LEVEL", "CERT_LEVEL"]);
  const idxRatingsSingle = colIdx(["RATINGS", "RATING"]);

  // CSV format has RATING1..RATING11 and TYPERATING1..TYPERATING99 as separate columns
  const ratingColIndices: number[] = [];
  for (let r = 1; r <= 11; r++) {
    const ri = headers.indexOf(`RATING${r}`);
    if (ri >= 0) ratingColIndices.push(ri);
  }
  for (let r = 1; r <= 99; r++) {
    const ri = headers.indexOf(`TYPERATING${r}`);
    if (ri >= 0) ratingColIndices.push(ri);
  }

  const hasMultiRatingCols = ratingColIndices.length > 0;
  if (idxRatingsSingle < 0 && !hasMultiRatingCols) {
    throw new Error(`No ratings columns found in CERT header. Available: ${headers.join(", ")}`);
  }

  console.log(`[airmen] Ratings mode: ${hasMultiRatingCols ? `multi-column (${ratingColIndices.length} cols)` : "single column"}`);

  const certsByPilot = new Map<string, CertRow[]>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const cols = line.split(",");
    const uniqueNumber = cols[idxUniqueNumber]?.trim() || "";
    if (!uniqueNumber) continue;

    let ratings: string;
    if (hasMultiRatingCols) {
      ratings = ratingColIndices
        .map((ci) => cols[ci]?.trim() || "")
        .filter(Boolean)
        .join(", ");
    } else {
      ratings = cols[idxRatingsSingle]?.trim() || "";
    }

    const cert: CertRow = {
      uniqueNumber,
      certType: cols[idxCertType]?.trim() || "",
      certLevel: cols[idxCertLevel]?.trim() || "",
      ratings,
    };

    const existing = certsByPilot.get(uniqueNumber);
    if (existing) {
      existing.push(cert);
    } else {
      certsByPilot.set(uniqueNumber, [cert]);
    }
  }

  console.log(`[airmen] Parsed ${certsByPilot.size} airmen certificates from CERT`);
  return certsByPilot;
}

// ── Download & extract ──────────────────────────────────────────────────

async function downloadAndExtract(): Promise<string> {
  mkdirSync(TEMP_DIR, { recursive: true });
  const zipPath = join(TEMP_DIR, "ReleasableAirmen.zip");

  console.log(`[airmen] Downloading from ${FAA_AIRMEN_URL}...`);
  const resp = await fetch(FAA_AIRMEN_URL, {
    signal: AbortSignal.timeout(120_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OSA-Dumont/1.0)",
    },
  });

  if (!resp.ok) {
    throw new Error(
      `FAA download failed: HTTP ${resp.status} ${resp.statusText}. ` +
      `Try downloading manually and passing the path: npm run ingest:airmen -- /path/to/ReleasableAirmen`,
    );
  }

  const buffer = Buffer.from(await resp.arrayBuffer());

  // Check if FAA returned an HTML page instead of the zip
  const head = buffer.subarray(0, 20).toString("utf-8");
  if (head.includes("<!DOCTYPE") || head.includes("<html")) {
    throw new Error(
      `FAA returned an HTML page instead of the zip (download blocked). ` +
      `Download manually from ${FAA_AIRMEN_URL} and run:\n` +
      `  npm run ingest:airmen -- --zip /path/to/ReleasableAirmen.zip\n` +
      `  npm run ingest:airmen -- /path/to/extracted/folder`,
    );
  }

  writeFileSync(zipPath, buffer);
  console.log(`[airmen] Downloaded ${(buffer.length / 1_048_576).toFixed(1)} MB → ${zipPath}`);

  const extractDir = join(TEMP_DIR, "ReleasableAirmen");
  mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
  console.log(`[airmen] Extracted to ${extractDir}`);
  return extractDir;
}

// ── Resolve input path ──────────────────────────────────────────────────

async function resolveInputPath(): Promise<string> {
  const args = process.argv.slice(2);

  // --zip /path/to/ReleasableAirmen.zip
  const zipIdx = args.indexOf("--zip");
  if (zipIdx >= 0 && args[zipIdx + 1]) {
    const zipPath = resolve(args[zipIdx + 1]!);
    if (!existsSync(zipPath)) throw new Error(`Zip not found: ${zipPath}`);
    console.log(`[airmen] Extracting from local zip: ${zipPath}`);
    const extractDir = join(TEMP_DIR, "ReleasableAirmen");
    mkdirSync(extractDir, { recursive: true });
    execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: "pipe" });
    return extractDir;
  }

  // Direct folder path containing BASIC.csv and CERT.csv
  if (args[0] && !args[0].startsWith("--")) {
    const dirPath = resolve(args[0]);
    if (!existsSync(dirPath)) throw new Error(`Path not found: ${dirPath}`);
    return dirPath;
  }

  // Default: download from FAA
  return downloadAndExtract();
}

// ── Find CSV files in extracted folder ──────────────────────────────────

function findCsvFiles(dir: string): { basicPath: string; certPath: string } {
  // FAA uses various naming: PILOT_BASIC.csv, BASIC.csv, etc.
  const candidates = {
    basic: ["PILOT_BASIC.csv", "BASIC.csv", "basic.csv", "PILOT_BASIC.CSV"],
    cert: ["PILOT_CERT.csv", "CERT.csv", "cert.csv", "PILOT_CERT.CSV"],
  };

  let basicPath = "";
  let certPath = "";

  for (const name of candidates.basic) {
    const p = join(dir, name);
    if (existsSync(p)) { basicPath = p; break; }
  }
  for (const name of candidates.cert) {
    const p = join(dir, name);
    if (existsSync(p)) { certPath = p; break; }
  }

  if (!basicPath || !certPath) {
    // List directory to help debug
    const files = execSync(`ls -la "${dir}"`).toString();
    throw new Error(
      `Could not find BASIC.csv or CERT.csv in ${dir}.\n` +
      `Directory contents:\n${files}`,
    );
  }

  return { basicPath, certPath };
}

// ── Get aircraft base airports from ADS-B legs ─────────────────────────

function getAircraftBases(db: ReturnType<typeof getDb>): Map<string, AircraftBase> {
  // For each aircraft, find their most frequent origin airport (= likely base)
  // Join with faa_airports to get city/state
  const rows = db.prepare(`
    WITH base_freq AS (
      SELECT
        l.tail_number,
        l.origin_icao,
        l.aircraft_class,
        l.operator_name,
        COUNT(*) AS leg_count,
        ROW_NUMBER() OVER (PARTITION BY l.tail_number ORDER BY COUNT(*) DESC) AS rn
      FROM adsb_completed_legs l
      WHERE l.tail_number IS NOT NULL
        AND l.origin_icao IS NOT NULL
        AND l.aircraft_class IN ('light_jet', 'midsize_jet', 'super_mid_jet', 'heavy_jet', 'ultra_long_range', 'vip_airliner', 'turboprop')
      GROUP BY l.tail_number, l.origin_icao
    )
    SELECT
      bf.tail_number,
      bf.origin_icao AS base_icao,
      COALESCE(a.city, '') AS base_city,
      COALESCE(a.state, '') AS base_state,
      bf.aircraft_class,
      COALESCE(bf.operator_name, '') AS operator_name,
      bf.leg_count
    FROM base_freq bf
    LEFT JOIN faa_airports a ON a.icao_code = bf.origin_icao
    WHERE bf.rn = 1 AND bf.leg_count >= 3
  `).all() as AircraftBase[];

  const bases = new Map<string, AircraftBase>();
  for (const row of rows) {
    bases.set(row.tail_number, row);
  }

  console.log(`[airmen] Found ${bases.size} aircraft with identified base airports`);
  return bases;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const extractDir = await resolveInputPath();
  const { basicPath, certPath } = findCsvFiles(extractDir);

  // Parse CSV files
  const basicRecords = parseBasicCsv(basicPath);
  const certRecords = parseCertCsv(certPath);

  // Filter for ATP certificate holders only
  const atpUniqueNumbers = new Set<string>();
  const atpRatings = new Map<string, string[]>();

  for (const [uniqueNumber, certs] of certRecords) {
    const atpCerts = certs.filter((c) => c.certType === "P" && c.certLevel === "A");
    if (atpCerts.length > 0) {
      atpUniqueNumbers.add(uniqueNumber);
      // Collect all ratings from all certs for this pilot
      const ratings: string[] = [];
      for (const cert of certs) {
        if (cert.ratings) {
          ratings.push(cert.ratings);
        }
      }
      atpRatings.set(uniqueNumber, ratings);
    }
  }

  console.log(`[airmen] Found ${atpUniqueNumbers.size} ATP certificate holders`);

  // Open DB and ingest
  const db = getDb();

  // Clear existing data for clean re-ingest
  db.exec("DELETE FROM pilot_aircraft_link");
  db.exec("DELETE FROM pilot_contacts");

  const insertPilot = db.prepare(`
    INSERT OR REPLACE INTO pilot_contacts
      (certificate_number, first_middle_name, last_name, street1, street2,
       city, state, zip, country, region, medical_class, medical_date,
       medical_expire_date, ratings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let ingested = 0;
  let skippedNoBasic = 0;

  const batchInsert = db.transaction(() => {
    for (const uniqueNumber of atpUniqueNumbers) {
      const basic = basicRecords.get(uniqueNumber);
      if (!basic) {
        skippedNoBasic++;
        continue;
      }

      const ratings = atpRatings.get(uniqueNumber) || [];

      insertPilot.run(
        uniqueNumber,
        basic.firstMiddleName || null,
        basic.lastName || null,
        basic.street1 || null,
        basic.street2 || null,
        basic.city || null,
        basic.state || null,
        basic.zip || null,
        basic.country || null,
        basic.region || null,
        basic.medicalClass || null,
        basic.medicalDate || null,
        basic.medicalExpireDate || null,
        JSON.stringify(ratings),
      );
      ingested++;
    }
  });

  console.log("[airmen] Inserting ATP pilots...");
  batchInsert();
  console.log(`[airmen] Ingested ${ingested.toLocaleString()} ATP pilots (${skippedNoBasic} skipped — no basic record)`);

  // ── Cross-reference: pilot city/state ↔ aircraft base city/state ─────

  console.log("[airmen] Building pilot ↔ aircraft cross-reference...");
  const aircraftBases = getAircraftBases(db);

  if (aircraftBases.size === 0) {
    console.log("[airmen] No aircraft bases found in adsb_completed_legs — skipping cross-reference");
    printReport(db);
    closeDb();
    return;
  }

  // Build a city+state → pilots index for fast lookup
  const pilotsByLocation = new Map<string, { certNum: string; name: string; city: string; state: string }[]>();

  const allPilots = db.prepare(`
    SELECT certificate_number, first_middle_name, last_name, city, state
    FROM pilot_contacts
    WHERE city IS NOT NULL AND state IS NOT NULL AND state != ''
  `).all() as { certificate_number: string; first_middle_name: string; last_name: string; city: string; state: string }[];

  for (const p of allPilots) {
    const key = `${p.city.toUpperCase()}|${p.state.toUpperCase()}`;
    const name = [p.first_middle_name, p.last_name].filter(Boolean).join(" ");
    const entry = { certNum: p.certificate_number, name, city: p.city, state: p.state };
    const existing = pilotsByLocation.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      pilotsByLocation.set(key, [entry]);
    }
  }

  console.log(`[airmen] Indexed ${allPilots.length.toLocaleString()} pilots by city/state`);

  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO pilot_aircraft_link
      (certificate_number, tail_number, pilot_name, pilot_city, pilot_state,
       aircraft_base_icao, aircraft_base_city, aircraft_base_state,
       aircraft_class, operator_name, match_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let linkCount = 0;

  const batchLink = db.transaction(() => {
    for (const [tailNumber, base] of aircraftBases) {
      if (!base.base_city || !base.base_state) continue;

      const key = `${base.base_city.toUpperCase()}|${base.base_state.toUpperCase()}`;
      const matchingPilots = pilotsByLocation.get(key);
      if (!matchingPilots) continue;

      for (const pilot of matchingPilots) {
        insertLink.run(
          pilot.certNum,
          tailNumber,
          pilot.name,
          pilot.city,
          pilot.state,
          base.base_icao,
          base.base_city,
          base.base_state,
          base.aircraft_class || null,
          base.operator_name || null,
          "city_state",
        );
        linkCount++;
      }
    }
  });

  batchLink();
  console.log(`[airmen] Created ${linkCount.toLocaleString()} pilot ↔ aircraft links`);

  printReport(db);
  closeDb();
  console.log("\n[airmen] Done.");
}

function printReport(db: ReturnType<typeof getDb>): void {
  // ── Report ──────────────────────────────────────────────────────────────
  const pilotCount = (db.prepare("SELECT COUNT(*) AS cnt FROM pilot_contacts").get() as { cnt: number }).cnt;
  const linkCount = (db.prepare("SELECT COUNT(*) AS cnt FROM pilot_aircraft_link").get() as { cnt: number }).cnt;

  console.log("\n═══ FAA Airmen Ingest Report ═══");
  console.log(`Total ATP pilots:        ${pilotCount.toLocaleString()}`);
  console.log(`Pilot ↔ Aircraft links:  ${linkCount.toLocaleString()}`);

  // State distribution
  const byState = db.prepare(`
    SELECT state, COUNT(*) AS cnt FROM pilot_contacts
    WHERE state IS NOT NULL AND state != ''
    GROUP BY state ORDER BY cnt DESC LIMIT 10
  `).all() as { state: string; cnt: number }[];

  if (byState.length > 0) {
    console.log("\n── Top 10 States by ATP Pilots ──");
    for (const r of byState) {
      console.log(`  ${r.state}: ${r.cnt.toLocaleString()}`);
    }
  }

  // Medical class distribution
  const byMedical = db.prepare(`
    SELECT medical_class, COUNT(*) AS cnt FROM pilot_contacts
    WHERE medical_class IS NOT NULL AND medical_class != ''
    GROUP BY medical_class ORDER BY cnt DESC
  `).all() as { medical_class: string; cnt: number }[];

  if (byMedical.length > 0) {
    console.log("\n── Medical Class Distribution ──");
    const classNames: Record<string, string> = { "1": "First Class", "2": "Second Class", "3": "Third Class" };
    for (const r of byMedical) {
      console.log(`  ${classNames[r.medical_class] || r.medical_class}: ${r.cnt.toLocaleString()}`);
    }
  }

  // Top matches by aircraft
  if (linkCount > 0) {
    const topMatches = db.prepare(`
      SELECT
        pal.tail_number,
        pal.aircraft_class,
        pal.operator_name,
        pal.aircraft_base_icao,
        pal.aircraft_base_city || ', ' || pal.aircraft_base_state AS base_location,
        COUNT(*) AS pilot_count
      FROM pilot_aircraft_link pal
      GROUP BY pal.tail_number
      ORDER BY pilot_count DESC
      LIMIT 15
    `).all() as { tail_number: string; aircraft_class: string; operator_name: string; aircraft_base_icao: string; base_location: string; pilot_count: number }[];

    console.log("\n── Top Matches: Aircraft with Most Co-located ATP Pilots ──");
    for (const r of topMatches) {
      console.log(`  ${r.tail_number} (${r.aircraft_class || "?"}) @ ${r.aircraft_base_icao} ${r.base_location} — ${r.pilot_count} ATP pilots nearby`);
    }

    // Sample specific links
    const sampleLinks = db.prepare(`
      SELECT pal.pilot_name, pal.tail_number, pal.aircraft_class, pal.aircraft_base_icao,
             pal.pilot_city || ', ' || pal.pilot_state AS pilot_location
      FROM pilot_aircraft_link pal
      ORDER BY RANDOM()
      LIMIT 10
    `).all() as { pilot_name: string; tail_number: string; aircraft_class: string; aircraft_base_icao: string; pilot_location: string }[];

    console.log("\n── Sample Pilot ↔ Aircraft Links ──");
    for (const r of sampleLinks) {
      console.log(`  ${r.pilot_name} (${r.pilot_location}) → ${r.tail_number} (${r.aircraft_class || "?"}) @ ${r.aircraft_base_icao}`);
    }
  }
}

main().catch((err) => {
  log.fatal({ err }, "airmen fatal error");
  process.exit(1);
});
