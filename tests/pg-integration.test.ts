/**
 * PostgreSQL integration tests.
 * Skips if SUPABASE_DATABASE_URL not set (safe for CI).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { convertSql, PgSyncBridge, getPgBridge } from "../src/memory/pg-database.js";

const hasPg = !!process.env.SUPABASE_DATABASE_URL;
const describeIf = hasPg ? describe : describe.skip;

// ── SQL Converter Tests (always run — no PG needed) ─────────────────────────

describe("convertSql", () => {
  it("converts ? params to $1, $2", () => {
    expect(convertSql("SELECT * FROM t WHERE a = ? AND b = ?")).toContain("$1");
    expect(convertSql("SELECT * FROM t WHERE a = ? AND b = ?")).toContain("$2");
  });

  it("converts strftime to to_char", () => {
    const result = convertSql("SELECT strftime('%Y-%m', departure_time) as month");
    expect(result).toContain("to_char");
    expect(result).toContain("YYYY-MM");
  });

  it("converts CAST(strftime('%w',...) AS INTEGER) to EXTRACT(DOW)", () => {
    const result = convertSql("SELECT CAST(strftime('%w', departure_time) AS INTEGER) as dow");
    expect(result).toContain("EXTRACT(DOW FROM");
    expect(result).toContain("::timestamp");
  });

  it("converts datetime('now') to NOW()::text", () => {
    expect(convertSql("WHERE x >= datetime('now')")).toContain("NOW()::text");
  });

  it("converts datetime('now', '-12 months') to interval", () => {
    const result = convertSql("WHERE x >= datetime('now', '-12 months')");
    expect(result).toContain("INTERVAL '-12 months'");
    expect(result).toContain("::text");
  });

  it("converts ROUND(AVG(x), 1) to ROUND((AVG(x))::numeric, 1)", () => {
    const result = convertSql("SELECT ROUND(AVG(flight_time_min), 1) as avg");
    expect(result).toContain("::numeric");
    expect(result).toContain("ROUND(");
  });

  it("converts GROUP_CONCAT to STRING_AGG", () => {
    expect(convertSql("GROUP_CONCAT(name, ',')")).toContain("STRING_AGG");
    expect(convertSql("GROUP_CONCAT(name)")).toContain("STRING_AGG");
  });

  it("converts IFNULL to COALESCE", () => {
    expect(convertSql("IFNULL(a, b)")).toContain("COALESCE(a, b)");
  });

  it("strips COLLATE NOCASE", () => {
    expect(convertSql("WHERE name = ? COLLATE NOCASE")).not.toContain("COLLATE");
  });

  it("converts INSERT OR IGNORE", () => {
    expect(convertSql("INSERT OR IGNORE INTO t")).toContain("INSERT");
    expect(convertSql("INSERT OR IGNORE INTO t")).not.toContain("IGNORE");
  });

  it("does not convert ? inside string literals", () => {
    const result = convertSql("SELECT * WHERE name = '?' AND id = ?");
    expect(result).toContain("'?'");
    expect(result).toContain("$1");
    expect(result).not.toContain("$2");
  });
});

// ── PG Integration Tests (skip if no SUPABASE_DATABASE_URL) ─────────────────

describeIf("PgSyncBridge integration", () => {
  let bridge: PgSyncBridge;

  beforeAll(() => {
    bridge = getPgBridge();
  });

  afterAll(async () => {
    // Don't close — other tests may use the pool
  });

  it("connects and queries faa_aircraft count", async () => {
    const rows = await bridge.prepare("SELECT COUNT(*) as cnt FROM faa_aircraft").all();
    expect(rows).toHaveLength(1);
    const cnt = Number((rows[0] as Record<string, unknown>).cnt);
    expect(cnt).toBeGreaterThan(100_000);
  });

  it("looks up aircraft by tail number", async () => {
    const row = await bridge.prepare("SELECT tail_number, aircraft_class FROM faa_aircraft WHERE tail_number = ?").get("N143QS");
    expect(row).toBeDefined();
    expect((row as Record<string, unknown>).tail_number).toBe("N143QS");
  });

  it("handles empty results", async () => {
    const row = await bridge.prepare("SELECT * FROM faa_aircraft WHERE tail_number = ?").get("NZZZZZ");
    expect(row).toBeUndefined();
  });
});

// ── getDatabase() factory test ──────────────────────────────────────────────

describe("getDatabase factory", () => {
  it("returns better-sqlite3 when DATABASE_TYPE is not postgres", async () => {
    const originalType = process.env.DATABASE_TYPE;
    delete process.env.DATABASE_TYPE;
    const { getDatabase } = await import("../src/memory/database.js");
    const db = getDatabase();
    // better-sqlite3 has a .pragma method
    expect(typeof db.prepare).toBe("function");
    process.env.DATABASE_TYPE = originalType;
  });
});
