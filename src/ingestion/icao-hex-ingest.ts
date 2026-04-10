/**
 * ICAO Hex Ingestion — maps icao24 hex codes to FAA tail numbers.
 *
 * Downloads the OpenSky aircraft database CSV and updates faa_aircraft
 * with the icao_hex column for US-registered aircraft (N-numbers).
 *
 * Run via: npm run ingest:icao
 */

import { getDb, closeDb } from "../memory/database.js";

const OPENSKY_DB_URL = "https://opensky-network.org/datasets/metadata/aircraftDatabase.csv";

async function main(): Promise<void> {
  console.log("[icao-hex] Downloading OpenSky aircraft database...");

  const resp = await fetch(OPENSKY_DB_URL, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    console.error(`[icao-hex] HTTP ${resp.status}: ${resp.statusText}`);
    process.exit(1);
  }

  const csv = await resp.text();
  const lines = csv.split("\n");
  const header = lines[0]!.split(",").map((h) => h.replace(/"/g, "").trim());

  // Find column indices
  const icaoIdx = header.indexOf("icao24");
  const regIdx = header.indexOf("registration");

  if (icaoIdx < 0 || regIdx < 0) {
    console.error("[icao-hex] Could not find icao24 or registration columns in CSV header");
    console.error("[icao-hex] Header:", header.join(", "));
    process.exit(1);
  }

  console.log(`[icao-hex] Parsed header: icao24@${icaoIdx}, registration@${regIdx}`);
  console.log(`[icao-hex] Processing ${lines.length - 1} rows...`);

  // Parse US aircraft (N-numbers)
  const mappings: { icao: string; tail: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    // Simple CSV parse — strip quotes from values
    const cols = line.split(",").map((c) => c.replace(/"/g, "").trim());
    const icao = cols[icaoIdx]?.toLowerCase();
    const reg = cols[regIdx]?.toUpperCase();

    if (!icao || !reg) continue;
    if (!reg.startsWith("N")) continue; // US aircraft only

    mappings.push({ icao, tail: reg });
  }

  console.log(`[icao-hex] Found ${mappings.length} US-registered aircraft in OpenSky database`);

  // Update faa_aircraft
  const db = getDb();
  const update = db.prepare("UPDATE faa_aircraft SET icao_hex = ? WHERE tail_number = ? AND (icao_hex IS NULL OR icao_hex != ?)");

  let updated = 0;
  const runBatch = db.transaction((batch: { icao: string; tail: string }[]) => {
    for (const { icao, tail } of batch) {
      const result = update.run(icao, tail, icao);
      if (result.changes > 0) updated++;
    }
  });

  // Process in chunks of 1000
  for (let i = 0; i < mappings.length; i += 1000) {
    runBatch(mappings.slice(i, i + 1000));
  }

  console.log(`[icao-hex] Updated ${updated} aircraft with ICAO hex codes`);

  // Verify
  const total = (db.prepare("SELECT COUNT(*) as cnt FROM faa_aircraft WHERE icao_hex IS NOT NULL").get() as { cnt: number }).cnt;
  console.log(`[icao-hex] Total aircraft with ICAO hex: ${total}`);

  closeDb();
}

main().catch((err) => {
  console.error("[icao-hex] Fatal:", err);
  process.exit(1);
});
