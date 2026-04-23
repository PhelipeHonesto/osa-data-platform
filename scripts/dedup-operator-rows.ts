/**
 * Dedup two canonical operator rows into one.
 *
 * Motivated by Phase 1 calibration finding #2 (docs/phase1-followups.md):
 * when the same real-world operator appears on both ARGUS and Wyvern but
 * neither side scores high enough to cross-match, the resolver creates two
 * canonical rows, one per source. This script collapses such pairs once a
 * human confirms they're the same entity.
 *
 * Safe sequence (all inside one transaction):
 *   1. UPDATE operator_aliases       SET operator_id = KEEP WHERE operator_id = MERGE
 *   2. UPDATE operator_identities    SET operator_id = KEEP WHERE operator_id = MERGE
 *      (UNIQUE (source, source_id) is table-global, so no conflict is
 *      possible — two canonical rows can't already share the same pair.)
 *   3. UPDATE operator_match_review  SET resolution_operator_id = KEEP
 *                                    WHERE resolution_operator_id = MERGE
 *   4. DELETE FROM operators WHERE id = MERGE
 *
 * Aliases + identities have ON DELETE CASCADE; re-pointing *before* the
 * DELETE is mandatory, or the children get wiped instead of moved.
 * resolution_operator_id is NO ACTION so the DELETE would hard-fail
 * without step 3.
 *
 * After commit, the survivor's trust scores are recomputed by shelling
 * out to `npm run operators:trust-scores -- --commit`. The survivor
 * typically gains an identity source, which shifts both
 * data_confidence_score (cross_source_agreement) and operator_trust_score
 * (source_count).
 *
 * Explicit --keep and --merge args by design. The script refuses to
 * auto-pick a survivor — that's a human call. parseTiebreaker() below
 * encodes the "oldest wins, then most identities, else flag" heuristic
 * for operators to consult, but the final choice is the invoker's.
 *
 * Usage:
 *   DATABASE_TYPE=postgres npm run operators:dedup -- \
 *     --keep <uuid> --merge <uuid>                      # dry run
 *   DATABASE_TYPE=postgres npm run operators:dedup -- \
 *     --keep <uuid> --merge <uuid> --commit
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { getPool, closePg } from "../src/db/pg-database.js";
import { initSentry, flushSentry, installProcessHandlers } from "../src/utils/sentry.js";
import { childLogger } from "../src/utils/logger.js";

const log = childLogger("dedup-operator-rows");

// ── Types ────────────────────────────────────────────────────────────────

export interface DedupArgs {
  keep: string;
  merge: string;
  /** Optional sanity gate: both operators must match this name (case-insensitive substring). */
  nameMatch: string | null;
  commit: boolean;
}

export interface OperatorSnapshot {
  id: string;
  canonical_name: string;
  operator_type: string | null;
  first_seen_at: string;
  identity_count: number;
  alias_count: number;
}

export interface DedupCounts {
  aliases_repointed: number;
  identities_repointed: number;
  review_rows_repointed: number;
  merge_row_deleted: boolean;
}

// ── Pure helpers (testable) ──────────────────────────────────────────────

export function parseArgs(argv: string[]): DedupArgs {
  let keep = "";
  let merge = "";
  let nameMatch: string | null = null;
  let commit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep" && argv[i + 1]) keep = argv[++i]!;
    else if (a === "--merge" && argv[i + 1]) merge = argv[++i]!;
    else if (a === "--name-match" && argv[i + 1]) nameMatch = argv[++i]!;
    else if (a === "--commit") commit = true;
  }
  return { keep, merge, nameMatch, commit };
}

export function validateArgs(args: DedupArgs): string | null {
  if (!args.keep) return "missing --keep <uuid>";
  if (!args.merge) return "missing --merge <uuid>";
  if (args.keep === args.merge) return "--keep and --merge must differ";
  return null;
}

/**
 * Apply the project's tiebreaker heuristic and return the keep/merge
 * assignment, or null when still tied. Informational — the script itself
 * always takes explicit IDs from the invoker.
 *
 *   1. Older first_seen_at wins.
 *   2. If tied, higher identity_count wins.
 *   3. Otherwise, return null (human pick needed).
 */
export function pickSurvivor(
  a: OperatorSnapshot,
  b: OperatorSnapshot,
): { keep: OperatorSnapshot; merge: OperatorSnapshot } | null {
  const ta = Date.parse(a.first_seen_at);
  const tb = Date.parse(b.first_seen_at);
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) {
    return ta < tb ? { keep: a, merge: b } : { keep: b, merge: a };
  }
  if (a.identity_count !== b.identity_count) {
    return a.identity_count > b.identity_count ? { keep: a, merge: b } : { keep: b, merge: a };
  }
  return null;
}

// ── DB I/O ───────────────────────────────────────────────────────────────

async function loadSnapshot(client: pg.PoolClient, id: string): Promise<OperatorSnapshot | null> {
  const res = await client.query<OperatorSnapshot>(
    `SELECT o.id,
            o.canonical_name,
            o.operator_type,
            o.first_seen_at::text AS first_seen_at,
            (SELECT COUNT(*)::int FROM operator_identities WHERE operator_id = o.id) AS identity_count,
            (SELECT COUNT(*)::int FROM operator_aliases    WHERE operator_id = o.id) AS alias_count
       FROM operators o
      WHERE o.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

/**
 * Move every FK child from merge → keep, then delete the merge row.
 *
 * **Metadata-preservation invariant**: this function NEVER touches the
 * survivor's canonical_name, headquarters_icao, type_tags, or
 * operator_type. The duplicate contributes its FK children only; the
 * survivor's own metadata is authoritative. For asymmetric dedups (e.g.
 * one side has a populated headquarters_icao, the other doesn't), the
 * invoker is responsible for choosing the right survivor up front.
 */
export async function dedupTransaction(
  client: pg.PoolClient,
  args: DedupArgs,
): Promise<DedupCounts> {
  const counts: DedupCounts = {
    aliases_repointed: 0,
    identities_repointed: 0,
    review_rows_repointed: 0,
    merge_row_deleted: false,
  };

  await client.query("BEGIN");
  try {
    const aliasesRes = await client.query(
      `UPDATE operator_aliases SET operator_id = $1 WHERE operator_id = $2`,
      [args.keep, args.merge],
    );
    counts.aliases_repointed = aliasesRes.rowCount ?? 0;

    const identitiesRes = await client.query(
      `UPDATE operator_identities SET operator_id = $1 WHERE operator_id = $2`,
      [args.keep, args.merge],
    );
    counts.identities_repointed = identitiesRes.rowCount ?? 0;

    const reviewRes = await client.query(
      `UPDATE operator_match_review
          SET resolution_operator_id = $1
        WHERE resolution_operator_id = $2`,
      [args.keep, args.merge],
    );
    counts.review_rows_repointed = reviewRes.rowCount ?? 0;

    const deleteRes = await client.query(
      `DELETE FROM operators WHERE id = $1`,
      [args.merge],
    );
    counts.merge_row_deleted = (deleteRes.rowCount ?? 0) === 1;
    if (!counts.merge_row_deleted) {
      throw new Error(`DELETE FROM operators WHERE id=${args.merge} affected 0 rows — aborting`);
    }

    // Bump the survivor's last_updated_at so downstream consumers can
    // detect that its identity footprint changed.
    await client.query(
      `UPDATE operators SET last_updated_at = NOW() WHERE id = $1`,
      [args.keep],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
  return counts;
}

// ── Env load ─────────────────────────────────────────────────────────────

function loadEnv(): void {
  try {
    const envContent = readFileSync(resolve(process.cwd(), ".env"), "utf-8");
    for (const line of envContent.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* .env not found — fine */
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

function formatSnapshot(label: string, snap: OperatorSnapshot): string {
  return `  ${label}: ${snap.id}
    canonical_name: ${snap.canonical_name}
    operator_type:  ${snap.operator_type ?? "NULL"}
    first_seen_at:  ${snap.first_seen_at}
    identities:     ${snap.identity_count}
    aliases:        ${snap.alias_count}`;
}

function nameSatisfies(snap: OperatorSnapshot, substr: string | null): boolean {
  if (!substr) return true;
  return snap.canonical_name.toLowerCase().includes(substr.toLowerCase());
}

async function main(): Promise<void> {
  loadEnv();
  if (process.env["DATABASE_TYPE"] !== "postgres") {
    throw new Error("operators:dedup requires DATABASE_TYPE=postgres");
  }
  initSentry();
  installProcessHandlers("dedup-operator-rows");

  const args = parseArgs(process.argv.slice(2));
  const err = validateArgs(args);
  if (err) {
    console.error(`[dedup] ${err}`);
    console.error(`Usage: npm run operators:dedup -- --keep <uuid> --merge <uuid> [--name-match <substr>] [--commit]`);
    process.exit(2);
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const [keepSnap, mergeSnap] = await Promise.all([
      loadSnapshot(client, args.keep),
      loadSnapshot(client, args.merge),
    ]);
    if (!keepSnap) throw new Error(`--keep ${args.keep} not found in operators`);
    if (!mergeSnap) throw new Error(`--merge ${args.merge} not found in operators`);

    console.log("\n[dedup] Targets:");
    console.log(formatSnapshot("KEEP ", keepSnap));
    console.log(formatSnapshot("MERGE", mergeSnap));

    if (args.nameMatch) {
      if (!nameSatisfies(keepSnap, args.nameMatch) || !nameSatisfies(mergeSnap, args.nameMatch)) {
        throw new Error(
          `--name-match '${args.nameMatch}' not satisfied by both rows ` +
            `(keep='${keepSnap.canonical_name}', merge='${mergeSnap.canonical_name}')`,
        );
      }
    }

    const tb = pickSurvivor(keepSnap, mergeSnap);
    if (tb === null) {
      console.log("\n[dedup] Tiebreaker heuristic: TIED — invoker's --keep stands.");
    } else if (tb.keep.id !== args.keep) {
      console.log(
        `\n[dedup] WARNING: tiebreaker heuristic would pick ${tb.keep.id} as survivor, ` +
          `not --keep=${args.keep}. Proceeding with invoker's choice.`,
      );
    } else {
      console.log("\n[dedup] Tiebreaker heuristic agrees with --keep.");
    }

    if (!args.commit) {
      // Dry-run: count what WOULD happen without modifying rows.
      const dryPreview = await client.query<{
        aliases: string;
        identities: string;
        review_rows: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::TEXT FROM operator_aliases    WHERE operator_id = $1)           AS aliases,
           (SELECT COUNT(*)::TEXT FROM operator_identities WHERE operator_id = $1)           AS identities,
           (SELECT COUNT(*)::TEXT FROM operator_match_review WHERE resolution_operator_id = $1) AS review_rows`,
        [args.merge],
      );
      const pre = dryPreview.rows[0]!;
      console.log(`\n[dedup] DRY RUN — would move:`);
      console.log(`  operator_aliases:      ${pre.aliases}`);
      console.log(`  operator_identities:   ${pre.identities}`);
      console.log(`  operator_match_review: ${pre.review_rows}`);
      console.log(`\n[dedup] DELETE operators row ${args.merge} would follow.`);
      console.log(`[dedup] Re-run with --commit to apply.`);
      return;
    }

    console.log(`\n[dedup] Applying merge...`);
    const counts = await dedupTransaction(client, args);
    console.log(`\n[dedup] Done. Moved:`);
    console.log(`  operator_aliases:      ${counts.aliases_repointed}`);
    console.log(`  operator_identities:   ${counts.identities_repointed}`);
    console.log(`  operator_match_review: ${counts.review_rows_repointed}`);
    console.log(`  operators row deleted: ${counts.merge_row_deleted}`);
  } finally {
    client.release();
    await closePg();
    await flushSentry();
  }

  if (args.commit) {
    console.log(`\n[dedup] Recomputing trust scores for all operators...`);
    const res = spawnSync("npm", ["run", "operators:trust-scores", "--", "--commit"], {
      stdio: "inherit",
      env: process.env,
    });
    if (res.status !== 0) {
      log.error({ status: res.status }, "trust-scores subprocess failed");
      console.error(`[dedup] trust-scores subprocess returned ${res.status}`);
      process.exit(res.status ?? 1);
    }
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    log.fatal({ err }, "dedup-operator-rows fatal error");
    process.exit(1);
  });
}
