/**
 * Phase 2 + Phase 2.5 — Auto-resolve mechanical omr rows.
 *
 * Path A — Stage 2 close-out per
 * /Users/phelipehonesto/.claude/plans/serene-bubbling-beaver.md.
 *
 * Phase 1 (commit 0633bc1) decomposed the 1054 pending operator_match_review
 * rows. This script reprocesses 20 mechanical rows (writes operator_identities
 * + flips omr.status='matched') and adds reviewer_notes to 3 deferred rows
 * (kept in 'pending' for LLM ER hand-off).
 *
 * ── Scope (23 rows in 4 categories) ──────────────────────────────────────
 *
 *   Phase 2 (14 rows, the original A.6-doc scope):
 *     • Dedup-unblocked (5): omr ids 1955, 1982, 2001, 2017, 2195
 *       — all FAA-source big-brand cases where A.6 dedup eliminated the
 *         runner-up that was causing ambiguous_runner_up review queue.
 *     • Normalize-match (9, excluding 2195 which overlaps with dedup):
 *       132, 159, 171, 188, 301, 1417, 1578, 1607, 1620
 *       — scraped_name normalize-equals an existing canonical_name under
 *         the LOWER+TRIM+collapse-whitespace expression installed in
 *         migration 2026-05-05-001. Pre-A.6.5 omr writes; today's
 *         resolver would catch via findOperatorByNormalizedName.
 *
 *   Phase 2.5 (6 rows, surfaced by Phase 1 with score gate >= 0.85):
 *     • High-score FAA-source dedup-unblocked: 1414, 1480, 1504, 1506, 1579,
 *       1602. Same mechanical pattern as Phase 2's 5, plus stricter score
 *       gate (>= 0.85) for confidence. Validated against the Tradewind
 *       Charter LLC case (omr#1580 at 0.8476) — below the gate is correct
 *       because the underlying truth is more complex than name match.
 *
 *   Reviewer-note-only (3 rows, kept in 'pending' for LLM ER):
 *     • omr#121  AB Jets LLC DBA Ab Jets   — 0.6425 below gate, no
 *                                            canonical row, needs new_operator
 *     • omr#157  ATI Jet Executive Charter — 0.6187 below gate, should
 *                                            match ATI JET INC not Tavaero
 *     • omr#1580 Tradewind Charter LLC     — 0.8476 below gate, confirmed
 *                                            rebrand event per April 2026
 *                                            labeling (reserved for Stage 5
 *                                            operator_events treatment)
 *
 * ── Mechanical write path (per row) ──────────────────────────────────────
 *
 *   BEGIN
 *     -- determine surviving operator_id (whichever of top/runner-up still
 *     -- exists, OR the normalize-match operator)
 *     -- verify the operator's canonical_name matches expected
 *
 *     INSERT INTO operator_identities (operator_id, source, source_id,
 *       name_as_provided, match_confidence, match_method, match_evidence)
 *
 *     UPDATE operator_match_review
 *        SET status = 'matched', resolution_operator_id, reviewed_at,
 *            reviewer_notes
 *      WHERE id = X AND status = 'pending'   -- guarded against double-write
 *   COMMIT
 *
 * ── CLI ──────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/reprocess-omr-mechanical-2026-05-06.ts          # dry-run
 *   npx tsx scripts/reprocess-omr-mechanical-2026-05-06.ts --write  # commit
 *
 * Default is dry-run — every step is simulated, no DB writes. --write
 * commits all 23 row updates inside per-row transactions (one BEGIN/COMMIT
 * per row, so a single failure rolls back only that row).
 */

import "dotenv/config";
import pg from "pg";

// ── Constants ─────────────────────────────────────────────────────────────

const NORMALIZE_EXPR = `LOWER(TRIM(REGEXP_REPLACE($COL$, '\\s+', ' ', 'g')))`;

// ── Types ─────────────────────────────────────────────────────────────────

type Category =
  | "phase2_dedup_unblocked"
  | "phase2_normalize_match"
  | "phase2_5_dedup_unblocked"
  | "reviewer_note_only";

interface OmrPlan {
  omr_id: number;
  category: Category;
  /**
   * Expected surviving canonical_name (the operator we expect to attach to).
   * The script verifies the surviving operator's canonical_name matches
   * before writing — guards against the surviving id pointing to an
   * unrelated operator (would be a Phase 1 classification bug).
   */
  expected_canonical_name: string;
  /**
   * The reviewer_notes value written to operator_match_review. For
   * mechanical categories, includes the score for traceability.
   */
  reviewer_notes: string;
}

interface OmrRow {
  id: number;
  status: string;
  scraped_name: string;
  scraped_source: string;
  scraped_source_id: string;
  candidate_matches: Array<{
    operator_id: string;
    canonical_name: string;
    score: number;
    signals: Record<string, unknown>;
  }>;
}

interface RowResult {
  omr_id: number;
  category: Category;
  outcome:
    | "RESOLVED"
    | "NOTE_ONLY"
    | "ALREADY_RESOLVED"
    | "NOT_FOUND"
    | "NO_SURVIVING_OPERATOR"
    | "EXPECTED_MISMATCH"
    | "ERROR";
  surviving_operator_id?: string;
  surviving_canonical_name?: string;
  detail?: string;
}

// ── Plan (the 23 rows) ────────────────────────────────────────────────────

const PLAN: OmrPlan[] = [
  // ── Phase 2 dedup-unblocked (5) ─────────────────────────────────────────
  {
    omr_id: 1955,
    category: "phase2_dedup_unblocked",
    expected_canonical_name: "JetRight",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2: ambiguous_runner_up unblocked, score 0.85)",
  },
  {
    omr_id: 1982,
    category: "phase2_dedup_unblocked",
    expected_canonical_name: "Flexjet",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2: ambiguous_runner_up unblocked, score 0.9167)",
  },
  {
    omr_id: 2001,
    category: "phase2_dedup_unblocked",
    expected_canonical_name: "Tradewind Aviation",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2: ambiguous_runner_up unblocked, score 0.9565)",
  },
  {
    omr_id: 2017,
    category: "phase2_dedup_unblocked",
    expected_canonical_name: "NetJets Aviation",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2: ambiguous_runner_up unblocked, score 0.9454)",
  },
  {
    omr_id: 2195,
    category: "phase2_dedup_unblocked",
    expected_canonical_name: "Thrive Aviation",
    reviewer_notes:
      "auto-resolved post-A.6 dedup (Phase 2: ambiguous_runner_up unblocked, score 1.00; also normalize-match — same canonical)",
  },

  // ── Phase 2 normalize-match (9, omr#2195 already in dedup-unblocked) ────
  {
    omr_id: 132,
    category: "phase2_normalize_match",
    expected_canonical_name: "Executive Jet Management",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 159,
    category: "phase2_normalize_match",
    expected_canonical_name: "AVIATION CHARTERS, INC.",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 171,
    category: "phase2_normalize_match",
    expected_canonical_name: "FLIGHT LEVEL SERVICES LLC",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 188,
    category: "phase2_normalize_match",
    expected_canonical_name: "SCOTT RICHARD AVIATION SERVICES, INC.",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 301,
    category: "phase2_normalize_match",
    expected_canonical_name: "Port Townsend Air LLC",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 1417,
    category: "phase2_normalize_match",
    expected_canonical_name: "FLIGHT PROGRAM OPERATIONS",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 1578,
    category: "phase2_normalize_match",
    expected_canonical_name: "Thrive Aviation",
    reviewer_notes:
      "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical; also dedup-unblocked at score 1.00 — same outcome)",
  },
  {
    omr_id: 1607,
    category: "phase2_normalize_match",
    expected_canonical_name: "WINGS AIR CHARTER, LLC",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },
  {
    omr_id: 1620,
    category: "phase2_normalize_match",
    expected_canonical_name: "Let's Jett Inc.",
    reviewer_notes: "auto-resolved post-A.6.5 normalize-match (Phase 2: scraped_name normalize-equals canonical)",
  },

  // ── Phase 2.5 high-score FAA-source dedup-unblocked (6) ─────────────────
  {
    omr_id: 1414,
    category: "phase2_5_dedup_unblocked",
    expected_canonical_name: "Flexjet",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2.5: FAA-source big-brand, score 0.9167 >= 0.85 gate)",
  },
  {
    omr_id: 1480,
    category: "phase2_5_dedup_unblocked",
    expected_canonical_name: "JetRight",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2.5: FAA-source big-brand, score 0.85 at gate)",
  },
  {
    omr_id: 1504,
    category: "phase2_5_dedup_unblocked",
    expected_canonical_name: "Wheels Up",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2.5: FAA-source big-brand, score 0.8818 >= 0.85 gate)",
  },
  {
    omr_id: 1506,
    category: "phase2_5_dedup_unblocked",
    expected_canonical_name: "NetJets Aviation",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2.5: FAA-source big-brand, score 0.9454 >= 0.85 gate)",
  },
  {
    omr_id: 1579,
    category: "phase2_5_dedup_unblocked",
    expected_canonical_name: "Tradewind Aviation",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2.5: FAA-source big-brand, score 0.9565 >= 0.85 gate)",
  },
  {
    omr_id: 1602,
    category: "phase2_5_dedup_unblocked",
    expected_canonical_name: "Wheels Up",
    reviewer_notes: "auto-resolved post-A.6 dedup (Phase 2.5: FAA-source big-brand, score 0.8692 >= 0.85 gate)",
  },

  // ── Reviewer-note-only (3 rows, kept in 'pending' for LLM ER) ───────────
  {
    omr_id: 121,
    category: "reviewer_note_only",
    expected_canonical_name: "",
    reviewer_notes:
      "Phase 1 surfaced as dedup-unblocked but score 0.6425 < 0.85 mechanical gate. " +
      "AB Jets has no canonical row — likely needs new_operator resolution. " +
      "Deferred to LLM ER for reasoning.",
  },
  {
    omr_id: 157,
    category: "reviewer_note_only",
    expected_canonical_name: "",
    reviewer_notes:
      "Phase 1 surfaced as dedup-unblocked but score 0.6187 < 0.85 mechanical gate. " +
      "Verified should match ATI JET INC (id 3373eb66-ee16-48f4-8b6c-3c55d4f850e4), " +
      "not Tavaero Jet Charter Corporation. Deferred to LLM ER for reasoning.",
  },
  {
    omr_id: 1580,
    category: "reviewer_note_only",
    expected_canonical_name: "",
    reviewer_notes:
      "Phase 1 surfaced as dedup-unblocked but score 0.8476 < 0.85 mechanical gate. " +
      "Confirmed rebrand event per April 2026 labeling — Tradewind Charter LLC was " +
      "2001 original legal entity name, rebranded to Tradewind Aviation brand. " +
      "Reserved for Phase 7 LLM ER pass + Stage 5 operator_events structural " +
      "treatment. Do not mechanically auto-resolve as simple operator_identities " +
      "attach — would flatten rebrand event into flat alias.",
  },
];

// ── CLI ───────────────────────────────────────────────────────────────────

interface Args {
  write: boolean;
}

function parseArgs(argv: string[]): Args {
  return { write: argv.includes("--write") };
}

// ── Surviving-operator resolution ─────────────────────────────────────────

/**
 * For dedup-unblocked categories: take whichever of top/runner-up still
 * exists in operators. Returns null if neither exists (shouldn't happen
 * for our 11 dedup-unblocked rows; would indicate a Phase 1 classifier
 * bug).
 */
async function survivingFromDedup(
  client: pg.PoolClient,
  candidates: OmrRow["candidate_matches"],
): Promise<{ operator_id: string; canonical_name: string } | null> {
  const top = candidates[0];
  const runnerUp = candidates[1];

  for (const c of [top, runnerUp]) {
    if (!c) continue;
    const r = await client.query<{ id: string; canonical_name: string }>(
      `SELECT id::text AS id, canonical_name FROM operators WHERE id = $1::uuid`,
      [c.operator_id],
    );
    if (r.rows[0]) return { operator_id: r.rows[0].id, canonical_name: r.rows[0].canonical_name };
  }
  return null;
}

/**
 * For normalize-match category: SELECT the operator whose canonical_name
 * normalize-equals scraped_name under the UNIQUE-index expression. The
 * UNIQUE index guarantees at most one row.
 */
async function survivingFromNormalize(
  client: pg.PoolClient,
  scrapedName: string,
): Promise<{ operator_id: string; canonical_name: string } | null> {
  const r = await client.query<{ id: string; canonical_name: string }>(
    `SELECT id::text AS id, canonical_name FROM operators
      WHERE ${NORMALIZE_EXPR.replace("$COL$", "canonical_name")}
          = ${NORMALIZE_EXPR.replace("$COL$", "$1::text")}
      LIMIT 1`,
    [scrapedName],
  );
  return r.rows[0] ? { operator_id: r.rows[0].id, canonical_name: r.rows[0].canonical_name } : null;
}

// ── Per-row processor ─────────────────────────────────────────────────────

async function processRow(
  pool: pg.Pool,
  plan: OmrPlan,
  dryRun: boolean,
): Promise<RowResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Fetch the omr row
    const omrRes = await client.query<OmrRow>(
      `SELECT
         id, status, scraped_name, scraped_source, scraped_source_id, candidate_matches
       FROM operator_match_review WHERE id = $1`,
      [plan.omr_id],
    );
    if (omrRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return { omr_id: plan.omr_id, category: plan.category, outcome: "NOT_FOUND" };
    }
    const omr = omrRes.rows[0]!;
    if (omr.status !== "pending") {
      await client.query("ROLLBACK");
      return {
        omr_id: plan.omr_id,
        category: plan.category,
        outcome: "ALREADY_RESOLVED",
        detail: `status=${omr.status}`,
      };
    }

    // 2. For reviewer-note-only: just UPDATE notes, leave status='pending'.
    if (plan.category === "reviewer_note_only") {
      if (!dryRun) {
        await client.query(
          `UPDATE operator_match_review
              SET reviewer_notes = $1
            WHERE id = $2 AND status = 'pending'`,
          [plan.reviewer_notes, plan.omr_id],
        );
      }
      await client.query(dryRun ? "ROLLBACK" : "COMMIT");
      return {
        omr_id: plan.omr_id,
        category: plan.category,
        outcome: "NOTE_ONLY",
        detail: `note: ${plan.reviewer_notes.slice(0, 80)}…`,
      };
    }

    // 3. Determine surviving operator
    let surviving: { operator_id: string; canonical_name: string } | null;
    if (plan.category === "phase2_normalize_match") {
      surviving = await survivingFromNormalize(client, omr.scraped_name);
    } else {
      surviving = await survivingFromDedup(client, omr.candidate_matches);
    }
    if (!surviving) {
      await client.query("ROLLBACK");
      return {
        omr_id: plan.omr_id,
        category: plan.category,
        outcome: "NO_SURVIVING_OPERATOR",
        detail: "neither top/runner-up exists, or normalize-match returned no row",
      };
    }

    // 4. Verify expected canonical_name match
    if (surviving.canonical_name !== plan.expected_canonical_name) {
      await client.query("ROLLBACK");
      return {
        omr_id: plan.omr_id,
        category: plan.category,
        outcome: "EXPECTED_MISMATCH",
        surviving_operator_id: surviving.operator_id,
        surviving_canonical_name: surviving.canonical_name,
        detail: `expected '${plan.expected_canonical_name}'`,
      };
    }

    // 5. Mechanical write: INSERT identity + UPDATE omr
    const matchMethod =
      plan.category === "phase2_normalize_match"
        ? "auto_resolved_post_normalize_match"
        : "auto_resolved_post_dedup";
    const matchConfidence = plan.category === "phase2_normalize_match" ? "exact" : "high";
    const evidence = {
      method: "phase_2_omr_reprocess_2026_05_06",
      category: plan.category,
      source_omr_id: plan.omr_id,
      surviving_canonical_name: surviving.canonical_name,
      gate_pass: plan.category === "phase2_5_dedup_unblocked" ? "score >= 0.85" : null,
    };

    if (!dryRun) {
      // INSERT operator_identities (UNIQUE on (source, source_id) — would 23505
      // if the identity already exists, signaling a different code path beat
      // us to it; per-row transaction lets that one row roll back cleanly).
      await client.query(
        `INSERT INTO operator_identities
           (operator_id, source, source_id, name_as_provided,
            match_confidence, match_method, match_evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          surviving.operator_id,
          omr.scraped_source,
          omr.scraped_source_id,
          omr.scraped_name,
          matchConfidence,
          matchMethod,
          JSON.stringify(evidence),
        ],
      );

      await client.query(
        `UPDATE operator_match_review
            SET status = 'matched',
                resolution_operator_id = $1::uuid,
                reviewed_at = NOW(),
                reviewer_notes = $2
          WHERE id = $3 AND status = 'pending'`,
        [surviving.operator_id, plan.reviewer_notes, plan.omr_id],
      );
    }

    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return {
      omr_id: plan.omr_id,
      category: plan.category,
      outcome: "RESOLVED",
      surviving_operator_id: surviving.operator_id,
      surviving_canonical_name: surviving.canonical_name,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      /* swallow */
    });
    return {
      omr_id: plan.omr_id,
      category: plan.category,
      outcome: "ERROR",
      detail: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.release();
  }
}

// ── Output helpers ────────────────────────────────────────────────────────

function pad(s: string | number, n: number): string {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function categoryShort(c: Category): string {
  switch (c) {
    case "phase2_dedup_unblocked":
      return "P2.dedup";
    case "phase2_normalize_match":
      return "P2.norm";
    case "phase2_5_dedup_unblocked":
      return "P2.5.dedup";
    case "reviewer_note_only":
      return "note-only";
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) throw new Error("SUPABASE_DATABASE_URL not set");

  const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

  console.log(`[reprocess-omr] Mode: ${args.write ? "WRITE" : "DRY-RUN (default)"}`);
  console.log(`[reprocess-omr] Total rows in plan: ${PLAN.length}`);
  const counts = PLAN.reduce(
    (acc, p) => {
      acc[p.category] = (acc[p.category] ?? 0) + 1;
      return acc;
    },
    {} as Record<Category, number>,
  );
  for (const [cat, n] of Object.entries(counts)) {
    console.log(`    ${pad(cat, 28)} ${n}`);
  }
  console.log("");

  // ── Pre-state ─────────────────────────────────────────────────────────

  const preState = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM operator_match_review WHERE status = 'pending'`,
  );
  console.log(`[reprocess-omr] Pre-state: ${preState.rows[0]!.n} pending omr rows`);
  console.log("");

  // ── Process each row ──────────────────────────────────────────────────

  const results: RowResult[] = [];
  for (const plan of PLAN) {
    const r = await processRow(pool, plan, !args.write);
    results.push(r);
  }

  // ── Per-row output ────────────────────────────────────────────────────

  console.log("[reprocess-omr] Per-row results:");
  console.log(
    "    " +
      pad("omr_id", 8) +
      pad("category", 14) +
      pad("outcome", 22) +
      pad("→ surviving", 30) +
      "detail",
  );
  console.log("    " + "─".repeat(110));
  for (const r of results) {
    const surviving = r.surviving_canonical_name ? trunc(r.surviving_canonical_name, 28) : "—";
    const detail = r.detail ?? "";
    console.log(
      "    " +
        pad(r.omr_id, 8) +
        pad(categoryShort(r.category), 14) +
        pad(r.outcome, 22) +
        pad(surviving, 30) +
        trunc(detail, 60),
    );
  }
  console.log("");

  // ── Summary ───────────────────────────────────────────────────────────

  const outcomes = results.reduce(
    (acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.log("[reprocess-omr] Outcome breakdown:");
  for (const [o, n] of Object.entries(outcomes)) {
    console.log(`    ${pad(o, 28)} ${n}`);
  }
  console.log("");

  // ── Post-state ────────────────────────────────────────────────────────

  const postState = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM operator_match_review WHERE status = 'pending'`,
  );
  const delta = postState.rows[0]!.n - preState.rows[0]!.n;
  console.log(`[reprocess-omr] Post-state: ${postState.rows[0]!.n} pending omr rows  (Δ ${delta >= 0 ? "+" : ""}${delta})`);
  if (args.write) {
    const expectedDelta = -results.filter((r) => r.outcome === "RESOLVED").length;
    if (delta !== expectedDelta) {
      console.log(
        `[reprocess-omr] ⚠ Expected delta ${expectedDelta} (RESOLVED count negated), saw ${delta} — investigate`,
      );
    } else {
      console.log(`[reprocess-omr] ✓ Pending count delta matches RESOLVED count.`);
    }
  } else {
    console.log(`[reprocess-omr] DRY-RUN — no rows changed. Re-run with --write to commit.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[reprocess-omr] FATAL:", err);
  process.exit(1);
});
