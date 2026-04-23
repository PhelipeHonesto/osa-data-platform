/**
 * Verifies the Phase 1 Gold canonical schema files declare the expected
 * tables + columns. DB-less — parses the SQL files and asserts structure.
 * Catches regressions where a rename or column rename slips through.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CANONICAL_PATH = resolve(
  __dirname,
  "..",
  "schema",
  "gold",
  "canonical",
  "operators.sql",
);
const INFRA_PATH = resolve(
  __dirname,
  "..",
  "schema",
  "gold",
  "infra",
  "gold-view-refresh.sql",
);
const OPERATOR_TYPE_MIGRATION_PATH = resolve(
  __dirname,
  "..",
  "schema",
  "migrations",
  "2026-04-19-003-operators-operator-type.sql",
);

interface TableBlock {
  name: string;
  columns: string[];
}

function parseTableBlocks(sql: string): Map<string, TableBlock> {
  const out = new Map<string, TableBlock>();
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([\s\S]*?)\n\)\s*;/gi;
  for (const m of sql.matchAll(re)) {
    const name = m[1] ?? "";
    // Strip line comments before splitting — a comma inside a -- comment is
    // not a column separator.
    const body = (m[2] ?? "").replace(/--.*$/gm, "");
    const cols: string[] = [];
    let depth = 0;
    let cur = "";
    for (const c of body) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) {
        cols.push(cur.trim());
        cur = "";
        continue;
      }
      cur += c;
    }
    if (cur.trim()) cols.push(cur.trim());
    const columns: string[] = [];
    for (const raw of cols) {
      const t = raw.trim();
      if (!t) continue;
      const first = t.split(/\s+/)[0]?.toUpperCase() ?? "";
      if (["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"].includes(first)) continue;
      const colName = t.split(/\s+/)[0] ?? "";
      if (colName) columns.push(colName.toLowerCase());
    }
    out.set(name, { name, columns });
  }
  return out;
}

describe("gold canonical schema — operators.sql", () => {
  const sql = readFileSync(CANONICAL_PATH, "utf-8");
  const tables = parseTableBlocks(sql);

  it("declares the four Phase 1 canonical tables", () => {
    expect([...tables.keys()].sort()).toEqual([
      "operator_aliases",
      "operator_identities",
      "operator_match_review",
      "operators",
    ]);
  });

  it("operators has UUID id, type_tags, operator_type, both trust-score columns, timestamps, schema_version", () => {
    const cols = tables.get("operators")?.columns ?? [];
    expect(cols).toEqual([
      "id",
      "canonical_name",
      "type_tags",
      "operator_type",           // legal/operational discriminator (migration 2026-04-19-003)
      "headquarters_icao",
      "data_confidence_score",   // meta — how confident are we in the record (commit 4)
      "operator_trust_score",    // substantive — how trustworthy is the operator (commit 10)
      "first_seen_at",
      "last_updated_at",
      "schema_version",
    ]);
  });

  it("operators.operator_type is a nullable TEXT with the ten ER-plan enum values", () => {
    // Every enum member must appear in the CHECK list — keeps the declarative
    // body + migration file + semantic YAML in lockstep.
    for (const v of [
      "part_135","part_121","part_91k","foreign_aoc","broker",
      "billing_agent","financier","holding_co","defunct","trust_holder",
    ]) {
      expect(sql).toMatch(new RegExp(`'${v}'`));
    }
    // Column declaration must be plain TEXT with no NOT NULL and no DEFAULT —
    // most rows stay NULL until a later audit pass.
    expect(sql).toMatch(/\boperator_type\s+TEXT\s*\n?\s*CHECK/);
    expect(sql).not.toMatch(/operator_type\s+TEXT[^,]*NOT\s+NULL/i);
    expect(sql).not.toMatch(/operator_type\s+TEXT[^,]*DEFAULT/i);
  });

  it("operators rejects type_tags outside the approved taxonomy (sanity check on raw SQL)", () => {
    expect(sql).toMatch(/type_tags\s+TEXT\[\][^;]*'charter'[^;]*'fractional'/);
    expect(sql).toMatch(/'air_ambulance'/);
    expect(sql).toMatch(/'government'/);
  });

  it("operator_identities has FK to operators and UNIQUE(source, source_id)", () => {
    const cols = tables.get("operator_identities")?.columns ?? [];
    expect(cols).toContain("operator_id");
    expect(cols).toContain("source");
    expect(cols).toContain("source_id");
    expect(cols).toContain("match_confidence");
    expect(cols).toContain("match_method");
    expect(cols).toContain("match_evidence");
    expect(sql).toMatch(/UNIQUE\s*\(\s*source\s*,\s*source_id\s*\)/);
  });

  it("operator_aliases enforces alias_type taxonomy", () => {
    expect(sql).toMatch(/alias_type\s+TEXT\s+NOT\s+NULL[\s\S]*?'legal'[\s\S]*?'historical'/);
  });

  it("operator_match_review has status enum covering the CLI transitions", () => {
    const cols = tables.get("operator_match_review")?.columns ?? [];
    expect(cols).toContain("status");
    expect(cols).toContain("candidate_matches");
    expect(sql).toMatch(/status[\s\S]*?'pending'[\s\S]*?'matched'[\s\S]*?'new_operator'[\s\S]*?'skipped'/);
  });
});

describe("migration 2026-04-19-003 — operator_type", () => {
  const sql = readFileSync(OPERATOR_TYPE_MIGRATION_PATH, "utf-8");

  it("uses ADD COLUMN IF NOT EXISTS for idempotent re-runs", () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+operators\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+operator_type\s+TEXT/i);
  });

  it("uses CREATE INDEX IF NOT EXISTS for the supporting index", () => {
    expect(sql).toMatch(/CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_operators_type\s+ON\s+operators\s*\(\s*operator_type\s*\)/i);
  });

  it("declares all ten enum values in the CHECK list", () => {
    for (const v of [
      "part_135","part_121","part_91k","foreign_aoc","broker",
      "billing_agent","financier","holding_co","defunct","trust_holder",
    ]) {
      expect(sql).toMatch(new RegExp(`'${v}'`));
    }
  });

  it("explicitly allows NULL via IS NULL in the CHECK (nullable column)", () => {
    expect(sql).toMatch(/operator_type\s+IS\s+NULL\s+OR\s+operator_type\s+IN/i);
  });
});

describe("gold infra schema — gold-view-refresh.sql", () => {
  const sql = readFileSync(INFRA_PATH, "utf-8");
  const tables = parseTableBlocks(sql);

  it("declares gold_view_refresh_log with freshness-tracking columns", () => {
    const cols = tables.get("gold_view_refresh_log")?.columns ?? [];
    expect(cols).toEqual([
      "id",
      "view_name",
      "refreshed_at",
      "row_count",
      "duration_ms",
      "status",
      "error",
      "schema_version",
    ]);
  });

  it("has (view_name, refreshed_at DESC) index for latest-refresh lookups", () => {
    expect(sql).toMatch(/INDEX[\s\S]*?gold_view_refresh_log\s*\(\s*view_name\s*,\s*refreshed_at\s+DESC\s*\)/);
  });
});
