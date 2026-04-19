/**
 * Tests for scripts/fix-canonical-name.ts.
 *
 * Pure checks run everywhere. The DB-backed integration test is gated
 * on SUPABASE_DATABASE_URL — it inserts a throwaway operator with a
 * typoed name, runs applyFix, verifies the canonical_name + historical
 * alias, then cleans up.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  parseArgs,
  validateArgs,
  normalizeAlias,
} from "../scripts/fix-canonical-name.js";
import { getPool } from "../src/memory/pg-database.js";

const hasPg = !!process.env["SUPABASE_DATABASE_URL"];
const describeIf = hasPg ? describe : describe.skip;

describe("parseArgs", () => {
  it("defaults aliasSource to 'faa_registry' and commit to false", () => {
    const a = parseArgs([]);
    expect(a).toEqual({ id: "", newName: "", aliasSource: "faa_registry", commit: false });
  });

  it("parses --id / --new-name / --alias-source / --commit", () => {
    const a = parseArgs([
      "--id", "op-uuid",
      "--new-name", "Premier Private Jets",
      "--alias-source", "manual_correction",
      "--commit",
    ]);
    expect(a).toEqual({
      id: "op-uuid",
      newName: "Premier Private Jets",
      aliasSource: "manual_correction",
      commit: true,
    });
  });

  it("is order-insensitive", () => {
    const a = parseArgs(["--commit", "--new-name", "X", "--id", "Y"]);
    expect(a.id).toBe("Y");
    expect(a.newName).toBe("X");
    expect(a.commit).toBe(true);
  });
});

describe("validateArgs", () => {
  it("flags missing --id", () => {
    expect(validateArgs({ id: "", newName: "X", aliasSource: "manual", commit: false }))
      .toMatch(/id/);
  });

  it("flags missing --new-name", () => {
    expect(validateArgs({ id: "u", newName: "", aliasSource: "manual", commit: false }))
      .toMatch(/new-name/);
  });

  it("flags whitespace-only --new-name", () => {
    expect(validateArgs({ id: "u", newName: "   ", aliasSource: "manual", commit: false }))
      .toMatch(/new-name/);
  });

  it("passes when id and new-name both set", () => {
    expect(validateArgs({ id: "u", newName: "X", aliasSource: "manual", commit: false }))
      .toBeNull();
  });
});

describe("normalizeAlias", () => {
  it("lowercases + trims + collapses whitespace", () => {
    expect(normalizeAlias("  Premiere   Private  Jets  ")).toBe("premiere private jets");
  });

  it("is idempotent", () => {
    const once = normalizeAlias("Premier Private Jets");
    expect(normalizeAlias(once)).toBe(once);
  });
});

// ── Integration: live canonical-name fix + historical alias insert ───────

describeIf("applyFix — live DB (gated on SUPABASE_DATABASE_URL)", () => {
  let client: pg.PoolClient;
  const testRunId = randomUUID().slice(0, 8);
  const opId = randomUUID();
  const typoedName = `fixname_test_Premiere_${testRunId}`;
  const correctedName = `fixname_test_Premier_${testRunId}`;

  beforeAll(async () => {
    client = await getPool().connect();
    await client.query(
      `INSERT INTO operators (id, canonical_name) VALUES ($1, $2)`,
      [opId, typoedName],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM operators WHERE id = $1`, [opId]).catch(() => undefined);
    client.release();
  });

  it("renames canonical_name and inserts the old value as a historical alias", async () => {
    const { applyFix } = await import("../scripts/fix-canonical-name.js");

    const existing = (await client.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM operators WHERE id = $1`,
      [opId],
    )).rows[0]!;

    const result = await applyFix(
      client,
      { id: opId, newName: correctedName, aliasSource: "faa_registry", commit: true },
      existing,
    );

    expect(result.old_name).toBe(typoedName);
    expect(result.new_name).toBe(correctedName);
    expect(result.alias_inserted).toBe(true);

    // canonical_name updated.
    const post = (await client.query<{ canonical_name: string }>(
      `SELECT canonical_name FROM operators WHERE id = $1`,
      [opId],
    )).rows[0]!;
    expect(post.canonical_name).toBe(correctedName);

    // Historical alias exists with the old name + faa_registry source.
    const alias = (await client.query<{
      alias: string;
      alias_normalized: string;
      alias_type: string;
      source: string;
    }>(
      `SELECT alias, alias_normalized, alias_type, source
         FROM operator_aliases
        WHERE operator_id = $1 AND alias_normalized = $2`,
      [opId, normalizeAlias(typoedName)],
    )).rows[0]!;
    expect(alias.alias).toBe(typoedName);
    expect(alias.alias_type).toBe("historical");
    expect(alias.source).toBe("faa_registry");
  });

  it("re-run is a no-op on the alias (ON CONFLICT DO NOTHING)", async () => {
    const { applyFix } = await import("../scripts/fix-canonical-name.js");

    // After the first run canonical_name is corrected; simulate a user
    // re-invoking fix-canonical-name on a row that's already fixed. The
    // UPDATE is a no-op on data but runs; the INSERT hits ON CONFLICT.
    const existing = (await client.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM operators WHERE id = $1`,
      [opId],
    )).rows[0]!;

    // Feed it the SAME old→new pair so the INSERT collides.
    const result = await applyFix(
      client,
      { id: opId, newName: correctedName, aliasSource: "faa_registry", commit: true },
      { id: opId, canonical_name: typoedName }, // pretend it was still old
    );

    expect(result.alias_already_existed).toBe(true);
    expect(result.alias_inserted).toBe(false);
  });
});
