/**
 * Aircraft Listing Tracker — marketplace listing ingestion
 *
 * Accepts a JSON file of listing data, upserts by tail_number + source,
 * detects price reductions, delistings, and cross-references with FAA
 * registry changes to confirm sales.
 *
 * Usage:
 *   npm run ingest:listings -- /path/to/listings.json
 *
 * JSON format: Array of objects with fields:
 *   tail_number, source, listing_url, asking_price_cents, currency,
 *   aircraft_type, year, description
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "../db/database.js";

// ── Types ─────────────────────────────────────────────────────────────────

interface ListingInput {
  tail_number: string;
  source: string;
  listing_url?: string;
  asking_price_cents?: number;
  currency?: string;
  aircraft_type?: string;
  year?: number;
  description?: string;
}

// ── Main ──────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const jsonPath = args[0];
  if (!jsonPath) {
    console.error("Usage: npm run ingest:listings -- /path/to/listings.json");
    process.exit(1);
  }

  const filePath = resolve(jsonPath);
  console.log(`[listings] Reading ${filePath}...`);

  const raw = readFileSync(filePath, "utf-8");
  const listings: ListingInput[] = JSON.parse(raw);
  console.log(`[listings] Parsed ${listings.length} listings from input`);

  const db = getDb();
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  // Track stats
  let inserted = 0;
  let updated = 0;
  let priceReductions = 0;
  let delistedCount = 0;
  let confirmedSales = 0;

  // ── Prepared statements ──────────────────────────────────────────────

  const selectListing = db.prepare(
    `SELECT tail_number, source, asking_price_cents, price_history_json, status, first_seen_at
     FROM aircraft_listings WHERE tail_number = ? AND source = ?`,
  );

  const insertListing = db.prepare(
    `INSERT INTO aircraft_listings
       (tail_number, source, listing_url, asking_price_cents, currency,
        aircraft_type, year, description, first_seen_at, last_seen_at,
        price_history_json, status, days_on_market)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const updateListing = db.prepare(
    `UPDATE aircraft_listings
     SET listing_url = ?, asking_price_cents = ?, currency = ?,
         aircraft_type = ?, year = ?, description = ?,
         last_seen_at = ?, price_history_json = ?, status = ?, days_on_market = ?
     WHERE tail_number = ? AND source = ?`,
  );

  const markDelisted = db.prepare(
    `UPDATE aircraft_listings SET status = ?, last_seen_at = ? WHERE tail_number = ? AND source = ?`,
  );

  const getActiveListings = db.prepare(
    `SELECT tail_number, source FROM aircraft_listings WHERE status IN ('active', 'reduced')`,
  );

  const checkOwnershipChange = db.prepare(
    `SELECT COUNT(*) as cnt FROM faa_registry_changes
     WHERE tail_number = ? AND change_type = 'ownership_change'
       AND detected_at >= datetime(?, '-30 days')`,
  );

  // ── Upsert listings ─────────────────────────────────────────────────

  const seenKeys = new Set<string>();

  const upsertAll = db.transaction(() => {
    for (const l of listings) {
      const tail = l.tail_number?.trim().toUpperCase();
      const source = l.source?.trim().toLowerCase();
      if (!tail || !source) continue;

      const key = `${tail}|${source}`;
      seenKeys.add(key);

      const existing = selectListing.get(tail, source) as {
        tail_number: string;
        source: string;
        asking_price_cents: number | null;
        price_history_json: string;
        status: string;
        first_seen_at: string;
      } | undefined;

      const priceCents = l.asking_price_cents ?? null;
      const currency = l.currency ?? "USD";

      if (!existing) {
        // New listing
        const priceHistory = priceCents != null
          ? JSON.stringify([{ price_cents: priceCents, date: now }])
          : "[]";

        insertListing.run(
          tail, source, l.listing_url ?? null, priceCents, currency,
          l.aircraft_type ?? null, l.year ?? null, l.description ?? null,
          now, now, priceHistory, "active", 0,
        );
        inserted++;
      } else {
        // Existing listing — check for price reduction
        let priceHistory: Array<{ price_cents: number; date: string }>;
        try {
          priceHistory = JSON.parse(existing.price_history_json || "[]");
        } catch {
          priceHistory = [];
        }

        let status = existing.status === "delisted" ? "active" : existing.status;

        if (priceCents != null && existing.asking_price_cents != null && priceCents < existing.asking_price_cents) {
          priceHistory.push({ price_cents: priceCents, date: now });
          status = "reduced";
          priceReductions++;
        }

        // Days on market
        const firstSeen = new Date(existing.first_seen_at);
        const daysOnMarket = Math.floor((Date.now() - firstSeen.getTime()) / (1000 * 60 * 60 * 24));

        updateListing.run(
          l.listing_url ?? null, priceCents, currency,
          l.aircraft_type ?? null, l.year ?? null, l.description ?? null,
          now, JSON.stringify(priceHistory), status, daysOnMarket,
          tail, source,
        );
        updated++;
      }
    }

    // ── Detect delistings ────────────────────────────────────────────────

    const activeListings = getActiveListings.all() as Array<{ tail_number: string; source: string }>;

    for (const active of activeListings) {
      const key = `${active.tail_number}|${active.source}`;
      if (seenKeys.has(key)) continue;

      // Not in latest file → mark as delisted (or sold if ownership changed)
      let newStatus = "delisted";
      const ownerChange = checkOwnershipChange.get(active.tail_number, now) as { cnt: number } | undefined;
      if (ownerChange && ownerChange.cnt > 0) {
        newStatus = "sold";
        confirmedSales++;
      } else {
        delistedCount++;
      }

      markDelisted.run(newStatus, now, active.tail_number, active.source);
    }
  });

  upsertAll();

  // ── Summary ─────────────────────────────────────────────────────────

  const totals = db.prepare(
    `SELECT status, COUNT(*) as cnt FROM aircraft_listings GROUP BY status`,
  ).all() as Array<{ status: string; cnt: number }>;

  const totalMap: Record<string, number> = {};
  for (const t of totals) totalMap[t.status] = t.cnt;

  console.log(`\n═══ Listing Tracker Report ═══`);
  console.log(`New listings:       ${inserted}`);
  console.log(`Updated listings:   ${updated}`);
  console.log(`Price reductions:   ${priceReductions}`);
  console.log(`Delisted:           ${delistedCount}`);
  console.log(`Confirmed sales:    ${confirmedSales}`);
  console.log(`\n── Database Totals ──`);
  console.log(`  Active:   ${totalMap["active"] ?? 0}`);
  console.log(`  Reduced:  ${totalMap["reduced"] ?? 0}`);
  console.log(`  Delisted: ${totalMap["delisted"] ?? 0}`);
  console.log(`  Sold:     ${totalMap["sold"] ?? 0}`);

  closeDb();
  console.log(`\n[listings] Done.`);
}

main();
