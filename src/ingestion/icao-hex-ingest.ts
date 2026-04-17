/**
 * ICAO Hex Ingestion — maps icao24 hex codes to FAA tail numbers.
 *
 * Downloads the OpenSky aircraft database CSV and updates faa_aircraft
 * with the icao_hex column for US-registered aircraft (N-numbers).
 *
 * Run via: npm run ingest:icao
 */

import { getDatabase, setPgBridge } from "../memory/database.js";
import { getPgBridge, closePg, type DbBridge } from "../memory/pg-database.js";

const OPENSKY_DB_URL = "https://opensky-network.org/datasets/metadata/aircraftDatabase.csv";
const BATCH = 1000;

/** Bulk UPDATE icao_hex on existing faa_aircraft rows using a single
 *  `UPDATE ... FROM (VALUES …)` round-trip per batch. Skips no-op updates
 *  where the icao_hex already matches. */
async function bulkUpdateIcao(
  db: DbBridge,
  batch: { icao: string; tail: string }[],
): Promise<number> {
  if (batch.length === 0) return 0;
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 1;
  for (const { tail, icao } of batch) {
    placeholders.push(`($${p++}::text, $${p++}::text)`);
    params.push(tail, icao);
  }
  const sql =
    `UPDATE faa_aircraft SET icao_hex = t.icao, updated_at = NOW() ` +
    `FROM (VALUES ${placeholders.join(",")}) AS t(tail, icao) ` +
    `WHERE faa_aircraft.tail_number = t.tail ` +
    `  AND (faa_aircraft.icao_hex IS NULL OR faa_aircraft.icao_hex IS DISTINCT FROM t.icao)`;
  const result = await db.prepare(sql).run(...params) as { changes: number };
  return result.changes;
}

async function main(): Promise<void> {
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error(
      "icao-hex-ingest requires DATABASE_TYPE=postgres (SQLite path removed in Phase 6)",
    );
  }
  setPgBridge(getPgBridge());
  const db = getDatabase();

  console.log("[icao-hex] Downloading OpenSky aircraft database...");

  const resp = await fetch(OPENSKY_DB_URL, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    console.error(`[icao-hex] HTTP ${resp.status}: ${resp.statusText}`);
    process.exit(1);
  }

  const csv = await resp.text();
  const lines = csv.split("\n");
  const header = lines[0]!.split(",").map((h) => h.replace(/"/g, "").trim());

  const icaoIdx = header.indexOf("icao24");
  const regIdx = header.indexOf("registration");

  if (icaoIdx < 0 || regIdx < 0) {
    console.error("[icao-hex] Could not find icao24 or registration columns in CSV header");
    console.error("[icao-hex] Header:", header.join(", "));
    process.exit(1);
  }

  console.log(`[icao-hex] Parsed header: icao24@${icaoIdx}, registration@${regIdx}`);
  console.log(`[icao-hex] Processing ${lines.length - 1} rows...`);

  const mappings: { icao: string; tail: string }[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cols = line.split(",").map((c) => c.replace(/"/g, "").trim());
    const icao = cols[icaoIdx]?.toLowerCase();
    const reg = cols[regIdx]?.toUpperCase();
    if (!icao || !reg) continue;
    if (!reg.startsWith("N")) continue;
    mappings.push({ icao, tail: reg });
  }

  console.log(`[icao-hex] Found ${mappings.length} US-registered aircraft in OpenSky database`);

  let updated = 0;
  for (let i = 0; i < mappings.length; i += BATCH) {
    const chunk = mappings.slice(i, i + BATCH);
    updated += await bulkUpdateIcao(db, chunk);
    if ((i + BATCH) % 10_000 === 0 || i + BATCH >= mappings.length) {
      console.log(`[icao-hex] Processed ${Math.min(i + BATCH, mappings.length)}/${mappings.length}`);
    }
  }

  console.log(`[icao-hex] Updated ${updated} aircraft with ICAO hex codes`);

  const total = ((await db.prepare(
    "SELECT COUNT(*) as cnt FROM faa_aircraft WHERE icao_hex IS NOT NULL",
  ).get()) as { cnt: number }).cnt;
  console.log(`[icao-hex] Total aircraft with ICAO hex: ${total}`);

  await closePg();
}

main().catch((err) => {
  console.error("[icao-hex] Fatal:", err);
  process.exit(1);
});
