/**
 * FAA Full Registry Ingest
 *
 * Downloads ReleasableAircraft.zip and ingests ALL files:
 *   MASTER.txt   → faa_aircraft (existing diff logic)
 *   DEREG.txt    → faa_deregistered (ownership timeline)
 *   ACFTREF.txt  → faa_aircraft_types (type reference)
 *   ENGINE.txt   → faa_engine_types (engine reference)
 *   DOCINDEX.txt → faa_docindex (liens, bills of sale)
 *
 * Usage:
 *   npm run ingest:faa-full -- --all
 *   npm run ingest:faa-full -- --file DEREG
 *   npm run ingest:faa-full -- --file ACFTREF
 *   npm run ingest:faa-full -- --skip-download --all
 */

import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg, type DbBridge } from "../memory/pg-database.js";
import { bulkUpsert } from "../memory/bulk-upsert.js";

// ── Constants ───────────────────────────────────────────────────────────────

const FAA_DOWNLOAD_URL = "https://registry.faa.gov/database/ReleasableAircraft.zip";
const TEMP_DIR = resolve("./data/faa_raw");
const BATCH_SIZE = 500;

// ── CLI ─────────────────────────────────────────────────────────────────────

interface CliArgs {
  file?: string;     // DEREG, ACFTREF, ENGINE, MASTER, DOCINDEX
  all: boolean;
  skipDownload: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { all: false, skipDownload: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && args[i + 1]) { result.file = args[i + 1]!.toUpperCase(); i++; }
    else if (args[i] === "--all") result.all = true;
    else if (args[i] === "--skip-download") result.skipDownload = true;
  }
  if (!result.file && !result.all) {
    console.error("Usage: npm run ingest:faa-full -- --all");
    console.error("       npm run ingest:faa-full -- --file DEREG");
    console.error("       npm run ingest:faa-full -- --skip-download --all");
    process.exit(1);
  }
  return result;
}

// ── Download & extract ──────────────────────────────────────────────────────

async function downloadZip(): Promise<void> {
  mkdirSync(TEMP_DIR, { recursive: true });
  const zipPath = join(TEMP_DIR, "ReleasableAircraft.zip");

  console.log(`[faa-full] Downloading ${FAA_DOWNLOAD_URL}...`);
  const resp = await fetch(FAA_DOWNLOAD_URL, {
    signal: AbortSignal.timeout(180_000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OSA-Dumont/1.0)" },
  });

  if (!resp.ok) {
    throw new Error(`FAA download failed: HTTP ${resp.status} ${resp.statusText}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(zipPath, buffer);
  console.log(`[faa-full] Downloaded ${(buffer.length / 1_048_576).toFixed(1)} MB`);

  // Extract all relevant files
  const files = ["MASTER.txt", "DEREG.txt", "ACFTREF.txt", "ENGINE.txt", "DOCINDEX.txt"];
  for (const f of files) {
    try {
      execSync(`unzip -o "${zipPath}" "${f}" -d "${TEMP_DIR}"`, { stdio: "pipe" });
      console.log(`[faa-full] Extracted ${f}`);
    } catch {
      console.warn(`[faa-full] ${f} not found in zip — skipping`);
    }
  }
}

// ── CSV streaming helper ────────────────────────────────────────────────────

async function streamCsv(
  filePath: string,
  callback: (headers: string[], cols: string[], lineNum: number) => void,
): Promise<number> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (lineNum === 1) {
      // Strip BOM and parse header
      headers = trimmed.replace(/^\uFEFF/, "").split(",").map((h) => h.trim());
      continue;
    }

    const cols = trimmed.split(",");
    callback(headers, cols, lineNum);
  }

  return lineNum - 1; // exclude header
}

function colIdx(headers: string[], name: string): number {
  const idx = headers.indexOf(name);
  if (idx < 0) throw new Error(`Column "${name}" not found. Available: ${headers.join(", ")}`);
  return idx;
}

function col(cols: string[], idx: number): string {
  return cols[idx]?.trim() ?? "";
}

function parseFaaDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 8) return null;
  const year = trimmed.substring(0, 4);
  const month = trimmed.substring(4, 6);
  const day = trimmed.substring(6, 8);
  if (year === "0000" || month === "00") return null;
  return `${year}-${month}-${day}`;
}

// ── DEREG.txt → faa_deregistered ────────────────────────────────────────────

const DEREG_COLS = [
  "tail_number", "serial_number", "manufacturer", "model", "common_name", "aircraft_class",
  "year_manufactured", "owner_name", "owner_city", "owner_state", "owner_country",
  "certificate_holder", "cancel_date", "last_action_date", "status", "mode_s_hex",
] as const;

async function ingestDereg(db: DbBridge): Promise<void> {
  const filePath = join(TEMP_DIR, "DEREG.txt");
  if (!existsSync(filePath)) { console.warn("[faa-full] DEREG.txt not found — skipping"); return; }

  console.log("[faa-full] Ingesting DEREG.txt → faa_deregistered...");

  // Clear existing data for idempotent re-runs
  await db.prepare("DELETE FROM faa_deregistered").run();

  let count = 0;
  let batch: unknown[][] = [];
  let headersParsed = false;
  let idx = {
    nNumber: 0, serial: 0, mfrMdl: 0, yearMfr: 0,
    name: 0, city: 0, state: 0, country: 0,
    certHolder: -1, cancelDate: -1, lastAction: -1,
    statusCode: 0, modeSHex: 0,
  };

  // We collect a batch during streaming, then flush each chunk via bulkUpsert.
  // Using onEntryPromise[] so node-readline's back-pressure waits for flushes.
  const pendingFlushes: Array<() => Promise<void>> = [];

  await streamCsv(filePath, (headers, cols, _lineNum) => {
    if (!headersParsed) {
      idx.nNumber = colIdx(headers, "N-NUMBER");
      idx.serial = colIdx(headers, "SERIAL NUMBER");
      idx.mfrMdl = colIdx(headers, "MFR MDL CODE");
      idx.yearMfr = colIdx(headers, "YEAR MFR");
      idx.name = colIdx(headers, "NAME");
      idx.city = colIdx(headers, "CITY");
      idx.state = colIdx(headers, "STATE");
      idx.country = headers.indexOf("COUNTRY") >= 0 ? colIdx(headers, "COUNTRY") : -1;
      idx.certHolder = headers.indexOf("CERT HOLDER") >= 0 ? colIdx(headers, "CERT HOLDER") : -1;
      idx.cancelDate = headers.indexOf("CANCEL DATE") >= 0 ? colIdx(headers, "CANCEL DATE") : -1;
      idx.lastAction = headers.indexOf("LAST ACTION DATE") >= 0 ? colIdx(headers, "LAST ACTION DATE") : -1;
      idx.statusCode = colIdx(headers, "STATUS CODE");
      idx.modeSHex = headers.indexOf("MODE S CODE HEX") >= 0 ? colIdx(headers, "MODE S CODE HEX") : -1;
      headersParsed = true;
    }

    const nNumber = col(cols, idx.nNumber);
    if (!nNumber) return;
    const tailNumber = nNumber.startsWith("N") ? nNumber : `N${nNumber}`;

    batch.push([
      tailNumber,
      col(cols, idx.serial) || null,
      null, // manufacturer — resolved via ACFTREF join later
      col(cols, idx.mfrMdl) || null,
      null, // common_name
      null, // aircraft_class
      col(cols, idx.yearMfr) || null,
      col(cols, idx.name) || null,
      col(cols, idx.city) || null,
      col(cols, idx.state) || null,
      idx.country >= 0 ? (col(cols, idx.country) || null) : null,
      idx.certHolder >= 0 ? (col(cols, idx.certHolder) || null) : null,
      idx.cancelDate >= 0 ? parseFaaDate(col(cols, idx.cancelDate)) : null,
      idx.lastAction >= 0 ? parseFaaDate(col(cols, idx.lastAction)) : null,
      col(cols, idx.statusCode) || null,
      idx.modeSHex >= 0 ? (col(cols, idx.modeSHex).toLowerCase() || null) : null,
    ]);

    count++;
    if (batch.length >= BATCH_SIZE) {
      const chunk = batch;
      batch = [];
      pendingFlushes.push(() => bulkUpsert(db, "faa_deregistered", [...DEREG_COLS], chunk, []));
    }

    if (count % 50_000 === 0) {
      console.log(`[faa-full] DEREG: ${count.toLocaleString()} rows...`);
    }
  });

  if (batch.length > 0) {
    const chunk = batch;
    pendingFlushes.push(() => bulkUpsert(db, "faa_deregistered", [...DEREG_COLS], chunk, []));
  }
  // Execute flushes serially to cap concurrent PG write pressure.
  for (const f of pendingFlushes) await f();
  console.log(`[faa-full] DEREG: ${count.toLocaleString()} rows ingested`);
}

// ── ACFTREF.txt → faa_aircraft_types ────────────────────────────────────────

const ACFTREF_COLS = [
  "model_code", "manufacturer", "model", "type_aircraft",
  "num_engines", "num_seats", "weight_class", "speed",
] as const;

async function ingestAcftRef(db: DbBridge): Promise<void> {
  const filePath = join(TEMP_DIR, "ACFTREF.txt");
  if (!existsSync(filePath)) { console.warn("[faa-full] ACFTREF.txt not found — skipping"); return; }

  console.log("[faa-full] Ingesting ACFTREF.txt → faa_aircraft_types...");

  let count = 0;
  let batch: unknown[][] = [];
  const pendingFlushes: Array<() => Promise<void>> = [];
  let headersParsed = false;
  let idx = { code: 0, mfr: 0, model: 0, typeAc: 0, numEng: 0, numSeats: 0, weight: 0, speed: 0 };

  await streamCsv(filePath, (headers, cols, _lineNum) => {
    if (!headersParsed) {
      idx.code = colIdx(headers, "CODE");
      idx.mfr = colIdx(headers, "MFR");
      idx.model = colIdx(headers, "MODEL");
      idx.typeAc = colIdx(headers, "TYPE-ACFT");
      idx.numEng = colIdx(headers, "NO-ENG");
      idx.numSeats = colIdx(headers, "NO-SEATS");
      idx.weight = colIdx(headers, "AC-WEIGHT");
      idx.speed = colIdx(headers, "SPEED");
      headersParsed = true;
    }

    const code = col(cols, idx.code);
    if (!code) return;

    const numEng = parseInt(col(cols, idx.numEng), 10);
    const numSeats = parseInt(col(cols, idx.numSeats), 10);
    batch.push([
      code,
      col(cols, idx.mfr) || null,
      col(cols, idx.model) || null,
      col(cols, idx.typeAc) || null,
      Number.isFinite(numEng) ? numEng : null,
      Number.isFinite(numSeats) ? numSeats : null,
      col(cols, idx.weight) || null,
      col(cols, idx.speed) || null,
    ]);

    count++;
    if (batch.length >= BATCH_SIZE) {
      const chunk = batch;
      batch = [];
      pendingFlushes.push(() => bulkUpsert(db, "faa_aircraft_types", [...ACFTREF_COLS], chunk, ["model_code"]));
    }
  });

  if (batch.length > 0) {
    const chunk = batch;
    pendingFlushes.push(() => bulkUpsert(db, "faa_aircraft_types", [...ACFTREF_COLS], chunk, ["model_code"]));
  }
  for (const f of pendingFlushes) await f();
  console.log(`[faa-full] ACFTREF: ${count.toLocaleString()} aircraft types ingested`);
}

// ── ENGINE.txt → faa_engine_types ───────────────────────────────────────────

const ENGINE_COLS = [
  "engine_code", "manufacturer", "model", "type_engine", "horsepower", "thrust",
] as const;

async function ingestEngine(db: DbBridge): Promise<void> {
  const filePath = join(TEMP_DIR, "ENGINE.txt");
  if (!existsSync(filePath)) { console.warn("[faa-full] ENGINE.txt not found — skipping"); return; }

  console.log("[faa-full] Ingesting ENGINE.txt → faa_engine_types...");

  let count = 0;
  let batch: unknown[][] = [];
  const pendingFlushes: Array<() => Promise<void>> = [];
  let headersParsed = false;
  let idx = { code: 0, mfr: 0, model: 0, typeEng: 0, hp: 0, thrust: 0 };

  await streamCsv(filePath, (headers, cols, _lineNum) => {
    if (!headersParsed) {
      idx.code = colIdx(headers, "CODE");
      idx.mfr = colIdx(headers, "MFR");
      idx.model = colIdx(headers, "MODEL");
      idx.typeEng = colIdx(headers, "TYPE");
      idx.hp = colIdx(headers, "HORSEPOWER");
      idx.thrust = colIdx(headers, "THRUST");
      headersParsed = true;
    }

    const code = col(cols, idx.code);
    if (!code) return;

    batch.push([
      code,
      col(cols, idx.mfr) || null,
      col(cols, idx.model) || null,
      col(cols, idx.typeEng) || null,
      col(cols, idx.hp) || null,
      col(cols, idx.thrust) || null,
    ]);

    count++;
    if (batch.length >= BATCH_SIZE) {
      const chunk = batch;
      batch = [];
      pendingFlushes.push(() => bulkUpsert(db, "faa_engine_types", [...ENGINE_COLS], chunk, ["engine_code"]));
    }
  });

  if (batch.length > 0) {
    const chunk = batch;
    pendingFlushes.push(() => bulkUpsert(db, "faa_engine_types", [...ENGINE_COLS], chunk, ["engine_code"]));
  }
  for (const f of pendingFlushes) await f();
  console.log(`[faa-full] ENGINE: ${count.toLocaleString()} engine types ingested`);
}

// ── MASTER.txt → faa_aircraft (reuse faa-daily-diff logic) ──────────────────

async function ingestMaster(): Promise<void> {
  const masterPath = join(TEMP_DIR, "MASTER.txt");
  if (!existsSync(masterPath)) { console.warn("[faa-full] MASTER.txt not found — skipping"); return; }

  console.log("[faa-full] Running FAA daily diff for MASTER.txt...");
  // Import and run the existing diff logic which handles MASTER.txt ingestion
  execSync(
    `npx tsx src/ingestion/faa-daily-diff.ts "${masterPath}"`,
    { stdio: "inherit", cwd: resolve("."), timeout: 300_000 },
  );
}

// ── DOCINDEX.txt → faa_docindex (reuse existing ingest) ─────────────────────

async function ingestDocindex(): Promise<void> {
  const docPath = join(TEMP_DIR, "DOCINDEX.txt");
  if (!existsSync(docPath)) { console.warn("[faa-full] DOCINDEX.txt not found — skipping"); return; }

  console.log("[faa-full] Running DOCINDEX ingest...");
  execSync(
    `npx tsx src/ingestion/faa-docindex-ingest.ts "${docPath}"`,
    { stdio: "inherit", cwd: resolve("."), timeout: 600_000 },
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "faa-full-ingest requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  const args = parseArgs();
  const t0 = Date.now();

  if (!args.skipDownload) {
    await downloadZip();
  } else {
    console.log("[faa-full] Using existing files in data/faa_raw/");
  }

  const shouldRun = (name: string) => args.all || args.file === name;

  if (shouldRun("MASTER")) await ingestMaster();
  if (shouldRun("DEREG")) await ingestDereg(db);
  if (shouldRun("ACFTREF")) await ingestAcftRef(db);
  if (shouldRun("ENGINE")) await ingestEngine(db);
  if (shouldRun("DOCINDEX")) await ingestDocindex();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[faa-full] All done in ${elapsed}s`);

  if (args.all || args.file === "DEREG") {
    const deregCount = ((await db.prepare("SELECT COUNT(*) as c FROM faa_deregistered").get()) as { c: number }).c;
    const uniqueTails = ((await db.prepare("SELECT COUNT(DISTINCT tail_number) as c FROM faa_deregistered").get()) as { c: number }).c;
    console.log(`  faa_deregistered: ${deregCount.toLocaleString()} rows (${uniqueTails.toLocaleString()} unique tails)`);
  }
  if (args.all || args.file === "ACFTREF") {
    const typeCount = ((await db.prepare("SELECT COUNT(*) as c FROM faa_aircraft_types").get()) as { c: number }).c;
    console.log(`  faa_aircraft_types: ${typeCount.toLocaleString()} types`);
  }
  if (args.all || args.file === "ENGINE") {
    const engCount = ((await db.prepare("SELECT COUNT(*) as c FROM faa_engine_types").get()) as { c: number }).c;
    console.log(`  faa_engine_types: ${engCount.toLocaleString()} engine types`);
  }

  await closePg();
}

main().catch((err) => {
  console.error("[faa-full] Fatal:", err);
  process.exit(1);
});
