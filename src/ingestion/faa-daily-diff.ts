/**
 * FAA Registry Daily Diff — the "free AMSTAT"
 *
 * Compares the current FAA ReleasableAircraft MASTER.txt against
 * faa_aircraft in SQLite. Detects:
 *   - NEW registrations
 *   - DEREGISTERED aircraft (in DB but missing from fresh file)
 *   - OWNERSHIP CHANGES (same tail, different owner_name)
 *   - FIELD CHANGES (serial, model, status, etc.)
 *
 * Results are written to faa_registry_changes for historical tracking.
 *
 * Usage:
 *   npm run faa:diff                          # download from FAA
 *   npm run faa:diff -- /path/to/MASTER.txt   # use local file
 *   npm run faa:diff -- --zip /path/to/ReleasableAircraft.zip
 *
 * Run via: npm run faa:diff
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { getDb, closeDb } from "../memory/database.js";

// ── Constants ──────────────────────────────────────────────────────────────

const FAA_DOWNLOAD_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip";
const TEMP_DIR = resolve("./data/faa_raw");

// ── Types ──────────────────────────────────────────────────────────────────

interface MasterRow {
  tailNumber: string;
  serialNumber: string;
  mfrModelCode: string;
  yearManufactured: number | null;
  registrantType: string;
  ownerName: string;
  ownerCity: string;
  ownerState: string;
  certification: string;
  typeAircraft: string;
  typeEngine: string;
  statusCode: string;
  modeSCodeHex: string;
}

interface DbRow {
  tail_number: string;
  serial_number: string | null;
  mfr_model_code: string | null;
  year_manufactured: number | null;
  owner_name: string | null;
  owner_city: string | null;
  owner_state: string | null;
  registrant_type: string | null;
  certificate_number: string | null;
  status: string | null;
  icao_hex: string | null;
}

interface DiffStats {
  newRegistrations: number;
  deregistered: number;
  ownershipChanges: number;
  fieldChanges: number;
  unchanged: number;
  totalInFile: number;
  totalInDb: number;
}

// ── Parse MASTER.txt ──────────────────────────────────────────────────────

function parseMasterFile(filePath: string): Map<string, MasterRow> {
  console.log(`[faa-diff] Reading ${filePath}...`);
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  // Parse header — strip BOM if present
  const headerLine = lines[0]!.replace(/^\uFEFF/, "");
  const headers = headerLine.split(",").map((h) => h.trim());

  // Build column index from header (dynamic, not hardcoded)
  const colIdx = (name: string): number => {
    const idx = headers.indexOf(name);
    if (idx < 0) throw new Error(`Column "${name}" not found in MASTER.txt header. Available: ${headers.join(", ")}`);
    return idx;
  };

  const idx = {
    nNumber: colIdx("N-NUMBER"),
    serial: colIdx("SERIAL NUMBER"),
    mfrMdl: colIdx("MFR MDL CODE"),
    yearMfr: colIdx("YEAR MFR"),
    typeReg: colIdx("TYPE REGISTRANT"),
    name: colIdx("NAME"),
    city: colIdx("CITY"),
    state: colIdx("STATE"),
    certification: colIdx("CERTIFICATION"),
    typeAircraft: colIdx("TYPE AIRCRAFT"),
    typeEngine: colIdx("TYPE ENGINE"),
    statusCode: colIdx("STATUS CODE"),
    modeSHex: colIdx("MODE S CODE HEX"),
  };

  const aircraft = new Map<string, MasterRow>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const cols = line.split(",");
    const nNumber = cols[idx.nNumber]?.trim();
    if (!nNumber) continue;

    // FAA format: N-NUMBER field doesn't include the "N" prefix sometimes,
    // and may have trailing spaces. Normalize to "N" + trimmed number.
    const tailNumber = nNumber.startsWith("N") ? nNumber : `N${nNumber}`;

    const yearStr = cols[idx.yearMfr]?.trim();

    aircraft.set(tailNumber, {
      tailNumber,
      serialNumber: cols[idx.serial]?.trim() || "",
      mfrModelCode: cols[idx.mfrMdl]?.trim() || "",
      yearManufactured: yearStr && yearStr !== "0" ? parseInt(yearStr, 10) : null,
      registrantType: cols[idx.typeReg]?.trim() || "",
      ownerName: cols[idx.name]?.trim() || "",
      ownerCity: cols[idx.city]?.trim() || "",
      ownerState: cols[idx.state]?.trim() || "",
      certification: cols[idx.certification]?.trim() || "",
      typeAircraft: cols[idx.typeAircraft]?.trim() || "",
      typeEngine: cols[idx.typeEngine]?.trim() || "",
      statusCode: cols[idx.statusCode]?.trim() || "",
      modeSCodeHex: cols[idx.modeSHex]?.trim() || "",
    });
  }

  console.log(`[faa-diff] Parsed ${aircraft.size} aircraft from MASTER.txt`);
  return aircraft;
}

// ── Download FAA zip ──────────────────────────────────────────────────────

async function downloadAndExtract(): Promise<string> {
  mkdirSync(TEMP_DIR, { recursive: true });
  const zipPath = join(TEMP_DIR, "ReleasableAircraft.zip");

  console.log(`[faa-diff] Downloading from ${FAA_DOWNLOAD_URL}...`);
  const resp = await fetch(FAA_DOWNLOAD_URL, {
    signal: AbortSignal.timeout(120_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OSA-Dumont/1.0)",
    },
  });

  if (!resp.ok) {
    throw new Error(
      `FAA download failed: HTTP ${resp.status} ${resp.statusText}. ` +
      `Try downloading manually and passing the path: npm run faa:diff -- /path/to/MASTER.txt`,
    );
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(zipPath, buffer);
  console.log(`[faa-diff] Downloaded ${(buffer.length / 1_048_576).toFixed(1)} MB → ${zipPath}`);

  // Extract MASTER.txt using unzip CLI (available on macOS/Linux)
  execSync(`unzip -o "${zipPath}" MASTER.txt -d "${TEMP_DIR}"`, { stdio: "pipe" });
  const masterPath = join(TEMP_DIR, "MASTER.txt");
  if (!existsSync(masterPath)) {
    throw new Error(`MASTER.txt not found after extraction in ${TEMP_DIR}`);
  }

  console.log(`[faa-diff] Extracted MASTER.txt`);
  return masterPath;
}

// ── Resolve input path ────────────────────────────────────────────────────

async function resolveInputPath(): Promise<string> {
  const args = process.argv.slice(2);

  // --zip /path/to/ReleasableAircraft.zip
  const zipIdx = args.indexOf("--zip");
  if (zipIdx >= 0 && args[zipIdx + 1]) {
    const zipPath = resolve(args[zipIdx + 1]!);
    console.log(`[faa-diff] Extracting from local zip: ${zipPath}`);
    mkdirSync(TEMP_DIR, { recursive: true });
    execSync(`unzip -o "${zipPath}" MASTER.txt -d "${TEMP_DIR}"`, { stdio: "pipe" });
    return join(TEMP_DIR, "MASTER.txt");
  }

  // Direct MASTER.txt path
  if (args[0] && !args[0].startsWith("--")) {
    const filePath = resolve(args[0]);
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    return filePath;
  }

  // Default: download from FAA
  return downloadAndExtract();
}

// ── Run diff ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const masterPath = await resolveInputPath();
  const freshData = parseMasterFile(masterPath);

  const db = getDb();

  // Ensure migration 17 has run (faa_registry_changes table)
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='faa_registry_changes'",
  ).get();
  if (!tables) {
    console.log("[faa-diff] Running migration for faa_registry_changes...");
    db.exec(`
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
    `);
  }

  // Load existing DB state
  console.log("[faa-diff] Loading existing faa_aircraft...");
  const existingRows = db.prepare(`
    SELECT tail_number, serial_number, mfr_model_code, year_manufactured,
           owner_name, owner_city, owner_state, registrant_type,
           certificate_number, status, icao_hex
    FROM faa_aircraft
  `).all() as DbRow[];

  const existingMap = new Map<string, DbRow>();
  for (const row of existingRows) {
    existingMap.set(row.tail_number, row);
  }

  console.log(`[faa-diff] DB has ${existingMap.size} aircraft, file has ${freshData.size}`);

  // Prepare statements
  const insertChange = db.prepare(`
    INSERT INTO faa_registry_changes (tail_number, change_type, field_name, old_value, new_value)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertAircraft = db.prepare(`
    INSERT INTO faa_aircraft
      (tail_number, serial_number, mfr_model_code, year_manufactured,
       owner_name, owner_city, owner_state, registrant_type,
       certificate_number, status, icao_hex)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateAircraft = db.prepare(`
    UPDATE faa_aircraft SET
      serial_number = ?, mfr_model_code = ?, year_manufactured = ?,
      owner_name = ?, owner_city = ?, owner_state = ?,
      registrant_type = ?, certificate_number = ?, status = ?,
      icao_hex = COALESCE(?, icao_hex),
      updated_at = datetime('now')
    WHERE tail_number = ?
  `);

  const markDeregistered = db.prepare(`
    UPDATE faa_aircraft SET status = 'deregistered', updated_at = datetime('now')
    WHERE tail_number = ?
  `);

  const stats: DiffStats = {
    newRegistrations: 0,
    deregistered: 0,
    ownershipChanges: 0,
    fieldChanges: 0,
    unchanged: 0,
    totalInFile: freshData.size,
    totalInDb: existingMap.size,
  };

  // ── Diff: compare file vs DB ────────────────────────────────────────────
  const runDiff = db.transaction(() => {
    // 1. Check each aircraft in the fresh file
    for (const [tail, fresh] of freshData) {
      const existing = existingMap.get(tail);

      if (!existing) {
        // NEW registration
        insertAircraft.run(
          tail,
          fresh.serialNumber || null,
          fresh.mfrModelCode || null,
          fresh.yearManufactured,
          fresh.ownerName || null,
          fresh.ownerCity || null,
          fresh.ownerState || null,
          fresh.registrantType || null,
          fresh.certification || null,
          fresh.statusCode || "active",
          fresh.modeSCodeHex?.toLowerCase() || null,
        );
        insertChange.run(tail, "new", null, null, fresh.ownerName || null);
        stats.newRegistrations++;
        continue;
      }

      // Compare tracked fields
      let hasChanges = false;
      const fieldValues: [string, string | null, string | null][] = [
        ["owner_name", existing.owner_name, fresh.ownerName || null],
        ["owner_city", existing.owner_city, fresh.ownerCity || null],
        ["owner_state", existing.owner_state, fresh.ownerState || null],
        ["serial_number", existing.serial_number, fresh.serialNumber || null],
        ["mfr_model_code", existing.mfr_model_code, fresh.mfrModelCode || null],
        ["status", existing.status, fresh.statusCode || null],
        ["certificate_number", existing.certificate_number, fresh.certification || null],
        ["registrant_type", existing.registrant_type, fresh.registrantType || null],
      ];

      for (const [fieldName, oldVal, newVal] of fieldValues) {
        const oldNorm = (oldVal || "").trim().toUpperCase();
        const newNorm = (newVal || "").trim().toUpperCase();
        if (oldNorm === newNorm) continue;

        // Detect ownership change specifically
        const changeType = fieldName === "owner_name" ? "ownership_change" : "field_change";
        insertChange.run(tail, changeType, fieldName, oldVal, newVal);

        if (changeType === "ownership_change") {
          stats.ownershipChanges++;
        } else {
          stats.fieldChanges++;
        }
        hasChanges = true;
      }

      if (hasChanges) {
        // Update the DB row
        updateAircraft.run(
          fresh.serialNumber || null,
          fresh.mfrModelCode || null,
          fresh.yearManufactured,
          fresh.ownerName || null,
          fresh.ownerCity || null,
          fresh.ownerState || null,
          fresh.registrantType || null,
          fresh.certification || null,
          fresh.statusCode || "active",
          fresh.modeSCodeHex?.toLowerCase() || null,
          tail,
        );
      } else {
        stats.unchanged++;
      }
    }

    // 2. Check for deregistered aircraft (in DB but not in fresh file)
    for (const [tail, existing] of existingMap) {
      if (freshData.has(tail)) continue;
      if (existing.status === "deregistered") continue; // already marked

      markDeregistered.run(tail);
      insertChange.run(tail, "deregistered", "status", existing.status, "deregistered");
      stats.deregistered++;
    }
  });

  console.log("[faa-diff] Running diff...");
  runDiff();

  // ── Report ──────────────────────────────────────────────────────────────
  console.log("\n═══ FAA Registry Diff Report ═══");
  console.log(`File:                ${freshData.size.toLocaleString()} aircraft`);
  console.log(`Database (before):   ${existingMap.size.toLocaleString()} aircraft`);
  console.log(`───────────────────────────────`);
  console.log(`New registrations:   ${stats.newRegistrations.toLocaleString()}`);
  console.log(`Deregistered:        ${stats.deregistered.toLocaleString()}`);
  console.log(`Ownership changes:   ${stats.ownershipChanges.toLocaleString()}`);
  console.log(`Field changes:       ${stats.fieldChanges.toLocaleString()}`);
  console.log(`Unchanged:           ${stats.unchanged.toLocaleString()}`);

  // Show recent ownership changes (most interesting for transactions)
  const recentOwnership = db.prepare(`
    SELECT tail_number, old_value, new_value, detected_at
    FROM faa_registry_changes
    WHERE change_type = 'ownership_change'
    ORDER BY detected_at DESC
    LIMIT 10
  `).all() as { tail_number: string; old_value: string; new_value: string; detected_at: string }[];

  if (recentOwnership.length > 0) {
    console.log("\n── Recent Ownership Changes (Transaction Signals) ──");
    for (const r of recentOwnership) {
      console.log(`  ${r.tail_number}: ${r.old_value} → ${r.new_value}`);
    }
  }

  // Show new registrations
  const recentNew = db.prepare(`
    SELECT tail_number, new_value as owner
    FROM faa_registry_changes
    WHERE change_type = 'new'
    ORDER BY detected_at DESC
    LIMIT 10
  `).all() as { tail_number: string; owner: string }[];

  if (recentNew.length > 0) {
    console.log("\n── Recent New Registrations ──");
    for (const r of recentNew) {
      console.log(`  ${r.tail_number}: ${r.owner}`);
    }
  }

  closeDb();
  console.log("\n[faa-diff] Done.");
}

main().catch((err) => {
  console.error("[faa-diff] Fatal:", err);
  process.exit(1);
});
