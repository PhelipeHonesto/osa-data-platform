/**
 * Tests for scripts/dedup-operator-rows.ts.
 *
 * Pure-helper checks run everywhere. The transactional FK-migration
 * integration test runs only when SUPABASE_DATABASE_URL is set — it
 * inserts throwaway rows under a 'dedup_test_' name prefix, exercises
 * dedupTransaction end-to-end, and cleans up after itself whether or
 * not the assertions succeed.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  parseArgs,
  validateArgs,
  pickSurvivor,
  type OperatorSnapshot,
} from "../scripts/dedup-operator-rows.js";
import { getPool } from "../src/db/pg-database.js";

const hasPg = !!process.env["SUPABASE_DATABASE_URL"];
const describeIf = hasPg ? describe : describe.skip;

describe("parseArgs", () => {
  it("requires --keep and --merge args (both default empty)", () => {
    const a = parseArgs([]);
    expect(a.keep).toBe("");
    expect(a.merge).toBe("");
    expect(a.commit).toBe(false);
    expect(a.nameMatch).toBeNull();
  });

  it("parses --keep / --merge / --name-match / --commit", () => {
    const a = parseArgs([
      "--keep", "keep-uuid",
      "--merge", "merge-uuid",
      "--name-match", "A-Ok",
      "--commit",
    ]);
    expect(a).toEqual({
      keep: "keep-uuid",
      merge: "merge-uuid",
      nameMatch: "A-Ok",
      commit: true,
    });
  });

  it("is order-insensitive", () => {
    const a = parseArgs(["--commit", "--merge", "m", "--keep", "k"]);
    expect(a.keep).toBe("k");
    expect(a.merge).toBe("m");
    expect(a.commit).toBe(true);
  });
});

describe("validateArgs", () => {
  it("flags missing --keep", () => {
    expect(validateArgs({ keep: "", merge: "m", nameMatch: null, commit: false })).toMatch(/keep/);
  });

  it("flags missing --merge", () => {
    expect(validateArgs({ keep: "k", merge: "", nameMatch: null, commit: false })).toMatch(/merge/);
  });

  it("flags identical keep and merge", () => {
    expect(validateArgs({ keep: "same", merge: "same", nameMatch: null, commit: false }))
      .toMatch(/differ/);
  });

  it("passes when both provided and distinct", () => {
    expect(validateArgs({ keep: "k", merge: "m", nameMatch: null, commit: false })).toBeNull();
  });
});

describe("pickSurvivor — tiebreaker heuristic", () => {
  const mk = (over: Partial<OperatorSnapshot>): OperatorSnapshot => ({
    id: randomUUID(),
    canonical_name: "Test Operator",
    operator_type: null,
    first_seen_at: "2026-04-19T00:00:00.000Z",
    identity_count: 1,
    alias_count: 0,
    ...over,
  });

  it("older first_seen_at wins (rule 1)", () => {
    const older = mk({ first_seen_at: "2026-04-10T00:00:00.000Z" });
    const newer = mk({ first_seen_at: "2026-04-19T00:00:00.000Z" });
    const r = pickSurvivor(newer, older);
    expect(r?.keep.id).toBe(older.id);
    expect(r?.merge.id).toBe(newer.id);
  });

  it("higher identity_count wins when first_seen_at ties (rule 2)", () => {
    const fewer = mk({ identity_count: 1, first_seen_at: "2026-04-19T00:00:00.000Z" });
    const more  = mk({ identity_count: 3, first_seen_at: "2026-04-19T00:00:00.000Z" });
    const r = pickSurvivor(fewer, more);
    expect(r?.keep.id).toBe(more.id);
    expect(r?.merge.id).toBe(fewer.id);
  });

  it("returns null when both first_seen_at AND identity_count tie (rule 3 — human pick)", () => {
    // Mirrors the A-Ok Jets case: same batch-second create, identity_count=1 each.
    const a = mk({ identity_count: 1, first_seen_at: "2026-04-19T05:03:13.170608Z" });
    const b = mk({ identity_count: 1, first_seen_at: "2026-04-19T05:03:13.170608Z" });
    expect(pickSurvivor(a, b)).toBeNull();
  });

  it("does not treat identity_count tie as a winner when first_seen_at differs", () => {
    const older = mk({ first_seen_at: "2026-04-10T00:00:00.000Z", identity_count: 5 });
    const newer = mk({ first_seen_at: "2026-04-19T00:00:00.000Z", identity_count: 5 });
    const r = pickSurvivor(newer, older);
    expect(r?.keep.id).toBe(older.id); // time wins before count
  });
});

// ── Integration: real FK migration against Supabase ──────────────────────

describeIf("dedupTransaction — live FK migration (gated on SUPABASE_DATABASE_URL)", () => {
  let client: pg.PoolClient;
  const testRunId = randomUUID().slice(0, 8);
  const keepId = randomUUID();
  const mergeId = randomUUID();
  const keepName = `dedup_test_keep_${testRunId}`;
  const mergeName = `dedup_test_merge_${testRunId}`;
  // Throwaway canonical entities for FK targets. Set in beforeAll, used in
  // the canonical-schema seeds and the afterAll cleanup.
  let testAircraftId: string;
  let testCertId: string;
  const testRunTag = `dedup_test_${testRunId}`;

  beforeAll(async () => {
    client = await getPool().connect();
    // Seed two operators. Deliberately asymmetric on every metadata column
    // so the metadata-preservation invariant is falsifiable: if the dedup
    // ever starts merging fields, the keep row's headquarters_icao /
    // type_tags / operator_type will change and the assertions below fail.
    await client.query(
      `INSERT INTO operators (id, canonical_name, headquarters_icao, type_tags, operator_type)
         VALUES ($1, $2, 'KORD', ARRAY['charter']::TEXT[], 'part_135'),
                ($3, $4, 'KTEB', ARRAY['fractional']::TEXT[], 'part_91k')`,
      [keepId, keepName, mergeId, mergeName],
    );
    await client.query(
      `INSERT INTO operator_identities
         (operator_id, source, source_id, name_as_provided, match_confidence, match_method)
       VALUES
         ($1, 'argus',  $2, $3, 'exact', 'self_creation'),
         ($4, 'wyvern', $5, $6, 'exact', 'self_creation')`,
      [keepId, `dedup_test_${testRunId}_a`, keepName,
       mergeId, `dedup_test_${testRunId}_w`, mergeName],
    );
    await client.query(
      `INSERT INTO operator_aliases
         (operator_id, alias, alias_normalized, alias_type, source)
       VALUES ($1, $2, $3, 'dba', 'manual')`,
      [mergeId, `${mergeName} DBA`, `${mergeName.toLowerCase()} dba`],
    );
    await client.query(
      `INSERT INTO operator_match_review
         (scraped_name, scraped_source, scraped_payload, status, resolution_operator_id)
       VALUES ($1, 'manual', '{}'::jsonb, 'matched', $2)`,
      [mergeName, mergeId],
    );

    // Seed canonical-schema FK targets so the canonical UPDATE pass has
    // something to repoint. Aircraft + cert are bare-minimum rows (only
    // PK, defaults). The three operator-side rows point at MERGE so the
    // assertion can verify they're moved to KEEP after dedup.
    const aircraftRes = await client.query<{ aircraft_id: string }>(
      `INSERT INTO canonical.aircraft DEFAULT VALUES RETURNING aircraft_id`,
    );
    testAircraftId = aircraftRes.rows[0]!.aircraft_id;

    const certRes = await client.query<{ cert_id: string }>(
      `INSERT INTO canonical.certificates DEFAULT VALUES RETURNING cert_id`,
    );
    testCertId = certRes.rows[0]!.cert_id;

    await client.query(
      `INSERT INTO canonical.operator_holds_certificate
         (operator_id, cert_id, role, valid_from, source)
       VALUES ($1, $2, 'holder_of_record', '2026-01-01'::DATE, $3)`,
      [mergeId, testCertId, testRunTag],
    );
    await client.query(
      `INSERT INTO canonical.operator_aircraft_link
         (operator_id, aircraft_id, role, valid_from, source)
       VALUES ($1, $2, 'operator', '2026-01-01'::DATE, $3)`,
      [mergeId, testAircraftId, testRunTag],
    );
    await client.query(
      `INSERT INTO canonical.operator_aircraft_resolution_log
         (aircraft_id, resolver_action, operator_id, backfill_run_id)
       VALUES ($1, 'matched', $2, $3)`,
      [testAircraftId, mergeId, testRunTag],
    );
  });

  afterAll(async () => {
    // Order matters: canonical FK children → operator_match_review → operators.
    // ohc and oal are ON DELETE RESTRICT, so the operators DELETE will fail
    // unless we drop the canonical rows first. resolution_log is ON DELETE
    // SET NULL but we delete it explicitly for cleanliness.
    await client.query(
      `DELETE FROM canonical.operator_aircraft_resolution_log
        WHERE backfill_run_id = $1`,
      [testRunTag],
    ).catch(() => undefined);
    await client.query(
      `DELETE FROM canonical.operator_aircraft_link
        WHERE operator_id = ANY($1::UUID[])`,
      [[keepId, mergeId]],
    ).catch(() => undefined);
    await client.query(
      `DELETE FROM canonical.operator_holds_certificate
        WHERE operator_id = ANY($1::UUID[])`,
      [[keepId, mergeId]],
    ).catch(() => undefined);
    await client.query(
      `DELETE FROM canonical.aircraft WHERE aircraft_id = $1`,
      [testAircraftId],
    ).catch(() => undefined);
    await client.query(
      `DELETE FROM canonical.certificates WHERE cert_id = $1`,
      [testCertId],
    ).catch(() => undefined);
    await client.query(
      `DELETE FROM operator_match_review
        WHERE scraped_name IN ($1, $2)`,
      [keepName, mergeName],
    ).catch(() => undefined);
    await client.query(
      `DELETE FROM operators WHERE id = ANY($1::UUID[])`,
      [[keepId, mergeId]],
    ).catch(() => undefined);
    client.release();
  });

  it("re-points every FK to the keep row and deletes the merge row", async () => {
    const { dedupTransaction } = await import("../scripts/dedup-operator-rows.js");
    const counts = await dedupTransaction(client, {
      keep: keepId,
      merge: mergeId,
      nameMatch: null,
      commit: true,
    });

    expect(counts.aliases_repointed).toBe(1);
    expect(counts.identities_repointed).toBe(1);
    expect(counts.review_rows_repointed).toBe(1);
    expect(counts.ohc_repointed).toBe(1);
    expect(counts.oal_repointed).toBe(1);
    expect(counts.resolution_log_repointed).toBe(1);
    expect(counts.merge_row_deleted).toBe(true);

    // After dedup, all FKs point at keep.
    const aliasRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM operator_aliases WHERE operator_id = $1`,
      [keepId],
    );
    expect(Number(aliasRes.rows[0]?.c)).toBe(1);

    const identityRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM operator_identities WHERE operator_id = $1`,
      [keepId],
    );
    expect(Number(identityRes.rows[0]?.c)).toBe(2); // keep's own + merge's moved-in

    const reviewRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM operator_match_review WHERE resolution_operator_id = $1`,
      [keepId],
    );
    expect(Number(reviewRes.rows[0]?.c)).toBe(1);

    const ohcRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM canonical.operator_holds_certificate
         WHERE operator_id = $1 AND source = $2`,
      [keepId, testRunTag],
    );
    expect(Number(ohcRes.rows[0]?.c)).toBe(1);

    const oalRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM canonical.operator_aircraft_link
         WHERE operator_id = $1 AND source = $2`,
      [keepId, testRunTag],
    );
    expect(Number(oalRes.rows[0]?.c)).toBe(1);

    const resLogRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM canonical.operator_aircraft_resolution_log
         WHERE operator_id = $1 AND backfill_run_id = $2`,
      [keepId, testRunTag],
    );
    expect(Number(resLogRes.rows[0]?.c)).toBe(1);

    // Merge row is gone.
    const mergeRes = await client.query<{ c: string }>(
      `SELECT COUNT(*)::TEXT AS c FROM operators WHERE id = $1`,
      [mergeId],
    );
    expect(Number(mergeRes.rows[0]?.c)).toBe(0);

    // No leftover rows pointing at the merged-out id in any of the three
    // canonical tables (catches a regression where the UPDATE silently
    // missed a row).
    const orphanRes = await client.query<{
      ohc: string; oal: string; reslog: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::TEXT FROM canonical.operator_holds_certificate       WHERE operator_id = $1) AS ohc,
         (SELECT COUNT(*)::TEXT FROM canonical.operator_aircraft_link           WHERE operator_id = $1) AS oal,
         (SELECT COUNT(*)::TEXT FROM canonical.operator_aircraft_resolution_log WHERE operator_id = $1) AS reslog`,
      [mergeId],
    );
    expect(Number(orphanRes.rows[0]?.ohc)).toBe(0);
    expect(Number(orphanRes.rows[0]?.oal)).toBe(0);
    expect(Number(orphanRes.rows[0]?.reslog)).toBe(0);
  });

  it("preserves the survivor's metadata — no field merge from the duplicate row", async () => {
    // Survivor was seeded with KORD / charter / part_135. Merge row had
    // KTEB / fractional / part_91k. After the prior dedup step, the
    // survivor's own metadata must be untouched; only its FK footprint
    // grew. This is the invariant called out in dedupTransaction's
    // docstring — dedups move children, they do not merge fields.
    const meta = await client.query<{
      canonical_name: string;
      headquarters_icao: string;
      type_tags: string[];
      operator_type: string;
    }>(
      `SELECT canonical_name, headquarters_icao, type_tags, operator_type
         FROM operators
        WHERE id = $1`,
      [keepId],
    );
    const row = meta.rows[0];
    expect(row?.canonical_name).toBe(keepName);
    expect(row?.headquarters_icao).toBe("KORD");
    expect(row?.type_tags).toEqual(["charter"]);
    expect(row?.operator_type).toBe("part_135");
  });
});
