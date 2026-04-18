/**
 * Unit tests for the pure helpers in scripts/refresh-safety-ratings.ts.
 * DB-touching functions (upsertMergedRows, syncToFaaOperators) run against
 * the real Supabase bridge and aren't unit-tested here — they're exercised
 * by the CLI's --dry-run / live runs.
 */

import { describe, it, expect } from "vitest";
import {
  shouldSkipRefresh,
  mergeScrapedRows,
  computeSeedDiff,
  attemptCertMatch,
} from "../scripts/refresh-safety-ratings.js";

// ── 25-day guard ──────────────────────────────────────────────────────────

describe("shouldSkipRefresh", () => {
  const now = new Date("2026-05-01T00:00:00Z");

  it("runs when there is no prior scrape", () => {
    expect(shouldSkipRefresh(null, now, false)).toBe(false);
  });

  it("skips when the last scrape was 10 days ago", () => {
    const last = new Date("2026-04-21T00:00:00Z");
    expect(shouldSkipRefresh(last, now, false)).toBe(true);
  });

  it("skips when the last scrape was exactly 24 days ago", () => {
    const last = new Date("2026-04-07T00:00:00Z");
    expect(shouldSkipRefresh(last, now, false)).toBe(true);
  });

  it("runs when the last scrape was 26 days ago", () => {
    const last = new Date("2026-04-05T00:00:00Z");
    expect(shouldSkipRefresh(last, now, false)).toBe(false);
  });

  it("honours --force even when the guard would skip", () => {
    const last = new Date("2026-04-30T00:00:00Z");
    expect(shouldSkipRefresh(last, now, true)).toBe(false);
  });
});

// ── Row merge across sources ──────────────────────────────────────────────

describe("mergeScrapedRows", () => {
  const now = "2026-04-18T12:00:00Z";

  it("emits one row per unique normalized name across three sources", () => {
    const rows = mergeScrapedRows(
      [{ operator_name: "NetJets Aviation", argus_rating: "platinum", source_url: "a" }],
      [{ operator_name: "NetJets Aviation", certificate_number: "EJA", wyvern_status: "wingman", wyvern_country: "United States", source_url: "w" }],
      [],
      now,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.argus_rating).toBe("platinum");
    expect(rows[0]?.wyvern_status).toBe("wingman");
  });

  it("ARGUS-only operator has null wyvern fields", () => {
    const rows = mergeScrapedRows(
      [{ operator_name: "Foo Air", argus_rating: "gold", source_url: "a" }],
      [],
      [],
      now,
    );
    expect(rows[0]?.wyvern_status).toBeNull();
    expect(rows[0]?.argus_last_seen_at).toBe(now);
    expect(rows[0]?.wyvern_last_seen_at).toBeNull();
  });

  it("wingman wins over registered when same operator appears on both", () => {
    const rows = mergeScrapedRows(
      [],
      [{ operator_name: "Bar Jet", certificate_number: "X", wyvern_status: "wingman", wyvern_country: null, source_url: "w" }],
      [{ operator_name: "Bar Jet", certificate_number: "X", wyvern_status: "registered", wyvern_country: null, source_url: "r" }],
      now,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.wyvern_status).toBe("wingman");
  });

  it("records all present source_urls on a merged row", () => {
    const rows = mergeScrapedRows(
      [{ operator_name: "Baz Aero", argus_rating: "gold_plus", source_url: "argus-url" }],
      [{ operator_name: "Baz Aero", certificate_number: null, wyvern_status: "wingman", wyvern_country: "Canada", source_url: "wingman-url" }],
      [],
      now,
    );
    expect(rows[0]?.source_urls).toEqual({ argus: "argus-url", wyvern_wingman: "wingman-url" });
  });

  it("preserves certificate_number from whichever source supplies it", () => {
    const rows = mergeScrapedRows(
      [{ operator_name: "CertOp", argus_rating: "platinum", source_url: "a" }],
      [{ operator_name: "CertOp", certificate_number: "ABC123", wyvern_status: "wingman", wyvern_country: null, source_url: "w" }],
      [],
      now,
    );
    expect(rows[0]?.certificate_number).toBe("ABC123");
  });
});

// ── Seed diff ─────────────────────────────────────────────────────────────

describe("computeSeedDiff", () => {
  const row = (name: string) => ({
    operator_name: name,
    operator_name_normalized: name.toUpperCase().replace(/\b(LLC|INC|AVIATION)\b/g, "").replace(/\s+/g, " ").trim(),
    argus_rating: null,
    argus_last_seen_at: null,
    wyvern_status: null,
    wyvern_country: null,
    wyvern_last_seen_at: null,
    certificate_number: null,
    source_urls: {},
  });

  it("categorises seed-only, scrape-only, and matched by normalized name", () => {
    const seed = [{ operator_name: "NetJets Aviation" }, { operator_name: "Stale Operator LLC" }];
    const scraped = [row("NetJets Aviation"), row("New Operator Inc")];
    const diff = computeSeedDiff(seed, scraped);
    expect(diff.matched).toContain("NetJets Aviation");
    expect(diff.seedOnly).toContain("Stale Operator LLC");
    expect(diff.scrapeOnly).toContain("New Operator Inc");
  });
});

// ── Cert match ────────────────────────────────────────────────────────────

describe("attemptCertMatch", () => {
  const ops = [
    { certificate_number: "A1", name: "NetJets Aviation Inc" },
    { certificate_number: "B2", name: "Flexjet LLC" },
    { certificate_number: "C3", name: "NetJets Sales Inc" },
  ];

  it("returns cert for a clear single-match", () => {
    expect(attemptCertMatch("Flexjet", ops)).toBe("B2");
  });

  it("returns null when the name is ambiguous (multiple matches)", () => {
    // "NetJets" fuzzy-matches both NetJets Aviation and NetJets Sales.
    expect(attemptCertMatch("NetJets", ops)).toBeNull();
  });

  it("returns null for no match", () => {
    expect(attemptCertMatch("Wholly Unknown Operator", ops)).toBeNull();
  });
});
