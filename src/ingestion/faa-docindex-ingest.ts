/**
 * FAA Document Index Ingestion — Aircraft Liens from DOCINDEX.txt
 *
 * Parses the FAA's Aircraft Document Index file, which records every
 * document filed with the Aircraft Registry: bills of sale, security
 * conveyances (liens), lien releases, repossessions, court orders.
 *
 * This replaces the need to scrape state UCC filings — the FAA is the
 * authoritative federal recording office for aircraft liens under
 * 49 USC Chapter 441 and 14 CFR Part 49.
 *
 * Data dictionary (from ardata.pdf):
 *   TYPE-COLLATERAL: 1=Aircraft, 2=Engine, 3=Propeller, 4=Spare Parts, 5=Document, 9=Unidentified
 *   COLLATERAL:      N-number (type 1) or engine/propeller make-model-serial (type 2/3)
 *   PARTY:           Name of party (redacted since 49 USC §44114(b) privacy rule)
 *   DOC-ID:          Unique document image number
 *   DRDATE:          Document receipt date (YYYYMMDD)
 *   PROCESSING-DATE: Date entered into file (YYYYMMDD)
 *   CORR-DATE:       Correction date (YYYYMMDD, blank if none)
 *   CORR-ID:         A=Added, C=Changed
 *   SERIAL-ID:       Serial number for engine or propeller
 *   DOC-TYPE:        BOS=Bill of Sale, S/A=Security Conveyance/Lien,
 *                    REL=Lien Release, REP=Repossession,
 *                    CSC=Evidence of Ownership w/Lien,
 *                    DIS=Disclaimer, CRT=Court Documents
 *
 * Usage:
 *   npm run ingest:docindex                              # use local extracted file
 *   npm run ingest:docindex -- /path/to/DOCINDEX.txt     # explicit path
 *   npm run ingest:docindex -- --zip /path/to/ReleasableAircraft.zip
 *
 * The file is inside the same ReleasableAircraft.zip used by faa-daily-diff.
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { getDb, closeDb } from "../db/database.js";
import { runMigrations } from "../db/migrations.js";

// ── Constants ──────────────────────────────────────────────────────────────

const TEMP_DIR = resolve("./data/faa_raw");
const DEFAULT_PATH = join(TEMP_DIR, "DOCINDEX.txt");

// Doc types relevant to lien intelligence
const LIEN_DOC_TYPES = new Set(["S/A", "REL", "REP", "CSC", "CRT"]);

const DOC_TYPE_LABELS: Record<string, string> = {
  "BOS": "Bill of Sale",
  "S/A": "Security Conveyance/Lien",
  "REL": "Lien Release",
  "REP": "Repossession",
  "CSC": "Evidence of Ownership w/Lien",
  "DIS": "Disclaimer",
  "CRT": "Court Documents",
};

const COLLATERAL_TYPE_LABELS: Record<number, string> = {
  1: "Aircraft",
  2: "Engine",
  3: "Propeller",
  4: "Spare Parts",
  5: "Document",
  9: "Unidentified",
};

// ── Types ──────────────────────────────────────────────────────────────────

interface DocIndexRow {
  collateralType: number;
  collateralRaw: string;
  tailNumber: string | null;
  partyName: string | null;
  docId: string | null;
  receiptDate: string | null;      // YYYY-MM-DD
  processingDate: string | null;
  correctionDate: string | null;
  correctionId: string | null;
  serialId: string | null;
  docType: string;
}

interface IngestStats {
  totalRows: number;
  skippedDuplicates: number;
  inserted: number;
  aircraftDocs: number;
  lienDocs: number;
  matchedToFaa: number;
  charterClassMatched: number;
  byDocType: Record<string, number>;
  byCollateralType: Record<number, number>;
}

// ── Date parsing ──────────────────────────────────────────────────────────

function parseFaaDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 8) return null;
  const year = trimmed.substring(0, 4);
  const month = trimmed.substring(4, 6);
  const day = trimmed.substring(6, 8);
  if (year === "0000" || month === "00") return null;
  return `${year}-${month}-${day}`;
}

// ── Parse DOCINDEX.txt ────────────────────────────────────────────────────

function parseDocIndex(filePath: string): DocIndexRow[] {
  console.log(`[docindex] Reading ${filePath}...`);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  // Parse header — strip BOM
  const headerLine = lines[0]!.replace(/^\uFEFF/, "");
  const headers = headerLine.split(",").map((h) => h.trim());

  const colIdx = (name: string): number => {
    const idx = headers.indexOf(name);
    if (idx < 0) throw new Error(`Column "${name}" not found. Available: ${headers.join(", ")}`);
    return idx;
  };

  const idx = {
    typeCollateral: colIdx("TYPE-COLLATERAL"),
    collateral: colIdx("COLLATERAL"),
    party: colIdx("PARTY"),
    docId: colIdx("DOC-ID"),
    drDate: colIdx("DRDATE"),
    processingDate: colIdx("PROCESSING-DATE"),
    corrDate: colIdx("CORR-DATE"),
    corrId: colIdx("CORR-ID"),
    serialId: colIdx("SERIAL-ID"),
    docType: colIdx("DOC-TYPE"),
  };

  const rows: DocIndexRow[] = [];
  // Dedup: same collateral+docId+date+docType+serial is the same document
  const seen = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const cols = line.split(",");
    const collateralType = parseInt(cols[idx.typeCollateral]?.trim() || "0", 10);
    const collateralRaw = cols[idx.collateral]?.trim() || "";
    const docType = cols[idx.docType]?.trim() || "";

    if (!collateralRaw || !docType) continue;

    const partyName = cols[idx.party]?.trim() || null;
    const docId = cols[idx.docId]?.trim() || null;
    const serialId = cols[idx.serialId]?.trim() || null;
    const receiptDate = parseFaaDate(cols[idx.drDate] || "");

    // Dedup key
    const key = `${collateralRaw}|${docId || ""}|${receiptDate || ""}|${docType}|${serialId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Resolve tail number for aircraft collateral (type 1)
    let tailNumber: string | null = null;
    if (collateralType === 1 && collateralRaw) {
      tailNumber = collateralRaw.startsWith("N") ? collateralRaw : `N${collateralRaw}`;
    }

    rows.push({
      collateralType,
      collateralRaw,
      tailNumber,
      partyName: partyName || null,
      docId,
      receiptDate,
      processingDate: parseFaaDate(cols[idx.processingDate] || ""),
      correctionDate: parseFaaDate(cols[idx.corrDate] || ""),
      correctionId: cols[idx.corrId]?.trim() || null,
      serialId,
      docType,
    });
  }

  console.log(`[docindex] Parsed ${rows.length} unique documents (deduped from ${lines.length - 1} rows)`);
  return rows;
}

// ── Resolve input path ────────────────────────────────────────────────────

function resolveInputPath(): string {
  const args = process.argv.slice(2);

  // --zip /path/to/ReleasableAircraft.zip
  const zipIdx = args.indexOf("--zip");
  if (zipIdx >= 0 && args[zipIdx + 1]) {
    const zipPath = resolve(args[zipIdx + 1]!);
    console.log(`[docindex] Extracting DOCINDEX.txt from ${zipPath}`);
    mkdirSync(TEMP_DIR, { recursive: true });
    execSync(`unzip -o "${zipPath}" DOCINDEX.txt -d "${TEMP_DIR}"`, { stdio: "pipe" });
    return join(TEMP_DIR, "DOCINDEX.txt");
  }

  // Direct path
  if (args[0] && !args[0].startsWith("--")) {
    const filePath = resolve(args[0]);
    if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    return filePath;
  }

  // Default: use already-extracted file
  if (existsSync(DEFAULT_PATH)) return DEFAULT_PATH;

  throw new Error(
    `DOCINDEX.txt not found at ${DEFAULT_PATH}. ` +
    `Extract it: unzip ~/Downloads/ReleasableAircraft.zip DOCINDEX.txt -d data/faa_raw/`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────

function main(): void {
  const filePath = resolveInputPath();
  const docs = parseDocIndex(filePath);

  const db = getDb();
  runMigrations(db);

  const stats: IngestStats = {
    totalRows: docs.length,
    skippedDuplicates: 0,
    inserted: 0,
    aircraftDocs: 0,
    lienDocs: 0,
    matchedToFaa: 0,
    charterClassMatched: 0,
    byDocType: {},
    byCollateralType: {},
  };

  // Pre-load FAA aircraft for cross-reference
  const faaByTail = new Map<string, { aircraft_class: string | null; owner_name: string | null; serial_number: string | null }>();
  const faaBySerial = new Map<string, { tail_number: string; aircraft_class: string | null; owner_name: string | null }>();
  const faaRows = db.prepare(
    "SELECT tail_number, serial_number, aircraft_class, owner_name FROM faa_aircraft",
  ).all() as { tail_number: string; serial_number: string | null; aircraft_class: string | null; owner_name: string | null }[];

  for (const f of faaRows) {
    faaByTail.set(f.tail_number, { aircraft_class: f.aircraft_class, owner_name: f.owner_name, serial_number: f.serial_number });
    if (f.serial_number) {
      faaBySerial.set(f.serial_number.trim(), { tail_number: f.tail_number, aircraft_class: f.aircraft_class, owner_name: f.owner_name });
    }
  }
  console.log(`[docindex] Loaded ${faaByTail.size} aircraft, ${faaBySerial.size} serials for cross-reference`);

  // Insert
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO faa_docindex
      (tail_number, collateral_type, collateral_raw, party_name, doc_id,
       doc_type, receipt_date, processing_date, correction_date, correction_id,
       serial_id, faa_aircraft_match, aircraft_class, owner_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const ingest = db.transaction(() => {
    for (const doc of docs) {
      // Cross-reference with faa_aircraft
      let matched = false;
      let aircraftClass: string | null = null;
      let ownerName: string | null = null;

      if (doc.tailNumber) {
        const faa = faaByTail.get(doc.tailNumber);
        if (faa) {
          matched = true;
          aircraftClass = faa.aircraft_class;
          ownerName = faa.owner_name;
        }
      }

      // For engine/propeller docs, try matching serial to faa_aircraft.serial_number
      if (!matched && doc.serialId) {
        const faaSerial = faaBySerial.get(doc.serialId.trim());
        if (faaSerial) {
          matched = true;
          aircraftClass = faaSerial.aircraft_class;
          ownerName = faaSerial.owner_name;
          // Backfill tail number from serial match
          if (!doc.tailNumber) doc.tailNumber = faaSerial.tail_number;
        }
      }

      const result = insertStmt.run(
        doc.tailNumber,
        doc.collateralType,
        doc.collateralRaw,
        doc.partyName,
        doc.docId,
        doc.docType,
        doc.receiptDate,
        doc.processingDate,
        doc.correctionDate,
        doc.correctionId,
        doc.serialId,
        matched ? 1 : 0,
        aircraftClass,
        ownerName,
      );

      if (result.changes > 0) {
        stats.inserted++;
      } else {
        stats.skippedDuplicates++;
      }

      // Track stats
      if (doc.collateralType === 1) stats.aircraftDocs++;
      if (LIEN_DOC_TYPES.has(doc.docType)) stats.lienDocs++;
      if (matched) {
        stats.matchedToFaa++;
        if (aircraftClass) stats.charterClassMatched++;
      }
      stats.byDocType[doc.docType] = (stats.byDocType[doc.docType] ?? 0) + 1;
      stats.byCollateralType[doc.collateralType] = (stats.byCollateralType[doc.collateralType] ?? 0) + 1;
    }
  });

  console.log("[docindex] Ingesting...");
  ingest();

  // ── Report ──────────────────────────────────────────────────────────────
  console.log("\n═══ FAA Document Index Ingestion Report ═══");
  console.log(`Total unique documents:  ${stats.totalRows}`);
  console.log(`Inserted:               ${stats.inserted}`);
  console.log(`Skipped (duplicates):    ${stats.skippedDuplicates}`);
  console.log(`Aircraft documents:     ${stats.aircraftDocs}`);
  console.log(`Lien-relevant docs:     ${stats.lienDocs} (S/A + REL + REP + CSC + CRT)`);
  console.log(`Matched to faa_aircraft: ${stats.matchedToFaa}`);
  console.log(`Charter-class matched:  ${stats.charterClassMatched}`);

  console.log("\n── By Document Type ──");
  for (const [docType, count] of Object.entries(stats.byDocType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${docType.padEnd(4)} ${DOC_TYPE_LABELS[docType] ?? docType}: ${count}`);
  }

  console.log("\n── By Collateral Type ──");
  for (const [typeStr, count] of Object.entries(stats.byCollateralType).sort((a, b) => b[1] - a[1])) {
    const typeNum = parseInt(typeStr, 10);
    console.log(`  ${COLLATERAL_TYPE_LABELS[typeNum] ?? `Type ${typeStr}`}: ${count}`);
  }

  // Charter aircraft with active liens
  const charterLiens = db.prepare(`
    SELECT d.tail_number, d.doc_type, d.receipt_date, d.serial_id,
           d.aircraft_class, d.owner_name
    FROM faa_docindex d
    WHERE d.doc_type IN ('S/A', 'CSC', 'REP')
      AND d.aircraft_class IS NOT NULL
      AND d.collateral_type = 1
    ORDER BY d.receipt_date DESC
    LIMIT 25
  `).all() as { tail_number: string; doc_type: string; receipt_date: string; serial_id: string; aircraft_class: string; owner_name: string }[];

  if (charterLiens.length > 0) {
    console.log("\n── Recent Charter Aircraft Lien Activity ──");
    for (const r of charterLiens) {
      const label = DOC_TYPE_LABELS[r.doc_type] ?? r.doc_type;
      console.log(`  ${r.tail_number} (${r.aircraft_class}) ${r.receipt_date} — ${label} — ${r.owner_name ?? "N/A"} [S/N: ${r.serial_id}]`);
    }
  }

  // Lien vs release balance per charter aircraft
  const lienBalance = db.prepare(`
    SELECT tail_number, aircraft_class, owner_name,
           SUM(CASE WHEN doc_type IN ('S/A', 'CSC') THEN 1 ELSE 0 END) AS liens,
           SUM(CASE WHEN doc_type = 'REL' THEN 1 ELSE 0 END) AS releases,
           MAX(receipt_date) AS latest_activity
    FROM faa_docindex
    WHERE collateral_type = 1
      AND aircraft_class IS NOT NULL
      AND doc_type IN ('S/A', 'CSC', 'REL')
    GROUP BY tail_number
    HAVING liens > releases
    ORDER BY latest_activity DESC
    LIMIT 20
  `).all() as { tail_number: string; aircraft_class: string; owner_name: string; liens: number; releases: number; latest_activity: string }[];

  if (lienBalance.length > 0) {
    console.log("\n── Charter Aircraft with Unreleased Liens (liens > releases) ──");
    for (const r of lienBalance) {
      console.log(`  ${r.tail_number} (${r.aircraft_class}) — ${r.liens} liens, ${r.releases} releases — ${r.owner_name ?? "N/A"} — last: ${r.latest_activity}`);
    }
  }

  closeDb();
  console.log("\n[docindex] Done.");
}

main();
