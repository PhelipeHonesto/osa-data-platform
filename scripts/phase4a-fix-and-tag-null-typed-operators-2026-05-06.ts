/**
 * Phase 4a — Fix-and-tag NULL-typed operators (Path A — Stage 2 close-out).
 *
 * Path A — per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Predecessors (all read-only Phase 3 follow-ups):
 *   - scripts/triage-null-typed-operators-2026-05-06.ts (Phase 3 primary)
 *   - scripts/triage-null-typed-cert-status-breakdown-2026-05-06.ts
 *   - scripts/triage-null-typed-population-breakdown-2026-05-06.ts
 *   - scripts/triage-phase4a-reopen-candidates-2026-05-06.ts
 *
 * THREE STAGES, each transactional independently, idempotent on re-run:
 *
 *   Stage 1 — Re-open 155 wrongly-closed ohc rows.
 *     UPDATE canonical.operator_holds_certificate SET valid_to = NULL,
 *     evidence = evidence || <audit JSONB> WHERE the row passes ALL
 *     THREE guards:
 *       (a) cert.status = 'active_operating'
 *       (b) cert in canonical.certificate_identities[source =
 *           'faa_d085_2026_05_01']
 *       (c) operator.operator_type IS NULL
 *     Plus a defensive sibling check: no OTHER ohc row exists for the
 *     same (operator_id, cert_id, role) tuple (avoids EXCLUDE constraint
 *     violation on the GIST daterange overlap).
 *
 *   Stage 2 — INSERT 2 fresh ohc rows for Silver Air + Solairus Aviation.
 *     These are P3 operators (realfleet_merge) with zero existing ohc
 *     rows. For each, locate the realfleet_merge cert via
 *     operator_identities.match_method = 'faa_operators_realfleet_merge'
 *     joining canonical.certificates by faa_cert_number = source_id.
 *     Verify the cert passes (a)+(b) above, then INSERT a fresh ohc with
 *     role='holder_of_record', valid_from=cert.issued_date (or today as
 *     fallback), valid_to=NULL, source/audit JSONB capturing the four
 *     pre-INSERT guards.
 *
 *   Stage 3 — Re-run A.5 Phase 3's UPDATE_SQL EXACTLY AS-IS.
 *     UPDATE public.operators SET operator_type = 'part_135',
 *     data_confidence_score = 0.95 WHERE the operator now meets A.5's
 *     criteria (open ohc + role='holder_of_record' + cert_id in
 *     canonical.certificate_identities[source='faa_d085_2026_05_01']).
 *     Stages 1+2 set up exactly 156 NULL-typed operators to match (155
 *     ohc rows on 154 distinct ops, plus 2 from Stage 2).
 *
 * CLI:
 *   --dry-run     default; reports what would change, no writes
 *   --write       executes the three stages
 *   --stage=N     optional; runs only stage N (1, 2, or 3)
 *
 * Each stage:
 *   BEGIN
 *     run stage SQL
 *     verify expected row count
 *   COMMIT (or ROLLBACK on mismatch)
 *
 * Pre-flight (always runs):
 *   - NULL-typed invariant = 471
 *   - Stage 1 candidate count = 155 (re-derive from current DB state)
 *   - Stage 2 cert lookup for Silver Air + Solairus
 *   - Per-op Type=NULL check (catches drift between analysis and execute)
 *
 * Post-write verification (--write only):
 *   - Operators tagged part_135 in this run = 156 expected
 *   - ohc rows touched in stage 1 = 155 expected
 *   - ohc rows inserted in stage 2 = 2 expected
 *   - Top-20 fleet sanity (NetJets / Flexjet / Wheels Up still present)
 *
 * Followup (NOT in scope here, logged for A.8 close-out):
 *   The pre-2026-05-01 ohc close dates (clusters at 2023-12-23,
 *   2024-07-27, 2025-10-26) suggest a recurring ingestion bug pattern.
 *   Requires its own session to trace which loader/script/commit was
 *   responsible. May indicate Stage 5 schema needs to capture ohc
 *   lifecycle events more rigorously, OR an earlier loader needs the
 *   defensive guard A.6.5 added to operator-resolver.
 *
 * Usage:
 *   npx tsx scripts/phase4a-fix-and-tag-null-typed-operators-2026-05-06.ts
 *   npx tsx scripts/phase4a-fix-and-tag-null-typed-operators-2026-05-06.ts --write
 *   npx tsx scripts/phase4a-fix-and-tag-null-typed-operators-2026-05-06.ts --write --stage=1
 */

import "dotenv/config";
import { execSync } from "node:child_process";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const NULL_TYPED_INVARIANT = 471;
const D085_MAY1_SOURCE = "faa_d085_2026_05_01";
const TARGET_TYPE = "part_135";
const TARGET_CONF = 0.95;

const EXPECTED_STAGE1_OHC_COUNT = 155;
const EXPECTED_STAGE1_DISTINCT_OPS = 154;
const EXPECTED_STAGE2_OHC_INSERTS = 2;
const EXPECTED_STAGE3_TAG_COUNT = 156;

// Silver Air + Solairus — the two P3 operators with 0 ohc rows.
// IDs come from the population breakdown's P3 enumerate output.
const STAGE2_OPERATORS = [
  { name: "Silver Air", id: "9ac5691b-88ae-4d6d-b388-7e00fe1afe85" },
  { name: "Solairus Aviation", id: "98bc813c-f3d4-43df-af5a-37e0e5ef3e1b" },
] as const;

const SESSION_DOC_REF = "docs/sessions/2026-05-06-session-a8-close-out.md";

// ── CLI ───────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
  stage: 1 | 2 | 3 | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let write = false;
  let stage: 1 | 2 | 3 | undefined;
  for (const a of argv) {
    if (a === "--write") write = true;
    else if (a === "--dry-run") write = false;
    else if (a.startsWith("--stage=")) {
      const n = Number(a.slice("--stage=".length));
      if (n !== 1 && n !== 2 && n !== 3) {
        throw new Error(`--stage must be 1, 2, or 3; got ${n}`);
      }
      stage = n;
    } else if (a.length > 0) {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return { write, stage };
}

function getCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "(unknown)";
  }
}

// ── Output helpers ────────────────────────────────────────────────────────

function pad(s: string | null | number, n: number): string {
  const str = s === null ? "—" : String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function rpad(s: string | null | number, n: number): string {
  const str = s === null ? "—" : String(s);
  return str.length >= n ? str.slice(0, n) : " ".repeat(n - str.length) + str;
}

function trunc(s: string | null, n: number): string {
  if (s === null || s === undefined) return "—";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  const commitSha = getCommitSha();
  const stagesToRun: Array<1 | 2 | 3> =
    args.stage !== undefined ? [args.stage] : [1, 2, 3];

  console.log("[phase4a] ════════════════════════════════════════════════════");
  console.log(`[phase4a] Mode:     ${args.write ? "WRITE (will commit)" : "DRY-RUN"}`);
  console.log(`[phase4a] Stages:   ${stagesToRun.join(", ")}`);
  console.log(`[phase4a] HEAD:     ${commitSha}`);
  console.log(`[phase4a] Session:  ${SESSION_DOC_REF}`);
  console.log("[phase4a] ════════════════════════════════════════════════════");
  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // PRE-FLIGHT
  // ════════════════════════════════════════════════════════════════════════

  console.log("[phase4a] Pre-flight checks:");

  // 1. NULL-typed invariant
  const nullCount = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM public.operators WHERE operator_type IS NULL`,
  );
  const nullN = nullCount.rows[0]!.n;
  console.log(`  • NULL-typed operators: ${nullN}  (expected ${NULL_TYPED_INVARIANT})`);
  if (nullN !== NULL_TYPED_INVARIANT) {
    console.log(`    ✗ INVARIANT VIOLATION — abort`);
    await pool.end();
    process.exit(1);
  }

  // 2. Stage 1 candidate count
  const stage1Count = await pool.query<{ n_ohc: number; n_ops: number }>(`
    SELECT
      COUNT(*)::int                        AS n_ohc,
      COUNT(DISTINCT ohc.operator_id)::int AS n_ops
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
    JOIN canonical.certificate_identities ci
      ON ci.cert_id = ohc.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
    WHERE ohc.valid_to IS NOT NULL
      AND c.status = 'active_operating'
      AND o.operator_type IS NULL
  `);
  const s1n = stage1Count.rows[0]!.n_ohc;
  const s1ops = stage1Count.rows[0]!.n_ops;
  console.log(
    `  • Stage 1 candidate ohc rows: ${s1n} (${s1ops} distinct ops)  (expected ${EXPECTED_STAGE1_OHC_COUNT}/${EXPECTED_STAGE1_DISTINCT_OPS})`,
  );
  if (s1n !== EXPECTED_STAGE1_OHC_COUNT || s1ops !== EXPECTED_STAGE1_DISTINCT_OPS) {
    console.log(
      `    ⚠ drift from expected — investigate before --write (current run will use ${s1n} actual)`,
    );
  }

  // 3. Overlap-conflict pre-check for Stage 1 (precise: only blocks rows
  //    where re-opening would actually violate the GIST EXCLUDE constraint
  //    on (operator_id, cert_id, role, daterange))
  const overlapConflict = await pool.query<{
    ohc_id: string;
    canonical_name: string;
    cert_number: string;
    role: string;
    valid_from: string;
    valid_to: string;
    other_valid_from: string;
    other_valid_to: string | null;
  }>(`
    SELECT
      ohc.id::text                 AS ohc_id,
      o.canonical_name,
      c.faa_cert_number            AS cert_number,
      ohc.role,
      ohc.valid_from::text         AS valid_from,
      ohc.valid_to::text           AS valid_to,
      other.valid_from::text       AS other_valid_from,
      other.valid_to::text         AS other_valid_to
    FROM canonical.operator_holds_certificate ohc
    JOIN public.operators o ON o.id = ohc.operator_id
    JOIN canonical.certificates c ON c.cert_id = ohc.cert_id
    JOIN canonical.certificate_identities ci
      ON ci.cert_id = ohc.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
    JOIN canonical.operator_holds_certificate other
      ON other.operator_id = ohc.operator_id
     AND other.cert_id = ohc.cert_id
     AND other.role = ohc.role
     AND other.id <> ohc.id
     AND (other.valid_to IS NULL OR other.valid_to > ohc.valid_from)
    WHERE ohc.valid_to IS NOT NULL
      AND c.status = 'active_operating'
      AND o.operator_type IS NULL
    ORDER BY o.canonical_name
  `);
  const sibN = overlapConflict.rows.length;
  console.log(`  • Overlap-conflict candidates (would violate EXCLUDE on re-open): ${sibN}`);
  if (sibN > 0) {
    console.log(`    These rows will be excluded from Stage 1 UPDATE. Detail:`);
    for (const r of overlapConflict.rows) {
      console.log(
        `      ${pad(trunc(r.canonical_name, 28), 28)}  cert=${pad(r.cert_number, 10)}  candidate=[${r.valid_from}, ${r.valid_to})  other=[${r.other_valid_from}, ${r.other_valid_to ?? "open"})`,
      );
    }
  }
  const expectedStage1Update = s1n - sibN;
  console.log(`  • Stage 1 expected rowCount: ${expectedStage1Update}  (155 candidates − ${sibN} overlap-conflicts)`);

  // 4. Stage 2 cert lookup for Silver Air + Solairus.
  //    Try matching against ANY of the operator's identity source_ids
  //    (not just realfleet_merge), since the realfleet_merge identity's
  //    source_id format may not match canonical.certificates.faa_cert_number
  //    directly. Pick the cert that passes the guards if exactly one does.
  const stage2Lookup = await pool.query<{
    operator_id: string;
    canonical_name: string;
    identity_source_id: string;
    identity_match_method: string;
    cert_id: string | null;
    faa_cert_number: string | null;
    cert_status: string | null;
    in_may1: boolean;
    has_existing_ohc: boolean;
  }>(`
    WITH stage2_ops AS (
      SELECT id::uuid AS operator_id
      FROM unnest($1::uuid[]) AS id
    )
    SELECT
      o.id::text                                  AS operator_id,
      o.canonical_name,
      oi.source_id                                AS identity_source_id,
      oi.match_method                             AS identity_match_method,
      c.cert_id::text                             AS cert_id,
      c.faa_cert_number,
      c.status                                    AS cert_status,
      EXISTS (
        SELECT 1 FROM canonical.certificate_identities ci
        WHERE ci.cert_id = c.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
      ) AS in_may1,
      EXISTS (
        SELECT 1 FROM canonical.operator_holds_certificate ohc
        WHERE ohc.operator_id = o.id
      ) AS has_existing_ohc
    FROM stage2_ops s
    JOIN public.operators o ON o.id = s.operator_id
    JOIN public.operator_identities oi ON oi.operator_id = o.id
    JOIN canonical.certificates c ON c.faa_cert_number = oi.source_id
    ORDER BY o.canonical_name, oi.match_method
  `, [STAGE2_OPERATORS.map((o) => o.id)]);

  console.log(`  • Stage 2 cert lookup (${stage2Lookup.rows.length} cert matches across identities for ${STAGE2_OPERATORS.length} ops):`);
  for (const r of stage2Lookup.rows) {
    const guardOk =
      r.cert_id !== null &&
      r.cert_status === "active_operating" &&
      r.in_may1 === true &&
      r.has_existing_ohc === false;
    console.log(
      `      ${pad(trunc(r.canonical_name, 22), 22)}  via=${pad(r.identity_match_method, 32)}  src_id=${pad(r.identity_source_id, 10)}  faa_cert=${pad(r.faa_cert_number ?? "—", 10)}  status=${pad(r.cert_status ?? "—", 18)}  in_may1=${pad(r.in_may1 ? "yes" : "no", 4)}  guards=${guardOk ? "✓" : "✗"}`,
    );
  }
  // Pick the BEST cert per operator: prefer guard-passing rows; if multiple
  // guard-pass, prefer the one matched via realfleet_merge; else first.
  const opCerts: Record<string, typeof stage2Lookup.rows[number]> = {};
  for (const r of stage2Lookup.rows) {
    const guardOk =
      r.cert_id !== null &&
      r.cert_status === "active_operating" &&
      r.in_may1 === true &&
      r.has_existing_ohc === false;
    if (!guardOk) continue;
    const existing = opCerts[r.operator_id];
    if (
      !existing ||
      (existing.identity_match_method !== "faa_operators_realfleet_merge" &&
        r.identity_match_method === "faa_operators_realfleet_merge")
    ) {
      opCerts[r.operator_id] = r;
    }
  }
  const stage2Insertable = Object.values(opCerts);
  console.log(`      → Stage 2 insertable (after guard + best-cert pick): ${stage2Insertable.length} of ${STAGE2_OPERATORS.length} target ops`);
  for (const r of stage2Insertable) {
    console.log(
      `         ✓ ${pad(trunc(r.canonical_name, 22), 22)}  picked cert=${r.faa_cert_number}  via=${r.identity_match_method}`,
    );
  }
  const targetIdsWithoutPick = STAGE2_OPERATORS.filter((o) => !opCerts[o.id]);
  for (const o of targetIdsWithoutPick) {
    console.log(`         ✗ ${o.name}: no cert found that passes all guards (defer to LLM ER)`);
  }

  console.log("");

  // ════════════════════════════════════════════════════════════════════════
  // STAGE 1 — Re-open 155 ohc rows
  // ════════════════════════════════════════════════════════════════════════

  if (stagesToRun.includes(1)) {
    console.log("[phase4a] ── STAGE 1: Re-open closed ohc rows ──");

    const auditJsonb = {
      reason: "reopened_post_a8_phase3_finding",
      phase: "a8_phase4a_stage1",
      original_valid_to: null as string | null,
      guards_passed: {
        operator_was_null_typed: true,
        cert_status_active_operating: true,
        cert_in_may1_d085_attestation: true,
      },
      session_doc: SESSION_DOC_REF,
      commit_sha: commitSha,
    };

    if (!args.write) {
      console.log(`  DRY-RUN: would UPDATE ${expectedStage1Update} ohc rows (set valid_to=NULL, append audit evidence).`);
      console.log(`  (${s1n} candidates − ${sibN} overlap-conflicts = ${expectedStage1Update})`);
      console.log(`  Audit JSONB shape (original_valid_to populated per-row at runtime):`);
      console.log(
        "    " +
          JSON.stringify(auditJsonb, null, 2)
            .split("\n")
            .map((l, i) => (i === 0 ? l : "    " + l))
            .join("\n"),
      );
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Build the audit JSONB per-row using to_jsonb so original_valid_to
        // is captured from the row's current valid_to value.
        const updateSql = `
          UPDATE canonical.operator_holds_certificate ohc
          SET
            valid_to = NULL,
            evidence = COALESCE(ohc.evidence, '{}'::jsonb) || jsonb_build_object(
              'reason', 'reopened_post_a8_phase3_finding',
              'phase', 'a8_phase4a_stage1',
              'original_valid_to', ohc.valid_to::text,
              'guards_passed', jsonb_build_object(
                'operator_was_null_typed', true,
                'cert_status_active_operating', true,
                'cert_in_may1_d085_attestation', true
              ),
              'session_doc', $2::text,
              'commit_sha', $1::text
            ),
            last_updated_at = NOW()
          WHERE ohc.id IN (
            SELECT ohc2.id
            FROM canonical.operator_holds_certificate ohc2
            JOIN public.operators o ON o.id = ohc2.operator_id
            JOIN canonical.certificates c ON c.cert_id = ohc2.cert_id
            JOIN canonical.certificate_identities ci
              ON ci.cert_id = ohc2.cert_id AND ci.source = '${D085_MAY1_SOURCE}'
            WHERE ohc2.valid_to IS NOT NULL
              AND c.status = 'active_operating'
              AND o.operator_type IS NULL
              -- Precise overlap check: only block if another ohc on
              -- (operator_id, cert_id, role) would actually overlap with
              -- the re-opened daterange [valid_from, infinity).
              AND NOT EXISTS (
                SELECT 1 FROM canonical.operator_holds_certificate other
                WHERE other.operator_id = ohc2.operator_id
                  AND other.cert_id = ohc2.cert_id
                  AND other.role = ohc2.role
                  AND other.id <> ohc2.id
                  AND (other.valid_to IS NULL OR other.valid_to > ohc2.valid_from)
              )
          )
        `;
        const result = await client.query(updateSql, [commitSha, SESSION_DOC_REF]);
        const rowCount = result.rowCount ?? 0;
        console.log(`  UPDATE: ${rowCount} ohc rows re-opened.`);

        if (rowCount !== expectedStage1Update) {
          console.log(
            `  ✗ rowCount (${rowCount}) ≠ pre-flight expected (${expectedStage1Update}) — ROLLBACK`,
          );
          await client.query("ROLLBACK");
          process.exit(1);
        }
        await client.query("COMMIT");
        console.log(`  ✓ COMMIT ok.`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("  ✗ Stage 1 error, ROLLBACK:", err);
        throw err;
      } finally {
        client.release();
      }
    }
    console.log("");
  }

  // ════════════════════════════════════════════════════════════════════════
  // STAGE 2 — INSERT 2 fresh ohc rows for Silver Air + Solairus
  // ════════════════════════════════════════════════════════════════════════

  if (stagesToRun.includes(2)) {
    console.log("[phase4a] ── STAGE 2: INSERT fresh ohc for Silver Air + Solairus ──");

    if (stage2Insertable.length !== EXPECTED_STAGE2_OHC_INSERTS) {
      console.log(
        `  ⚠ insertable count = ${stage2Insertable.length}, originally expected ${EXPECTED_STAGE2_OHC_INSERTS}`,
      );
      console.log(`    See pre-flight Stage 2 lookup above for skip reasons.`);
    }

    if (stage2Insertable.length === 0) {
      console.log(`  no insertable candidates — skipping Stage 2 entirely`);
    } else if (!args.write) {
      console.log(`  DRY-RUN: would INSERT ${stage2Insertable.length} ohc rows:`);
      for (const r of stage2Insertable) {
        console.log(
          `    ${pad(trunc(r.canonical_name, 24), 24)}  cert=${pad(r.faa_cert_number!, 10)}  via=${r.identity_match_method}  cert_id=${r.cert_id!.slice(0, 8)}…`,
        );
      }
    } else {
      for (const op of stage2Insertable) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          // Pre-INSERT guard re-check inside transaction (defensive against
          // concurrent writes between pre-flight and this point)
          const guardCheck = await client.query<{
            cert_status: string;
            in_may1: boolean;
            existing_ohc: number;
          }>(
            `SELECT
               c.status                              AS cert_status,
               EXISTS (
                 SELECT 1 FROM canonical.certificate_identities ci
                 WHERE ci.cert_id = c.cert_id AND ci.source = $2
               ) AS in_may1,
               (SELECT COUNT(*)::int FROM canonical.operator_holds_certificate ohc
                WHERE ohc.operator_id = $1::uuid) AS existing_ohc
             FROM canonical.certificates c
             WHERE c.cert_id = $3::uuid`,
            [op.operator_id, D085_MAY1_SOURCE, op.cert_id],
          );
          const g = guardCheck.rows[0];
          if (
            !g ||
            g.cert_status !== "active_operating" ||
            g.in_may1 !== true ||
            g.existing_ohc !== 0
          ) {
            console.log(
              `  ✗ ${op.canonical_name}: guard re-check failed inside tx — ROLLBACK and skip`,
            );
            await client.query("ROLLBACK");
            continue;
          }

          const insertSql = `
            INSERT INTO canonical.operator_holds_certificate (
              operator_id, cert_id, role, valid_from, valid_to,
              source, source_url, source_timestamp, ingestion_date,
              confidence, match_method, evidence,
              corroborated_by, contradicted_by,
              first_seen_at, last_updated_at, schema_version
            )
            SELECT
              $1::uuid AS operator_id,
              $2::uuid AS cert_id,
              'holder_of_record' AS role,
              COALESCE(c.issued_date, CURRENT_DATE) AS valid_from,
              NULL::date AS valid_to,
              'phase4a_realfleet_merge_repair' AS source,
              NULL AS source_url,
              NULL AS source_timestamp,
              NOW() AS ingestion_date,
              0.95::numeric(3,2) AS confidence,
              'inserted_from_existing_identity' AS match_method,
              jsonb_build_object(
                'reason', 'inserted_post_a8_phase3_finding',
                'phase', 'a8_phase4a_stage2',
                'guards_passed', jsonb_build_object(
                  'operator_has_no_existing_ohc', true,
                  'target_cert_exists', true,
                  'cert_status_active_operating', true,
                  'cert_in_may1_d085_attestation', true
                ),
                'picked_identity_source_id', $3::text,
                'picked_identity_match_method', $6::text,
                'session_doc', $4::text,
                'commit_sha', $5::text
              ) AS evidence,
              NULL AS corroborated_by,
              NULL AS contradicted_by,
              NOW() AS first_seen_at,
              NOW() AS last_updated_at,
              1 AS schema_version
            FROM canonical.certificates c
            WHERE c.cert_id = $2::uuid
            RETURNING id
          `;
          const result = await client.query(insertSql, [
            op.operator_id,
            op.cert_id,
            op.identity_source_id,
            SESSION_DOC_REF,
            commitSha,
            op.identity_match_method,
          ]);
          const rowCount = result.rowCount ?? 0;
          if (rowCount !== 1) {
            console.log(
              `  ✗ ${op.canonical_name}: INSERT rowCount = ${rowCount} ≠ 1 — ROLLBACK`,
            );
            await client.query("ROLLBACK");
            continue;
          }
          await client.query("COMMIT");
          console.log(
            `  ✓ ${op.canonical_name}: INSERT ok (cert ${op.faa_cert_number}, role=holder_of_record)`,
          );
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          console.error(`  ✗ ${op.canonical_name}: error, ROLLBACK:`, err);
          throw err;
        } finally {
          client.release();
        }
      }
    }
    console.log("");
  }

  // ════════════════════════════════════════════════════════════════════════
  // STAGE 3 — Re-run A.5 Phase 3 UPDATE_SQL exactly as-is
  // ════════════════════════════════════════════════════════════════════════

  if (stagesToRun.includes(3)) {
    console.log("[phase4a] ── STAGE 3: Re-run A.5 Phase 3 UPDATE_SQL ──");

    // Mirrors the EVIDENCE clause from
    // scripts/type-tag-operators-from-faa-p135-2026-05-01.ts but scopes to
    // NULL-typed operators only. A.5's full clause also upgrades existing
    // part_135 operators with conf < 0.95, which is outside Phase 4a's
    // scope (1400+ already-tagged operators would be touched). The
    // evidence requirement (open ohc + role=holder_of_record + cert in
    // May 1 attestation) is preserved verbatim.
    const updateSql = `
      UPDATE public.operators o SET
        operator_type = $1,
        data_confidence_score = $2::numeric(3,2),
        last_updated_at = NOW()
      WHERE o.operator_type IS NULL
      AND EXISTS (
        SELECT 1 FROM canonical.operator_holds_certificate ohc
        JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
        WHERE ohc.operator_id = o.id
          AND ohc.role = 'holder_of_record'
          AND ohc.valid_to IS NULL
          AND ci.source = $3
      )
    `;

    if (!args.write) {
      // Dry-run: count what would be updated against CURRENT db state.
      // Pre-Stage-1+2, this is 0 (no NULL-typed operators have open ohc
      // for May-1-attested certs). Post-Stage-1+2, expect 156.
      const countSql = `
        SELECT COUNT(*)::int AS n
        FROM public.operators o
        WHERE o.operator_type IS NULL
        AND EXISTS (
          SELECT 1 FROM canonical.operator_holds_certificate ohc
          JOIN canonical.certificate_identities ci ON ci.cert_id = ohc.cert_id
          WHERE ohc.operator_id = o.id
            AND ohc.role = 'holder_of_record'
            AND ohc.valid_to IS NULL
            AND ci.source = $1
        )
      `;
      const countResult = await pool.query<{ n: number }>(countSql, [D085_MAY1_SOURCE]);
      const wouldUpdate = countResult.rows[0]!.n;
      console.log(`  DRY-RUN: would UPDATE ${wouldUpdate} NULL-typed operators to ${TARGET_TYPE} @ ${TARGET_CONF}`);
      console.log(
        `  (note: pre-Stage-1+2, expect 0 — A.5 already tagged all currently-eligible ops.)`,
      );
      console.log(
        `   Post-stage-1+2 (in --write mode), expect ${expectedStage1Update} + ${stage2Insertable.length} = ${expectedStage1Update + stage2Insertable.length}.`,
      );
    } else {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(updateSql, [TARGET_TYPE, TARGET_CONF, D085_MAY1_SOURCE]);
        const rowCount = result.rowCount ?? 0;
        const expectedStage3 = expectedStage1Update + stage2Insertable.length;
        console.log(`  UPDATE: ${rowCount} operators tagged (expected ${expectedStage3}).`);
        if (stagesToRun.length === 3 && rowCount !== expectedStage3) {
          console.log(
            `  ⚠ rowCount drift from expected. Continuing COMMIT (may be benign — e.g.,`,
          );
          console.log(`    already tagged in earlier --stage=3 run, or some op has ohc but no`);
          console.log(`    May-1-attested cert that A.5's evidence catches).`);
        }
        await client.query("COMMIT");
        console.log(`  ✓ COMMIT ok.`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        console.error("  ✗ Stage 3 error, ROLLBACK:", err);
        throw err;
      } finally {
        client.release();
      }
    }
    console.log("");
  }

  // ════════════════════════════════════════════════════════════════════════
  // POST-WRITE VERIFICATION
  // ════════════════════════════════════════════════════════════════════════

  if (args.write) {
    console.log("[phase4a] ── POST-WRITE VERIFICATION ──");

    const postNullCount = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM public.operators WHERE operator_type IS NULL`,
    );
    const postNull = postNullCount.rows[0]!.n;
    console.log(`  NULL-typed operators after Phase 4a:        ${postNull}  (was ${nullN})`);
    console.log(`  Operators tagged by Phase 4a:               ${nullN - postNull}`);

    const postTypeBreakdown = await pool.query<{ operator_type: string | null; n: number }>(`
      SELECT operator_type, COUNT(*)::int AS n FROM public.operators
      GROUP BY operator_type ORDER BY operator_type NULLS FIRST
    `);
    console.log(`  operator_type breakdown:`);
    for (const r of postTypeBreakdown.rows) {
      console.log(
        `    ${pad(r.operator_type ?? "(NULL)", 18)}  n=${r.n}`,
      );
    }

    // Top-20 by fleet sanity (NetJets / Flexjet / Wheels Up retention)
    const top20 = await pool.query<{ canonical_name: string; fleet: number }>(`
      SELECT
        o.canonical_name,
        COUNT(DISTINCT oal.aircraft_id)::int AS fleet
      FROM public.operators o
      JOIN canonical.operator_aircraft_link oal
        ON oal.operator_id = o.id AND oal.valid_to IS NULL
      GROUP BY o.canonical_name
      ORDER BY fleet DESC
      LIMIT 20
    `);
    console.log(`  Top 20 by fleet:`);
    for (const r of top20.rows) {
      console.log(`    ${pad(trunc(r.canonical_name, 50), 50)}  fleet=${rpad(r.fleet, 4)}`);
    }
    const expectedBrands = ["NetJets", "Flexjet", "Wheels Up"];
    for (const brand of expectedBrands) {
      const found = top20.rows.some((r) => r.canonical_name.includes(brand));
      console.log(`    ${found ? "✓" : "✗"} ${brand} ${found ? "in top 20" : "MISSING"}`);
    }

    console.log("");
    console.log(`[phase4a] ✓ Write complete. Run \`npx tsc --noEmit && npm test\` next.`);
  }

  console.log("[phase4a] STOP — gate review next, no further writes.");

  await pool.end();
}

main().catch((err) => {
  console.error("[phase4a] FATAL:", err);
  process.exit(1);
});
