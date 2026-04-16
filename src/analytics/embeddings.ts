/**
 * Route similarity via feature vectors (pgvector).
 *
 * Builds a 9-dimensional feature vector per route pair using geometry + stats:
 *   [lat_origin, lon_origin, lat_dest, lon_dest, distance_nm_norm,
 *    avg_flight_time_norm, log_total_flights, heavy_pct, peak_month_norm]
 *
 * No LLM API calls — pure numeric features give semantic similarity.
 *
 * CLI: npm run embeddings:build
 * API: GET /api/routes/:origin/:destination/similar
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const { Pool } = pg;

// ── Load .env ───────────────────────────────────────────────────────────────
try {
  const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
  for (const line of envContent.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    if (!process.env[t.slice(0, eq).trim()]) process.env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
} catch { /* no .env */ }

// ── Create route_vectors table ──────────────────────────────────────────────

async function ensureTable(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS route_vectors (
      origin_icao TEXT NOT NULL,
      destination_icao TEXT NOT NULL,
      embedding vector(9),
      metadata JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (origin_icao, destination_icao)
    );
    CREATE INDEX IF NOT EXISTS idx_rv_embedding ON route_vectors USING ivfflat (embedding vector_l2_ops) WITH (lists = 50);
  `).catch(() => {
    // IVFFlat index may fail if < 50 rows — create after data load
  });
}

// ── Build feature vectors ───────────────────────────────────────────────────

interface RouteRow {
  origin_icao: string;
  destination_icao: string;
  total_flights: number;
  avg_flight_time_min: number;
  avg_distance_nm: number;
  heavy_pct: number;
  peak_month: number;
  origin_lat: number;
  origin_lon: number;
  dest_lat: number;
  dest_lon: number;
}

async function buildVectors(pool: pg.Pool): Promise<number> {
  console.log("[embeddings] Querying route statistics...");

  // Get all route pairs with 10+ flights + airport coordinates
  const result = await pool.query(`
    SELECT
      l.origin_icao, l.destination_icao,
      COUNT(*) as total_flights,
      ROUND(AVG(l.flight_time_min)::numeric, 1) as avg_flight_time_min,
      ROUND(AVG(l.distance_nm)::numeric, 1) as avg_distance_nm,
      ROUND(
        (SUM(CASE WHEN l.aircraft_class = 'heavy' THEN 1 ELSE 0 END)::numeric
         / GREATEST(COUNT(*), 1)) * 100, 1
      ) as heavy_pct,
      MODE() WITHIN GROUP (ORDER BY EXTRACT(MONTH FROM l.departure_time::timestamp)::integer) as peak_month,
      o.latitude as origin_lat, o.longitude as origin_lon,
      d.latitude as dest_lat, d.longitude as dest_lon
    FROM adsb_completed_legs l
    JOIN faa_airports o ON l.origin_icao = o.icao_code
    JOIN faa_airports d ON l.destination_icao = d.icao_code
    WHERE l.origin_icao IS NOT NULL AND l.destination_icao IS NOT NULL
    GROUP BY l.origin_icao, l.destination_icao, o.latitude, o.longitude, d.latitude, d.longitude
    HAVING COUNT(*) >= 10
    ORDER BY total_flights DESC
  `);

  const routes = result.rows as RouteRow[];
  console.log(`[embeddings] Found ${routes.length} routes with 10+ flights`);

  if (routes.length === 0) return 0;

  // Compute normalization bounds
  const maxDist = Math.max(...routes.map((r) => r.avg_distance_nm || 1));
  const maxTime = Math.max(...routes.map((r) => r.avg_flight_time_min || 1));
  const maxFlights = Math.max(...routes.map((r) => r.total_flights));

  // Clear and rebuild
  await pool.query("DELETE FROM route_vectors");

  let count = 0;
  for (const r of routes) {
    // Normalize features to [0, 1] range
    const vec = [
      (r.origin_lat + 90) / 180,              // lat origin normalized
      (r.origin_lon + 180) / 360,              // lon origin normalized
      (r.dest_lat + 90) / 180,                 // lat dest normalized
      (r.dest_lon + 180) / 360,                // lon dest normalized
      (r.avg_distance_nm || 0) / maxDist,      // distance normalized
      (r.avg_flight_time_min || 0) / maxTime,  // flight time normalized
      Math.log1p(r.total_flights) / Math.log1p(maxFlights), // log flights normalized
      (r.heavy_pct || 0) / 100,                // heavy percentage
      (r.peak_month || 6) / 12,                // peak month normalized
    ];

    const metadata = {
      total_flights: r.total_flights,
      avg_flight_time_min: r.avg_flight_time_min,
      avg_distance_nm: r.avg_distance_nm,
      heavy_pct: r.heavy_pct,
      peak_month: r.peak_month,
    };

    await pool.query(
      `INSERT INTO route_vectors (origin_icao, destination_icao, embedding, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (origin_icao, destination_icao) DO UPDATE SET
         embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata, updated_at = NOW()`,
      [r.origin_icao, r.destination_icao, `[${vec.join(",")}]`, JSON.stringify(metadata)],
    );
    count++;

    if (count % 500 === 0) {
      console.log(`[embeddings] ${count}/${routes.length} routes...`);
    }
  }

  // Try creating IVFFlat index now that we have data
  if (count >= 50) {
    try {
      await pool.query("DROP INDEX IF EXISTS idx_rv_embedding");
      await pool.query(`
        CREATE INDEX idx_rv_embedding ON route_vectors
        USING ivfflat (embedding vector_l2_ops) WITH (lists = ${Math.min(Math.floor(count / 10), 100)})
      `);
      console.log("[embeddings] IVFFlat index created");
    } catch (err) {
      console.warn("[embeddings] IVFFlat index failed (using seq scan):", (err as Error).message);
    }
  }

  console.log(`[embeddings] ${count} route vectors stored`);
  return count;
}

// ── Similarity search ───────────────────────────────────────────────────────

export async function findSimilarRoutes(
  pool: pg.Pool,
  origin: string,
  dest: string,
  limit = 5,
): Promise<Array<Record<string, unknown>>> {
  // Get the query route's vector
  const ref = await pool.query(
    `SELECT embedding FROM route_vectors WHERE origin_icao = $1 AND destination_icao = $2`,
    [origin, dest],
  );

  if (ref.rows.length === 0) {
    return []; // Route not in vectors table
  }

  const embedding = ref.rows[0]!.embedding;

  // Find nearest neighbors (exclude self)
  const result = await pool.query(
    `SELECT origin_icao, destination_icao, metadata,
            embedding <-> $1 as distance
     FROM route_vectors
     WHERE NOT (origin_icao = $2 AND destination_icao = $3)
     ORDER BY embedding <-> $1
     LIMIT $4`,
    [embedding, origin, dest, limit],
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    origin: r.origin_icao,
    destination: r.destination_icao,
    distance: Math.round((r.distance as number) * 1000) / 1000,
    ...(r.metadata as Record<string, unknown>),
  }));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const connStr = process.env.SUPABASE_DATABASE_URL;
  if (!connStr) {
    console.error("[embeddings] SUPABASE_DATABASE_URL not set");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: connStr,
    max: 5,
    ssl: { rejectUnauthorized: false },
  });

  const t0 = Date.now();
  await ensureTable(pool);
  const count = await buildVectors(pool);

  // Test similarity
  if (count > 0) {
    console.log("\n[embeddings] Sample: routes similar to KTEB→KPBI:");
    const similar = await findSimilarRoutes(pool, "KTEB", "KPBI", 5);
    for (const s of similar) {
      console.log(`  ${s.origin}→${s.destination}: dist=${s.distance}, flights=${s.total_flights}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[embeddings] Done in ${elapsed}s`);
  await pool.end();
}

const isDirectRun = process.argv[1]?.includes("embeddings");
if (isDirectRun) {
  main().catch((err) => {
    console.error("[embeddings] Fatal:", err);
    process.exit(1);
  });
}
